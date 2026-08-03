// Run from a Worker. Calling this from the main thread will throw.

import type { StorageBackend } from './types'

interface StorageEntry {
  rootDir: FileSystemDirectoryHandle
  files: Map<number, FileSystemSyncAccessHandle>
  opening: Map<number, Promise<FileSystemSyncAccessHandle>>
  fileMeta: Array<{ path: string; size: number }>
}

// libtorrent's status_t (storage_defs.hpp), as returned by check().
export const STORAGE_NO_ERROR = 0
export const STORAGE_NEED_FULL_CHECK = 2

export class OPFSStorage implements StorageBackend {
  private storages = new Map<number, StorageEntry>()
  // libtorrent asks for a check from inside the same synchronous pass that creates the storage, so check() can run before the entry exists
  private opened = new Map<number, Promise<void>>()

  onNewStorage(id: number, savePath: string, files: Array<{ path: string; size: number }>): Promise<void> {
    const open = (async () => {
      const root = await navigator.storage.getDirectory()
      const cleanPath = savePath.replace(/^\/+/, '')
      const rootDir = await ensureDirRecursive(root, cleanPath)
      this.storages.set(id, { rootDir, files: new Map(), opening: new Map(), fileMeta: files })
    })()
    this.opened.set(id, open)
    // Forgotten on success only: a failed open has to stay visible, or check() cannot tell "looked, and there is nothing there" from "never got to look"
    void open.then(
      () => { if (this.opened.get(id) === open) this.opened.delete(id) },
      () => {},
    )
    return open
  }

  async onRemoveStorage(id: number) {
    this.opened.delete(id)
    const e = this.storages.get(id)
    if (!e) return
    for (const h of e.files.values()) {
      try { h.close() } catch (e) {}
    }
    this.storages.delete(id)
  }

  // return type is a union of sync and Promise - js_disk_read/write detect this and skip the microtask round-trip
  read(id: number, fileIndex: number, offset: number, len: number): Uint8Array | Promise<Uint8Array> {
    const handleOrPromise = this.openFile(id, fileIndex)
    const doRead = (handle: FileSystemSyncAccessHandle): Uint8Array => {
      const out = new Uint8Array(len)
      const read = handle.read(out, { at: offset })
      if (read < len) out.fill(0, read)
      return out
    }
    if (handleOrPromise instanceof Promise) return handleOrPromise.then(doRead)
    return doRead(handleOrPromise)
  }

  write(id: number, fileIndex: number, offset: number, bytes: Uint8Array): void | Promise<void> {
    const handleOrPromise = this.openFile(id, fileIndex)
    const doWrite = (handle: FileSystemSyncAccessHandle): void => {
      try {
        const wrote = handle.write(bytes, { at: offset })
        if (wrote < bytes.length) {
          // eslint-disable-next-line no-console
          console.error('[opfs] short write', { id, fileIndex, offset, want: bytes.length, wrote })
          throw new Error('short write')
        }
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error('[opfs] write failed', {
          id, fileIndex, offset, len: bytes.length,
          err: String(e),
          errName: (e as any)?.name,
          errMsg: (e as any)?.message,
          isView: ArrayBuffer.isView(bytes),
          bytesType: Object.prototype.toString.call(bytes),
        })
        throw e
      }
    }
    if (handleOrPromise instanceof Promise) {
      return handleOrPromise.then(doWrite).catch((e) => {
        // eslint-disable-next-line no-console
        console.error('[opfs] openFile failed', { id, fileIndex, err: String(e) })
        throw e
      })
    }
    return doWrite(handleOrPromise)
  }

  async release(id: number): Promise<void> {
    const e = this.storages.get(id)
    if (!e) return
    for (const h of e.files.values()) {
      try { h.flush(); h.close() } catch (e) {}
    }
    e.files.clear()
  }

  async stop(id: number): Promise<void> {
    return this.release(id)
  }

  // no_error means "trust what you have", NOT "verify"
  // mirrors libtorrent's own posix_disk_io and mmap_disk_io: need_full_check if any file holds bytes, no_error if none do; answering no_error unconditionally turns force_recheck into a full re-download and makes a restore without a resume blob re-fetch data already on disk
  async check(id: number): Promise<number> {
    let openFailed = false
    await this.opened.get(id)?.catch(() => { openFailed = true })
    if (openFailed) return STORAGE_NEED_FULL_CHECK
    const e = this.storages.get(id)
    if (!e) return STORAGE_NO_ERROR
    // getFile() takes a shared lock that a cached SyncAccessHandle holds exclusively
    await this.release(id)
    for (const meta of e.fileMeta) {
      if (await this.hasBytes(e, meta.path)) return STORAGE_NEED_FULL_CHECK
    }
    return STORAGE_NO_ERROR
  }

  // existence, not size: a partially downloaded file is legitimately shorter than the torrent declares, and zero-length counts as absent because openFile creates files on demand, so a torrent only ever read from leaves empty files behind
  private async hasBytes(e: StorageEntry, path: string): Promise<boolean> {
    const segments = path.split('/').filter(Boolean)
    const name = segments.pop()
    if (!name) return false
    let dir = e.rootDir
    try {
      for (const s of segments) dir = await dir.getDirectoryHandle(s)
      return (await (await dir.getFileHandle(name)).getFile()).size > 0
    } catch (err) {
      // true for any error other than NotFoundError: not being there is the ordinary answer, anything else leaves the file's state unknown, and verifying an intact torrent costs time where trusting a broken one costs the download
      return (err as { name?: string })?.name !== 'NotFoundError'
    }
  }

  async deleteFiles(id: number, _flags: number): Promise<void> {
    const e = this.storages.get(id)
    if (!e) return
    for (const h of e.files.values()) try { h.close() } catch {}
    e.files.clear()
    for (const meta of e.fileMeta) {
      const segments = meta.path.split('/').filter(Boolean)
      const name = segments.pop()
      if (!name) continue
      let dir = e.rootDir
      for (const s of segments) {
        try { dir = await dir.getDirectoryHandle(s) } catch { dir = null as any; break }
      }
      if (dir) try { await dir.removeEntry(name) } catch {}
    }
  }

  // OPFS allows one SyncAccessHandle per file, so concurrent callers must share one in-flight Promise
  private openFile(id: number, fileIndex: number): FileSystemSyncAccessHandle | Promise<FileSystemSyncAccessHandle> {
    const e = this.storages.get(id)
    if (!e) throw new Error(`unknown storage ${id}`)
    const cached = e.files.get(fileIndex)
    if (cached) return cached
    const pending = e.opening.get(fileIndex)
    if (pending) return pending
    const p = this.openFileSlow(id, fileIndex)
    e.opening.set(fileIndex, p)
    p.finally(() => e.opening.delete(fileIndex))
    return p
  }

  private async openFileSlow(id: number, fileIndex: number): Promise<FileSystemSyncAccessHandle> {
    const e = this.storages.get(id)!
    const meta = e.fileMeta[fileIndex]
    if (!meta) throw new Error(`unknown file ${fileIndex}`)
    const segments = meta.path.split('/').filter(Boolean)
    const name = segments.pop()!
    let dir = e.rootDir
    for (const s of segments) {
      dir = await dir.getDirectoryHandle(s, { create: true })
    }
    const fileHandle = await dir.getFileHandle(name, { create: true })
    const h = await (fileHandle as any).createSyncAccessHandle() as FileSystemSyncAccessHandle
    e.files.set(fileIndex, h)
    return h
  }
}

async function ensureDirRecursive(
  root: FileSystemDirectoryHandle, path: string,
): Promise<FileSystemDirectoryHandle> {
  if (!path) return root
  let dir = root
  for (const seg of path.split('/').filter(Boolean)) {
    dir = await dir.getDirectoryHandle(seg, { create: true })
  }
  return dir
}

declare global {
  interface FileSystemSyncAccessHandle {
    read(buf: Uint8Array<ArrayBufferLike>, opts?: { at?: number }): number
    write(buf: Uint8Array<ArrayBufferLike>, opts?: { at?: number }): number
    flush(): void
    close(): void
    truncate(size: number): void
    getSize(): number
  }
}
