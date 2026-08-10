// A fleet of real transmission daemons seeding the fixture on loopback.
//
// Real client, not a hand-rolled peer: the baseline is only worth having if the
// peers behave like the ones in a public swarm. The misbehaving-peer case (a peer
// that claims blocks and does not deliver) needs a purpose-built peer and lives
// in bad-peer.mjs, because a healthy transmission never strands a piece.
//
// Every seeder gets its OWN 127.0.0.x. libtorrent's allow_multiple_connections_per_ip
// defaults false and peer_list dedups on address, so a fleet sharing one address
// is silently a single peer and every "does peer count matter" result would be
// measuring nothing.

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'

const TRANSMISSION = process.env.RIG_TRANSMISSION
  ?? '/nix/store/gj4h7bw0is2y3idjzlih6dr9ddxmq055-transmission-4.1.1'

const daemonBin = path.join(TRANSMISSION, 'bin', 'transmission-daemon')
const remoteBin = path.join(TRANSMISSION, 'bin', 'transmission-remote')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Every daemon this process ever spawned, so none of them outlives it.
//
// A leaked seeder is not a tidiness problem: it holds its address and rpc port,
// the next run's daemon silently loses the bind, and the run then measures a
// daemon serving a different torrent while every readiness check passes. node
// does not kill its children on exit, and `timeout` signals only node, so
// without this an interrupted or crashed run leaks the whole fleet.
const spawned = new Set()
let reaperInstalled = false
const installReaper = () => {
  if (reaperInstalled) return
  reaperInstalled = true
  const reap = () => { for (const p of spawned) { try { p.kill('SIGKILL') } catch {} } }
  process.on('exit', reap)
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => { reap(); process.exit(130) })
  }
  process.on('uncaughtException', (err) => { reap(); console.error(err); process.exit(1) })
}

// transmission 4.1 writes settings.json with snake_case keys; the 3.x hyphenated
// names are silently ignored, which reads as "the setting had no effect".
const settingsFor = ({ bindAddress, peerPort, rpcPort, downloadDir, uploadKBps, peerLimit }) => ({
  bind_address_ipv4: bindAddress,
  bind_address_ipv6: '::',
  peer_port: peerPort,
  peer_port_random_on_start: false,
  rpc_bind_address: '127.0.0.1',
  rpc_port: rpcPort,
  rpc_authentication_required: false,
  rpc_whitelist_enabled: false,
  rpc_host_whitelist_enabled: false,
  download_dir: downloadDir,
  incomplete_dir_enabled: false,
  // The swarm is exactly the peers the harness names. Any discovery mechanism
  // left on can pull a real peer into a "local" measurement.
  dht_enabled: false,
  pex_enabled: false,
  lpd_enabled: false,
  port_forwarding_enabled: false,
  blocklist_enabled: false,
  // 'tolerated' prefers plaintext, so the transport under test is the one being
  // measured rather than an encryption negotiation.
  encryption: 'tolerated',
  speed_limit_up: uploadKBps,
  speed_limit_up_enabled: uploadKBps > 0,
  speed_limit_down_enabled: false,
  ratio_limit_enabled: false,
  idle_seeding_limit_enabled: false,
  seed_queue_enabled: false,
  download_queue_enabled: false,
  peer_limit_global: peerLimit,
  peer_limit_per_torrent: peerLimit,
  message_level: 1,
  scrape_paused_torrents_enabled: false,
})

const isListening = (host, port) => new Promise((resolve) => {
  const s = net.connect({ host, port })
  const done = (v) => { s.destroy(); resolve(v) }
  s.on('connect', () => done(true))
  s.on('error', () => done(false))
  setTimeout(() => done(false), 500)
})

const waitForPort = async (host, port, timeoutMs = 20_000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const ok = await new Promise((resolve) => {
      const s = net.connect({ host, port })
      const done = (v) => { s.destroy(); resolve(v) }
      s.on('connect', () => done(true))
      s.on('error', () => done(false))
      setTimeout(() => done(false), 500)
    })
    if (ok) return true
    await sleep(100)
  }
  return false
}

const run = (bin, args) => new Promise((resolve) => {
  const p = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
  let out = '', err = ''
  p.stdout.on('data', (d) => { out += d })
  p.stderr.on('data', (d) => { err += d })
  p.on('close', (code) => resolve({ code, out, err }))
})

export class SeederFleet {
  /**
   * @param {object} o
   * @param {string} o.dir           scratch root for config dirs
   * @param {string} o.dataDir       directory holding the completed payload
   * @param {string} o.torrentFile   path to the .torrent
   * @param {number} [o.count]       how many seeders, default 8
   * @param {number} [o.uploadKBps]  per-seeder upload cap in KB/s, 0 for unlimited
   * @param {number} [o.basePeerPort]
   * @param {number} [o.baseRpcPort]
   */
  /**
   * `stagger` spreads the daemons' choke timers.
   *
   * transmission runs its rechoke on a fixed 10 s period, and a peer that arrives
   * just after a round waits for the next one. Started together, every seeder
   * shares one phase, so the whole fleet unchokes at the same instant and the
   * engine cannot receive a byte before it: measured, first byte landed at
   * 10543 ms +/- 3 ms whether the fleet was 1, 3 or 8 seeders. That floor is the
   * rig's own, it sits on top of every startup number, and it is not something a
   * real swarm has, where peers were started at unrelated times.
   *
   * Spreading the starts across one rechoke period restores the property that
   * matters: some peer is always about to unchoke. It stays deterministic
   * because the offsets are fixed, not random.
   */
  constructor({ dir, dataDir, torrentFile, count = 8, uploadKBps = 10 * 1024, basePeerPort = 51500, baseRpcPort = 9200, peerLimit = 200, stagger = true, rechokeMs = 10_000 }) {
    this.dir = dir
    this.dataDir = dataDir
    this.torrentFile = torrentFile
    this.count = count
    this.uploadKBps = uploadKBps
    this.basePeerPort = basePeerPort
    this.baseRpcPort = baseRpcPort
    this.peerLimit = peerLimit
    this.stagger = stagger
    this.rechokeMs = rechokeMs
    this.procs = []
    this.peers = []
  }

  static available() {
    return fs.existsSync(daemonBin) && fs.existsSync(remoteBin)
  }

  async start() {
    if (!SeederFleet.available()) {
      throw new Error(`transmission not found at ${TRANSMISSION}; set RIG_TRANSMISSION or run: nix build --no-link --print-out-paths 'nixpkgs#transmission_4'`)
    }

    // Refuse to start on an address something is already listening on.
    //
    // A leaked daemon from an earlier run keeps its peer port AND its rpc port,
    // so the new daemon silently fails to bind while every readiness check still
    // passes: waitForPort connects to the STALE process, the torrent add goes to
    // the stale process, and `-t 1` then reports on whatever torrent that one
    // happened to have. The engine dials the address, gets a peer serving a
    // different infohash, and the seeder reports connected=0 forever.
    //
    // That is what the 2-of-4 and 6-of-8 connection counts were: not an engine
    // behaviour at all, just two stale daemons squatting 127.0.0.2 and 127.0.0.3.
    // Failing loudly here is the only thing that separates the two readings.
    const occupied = []
    for (let i = 0; i < this.count; i++) {
      const peerPort = this.basePeerPort + i
      const rpcPort = this.baseRpcPort + i
      const bindAddress = `127.0.0.${i + 2}`
      if (await isListening(bindAddress, peerPort)) occupied.push(`${bindAddress}:${peerPort} (peer)`)
      if (await isListening('127.0.0.1', rpcPort)) occupied.push(`127.0.0.1:${rpcPort} (rpc)`)
    }
    if (occupied.length) {
      throw new Error(
        `rig ports already in use: ${occupied.join(', ')}\n`
        + 'A leaked seeder from an earlier run makes every measurement describe the wrong torrent. Clear it with:\n'
        + '  pkill -f "transmission-daem[o]n"\n'
        + '(the character class is deliberate: a plain pattern matches the pkill command itself)',
      )
    }

    for (let i = 0; i < this.count; i++) {
      // 127.0.0.1 is skipped so the fleet never collides with anything else the
      // machine has bound to loopback proper.
      const bindAddress = `127.0.0.${i + 2}`
      const peerPort = this.basePeerPort + i
      const rpcPort = this.baseRpcPort + i
      const configDir = path.join(this.dir, `seeder-${i}`)
      fs.mkdirSync(configDir, { recursive: true })
      fs.writeFileSync(
        path.join(configDir, 'settings.json'),
        JSON.stringify(settingsFor({
          bindAddress, peerPort, rpcPort,
          downloadDir: this.dataDir,
          uploadKBps: this.uploadKBps,
          peerLimit: this.peerLimit,
        }), null, 2),
      )

      const logFile = path.join(configDir, 'daemon.log')
      const proc = spawn(daemonBin, [
        '-f', '-g', configDir,
        '-i', bindAddress,
        '-P', String(peerPort),
        '-p', String(rpcPort),
        '-w', this.dataDir,
        '-T', '-O', '-Y', '-M', '-B',
        '--log-level', 'error',
        '-e', logFile,
      ], { stdio: ['ignore', 'ignore', 'pipe'] })
      installReaper()
      spawned.add(proc)
      proc.on('close', () => spawned.delete(proc))
      proc.stderr.on('data', (d) => {
        const s = String(d).trim()
        if (s) console.error(`[seeder ${i}] ${s}`)
      })
      this.procs.push({ proc, rpcPort, configDir, logFile })
      this.peers.push({ host: bindAddress, port: peerPort })
    }

    for (const s of this.procs) {
      if (!await waitForPort('127.0.0.1', s.rpcPort)) {
        throw new Error(`seeder rpc ${s.rpcPort} never came up; see ${s.logFile}`)
      }
    }

    // -w on the add is what makes transmission look for the payload where it
    // already is, verify it, and go straight to seeding instead of downloading.
    //
    // The adds are spread, not the daemon starts. transmission's rechoke runs on
    // a fixed period anchored at the TORRENT ADD, so adding to the whole fleet in
    // a tight loop phase-locks every seeder: the engine then cannot receive a byte
    // until the one shared round comes up. Measured with the adds in a tight loop,
    // first byte landed at 10512-10522 ms across five trials, and staggering the
    // daemon SPAWNS instead did not move it at all.
    for (let i = 0; i < this.procs.length; i++) {
      const s = this.procs[i]
      const r = await run(remoteBin, [`127.0.0.1:${s.rpcPort}`, '-w', this.dataDir, '-a', this.torrentFile])
      if (r.code !== 0) throw new Error(`add failed on rpc ${s.rpcPort}: ${r.err || r.out}`)
      if (this.stagger && i < this.procs.length - 1) await sleep(Math.round(this.rechokeMs / this.count))
    }

    return this.peers
  }

  /** Wait until every seeder reports the torrent as complete and seeding. */
  async waitSeeding(timeoutMs = 120_000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const states = await Promise.all(this.procs.map(async (s) => {
        const r = await run(remoteBin, [`127.0.0.1:${s.rpcPort}`, '-t', '1', '-i'])
        const pct = /Percent Done:\s*([\d.]+)%/.exec(r.out)?.[1]
        const state = /State:\s*(.+)/.exec(r.out)?.[1]?.trim()
        return { pct: pct ? Number(pct) : 0, state }
      }))
      // A complete torrent with nobody connected reports "Idle", never "Seeding",
      // so waiting for the word "seed" waits forever on a fleet that is ready.
      // Complete and not still checking is the real condition.
      if (states.every((s) => s.pct >= 100 && !/verif|check|download/i.test(s.state ?? ''))) return states
      await sleep(500)
    }
    throw new Error('seeders did not reach seeding state in time')
  }

  /** Per-seeder upload totals, for confirming the swarm actually served the data. */
  async uploaded() {
    return Promise.all(this.procs.map(async (s, i) => {
      const r = await run(remoteBin, [`127.0.0.1:${s.rpcPort}`, '-t', '1', '-i'])
      return { seeder: i, uploaded: /Uploaded:\s*(.+)/.exec(r.out)?.[1]?.trim() ?? '?' }
    }))
  }

  async stop() {
    for (const { proc } of this.procs) {
      try { proc.kill('SIGTERM') } catch {}
    }
    await Promise.all(this.procs.map(({ proc }) => new Promise((resolve) => {
      if (proc.exitCode !== null || proc.signalCode) return resolve()
      const t = setTimeout(() => { try { proc.kill('SIGKILL') } catch {}; resolve() }, 5_000)
      proc.on('close', () => { clearTimeout(t); resolve() })
    })))
    this.procs = []
  }
}
