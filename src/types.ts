export interface LtModule {
  HEAPU8: Uint8Array
  HEAP32: Int32Array
  HEAPU32: Uint32Array

  _malloc(n: number): number
  _free(ptr: number): void
  stringToNewUTF8(s: string): number
  UTF8ToString(ptr: number, maxBytes?: number): string

  _lt_set_utp_receive_buffer(bytes: number): void
  _lt_set_dht(on: number): void
  _lt_set_listen_port(port: number): void
  _lt_session_create(): number
  _lt_session_destroy(): void
  _lt_session_tick(): void
  _lt_session_pump_alerts(): void

  _lt_alerts_size(): number
  _lt_alerts_data(): number
  _lt_alerts_clear(): void

  _lt_session_set_rate_limits(downloadBps: number, uploadBps: number, limitLocalPeers: number): void

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
  _lt_torrent_post_peers(handle: number): number
  _lt_torrent_post_trackers(handle: number): number
  _lt_torrent_infohash(handle: number, out: number): number

  _lt_torrent_set_sequential(handle: number, on: number): number
  _lt_torrent_set_flags(handle: number, flags: number, mask: number): number
  _lt_torrent_force_reannounce(handle: number): number
  _lt_torrent_queue_position(handle: number, where: number): number
  _lt_torrent_set_upload_limit(handle: number, bytesPerSecond: number): number
  _lt_torrent_set_download_limit(handle: number, bytesPerSecond: number): number
  _lt_torrent_read_piece(handle: number, piece: number): number
  _lt_torrent_set_piece_deadline(handle: number, piece: number, deadlineMs: number, alertWhenAvailable: number): number
  _lt_torrent_clear_piece_deadlines(handle: number): number
  _lt_torrent_reset_piece_deadline(handle: number, piece: number): number
  _lt_torrent_prioritize_pieces(handle: number, priosPtr: number, count: number): number
  _lt_torrent_prioritize_piece_list(handle: number, piecesPtr: number, priosPtr: number, count: number): number
  _lt_torrent_prioritize_files(handle: number, priosPtr: number, count: number): number
  _lt_torrent_set_file_priority(handle: number, fileIndex: number, prio: number): number
  _lt_torrent_cancel_piece_requests(handle: number, piece: number): number
}

export type LtModuleFactory = (init?: Partial<{ fkn: FknHost; wasmBinary: ArrayBuffer }>) => Promise<LtModule>

/**
 * A TCP listener and a UDP socket the host bound on the relay, on the same port number, before the
 * session existed. The shim adopts both instead of binding its own, which is what lets libtorrent
 * announce a port that something is actually listening on. `backlog` parks connections that arrive
 * between the reservation and the adoption; `adopted` stops the reservation's own handler once the
 * shim has taken over. Null when the reservation could not be made.
 */
export interface PreboundSockets {
  port: number
  /**
   * Null when the paired TCP bind lost its draw. The announce is then anchored on the UDP port
   * alone, which still reaches every peer that dials uTP (all of them try it first), and inbound
   * TCP is dark for the session exactly as it was before any of this.
   */
  server: any | null
  udp: any
  backlog: any[]
  adopted?: boolean
  serverTaken?: boolean
  udpTaken?: boolean
}

export interface FknHost {
  net: any
  dgram: any
  storage: StorageBackend | null
  prebound?: PreboundSockets | null
  /** Turn on the transport and tick traces. Off by default: they run to hundreds of
   *  lines a minute on an ordinary download. */
  debug?: boolean
  /**
   * Optional. When supplied, the WASM resolver routes DNS lookups through
   * this function (typically @fkn/lib's dnsLookup, which tunnels via
   * WebVPN). When omitted, the module falls back to plain fetch against
   * 1.1.1.1's DoH JSON endpoint.
   */
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
