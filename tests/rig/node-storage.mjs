// A StorageBackend over the real filesystem, for driving the engine from node.
//
// The browser has exactly one readable backend (OPFSStorage), and read() is what
// streaming needs, so without this there is no way to run a download outside a
// browser. The shape is the same five methods; the difference is that node can do
// the whole thing synchronously, where OPFS has to await a SyncAccessHandle.
//
// js_disk_read/js_disk_write in library_fkn.js detect a non-Promise return and
// skip the microtask round-trip, so a synchronous backend also removes the disk
// hop from every measurement. That is a deliberate difference from production and
// the reason node results transfer for picking behaviour but not for throughput.

import fs from 'node:fs'
import path from 'node:path'

// libtorrent's status_t (storage_defs.hpp), as returned by check().
export const STORAGE_NO_ERROR = 0
export const STORAGE_NEED_FULL_CHECK = 2

export class NodeFSStorage {
  #storages = new Map()
  #root

  /**
   * @param {string} root  directory that savePath is resolved against
   */
  constructor(root) {
    this.#root = root
  }

  onNewStorage(id, savePath, files) {
    // savePath arrives as libtorrent built it, which for the harness is a bare
    // name. Anchoring it under root keeps a stray absolute path from escaping.
    const dir = path.resolve(this.#root, savePath.replace(/^\/+/, ''))
    fs.mkdirSync(dir, { recursive: true })
    this.#storages.set(id, { dir, fds: new Map(), fileMeta: files })
  }

  onRemoveStorage(id) {
    const e = this.#storages.get(id)
    if (!e) return
    for (const fd of e.fds.values()) {
      try { fs.closeSync(fd) } catch {}
    }
    this.#storages.delete(id)
  }

  read(id, fileIndex, offset, len) {
    const fd = this.#openFile(id, fileIndex)
    const out = new Uint8Array(len)
    // A read that runs past EOF is ordinary: libtorrent asks for a whole block
    // and the file may be sparse. Short reads zero-fill, matching OPFSStorage.
    const got = fs.readSync(fd, out, 0, len, offset)
    if (got < len) out.fill(0, got)
    return out
  }

  write(id, fileIndex, offset, bytes) {
    const fd = this.#openFile(id, fileIndex)
    const wrote = fs.writeSync(fd, bytes, 0, bytes.length, offset)
    if (wrote < bytes.length) {
      throw new Error(`short write: id=${id} file=${fileIndex} off=${offset} want=${bytes.length} wrote=${wrote}`)
    }
  }

  async release(id) {
    const e = this.#storages.get(id)
    if (!e) return
    for (const fd of e.fds.values()) {
      try { fs.fsyncSync(fd) } catch {}
      try { fs.closeSync(fd) } catch {}
    }
    e.fds.clear()
  }

  async stop(id) {
    return this.release(id)
  }

  // no_error means "trust what you have", NOT "verify". Answering no_error
  // unconditionally turns force_recheck into a full re-download; this mirrors
  // OPFSStorage and libtorrent's own posix_disk_io.
  async check(id) {
    const e = this.#storages.get(id)
    if (!e) return STORAGE_NO_ERROR
    for (const meta of e.fileMeta) {
      try {
        if (fs.statSync(path.resolve(e.dir, meta.path)).size > 0) return STORAGE_NEED_FULL_CHECK
      } catch (err) {
        // Not being there is the ordinary answer. Anything else leaves the file's
        // state unknown, and verifying an intact torrent is cheaper than trusting
        // a broken one.
        if (err.code !== 'ENOENT') return STORAGE_NEED_FULL_CHECK
      }
    }
    return STORAGE_NO_ERROR
  }

  async deleteFiles(id, _flags) {
    const e = this.#storages.get(id)
    if (!e) return
    for (const fd of e.fds.values()) {
      try { fs.closeSync(fd) } catch {}
    }
    e.fds.clear()
    for (const meta of e.fileMeta) {
      try { fs.rmSync(path.resolve(e.dir, meta.path)) } catch {}
    }
  }

  async rename(id, fileIndex, newName) {
    const e = this.#storages.get(id)
    if (!e) return
    const meta = e.fileMeta[fileIndex]
    if (!meta) return
    const fd = e.fds.get(fileIndex)
    if (fd !== undefined) {
      try { fs.closeSync(fd) } catch {}
      e.fds.delete(fileIndex)
    }
    const from = path.resolve(e.dir, meta.path)
    const to = path.resolve(e.dir, newName)
    fs.mkdirSync(path.dirname(to), { recursive: true })
    try { fs.renameSync(from, to) } catch {}
    meta.path = newName
  }

  /** Absolute path of a file in a storage, for assertions in tests. */
  filePath(id, fileIndex) {
    const e = this.#storages.get(id)
    if (!e) throw new Error(`unknown storage ${id}`)
    const meta = e.fileMeta[fileIndex]
    if (!meta) throw new Error(`unknown file ${fileIndex}`)
    return path.resolve(e.dir, meta.path)
  }

  #openFile(id, fileIndex) {
    const e = this.#storages.get(id)
    if (!e) throw new Error(`unknown storage ${id}`)
    const cached = e.fds.get(fileIndex)
    if (cached !== undefined) return cached
    const meta = e.fileMeta[fileIndex]
    if (!meta) throw new Error(`unknown file ${fileIndex}`)
    const file = path.resolve(e.dir, meta.path)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    // 'r+' fails when the file is absent and 'w+' truncates an existing one, so
    // neither alone survives both a fresh download and a resumed one.
    const fd = fs.openSync(file, fs.existsSync(file) ? 'r+' : 'w+')
    e.fds.set(fileIndex, fd)
    return fd
  }
}
