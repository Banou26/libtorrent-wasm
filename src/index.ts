import type { LtModuleFactory, LtModule, FknHost, StorageBackend } from './types'

export interface SessionOptions {
  net: any
  dgram: any
  storage?: StorageBackend
  moduleFactory?: LtModuleFactory
  // defaults to 250 ms; the fallback that fires libtorrent's internal timers (DHT bucket refresh, tracker announces) when no socket or disk activity is pumping ticks
  tickIntervalMs?: number
  // defaults to 1 MiB (the patched lt::aux::utp_receive_buffer_capacity)
  utpReceiveBufferBytes?: number
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
  autoManaged: boolean
  // -1 for a seeding or finished torrent
  queuePosition: number
  errorCode: number
  error: string
}

export interface FileEntry {
  path: string
  size: number
  // absolute byte offset of this file within the concatenated torrent payload, not an offset inside the file
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
  pieces: Uint8Array
  numPieces: number
  pieceLength: number
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

type PieceWaiter = { handle: number, p0: number, p1: number, resolve: () => void }
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
    this.filesByHandle.delete(handle)
    this.bitfieldByHandle.delete(handle)
    this.statusByHandle.delete(handle)
    this.resumeByHandle.delete(handle)
  }

  pauseTorrent(handle: number) { this.mod._lt_torrent_pause(handle) }
  resumeTorrent(handle: number) { this.mod._lt_torrent_resume(handle) }

  // The torrent forgets what it has first, so any saved resume blob for it is stale.
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

  files(handle: number): TorrentFiles | null {
    return this.filesByHandle.get(handle) ?? null
  }

  bitfield(handle: number): PieceBitfield | null {
    const bf = this.bitfieldByHandle.get(handle)
    const layout = this.filesByHandle.get(handle)
    if (!bf || !layout) return null
    return { pieces: bf.pieces, numPieces: bf.numPieces, pieceLength: layout.pieceLength, length: layout.totalSize }
  }

  status(handle: number): TorrentStatus | null {
    return this.statusByHandle.get(handle) ?? null
  }

  async read(handle: number, fileIndex: number, offset: number, len: number): Promise<Uint8Array> {
    const layout = this.filesByHandle.get(handle)
    if (!layout) throw new Error(`read: no layout for handle ${handle} (metadata not ready)`)
    const file = layout.files[fileIndex]
    if (!file) throw new Error(`read: no file ${fileIndex}`)
    if (!this.storage) throw new Error('read: no storage backend configured')
    const { pieceLength } = layout
    const absStart = file.offset + offset
    const p0 = Math.floor(absStart / pieceLength)
    const p1 = Math.floor((absStart + len - 1) / pieceLength)
    if (!this.hasPieces(handle, p0, p1)) {
      // deadline 0 = most urgent
      for (let p = p0; p <= p1; p++) this.mod._lt_torrent_set_piece_deadline(handle, p, 0, 0)
      this.mod._lt_torrent_post_status(handle)
      await this.awaitPieces(handle, p0, p1)
    }
    // have-bit set ⇒ the piece passed hash AND its disk write completed (no read-before-write race)
    const data = await this.storage.read(layout.storageIndex, fileIndex, offset, len)
    return data instanceof Uint8Array ? data : new Uint8Array(data)
  }

  prioritizeRange(handle: number, fileIndex: number, offset: number, len: number) {
    const layout = this.filesByHandle.get(handle)
    const file = layout?.files[fileIndex]
    if (!layout || !file) return
    const { pieceLength } = layout
    const p0 = Math.floor((file.offset + offset) / pieceLength)
    const p1 = Math.floor((file.offset + offset + len - 1) / pieceLength)
    const prios = new Uint8Array(p1 + 1).fill(4)
    for (let p = p0; p <= p1; p++) prios[p] = 7
    this.prioritizePieces(handle, prios)
    for (let p = p0; p <= p1; p++) this.mod._lt_torrent_set_piece_deadline(handle, p, (p - p0) * 1000, 0)
  }

  setSequential(handle: number, on: boolean) {
    this.mod._lt_torrent_set_sequential(handle, on ? 1 : 0)
  }

  setPieceDeadline(handle: number, piece: number, deadlineMs: number, alertWhenAvailable = false) {
    this.mod._lt_torrent_set_piece_deadline(handle, piece, deadlineMs, alertWhenAvailable ? 1 : 0)
  }

  clearPieceDeadlines(handle: number) {
    this.mod._lt_torrent_clear_piece_deadlines(handle)
  }

  prioritizePieces(handle: number, prios: Uint8Array) {
    const m = this.mod
    const ptr = m._malloc(prios.length)
    m.HEAPU8.set(prios, ptr)
    try { m._lt_torrent_prioritize_pieces(handle, ptr, prios.length) }
    finally { m._free(ptr) }
  }

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

  private awaitPieces(handle: number, p0: number, p1: number): Promise<void> {
    return new Promise<void>(resolve => { this.pieceWaiters.push({ handle, p0, p1, resolve }) })
  }

  private resolvePieceWaiters() {
    if (this.pieceWaiters.length === 0) return
    this.pieceWaiters = this.pieceWaiters.filter(w => {
      if (this.hasPieces(w.handle, w.p0, w.p1)) { w.resolve(); return false }
      return true
    })
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
    m._lt_alerts_clear()
    this.resolvePieceWaiters()
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
      autoManaged, queuePosition, errorCode, error,
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
  }

  destroy() {
    if (this.destroyed) return
    this.destroyed = true
    if (this.fallbackTimer != null) clearInterval(this.fallbackTimer)
    this.pieceWaiters.forEach(w => w.resolve())
    this.pieceWaiters = []
    this.resumeWaiters = []
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
