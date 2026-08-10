// Bencode + .torrent construction, in node, with no external tool.
//
// mktorrent refuses to build a torrent without at least one -a announce URL, and
// a tracker is the one thing this rig must not have: the swarm is defined by the
// exact peers the harness dials, so a real announce would either fail noisily on
// every retry or, worse, succeed. Building the metainfo here also pins the piece
// length and the private flag exactly, and keeps the fixture reproducible.

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const bencode = (v) => {
  if (typeof v === 'number') {
    if (!Number.isInteger(v)) throw new Error(`bencode: non-integer ${v}`)
    return Buffer.from(`i${v}e`)
  }
  if (typeof v === 'string') return bencode(Buffer.from(v, 'utf8'))
  if (Buffer.isBuffer(v)) return Buffer.concat([Buffer.from(`${v.length}:`), v])
  if (Array.isArray(v)) return Buffer.concat([Buffer.from('l'), ...v.map(bencode), Buffer.from('e')])
  if (v && typeof v === 'object') {
    // bencode requires dictionary keys sorted as raw byte strings, and libtorrent
    // rejects a torrent whose info dict is not, so this is correctness not tidiness.
    const keys = Object.keys(v).filter((k) => v[k] !== undefined).sort()
    return Buffer.concat([
      Buffer.from('d'),
      ...keys.flatMap((k) => [bencode(k), bencode(v[k])]),
      Buffer.from('e'),
    ])
  }
  throw new Error(`bencode: unsupported ${typeof v}`)
}

/**
 * Build a single-file, trackerless torrent for a file already on disk.
 *
 * @param {object} o
 * The private flag defaults OFF, and turning it on breaks a magnet-driven rig
 * outright. create_ut_metadata_plugin returns {} when `valid_metadata() && priv()`
 * (libtorrent/src/ut_metadata.cpp:631-637), torrent plugins attach exactly once at
 * add time (session_impl.cpp:4910-4919), and a seeder handed a .torrent already
 * has valid metadata at that instant. So every seeder of a private torrent
 * refuses to serve metadata, ut_metadata never reaches the extended handshake,
 * and the leecher parks at "Loading metadata" forever with a completely healthy
 * data plane. That is indistinguishable from the headless-Chromium stall in
 * hard-rules.md and would cost a session to diagnose.
 *
 * Isolation does not need the flag anyway: the infohash covers a fixture that
 * exists only on this machine, so the DHT the wrapper enables (wrapper.cpp:298)
 * has nobody to find. Confirm that by asserting the peer count never exceeds the
 * fleet size rather than by trusting the flag.
 *
 * @param {string} o.file          path to the payload
 * @param {number} [o.pieceLength] bytes per piece, default 1 MiB
 * @param {boolean} [o.private]    set the private flag, default false. See above.
 * @param {string} [o.name]        override the torrent name
 * @returns {{ torrent: Buffer, infoHash: string, pieceLength: number, pieces: number, size: number, name: string }}
 */
export const makeTorrent = ({ file, pieceLength = 1 << 20, private: isPrivate = false, name }) => {
  const size = fs.statSync(file).size
  const torrentName = name ?? path.basename(file)

  const hashes = []
  const fd = fs.openSync(file, 'r')
  try {
    const buf = Buffer.allocUnsafe(pieceLength)
    for (let offset = 0; offset < size; offset += pieceLength) {
      const len = Math.min(pieceLength, size - offset)
      let got = 0
      // A single readSync can come up short on a large piece; the last piece is
      // legitimately shorter, and hashing a partly-filled buffer silently
      // produces a torrent whose every peer fails the hash check.
      while (got < len) {
        const n = fs.readSync(fd, buf, got, len - got, offset + got)
        if (n === 0) throw new Error(`unexpected EOF at ${offset + got} of ${size}`)
        got += n
      }
      hashes.push(crypto.createHash('sha1').update(buf.subarray(0, len)).digest())
    }
  } finally {
    fs.closeSync(fd)
  }

  const info = {
    length: size,
    name: torrentName,
    'piece length': pieceLength,
    pieces: Buffer.concat(hashes),
    ...(isPrivate ? { private: 1 } : {}),
  }
  const infoBytes = bencode(info)
  const infoHash = crypto.createHash('sha1').update(infoBytes).digest('hex')

  // No 'announce' and no 'announce-list': libtorrent treats the torrent as
  // trackerless and never announces, which is what makes the swarm exactly the
  // set of peers the harness names.
  const torrent = bencode({ info, 'creation date': 0 })

  return { torrent, infoHash, pieceLength, pieces: hashes.length, size, name: torrentName }
}

/**
 * A magnet naming the torrent and the exact peers to dial.
 *
 * x.pe carries a peer address into add_torrent_params.peers, which is how a
 * trackerless, DHT-less swarm bootstraps at all.
 *
 * @param {string} infoHash  hex
 * @param {string} name
 * @param {Array<{host: string, port: number}>} peers
 */
export const magnetFor = (infoHash, name, peers = []) => {
  const parts = [`magnet:?xt=urn:btih:${infoHash}`]
  if (name) parts.push(`dn=${encodeURIComponent(name)}`)
  for (const p of peers) parts.push(`x.pe=${p.host}:${p.port}`)
  return parts.join('&')
}

/**
 * Deterministic payload. Seeded so a rebuilt fixture has the same infohash, and
 * incompressible so nothing in the path can quietly shortcut it.
 */
export const writeFixture = (file, size, seed = 0x9e3779b9) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  if (fs.existsSync(file) && fs.statSync(file).size === size) return file
  const CHUNK = 1 << 20
  const out = fs.openSync(file, 'w')
  try {
    let state = seed >>> 0
    const buf = Buffer.allocUnsafe(CHUNK)
    let written = 0
    while (written < size) {
      const len = Math.min(CHUNK, size - written)
      for (let i = 0; i < len; i += 4) {
        // xorshift32: cheap, and the point is only that the bytes do not repeat
        state ^= state << 13; state >>>= 0
        state ^= state >>> 17
        state ^= state << 5; state >>>= 0
        buf.writeUInt32LE(state, i)
      }
      fs.writeSync(out, buf, 0, len)
      written += len
    }
  } finally {
    fs.closeSync(out)
  }
  return file
}
