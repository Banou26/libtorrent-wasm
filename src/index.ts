import type { LtModuleFactory, LtModule, FknHost, StorageBackend } from './types'

export interface SessionOptions {
  /** @fkn/lib's net module (@fkn/lib/net) */
  net: any
  /** @fkn/lib's dgram module (@fkn/lib/dgram) */
  dgram: any
  /** Disk backend - defaults to a no-op (download but discard). Streaming
   *  `read()` requires a backend that can read back (e.g. OPFSStorage). */
  storage?: StorageBackend
  /** Override the WASM module factory (testing) */
  moduleFactory?: LtModuleFactory
  // defaults to 250 ms; the fallback that fires libtorrent's internal timers (DHT bucket refresh, tracker announces) when no socket or disk activity is pumping ticks
  /** Fallback tick interval in ms - used when nothing else pumps */
  tickIntervalMs?: number
  // defaults to 1 MiB (the patched lt::aux::utp_receive_buffer_capacity)
  /** Per-socket uTP receive buffer capacity in bytes - defaults to 1 MiB */
  utpReceiveBufferBytes?: number
  /** Print the transport and tick traces. Off by default: on an ordinary download they
   *  run to several hundred console lines a minute, which is useful while working on the
   *  transport and noise everywhere else. */
  debug?: boolean
}

// torrent_status state_t (TORRENT_ABI_VERSION 3). Only these values occur.
export const TORRENT_STATE = {
  checkingFiles: 1,
  downloadingMetadata: 2,
  downloading: 3,
  finished: 4,
  seeding: 5,
  checkingResumeData: 7,
} as const

export interface TorrentStatus {
  state: number
  // units: progress is 0..1, totalDone is bytes we have, totalWanted is bytes of wanted pieces, download/uploadRate are payload bytes/s
  progress: number
  totalDone: number
  totalWanted: number
  downloadRate: number
  uploadRate: number
  numPeers: number
  numSeeds: number
  numPiecesTotal: number
  numPiecesHave: number
  hasMetadata: boolean
  paused: boolean
  /**
   * Still in libtorrent's own rotation. It stops whatever sits past active_downloads /
   * active_seeds and starts it again once a slot frees, so a paused torrent that is still
   * auto-managed and has no error is queued, not broken. The flag survives an error, so
   * read it together with `errorCode` rather than on its own.
   */
  autoManaged: boolean
  /** Whether libtorrent's sequential_download flag is currently set on this torrent. */
  sequential: boolean
  // -1 for a seeding or finished torrent
  /** Position in the download queue, or -1 for a seeding or finished torrent. */
  queuePosition: number
  /** libtorrent's error_code value for this torrent, 0 when it has no error. */
  errorCode: number
  /** The matching message, empty when there is no error. */
  error: string
}

export interface FileEntry {
  path: string
  size: number
  // absolute byte offset of this file within the concatenated torrent payload, not an offset inside the file
  /** absolute byte offset of this file within the concatenated torrent payload */
  offset: number
}

export interface TorrentFiles {
  storageIndex: number
  pieceLength: number
  numPieces: number
  totalSize: number
  files: FileEntry[]
}

// MSB-first packed have-set: piece p is set iff (pieces[p>>3] & (0x80 >> (p&7)))
export interface PieceBitfield {
  /** MSB-first packed have-set: piece p is set iff (pieces[p>>3] & (0x80 >> (p&7))) */
  pieces: Uint8Array
  numPieces: number
  pieceLength: number
  /** total torrent payload size, for byte↔piece mapping */
  length: number
}

export interface Alert {
  type: number
  message: string
}

const utf8 = new TextDecoder()

// Binary record ids the wrapper appends to the alert stream (see wrapper.cpp).
const REC_TORRENT_READY = 0xf0000001
const REC_STATE_UPDATE = 0xf0000002
const REC_READ_PIECE = 0xf0000003
const REC_RESUME_DATA = 0xf0000004

/** libtorrent download priorities. Anything above 7 truncates into a 3-bit field, and 8 would
 *  land as 0, i.e. never download, so stay on these values. */
export const PRIORITY = {
  /** never download this piece */
  skip: 0,
  /** below default: picked only once nothing else is available */
  low: 1,
  /** the default every piece starts at */
  normal: 4,
  /** top priority. Note this expresses no ORDER, see setStreamWindow. */
  top: 7,
} as const

/** One reader's position in the torrent: which file it is playing, and the byte offset it is at. */
export interface StreamClaim {
  fileIndex: number
  /** byte offset within the file that playback has reached */
  offset: number
}

export interface StreamWindowOptions {
  /**
   * How many pieces at the head of each claim are promoted to top priority and given a deadline.
   * Default 12. Keep it small: a wide top-priority band is skipped by libtorrent's in-order
   * cursor and served from a shuffled, availability-ordered list instead.
   */
  windowPieces?: number
  /**
   * Milliseconds between consecutive deadlines across the window. Default 1000, which is a
   * placeholder: the honest value is `pieceLength / playbackBytesPerSecond * 1000`, and only the
   * caller knows the bitrate. For small pieces the default authorizes falling behind real time.
   */
  deadlineStepMs?: number
  /** Priority for the rest of a claimed file. Default 4 (normal). Note that under sequential mode
   *  only 0 and "not 0" really change picking, so 1 and 4 behave the same here. */
  claimedPriority?: number
  /**
   * Priority for pieces in no claimed file. Default 4 (normal); 0 skips them entirely.
   * On a multi-file torrent 0 is usually what you want: sequential mode's cursor sits at the first
   * piece the torrent does not have, so with everything at 4 the spare capacity beyond the window
   * goes to the FIRST file in the torrent rather than the one being watched. Skipping is what moves
   * the cursor. It also shrinks totalWanted, so progress and the finished state then describe the
   * selection rather than the whole torrent.
   */
  unclaimedPriority?: number
  /** Also set the torrent's sequential_download flag. Default true. */
  sequential?: boolean
}

export interface ReadOptions {
  /** Reject if the covering pieces have not arrived in this many ms. Default 60000; 0 waits forever. */
  timeoutMs?: number
  /** Abort the wait early. The deadlines this read placed are retired with it. */
  signal?: AbortSignal
  /**
   * Deadline in ms handed to libtorrent for the covering pieces, default 0 (most urgent).
   * Pass null to leave deadlines untouched, for a caller that manages its own ladder through
   * setStreamWindow and does not want a scattered read reordering it.
   */
  deadlineMs?: number | null
}

const DEFAULT_READ_TIMEOUT_MS = 60_000
const DEFAULT_WINDOW_PIECES = 12
const DEFAULT_DEADLINE_STEP_MS = 1000

type PieceWaiter = { handle: number, p0: number, p1: number, settle: (err?: Error) => void }
type ResumeWaiter = { handle: number, resolve: (data: Uint8Array) => void }

export class Session {
  private mod: LtModule
  private storage: StorageBackend | null
  private destroyed = false
  private fallbackTimer?: number

  private filesByHandle = new Map<number, TorrentFiles>()
  private bitfieldByHandle = new Map<number, { pieces: Uint8Array, numPieces: number }>()
  private statusByHandle = new Map<number, TorrentStatus>()
  private pieceWaiters: PieceWaiter[] = []
  private resumeByHandle = new Map<number, Uint8Array>()
  private resumeWaiters: ResumeWaiter[] = []
  private priosByHandle = new Map<number, Uint8Array>()
  // handle -> piece -> how many in-flight read()s deadlined it, so an abandoned read only retires
  // the deadlines nothing else is still waiting on
  private deadlineRefs = new Map<number, Map<number, number>>()

  constructor(mod: LtModule, options: SessionOptions) {
    this.mod = mod
    this.storage = options.storage ?? null
    if (options.utpReceiveBufferBytes) mod._lt_set_utp_receive_buffer(options.utpReceiveBufferBytes)
    if (mod._lt_session_create() !== 0) {
      throw new Error('lt_session_create returned non-zero')
    }
    const tickMs = options.tickIntervalMs ?? 250
    this.fallbackTimer = setInterval(() => this.tick(), tickMs) as unknown as number
  }

  addMagnet(magnet: string, savePath: string = '/downloads'): number {
    const m = this.mod
    const magnetPtr = m.stringToNewUTF8(magnet)
    const pathPtr = m.stringToNewUTF8(savePath)
    try {
      return m._lt_session_add_magnet(magnetPtr, pathPtr) >>> 0
    } finally {
      m._free(magnetPtr); m._free(pathPtr)
    }
  }

  addTorrentFile(buffer: Uint8Array, savePath: string = '/downloads'): number {
    const m = this.mod
    const ptr = m._malloc(buffer.length)
    m.HEAPU8.set(buffer, ptr)
    const pathPtr = m.stringToNewUTF8(savePath)
    try {
      return m._lt_session_add_torrent_file(ptr, buffer.length, pathPtr) >>> 0
    } finally {
      m._free(ptr); m._free(pathPtr)
    }
  }

  addTorrentWithResume(resume: Uint8Array, savePath: string = '/downloads'): number {
    const m = this.mod
    const ptr = m._malloc(resume.length)
    m.HEAPU8.set(resume, ptr)
    const pathPtr = m.stringToNewUTF8(savePath)
    try {
      return m._lt_session_add_torrent_with_resume(ptr, resume.length, pathPtr) >>> 0
    } finally {
      m._free(ptr); m._free(pathPtr)
    }
  }

  removeTorrent(handle: number, deleteFiles = false) {
    this.mod._lt_session_remove_torrent_ex(handle, deleteFiles ? 1 : 0)
    // before the bitfield goes, or a parked read can never be satisfied and never rejected either
    this.failPieceWaiters(new Error(`read: torrent ${handle} was removed`), handle)
    this.filesByHandle.delete(handle)
    this.bitfieldByHandle.delete(handle)
    this.statusByHandle.delete(handle)
    this.resumeByHandle.delete(handle)
    this.priosByHandle.delete(handle)
    this.deadlineRefs.delete(handle)
  }

  pauseTorrent(handle: number) { this.mod._lt_torrent_pause(handle) }
  resumeTorrent(handle: number) { this.mod._lt_torrent_resume(handle) }

  // The torrent forgets what it has first, so any saved resume blob for it is stale.
  /**
   * Re-verify every piece against the bytes on disk, for when the files and the recorded
   * have-set have drifted apart. The torrent forgets what it has first, so any saved
   * resume blob for it is stale from this point and should be discarded. It reports
   * through the usual status updates, with `state` at checkingResumeData then
   * checkingFiles and `progress` tracking the check rather than the download. A paused or
   * errored torrent cannot be scheduled for a check, so this clears both.
   */
  forceRecheck(handle: number) { this.mod._lt_torrent_force_recheck(handle) }

  saveResumeData(handle: number, timeoutMs = 8000): Promise<Uint8Array> {
    this.mod._lt_torrent_save_resume_data(handle)
    return new Promise<Uint8Array>((resolve, reject) => {
      const waiter: ResumeWaiter = { handle, resolve }
      this.resumeWaiters.push(waiter)
      setTimeout(() => {
        const i = this.resumeWaiters.indexOf(waiter)
        if (i >= 0) { this.resumeWaiters.splice(i, 1); reject(new Error('save_resume_data timed out')) }
      }, timeoutMs)
    })
  }

  /** The torrent's file layout (path/size/absolute offset) + piece geometry.
   *  null until metadata + storage are ready (the torrent-ready record). */
  files(handle: number): TorrentFiles | null {
    return this.filesByHandle.get(handle) ?? null
  }

  /** The have-set bitfield + geometry, for rendering downloaded ranges. */
  bitfield(handle: number): PieceBitfield | null {
    const bf = this.bitfieldByHandle.get(handle)
    const layout = this.filesByHandle.get(handle)
    if (!bf || !layout) return null
    return { pieces: bf.pieces, numPieces: bf.numPieces, pieceLength: layout.pieceLength, length: layout.totalSize }
  }

  /** Latest status (peers/speeds/progress/state). null until first state update. */
  status(handle: number): TorrentStatus | null {
    return this.statusByHandle.get(handle) ?? null
  }

  /**
   * Read a byte range of a file. Deadlines the covering pieces (which also raises them to top
   * priority), awaits them landing, then reads the exact range from the storage backend that the
   * disk write path already filled. Requires a readable storage backend (e.g. OPFSStorage).
   *
   * `len` is clamped to the end of the file, so the returned array can be shorter than asked for
   * and is empty for an offset at or past EOF. It rejects on timeout (60 s by default) rather than
   * waiting forever, and retires its own deadlines when it does.
   *
   * The wait only completes while `popAlerts()` (or `alerts()`) is being pumped: that is where a
   * state update lands and the have-bits are read. `tick()` asks for the status updates itself.
   *
   * Placing a deadline also raises the piece to top priority and un-filters it, so reading into a
   * file you set to priority 0 starts downloading that range. Pass `deadlineMs: null` to read
   * without touching priorities or deadlines at all.
   */
  async read(handle: number, fileIndex: number, offset: number, len: number, opts: ReadOptions = {}): Promise<Uint8Array> {
    const layout = this.filesByHandle.get(handle)
    if (!layout) throw new Error(`read: no layout for handle ${handle} (metadata not ready)`)
    const file = layout.files[fileIndex]
    if (!file) throw new Error(`read: no file ${fileIndex}`)
    if (!this.storage) throw new Error('read: no storage backend configured')
    if (offset < 0) throw new RangeError(`read: negative offset ${offset}`)
    // a range past EOF would otherwise park on pieces that do not exist, while the backend
    // zero-fills the shortfall rather than reporting it
    const want = Math.min(len, file.size - offset)
    if (want <= 0) return new Uint8Array(0)

    const { pieceLength } = layout
    const absStart = file.offset + offset
    const p0 = Math.floor(absStart / pieceLength)
    const p1 = Math.min(layout.numPieces - 1, Math.floor((absStart + want - 1) / pieceLength))

    if (!this.hasPieces(handle, p0, p1)) {
      const deadlineMs = opts.deadlineMs === undefined ? 0 : opts.deadlineMs
      if (deadlineMs !== null) {
        for (let p = p0; p <= p1; p++) this.mod._lt_torrent_set_piece_deadline(handle, p, deadlineMs, 0)
        this.retainDeadlines(handle, p0, p1)
      }
      this.mod._lt_torrent_post_status(handle)
      try {
        await this.awaitPieces(handle, p0, p1, opts)
      } finally {
        // An expired deadline sorts ahead of every later one and nothing but the piece arriving
        // removes it, so an abandoned range would outrank every range asked for after it.
        if (deadlineMs !== null) this.releaseDeadlines(handle, p0, p1)
      }
    }
    // have-bit set ⇒ the piece passed hash AND its disk write completed (no read-before-write race)
    const data = await this.storage.read(layout.storageIndex, fileIndex, offset, want)
    return data instanceof Uint8Array ? data : new Uint8Array(data)
  }

  /**
   * Point the torrent at what is being played: for each reader, the file and the byte offset it has
   * reached. This is the call a streaming player wants; the primitives below are the pieces of it.
   *
   * Priority does NOT express order in libtorrent. A band of top-priority pieces is shuffled within
   * each availability bucket, and the sequential picker's in-order walk skips top-priority pieces
   * on the assumption the priority pass already took them, so painting a whole file 7 removes it
   * from the only in-order path there is. Order comes from the staggered deadlines this sets over a
   * small window, while the rest of the file stays at normal priority so the sequential cursor
   * walks it in index order.
   *
   * Call it again on every seek and as playback advances. It is not free: each call empties the
   * time-critical set, so the next deadline re-posts a cancel of every outstanding non-critical
   * block request, and it copies a full piece-count vector across the boundary. Call it on a real
   * position change, not on every read. Returns false if no claim could be resolved yet.
   */
  setStreamWindow(handle: number, claims: StreamClaim[], opts: StreamWindowOptions = {}): boolean {
    const layout = this.filesByHandle.get(handle)
    if (!layout) return false
    const { pieceLength, numPieces } = layout
    const windowPieces = Math.max(1, Math.floor(opts.windowPieces ?? DEFAULT_WINDOW_PIECES))
    const stepMs = Math.max(0, Math.floor(opts.deadlineStepMs ?? DEFAULT_DEADLINE_STEP_MS))
    const claimedPriority = opts.claimedPriority ?? PRIORITY.normal
    const unclaimedPriority = opts.unclaimedPriority ?? PRIORITY.normal

    const prios = new Uint8Array(numPieces).fill(unclaimedPriority)
    // piece -> deadline, keeping the most urgent where two readers overlap
    const ladder = new Map<number, number>()

    let resolved = 0
    for (const claim of claims) {
      const file = layout.files[claim.fileIndex]
      if (!file || file.size <= 0) continue
      resolved++
      const p0 = Math.floor(file.offset / pieceLength)
      const p1 = Math.min(numPieces - 1, Math.floor((file.offset + file.size - 1) / pieceLength))
      // written after the unclaimed fill so a piece straddling a file boundary keeps the claimed
      // value: skipping it would refuse bytes this file needs
      for (let p = p0; p <= p1; p++) prios[p] = claimedPriority
      const at = Math.min(Math.max(claim.offset, 0), Math.max(0, file.size - 1))
      const head = Math.min(Math.max(Math.floor((file.offset + at) / pieceLength), p0), p1)
      for (let k = 0; k < windowPieces; k++) {
        const p = head + k
        if (p > p1) break
        prios[p] = PRIORITY.top
        const ms = k * stepMs
        const prev = ladder.get(p)
        if (prev === undefined || ms < prev) ladder.set(p, ms)
      }
    }

    // No claim resolved, so there is no plan to write. Changing nothing beats writing a map that
    // says "want none of it", which with unclaimedPriority skip would stop the torrent outright.
    if (!resolved) return false

    // Order is load-bearing. Clearing demotes every cleared piece to priority 1 rather than back to
    // the default, so the map has to be written after the clear and the ladder after the map.
    this.mod._lt_torrent_clear_piece_deadlines(handle)
    this.prioritizePieces(handle, prios)
    for (const [piece, ms] of ladder) this.mod._lt_torrent_set_piece_deadline(handle, piece, ms, 0)
    // the clear above took the in-flight reads' deadlines with it
    this.reissueReadDeadlines(handle)
    if (opts.sequential !== false) this.setSequential(handle, true)
    return true
  }

  /** Drop the streaming window: no deadlines, every piece back to normal, sequential off. */
  clearStreamWindow(handle: number) {
    this.mod._lt_torrent_clear_piece_deadlines(handle)
    const layout = this.filesByHandle.get(handle)
    // not optional: clearing deadlines leaves those pieces at priority 1, below default
    if (layout) this.prioritizePieces(handle, new Uint8Array(layout.numPieces).fill(PRIORITY.normal))
    this.reissueReadDeadlines(handle)
    this.setSequential(handle, false)
  }

  /**
   * Top-priority + deadline the pieces covering one byte range, everything else back to normal.
   * This REPLACES any active stream window: it clears every deadline and rewrites the whole map.
   * To pull in a container header or a trailing index alongside playback, use read(), which only
   * adds deadlines. For playback itself use setStreamWindow.
   */
  prioritizeRange(handle: number, fileIndex: number, offset: number, len: number) {
    const layout = this.filesByHandle.get(handle)
    const file = layout?.files[fileIndex]
    if (!layout || !file) return
    const { pieceLength, numPieces } = layout
    const want = Math.min(len, file.size - offset)
    if (want <= 0) return
    const p0 = Math.max(0, Math.floor((file.offset + offset) / pieceLength))
    const p1 = Math.min(numPieces - 1, Math.floor((file.offset + offset + want - 1) / pieceLength))
    if (p1 < p0) return
    // full length, so a range earlier than the last one demotes what it replaced; a short vector
    // leaves everything past its end untouched at whatever the previous call set
    const prios = new Uint8Array(numPieces).fill(PRIORITY.normal)
    for (let p = p0; p <= p1; p++) prios[p] = PRIORITY.top
    this.mod._lt_torrent_clear_piece_deadlines(handle)
    this.prioritizePieces(handle, prios)
    for (let p = p0; p <= p1; p++) this.mod._lt_torrent_set_piece_deadline(handle, p, (p - p0) * DEFAULT_DEADLINE_STEP_MS, 0)
    this.reissueReadDeadlines(handle)
  }

  setSequential(handle: number, on: boolean) {
    this.mod._lt_torrent_set_sequential(handle, on ? 1 : 0)
  }

  setPieceDeadline(handle: number, piece: number, deadlineMs: number, alertWhenAvailable = false) {
    this.mod._lt_torrent_set_piece_deadline(handle, piece, deadlineMs, alertWhenAvailable ? 1 : 0)
  }

  /** Drops EVERY deadline on the torrent and leaves those pieces at priority 1, not the default 4.
   *  Re-apply priorities after calling this, never before. Deadlines held by an in-flight read()
   *  are re-placed, since that read is still waiting on them. */
  clearPieceDeadlines(handle: number) {
    this.mod._lt_torrent_clear_piece_deadlines(handle)
    this.reissueReadDeadlines(handle)
  }

  /** Retire one piece from the time-critical set, leaving the rest of the window alone. Like a
   *  clear, this also drops that piece to priority 1, so re-apply its priority afterwards. */
  resetPieceDeadline(handle: number, piece: number) {
    this.mod._lt_torrent_reset_piece_deadline(handle, piece)
  }

  /**
   * Positional priority map, one byte per piece from piece 0 (0=skip, 1=low, 4=default, 7=top).
   * A short array is padded out to the torrent's piece count from what this Session last wrote
   * (or the default 4), and a long one is truncated, so libtorrent always gets exactly one byte per
   * piece: it indexes this array by absolute piece number on its deadline bookkeeping path and
   * would read past a short one. No-op before the file layout is known.
   */
  prioritizePieces(handle: number, prios: Uint8Array) {
    const m = this.mod
    const layout = this.filesByHandle.get(handle)
    if (!layout || !layout.numPieces) return
    let view = prios
    if (view.length !== layout.numPieces) {
      const full = new Uint8Array(layout.numPieces)
      const planned = this.priosByHandle.get(handle)
      if (planned) full.set(planned.subarray(0, layout.numPieces))
      else full.fill(PRIORITY.normal)
      full.set(view.subarray(0, layout.numPieces))
      view = full
    }
    const ptr = m._malloc(view.length)
    m.HEAPU8.set(view, ptr)
    try {
      if (m._lt_torrent_prioritize_pieces(handle, ptr, view.length) === 0) {
        this.priosByHandle.set(handle, Uint8Array.from(view, v => Math.min(v, PRIORITY.top)))
      }
    } finally { m._free(ptr) }
  }

  /**
   * Sparse priority update: only the listed pieces change, every other piece keeps what it has.
   * Cheaper than rewriting the whole map, so this is the call for nudging a window rather than
   * replanning. Out-of-range indices are dropped. No-op before the file layout is known.
   */
  prioritizePieceList(handle: number, entries: Iterable<{ piece: number, priority: number }>) {
    const m = this.mod
    const layout = this.filesByHandle.get(handle)
    if (!layout) return
    const list = [...entries].filter(e => e.piece >= 0 && e.piece < layout.numPieces)
    if (!list.length) return
    const piecesPtr = m._malloc(list.length * 4)
    const priosPtr = m._malloc(list.length)
    try {
      const cached = this.priosByHandle.get(handle)
      for (let i = 0; i < list.length; i++) {
        const { piece, priority } = list[i]!
        const clamped = Math.min(Math.max(priority, 0), PRIORITY.top)
        m.HEAP32[(piecesPtr >> 2) + i] = piece
        m.HEAPU8[priosPtr + i] = clamped
        if (cached && piece < cached.length) cached[piece] = clamped
      }
      m._lt_torrent_prioritize_piece_list(handle, piecesPtr, priosPtr, list.length)
    } finally { m._free(piecesPtr); m._free(priosPtr) }
  }

  /**
   * Per-file priorities, one byte per file, same 0..7 encoding. This is how you skip the other
   * episodes in a pack. Send one byte for every file: libtorrent pads a short array with the
   * default 4, silently re-enabling the files you left off the end.
   *
   * Setting file priorities rewrites every piece priority to match, so any streaming window has to
   * be re-applied afterwards.
   */
  setFilePriorities(handle: number, prios: Uint8Array) {
    const m = this.mod
    if (!prios.length) return
    const ptr = m._malloc(prios.length)
    m.HEAPU8.set(prios, ptr)
    try { m._lt_torrent_prioritize_files(handle, ptr, prios.length) }
    finally { m._free(ptr) }
    this.priosByHandle.delete(handle)
  }

  /** One file's priority, leaving the others alone. Also rewrites that file's piece priorities.
   *  Works before metadata arrives; returns false if the index is out of range. */
  setFilePriority(handle: number, fileIndex: number, priority: number): boolean {
    const ok = this.mod._lt_torrent_set_file_priority(handle, fileIndex, priority) === 0
    if (ok) this.priosByHandle.delete(handle)
    return ok
  }

  /** The piece priorities as last written through this Session, or null if none were, or if a
   *  file-priority call has since rewritten them out from under us. Reading them back out of
   *  libtorrent is not possible here: its getter is a synchronous call on an io_context that only
   *  runs while JS ticks, so it would deadlock. */
  piecePriorities(handle: number): Uint8Array | null {
    const p = this.priosByHandle.get(handle)
    return p ? Uint8Array.from(p) : null
  }

  private retainDeadlines(handle: number, p0: number, p1: number) {
    let refs = this.deadlineRefs.get(handle)
    if (!refs) this.deadlineRefs.set(handle, refs = new Map())
    for (let p = p0; p <= p1; p++) refs.set(p, (refs.get(p) ?? 0) + 1)
  }

  private releaseDeadlines(handle: number, p0: number, p1: number) {
    const refs = this.deadlineRefs.get(handle)
    if (!refs) return
    const restore: { piece: number, priority: number }[] = []
    const planned = this.priosByHandle.get(handle)
    for (let p = p0; p <= p1; p++) {
      const n = (refs.get(p) ?? 0) - 1
      if (n > 0) { refs.set(p, n); continue }
      refs.delete(p)
      // only once no other in-flight read still wants it
      this.mod._lt_torrent_reset_piece_deadline(handle, p)
      // retiring a deadline drops the piece to priority 1, the same demotion a clear does, so put
      // back whatever the plan wanted it at or an abandoned read quietly deprioritizes its range
      restore.push({ piece: p, priority: planned?.[p] ?? PRIORITY.normal })
    }
    if (restore.length) this.prioritizePieceList(handle, restore)
    if (!refs.size) this.deadlineRefs.delete(handle)
  }

  // a clear takes every deadline, including the ones reads that are still parked depend on
  private reissueReadDeadlines(handle: number) {
    const refs = this.deadlineRefs.get(handle)
    if (!refs) return
    for (const piece of refs.keys()) this.mod._lt_torrent_set_piece_deadline(handle, piece, 0, 0)
  }

  /** Ask the engine to post a fresh status update (→ state_update record). */
  postStatus(handle: number) {
    this.mod._lt_torrent_post_status(handle)
  }

  infohash(handle: number): string | null {
    const m = this.mod
    const ptr = m._malloc(41)
    try {
      if (m._lt_torrent_infohash(handle, ptr) !== 0) return null
      return m.UTF8ToString(ptr)
    } finally {
      m._free(ptr)
    }
  }

  private hasPieces(handle: number, p0: number, p1: number): boolean {
    const bf = this.bitfieldByHandle.get(handle)
    if (!bf) return false
    for (let p = p0; p <= p1; p++) {
      if (p < 0 || p >= bf.numPieces) return false
      const byte = bf.pieces[p >> 3]
      if (byte === undefined || (byte & (0x80 >> (p & 7))) === 0) return false
    }
    return true
  }

  private awaitPieces(handle: number, p0: number, p1: number, opts: ReadOptions): Promise<void> {
    const { signal } = opts
    const timeoutMs = opts.timeoutMs ?? DEFAULT_READ_TIMEOUT_MS
    return new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      let onAbort: (() => void) | undefined
      const settle = (err?: Error) => {
        const i = this.pieceWaiters.indexOf(waiter)
        if (i < 0) return
        this.pieceWaiters.splice(i, 1)
        if (timer !== undefined) clearTimeout(timer)
        if (onAbort && signal) signal.removeEventListener('abort', onAbort)
        if (err) reject(err)
        else resolve()
      }
      const waiter: PieceWaiter = { handle, p0, p1, settle }
      this.pieceWaiters.push(waiter)
      if (signal?.aborted) { settle(new Error('read: aborted')); return }
      if (timeoutMs > 0) {
        timer = setTimeout(
          () => settle(new Error(`read: pieces ${p0}-${p1} of handle ${handle} did not arrive within ${timeoutMs}ms`)),
          timeoutMs,
        )
      }
      if (signal) {
        onAbort = () => settle(new Error('read: aborted'))
        signal.addEventListener('abort', onAbort, { once: true })
      }
    })
  }

  private resolvePieceWaiters() {
    if (this.pieceWaiters.length === 0) return
    // settle() splices itself out, so iterate a copy
    for (const w of [...this.pieceWaiters]) {
      if (this.hasPieces(w.handle, w.p0, w.p1)) w.settle()
    }
  }

  private failPieceWaiters(err: Error, handle?: number) {
    for (const w of [...this.pieceWaiters]) {
      if (handle === undefined || w.handle === handle) w.settle(err)
    }
  }

  // Eager - NOT a generator - so the cache updates always run even if the caller ignores the returned text alerts.
  popAlerts(): Alert[] {
    const m = this.mod
    m._lt_session_pump_alerts()
    const size = m._lt_alerts_size() >>> 0
    if (!size) return []
    const start = m._lt_alerts_data() >>> 0
    const view = new DataView(m.HEAPU8.buffer, start, size)
    const out: Alert[] = []
    let off = 0
    try {
      while (off + 8 <= size) {
        const type = view.getUint32(off, true); off += 4
        const len = view.getUint32(off, true); off += 4
        if (off + len > size) break
        if (type === REC_TORRENT_READY) this.decodeTorrentReady(view, off)
        else if (type === REC_STATE_UPDATE) this.decodeStateUpdate(view, off)
        else if (type === REC_RESUME_DATA) this.decodeResumeData(view, off, len)
        else if (type === REC_READ_PIECE) { /* fallback path - no MVP consumer */ }
        else out.push({ type, message: m.UTF8ToString(start + off, len) })
        off += len
      }
    } finally {
      // a throw mid-decode must still drain: leaving the buffer full makes every later pump
      // re-throw on the same record, and nothing would ever resolve again
      m._lt_alerts_clear()
      this.resolvePieceWaiters()
    }
    return out
  }

  private decodeResumeData(view: DataView, off: number, len: number) {
    const handle = view.getUint32(off, true)
    const data = new Uint8Array(len - 4)
    data.set(new Uint8Array(view.buffer, view.byteOffset + off + 4, len - 4))
    this.resumeByHandle.set(handle, data)
    this.resumeWaiters = this.resumeWaiters.filter(w => {
      if (w.handle !== handle) return true
      w.resolve(data); return false
    })
  }

  private decodeTorrentReady(view: DataView, off: number) {
    const dec = new TextDecoder()
    const handle = view.getUint32(off, true); off += 4
    const storageIndex = view.getUint32(off, true); off += 4
    const pieceLength = view.getUint32(off, true); off += 4
    const numPieces = view.getUint32(off, true); off += 4
    const totalSize = Number(view.getBigInt64(off, true)); off += 8
    const numFiles = view.getUint32(off, true); off += 4
    const files: FileEntry[] = []
    for (let i = 0; i < numFiles; i++) {
      const offset = Number(view.getBigInt64(off, true)); off += 8
      const size = Number(view.getBigInt64(off, true)); off += 8
      const pathLen = view.getUint32(off, true); off += 4
      const path = dec.decode(new Uint8Array(view.buffer, view.byteOffset + off, pathLen)); off += pathLen
      files.push({ path, size, offset })
    }
    this.filesByHandle.set(handle, { storageIndex, pieceLength, numPieces, totalSize, files })
  }

  private decodeStateUpdate(view: DataView, off: number) {
    const handle = view.getUint32(off, true); off += 4
    const state = view.getInt32(off, true); off += 4
    const totalDone = Number(view.getBigInt64(off, true)); off += 8
    const totalWanted = Number(view.getBigInt64(off, true)); off += 8
    const progress = view.getFloat32(off, true); off += 4
    const downloadRate = view.getInt32(off, true); off += 4
    const uploadRate = view.getInt32(off, true); off += 4
    const numPeers = view.getInt32(off, true); off += 4
    const numSeeds = view.getInt32(off, true); off += 4
    const paused = view.getUint32(off, true) !== 0; off += 4
    const autoManaged = view.getUint32(off, true) !== 0; off += 4
    const sequential = view.getUint32(off, true) !== 0; off += 4
    const queuePosition = view.getInt32(off, true); off += 4
    const errorCode = view.getInt32(off, true); off += 4
    const errorLen = view.getUint32(off, true); off += 4
    const error = errorLen
      ? utf8.decode(new Uint8Array(view.buffer, view.byteOffset + off, errorLen))
      : ''
    off += errorLen
    const numPiecesTotal = view.getUint32(off, true); off += 4
    const bitfieldBytes = view.getUint32(off, true); off += 4
    // Copy out of the heap (it can be reallocated / cleared on the next pump).
    const pieces = new Uint8Array(bitfieldBytes)
    pieces.set(new Uint8Array(view.buffer, view.byteOffset + off, bitfieldBytes))
    this.bitfieldByHandle.set(handle, { pieces, numPieces: numPiecesTotal })
    let numPiecesHave = 0
    for (let i = 0; i < bitfieldBytes; i++) { let b = pieces[i]!; while (b) { numPiecesHave += b & 1; b >>= 1 } }
    this.statusByHandle.set(handle, {
      state, progress, totalDone, totalWanted, downloadRate, uploadRate,
      numPeers, numSeeds, numPiecesTotal, numPiecesHave, paused,
      autoManaged, sequential, queuePosition, errorCode, error,
      hasMetadata: state !== TORRENT_STATE.downloadingMetadata,
    })
  }

  async *alerts(): AsyncIterableIterator<Alert> {
    while (!this.destroyed) {
      for (const a of this.popAlerts()) yield a
      await new Promise<void>(r => setTimeout(r, 100))
    }
  }

  tick() {
    if (this.destroyed) return
    this.mod._lt_session_tick()
    // post_status emits exactly one alert per call, and a parked read() only learns a piece landed
    // from a state update, so keep asking for as long as anything is waiting
    if (this.pieceWaiters.length) {
      const waiting = new Set(this.pieceWaiters.map(w => w.handle))
      for (const h of waiting) this.mod._lt_torrent_post_status(h)
    }
  }

  destroy() {
    if (this.destroyed) return
    this.destroyed = true
    if (this.fallbackTimer != null) clearInterval(this.fallbackTimer)
    // reject, never resolve: a resolved waiter sends read() on to the storage backend for bytes
    // that were never written, and it returns them as though they were real
    this.failPieceWaiters(new Error('read: session destroyed'))
    this.pieceWaiters = []
    this.resumeWaiters = []
    this.deadlineRefs.clear()
    this.priosByHandle.clear()
    this.mod._lt_session_destroy()
  }
}

export async function createSession(options: SessionOptions): Promise<Session> {
  const factory = options.moduleFactory
    // @ts-ignore - generated sibling, resolved at runtime
    ?? (await import('./libtorrent.js')).default as LtModuleFactory

  const host: FknHost = {
    net: options.net,
    dgram: options.dgram,
    storage: options.storage ?? null,
    debug: options.debug ?? false,
  }
  const mod: LtModule = await factory({ fkn: host })
  // Before the Session constructor, which creates the session and is itself one of the things that traces.
  mod._lt_set_log(options.debug ? 1 : 0)
  return new Session(mod, options)
}
