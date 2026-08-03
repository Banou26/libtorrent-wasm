export interface LtModule {
  HEAPU8: Uint8Array
  HEAP32: Int32Array
  HEAPU32: Uint32Array

  _malloc(n: number): number
  _free(ptr: number): void
  stringToNewUTF8(s: string): number
  UTF8ToString(ptr: number, maxBytes?: number): string

  _lt_set_utp_receive_buffer(bytes: number): void
  _lt_session_create(): number
  _lt_session_destroy(): void
  _lt_session_tick(): void
  _lt_session_pump_alerts(): void

  _lt_alerts_size(): number
  _lt_alerts_data(): number
  _lt_alerts_clear(): void

  _lt_session_add_magnet(magnet: number, savePath: number): number
  _lt_session_add_torrent_file(buf: number, len: number, savePath: number): number
  _lt_session_add_torrent_with_resume(buf: number, len: number, savePath: number): number
  _lt_session_remove_torrent(handle: number): number
  _lt_session_remove_torrent_ex(handle: number, deleteFiles: number): number

  _lt_torrent_pause(handle: number): number
  _lt_torrent_resume(handle: number): number
  _lt_torrent_force_recheck(handle: number): number
  _lt_set_log(on: number): void
  _lt_torrent_save_resume_data(handle: number): number

  _lt_torrent_status(handle: number, out: number): number
  _lt_torrent_post_status(handle: number): number
  _lt_torrent_infohash(handle: number, out: number): number

  _lt_torrent_set_sequential(handle: number, on: number): number
  _lt_torrent_read_piece(handle: number, piece: number): number
  _lt_torrent_set_piece_deadline(handle: number, piece: number, deadlineMs: number, alertWhenAvailable: number): number
  _lt_torrent_clear_piece_deadlines(handle: number): number
  _lt_torrent_prioritize_pieces(handle: number, priosPtr: number, count: number): number
}

export type LtModuleFactory = (init?: Partial<{ fkn: FknHost; wasmBinary: ArrayBuffer }>) => Promise<LtModule>

export interface FknHost {
  net: any
  dgram: any
  storage: StorageBackend | null
  debug?: boolean
  dnsLookup?: (hostname: string, opts?: { family?: 0 | 4 | 6 })
    => Promise<{ address: string; family: 0 | 4 | 6 } | { address: string; family: 0 | 4 | 6 }[] | undefined>
}

export interface StorageBackend {
  onNewStorage(id: number, savePath: string, files: Array<{ path: string; size: number }>): void | Promise<void>
  onRemoveStorage(id: number): void | Promise<void>

  read(id: number, fileIndex: number, offset: number, len: number): Uint8Array | Promise<Uint8Array>
  write(id: number, fileIndex: number, offset: number, bytes: Uint8Array): void | Promise<void>

  release?(id: number): Promise<void>
  check?(id: number): Promise<number>  // status_t - 0 = no_error
  move?(id: number, newPath: string): Promise<void>
  deleteFiles?(id: number, flags: number): Promise<void>
  rename?(id: number, fileIndex: number, newName: string): Promise<void>
  stop?(id: number): Promise<void>
}
