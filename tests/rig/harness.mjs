// Ripple's streaming behaviour, reproduced against the real engine in node.
//
// Everything here mirrors ripple/src/torrent/worker.ts. The engine only sees
// three entry points from ripple (setStreamWindow, clearStreamWindow, read), and
// this file reproduces all three plus the pumps and the stall loop that drive
// them, so a picking result measured here describes the plan production runs.
//
// Deliberately NOT reproduced, because none of it exists outside a browser:
// IndexedDB persistence, the worker message protocol, the online/pagehide hooks,
// and the Web Locks engine election. None of them touch piece picking.
//
// The one fidelity gap worth stating in any result: production reaches peers
// through the WebVPN relay, and wrapper.cpp's uTP settings (utp_target_delay 600
// vs a default of 100, utp_loss_multiplier 90, utp_min_timeout 1200) were tuned
// against that relay's latency profile. Loopback has none of it. Picking
// behaviour transfers; throughput does not.

import { createSession, PRIORITY } from '../../build/index.js'
import { NodeFSStorage } from './node-storage.mjs'
import { createNodeHost } from './node-host.mjs'
import {
  READ_SIZE, windowPiecesFor, deadlineStepMsFor, shouldReanchor,
} from './stream-plan.mjs'

// worker.ts:41-43
const READ_ATTEMPT_MS = 6_000
const READ_ATTEMPTS = 18
const CANCEL_PER_STALL = 16

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export class Rig {
  #session = null
  #storage
  #host
  #viewers = new Map()
  #pendingViewing = new Set()
  #pumpTimer = null
  #startedAt = 0

  /** Every measurement the rig takes, so a run is one object. */
  metrics = {
    metadataMs: null,
    firstPeerMs: null,
    firstByteMs: null,
    firstReadMs: null,
    reads: [],
    stalls: [],
    timeline: [],
    alerts: { hashFailed: 0, peerError: 0, peerBan: 0, incoming: 0 },
    maxPeers: 0,
    /** Every inbound connection, as { at, endpoint, transport }. Empty is a real answer. */
    incoming: [],
    /** The endpoint libtorrent believes it is listening on, per socket type, from the alert. */
    listening: {},
    /** Failures, so a listener that never came up is distinguishable from one nobody dialled. */
    listenFailed: [],
  }

  #enableDht

  constructor({ storageDir, debug = false, enableDht = false }) {
    this.#storage = new NodeFSStorage(storageDir)
    this.#host = createNodeHost()
    this.#debug = debug
    // Off by default here, the opposite of production. A rig that joins the DHT
    // announces its fixture's infohash publicly and gets real peers back for it,
    // so the swarm is not the one the rig defined. Measured: with DHT on, two
    // runs of the same trace diverged completely, one reaching metadata in 906 ms
    // and the next never reaching it.
    this.#enableDht = enableDht
  }

  #debug

  get session() { return this.#session }
  get storage() { return this.#storage }
  get socketErrors() { return this.#host.stats }

  async start() {
    this.#startedAt = Date.now()
    this.#session = await createSession({
      net: this.#host.net,
      dgram: this.#host.dgram,
      storage: this.#storage,
      // worker.ts:298 - matches ripple exactly
      utpReceiveBufferBytes: 4 * 1024 * 1024,
      enableDht: this.#enableDht,
      debug: this.#debug,
    })
    // worker.ts:299 - 30 synchronous ticks before anything is added
    for (let i = 0; i < 30; i++) this.#session.tick()
    return this
  }

  /** The 500 ms pump: popAlerts then postStatus per handle, then retry pending plans. */
  startPump(handles = []) {
    const tracked = new Set(handles)
    this.trackHandle = (h) => tracked.add(h)
    this.#pumpTimer = setInterval(() => {
      const s = this.#session
      if (!s) return
      for (const a of s.popAlerts()) this.#onAlert(a)
      for (const h of tracked) s.postStatus(h)
      for (const h of [...this.#pendingViewing]) this.#applyViewing(h)
      for (const h of tracked) this.#sample(h)
    }, 500)
    return this
  }

  /**
   * Classify on the MESSAGE, never on the type.
   *
   * `type` is libtorrent's numeric alert id (see the Alert interface in src/index.ts), so the
   * regexes this used to run against `String(a.type)` were matching words against "42" and every
   * counter here was permanently zero. That is worse than having no counters: a run reports
   * hashFailed 0 whether or not a piece failed, which reads as a clean run.
   *
   * The patterns below are the real formats, from libtorrent/src/alert.cpp. Note the socket type
   * names are "TCP" and "uTP", capitalised (libtorrent/src/socket_type.cpp:47-51), so the
   * transport match is case-insensitive on purpose: a case-sensitive /\(utp\)/ would reproduce
   * exactly the silent zero this replaces.
   */
  #onAlert(a) {
    const m = String(a?.message ?? '')

    // "incoming connection from 1.2.3.4:5678 (uTP)"  (alert.cpp:1733)
    const incoming = /^incoming connection from (\S+) \(([^)]*)\)/.exec(m)
    if (incoming) {
      this.metrics.alerts.incoming++
      this.metrics.incoming.push({
        at: Date.now() - this.#startedAt,
        endpoint: incoming[1],
        transport: incoming[2].toLowerCase(),
      })
      return
    }

    // "successfully listening on [TCP] 0.0.0.0:40989"  (alert.cpp:1290); the port is the one
    // reserved on the relay before the session started, so it differs run to run

    const listening = /^successfully listening on \[([^\]]*)\] (\S+)/.exec(m)
    if (listening) {
      this.metrics.listening[listening[1].toLowerCase()] = listening[2]
      return
    }

    // "listening on <endpoint> (device: <iface>) failed: ..."  (alert.cpp:1179)
    if (/^listening on .* failed:/.test(m)) {
      this.metrics.listenFailed.push({ at: Date.now() - this.#startedAt, message: m })
      return
    }

    if (/hash for piece \d+ failed/.test(m)) this.metrics.alerts.hashFailed++
    // "<peer> banned peer" (alert.cpp:610) and "<peer>: blocked peer [ip_filter]" (alert.cpp:1437)
    else if (/banned peer|blocked peer/.test(m)) this.metrics.alerts.peerBan++
    else if (/peer error|disconnecting/.test(m)) this.metrics.alerts.peerError++
  }

  #sample(h) {
    const st = this.#session.status(h)
    if (!st) return
    const at = Date.now() - this.#startedAt
    if (this.metrics.metadataMs == null && this.#session.files(h)) this.metrics.metadataMs = at
    if (this.metrics.firstPeerMs == null && st.numPeers > 0) this.metrics.firstPeerMs = at
    if (this.metrics.firstByteMs == null && st.totalDone > 0) this.metrics.firstByteMs = at
    this.metrics.maxPeers = Math.max(this.metrics.maxPeers, st.numPeers ?? 0)
    this.metrics.timeline.push({
      at,
      peers: st.numPeers,
      downloadRate: st.downloadRate,
      totalDone: st.totalDone,
      progress: st.progress,
      state: st.state,
    })
  }

  // ---- worker.ts:149-241, verbatim ------------------------------------------

  #filePieceRange(h, fileIndex) {
    const files = this.#session?.files(h)
    const file = files?.files[fileIndex]
    if (!files || !file || file.size <= 0) return null
    const p0 = Math.floor(file.offset / files.pieceLength)
    const p1 = Math.floor((file.offset + file.size - 1) / files.pieceLength)
    return { file, pieceLength: files.pieceLength, p0, p1 }
  }

  #applyViewing(h) {
    const s = this.#session
    if (!s) return
    const watching = this.#viewers.get(h)
    if (!watching?.size) {
      this.#pendingViewing.delete(h)
      s.clearStreamWindow(h)
      return
    }
    const files = s.files(h)
    if (!files) { this.#pendingViewing.add(h); return }
    const claims = [...watching.values()].map(({ fileIndex, fromOffset }) => ({ fileIndex, offset: fromOffset }))
    const planned = s.setStreamWindow(h, claims, {
      unclaimedPriority: PRIORITY.skip,
      windowPieces: windowPiecesFor(files.pieceLength),
      deadlineStepMs: deadlineStepMsFor(files.pieceLength, s.status(h)?.downloadRate || 3_000_000),
    })
    if (planned) this.#pendingViewing.delete(h)
    else this.#pendingViewing.add(h)
  }

  watch(viewer, h, fileIndex, fromOffset) {
    let watching = this.#viewers.get(h)
    if (!watching) this.#viewers.set(h, watching = new Map())
    watching.set(viewer, { fileIndex, fromOffset })
    this.#applyViewing(h)
  }

  unwatch(viewer) {
    for (const [h, watching] of this.#viewers) {
      if (watching.delete(viewer)) this.#applyViewing(h)
    }
  }

  #anchorSequential(viewer, h, fileIndex, offset, len) {
    if (!viewer) return
    const current = this.#viewers.get(h)?.get(viewer)
    if (!current || current.fileIndex !== fileIndex) { this.watch(viewer, h, fileIndex, offset); return }
    const r = this.#filePieceRange(h, fileIndex)
    if (!r) return
    const span = { fileOffset: r.file.offset, pieceLength: r.pieceLength, p1: r.p1 }
    if (!shouldReanchor(span, current.fromOffset, offset, len)) return
    this.watch(viewer, h, fileIndex, offset)
  }

  missingPieces(h, fileIndex, offset, len) {
    const files = this.#session?.files(h)
    const file = files?.files[fileIndex]
    const bf = this.#session?.bitfield(h)
    if (!files || !file || !bf) return []
    const p0 = Math.floor((file.offset + offset) / files.pieceLength)
    const p1 = Math.floor((file.offset + Math.min(offset + len, file.size) - 1) / files.pieceLength)
    const out = []
    for (let p = p0; p <= p1; p++) if (!((bf.pieces[p >> 3] ?? 0) & (0x80 >> (p & 7)))) out.push(p)
    return out
  }

  // ---- worker.ts:436-493, the read path and its stall loop ------------------

  /**
   * One player read, including the 18-attempt stall loop, the piece reclaim and
   * the forced re-anchor between attempts.
   */
  async read(h, fileIndex, offset, len, { viewer = 'rig', prioritize = true } = {}) {
    const s = this.#session
    if (prioritize) this.#anchorSequential(viewer, h, fileIndex, offset, len)
    const t0 = Date.now()
    for (let attempt = 0; ; attempt++) {
      try {
        const data = await s.read(h, fileIndex, offset, len, { timeoutMs: READ_ATTEMPT_MS })
        const took = Date.now() - t0
        if (this.metrics.firstReadMs == null) this.metrics.firstReadMs = Date.now() - this.#startedAt
        this.metrics.reads.push({ offset, len, tookMs: took, attempts: attempt + 1 })
        return data
      } catch (err) {
        if (attempt + 1 >= READ_ATTEMPTS || !/did not arrive/.test(String(err))) throw err
        const missing = this.missingPieces(h, fileIndex, offset, len)
        const st = s.status(h)
        this.metrics.stalls.push({
          at: Date.now() - this.#startedAt,
          offset, len,
          waitedMs: (attempt + 1) * READ_ATTEMPT_MS,
          missing: missing.slice(0, 32),
          missingCount: missing.length,
          cancelled: Math.min(missing.length, CANCEL_PER_STALL),
          downloadRate: st?.downloadRate ?? null,
          numPeers: st?.numPeers ?? null,
        })
        for (const piece of missing.slice(0, CANCEL_PER_STALL)) {
          s.cancelPieceRequests(h, piece)
        }
        if (prioritize) this.watch(viewer, h, fileIndex, offset)
      }
    }
  }

  /** Block until the torrent's layout has arrived, i.e. metadata landed. */
  async waitForMetadata(h, timeoutMs = 120_000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (this.#session.files(h)) return this.#session.files(h)
      await sleep(100)
    }
    throw new Error(`metadata did not arrive in ${timeoutMs}ms`)
  }

  /**
   * Walk the file the way the player does: forward in READ_SIZE chunks, each read
   * re-anchoring through the same test ripple applies.
   */
  async playFrom(h, fileIndex, { from = 0, bytes = Infinity, viewer = 'rig' } = {}) {
    const files = this.#session.files(h)
    const size = files.files[fileIndex].size
    let offset = from
    let got = 0
    while (offset < size && got < bytes) {
      const len = Math.max(0, Math.min(READ_SIZE, size - offset))
      if (len === 0) break
      const data = await this.read(h, fileIndex, offset, len, { viewer })
      offset += data.length
      got += data.length
      if (data.length === 0) break
    }
    return got
  }

  async stop() {
    if (this.#pumpTimer) clearInterval(this.#pumpTimer)
    this.#pumpTimer = null
    try { this.#session?.destroy() } catch {}
    this.#session = null
  }

  /** Summary line for a run, matching what the ripple bench reports. */
  summary() {
    const m = this.metrics
    const readMs = m.reads.map((r) => r.tookMs).sort((a, b) => a - b)
    return {
      metadataMs: m.metadataMs,
      firstPeerMs: m.firstPeerMs,
      firstByteMs: m.firstByteMs,
      firstReadMs: m.firstReadMs,
      reads: m.reads.length,
      medianReadMs: readMs.length ? readMs[readMs.length >> 1] : null,
      maxReadMs: readMs.length ? readMs[readMs.length - 1] : null,
      stalls: m.stalls.length,
      stalledPieces: [...new Set(m.stalls.flatMap((s) => s.missing))].slice(0, 20),
      maxPeers: m.maxPeers,
      peakRate: Math.max(0, ...m.timeline.map((t) => t.downloadRate ?? 0)),
      alerts: m.alerts,
      // What the engine believes it is listening on, and who actually dialled in. `listening`
      // empty means no listen_succeeded_alert ever arrived, which is a different failure from
      // `incoming` empty, which means nobody dialled a listener that did come up.
      listening: { ...m.listening },
      listenFailed: m.listenFailed.length,
      incoming: m.incoming.length,
      incomingByTransport: m.incoming.reduce((n, c) => ({ ...n, [c.transport]: (n[c.transport] ?? 0) + 1 }), {}),
      socketErrors: { ...this.#host.stats },
    }
  }
}
