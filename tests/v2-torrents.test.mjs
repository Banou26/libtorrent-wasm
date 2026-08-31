/*
 * Can this engine hold a v2 or HYBRID torrent?
 *
 * Until 2026-08-31 it could not, and nothing said so: the module died with `memory access out of
 * bounds` on the first piece that spanned a file boundary. Two separate faults, both in disk_io.cpp
 * and both invisible to a v1 torrent:
 *
 *  - `async_read`'s multi-slice path captured the caller's handler BY VALUE, once per slice. The
 *    checking code hands `async_hash` a `span<sha256_hash>` pointing INTO a vector that the handler
 *    owns, so copying the handler duplicated the vector and freed the buffer the span still pointed
 *    at. AddressSanitizer: heap-use-after-free, WRITE of size 32.
 *  - `async_hash` and `async_hash2` sized the v2 leaves from `piece_size`, the V1 piece size, which
 *    includes pad bytes. A v2 leaf covers `piece_size2`, the piece clamped to the end of its file.
 *    With the first fault repaired but not this one, a hybrid errors with `v1 and v2 hashes do not
 *    describe the same data` and a v2 torrent stalls at 87 per cent. Both were measured.
 *
 * THE METAINFO HERE WAS BUILT BY NATIVE LIBTORRENT 2.0.13, not by anything in this repo, so a
 * failure is entirely about the engine. The data is regenerated from the manifest's seeds rather
 * than checked in, which keeps the fixture at 100 KiB instead of several megabytes.
 *
 * The check is free and unavoidable: files already on disk answer `check()` with NEED_FULL_CHECK, so
 * libtorrent hashes every byte both ways and `on_piece_verified` errors the torrent if the two
 * descriptions disagree. Reaching 100 per cent is therefore a statement about the merkle trees, the
 * piece layers and the pad arithmetic all at once.
 */
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { createSession } from '../build/index.js'
import { NodeFSStorage } from './rig/node-storage.mjs'
import { createNodeHost } from './rig/node-host.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const FIXTURES = path.join(HERE, 'fixtures', 'v2')
const MANIFEST = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'manifest.json'), 'utf8'))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** The same sha256 chain the fixture generator used. Incompressible, so nothing agrees by accident. */
const contentFor = (seed, size) => {
  const out = Buffer.alloc(size)
  let hash = crypto.createHash('sha256').update(seed).digest()
  for (let at = 0; at < size; at += 32) {
    hash = crypto.createHash('sha256').update(hash).digest()
    hash.copy(out, at, 0, Math.min(32, size - at))
  }
  return out
}

/**
 * Lay the fixture out where the ENGINE will look for it.
 *
 * `path` in the manifest is what libtorrent's parser reports, not what the metainfo says, and the
 * two disagree in one case: a v2-ONLY torrent whose file tree holds exactly one file is parsed as a
 * single-file torrent named after that FILE, discarding the `name` field, while its hybrid sibling
 * keeps the directory. A layout that trusted the metainfo put the data one directory too deep, the
 * engine found nothing, answered "there is nothing to verify", and reported 0 per cent with no
 * error at all, which reads exactly like a hashing failure and is not one.
 */
const layOut = (root, entry) => {
  for (const file of entry.files) {
    const full = path.join(root, ...file.path)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, contentFor(file.seed, file.size))
  }
}

const verify = async (root, torrent) => {
  const host = createNodeHost()
  const session = await createSession({
    net: host.net, dgram: host.dgram, storage: new NodeFSStorage(root), enableDht: false,
  })
  try {
    for (let i = 0; i < 30; i++) session.tick()
    const handle = session.addTorrentFile(new Uint8Array(fs.readFileSync(torrent)), '/')
    assert.ok(handle >= 0, 'the engine refused the torrent outright')
    let last = null
    for (let i = 0; i < 80; i++) {
      session.tick()
      session.popAlerts()
      session.postStatus(handle)
      session.tick()
      last = session.status(handle) ?? last
      if (last && (last.progress >= 1 || last.error)) break
      await sleep(50)
    }
    return { status: last, infohash: session.infohash(handle) }
  } finally {
    session.destroy?.()
  }
}

for (const item of MANIFEST) {
  for (const kind of ['hybrid', 'v2']) {
    const entry = item.kinds[kind]
    test(`${kind}: ${item.case} (${item.why})`, async (t) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), `lt-${kind}-`))
      t.after(() => fs.rmSync(root, { recursive: true, force: true }))
      layOut(root, entry)

      const { status, infohash } = await verify(root, path.join(FIXTURES, `${item.case}.${kind}.torrent`))
      assert.ok(status, 'the engine never reported a status')
      assert.equal(status.error, '', `the engine errored: ${status.error}`)
      assert.equal(status.progress, 1, 'the engine did not verify the torrent to completion')

      // pad bytes are not content, so what the engine counts as done is what the person's files hold
      const wanted = entry.files.reduce((sum, f) => sum + f.size, 0)
      assert.equal(status.totalDone, wanted, 'the engine hashed a different number of bytes')

      /*
       * The identity, which is the other half of the infohash fix.
       *
       * A hybrid has both hashes and answers with the V1 one: 40 characters, the name every client
       * understands. It used to answer with the first twenty bytes of the SHA-256 formatted as a v1
       * hash, a string naming no torrent, while writing 24 bytes past a 41-byte allocation.
       */
      assert.match(infohash, kind === 'hybrid' ? /^[0-9a-f]{40}$/ : /^[0-9a-f]{64}$/)
    })
  }
}
