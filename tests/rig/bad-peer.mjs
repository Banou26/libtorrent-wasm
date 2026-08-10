// A peer that claims pieces and does not deliver them.
//
// A fleet of healthy transmission seeders gives a clean baseline but CANNOT
// reproduce the bug this rig exists to catch. The production symptom was "168 MB
// downloaded, still 0:00": the head of the file stranded while the rest of the
// torrent ran at full speed, because once every block of a piece is outstanding
// to some peer, libtorrent's rescue for a late time-critical piece is gated
// behind `m_average_piece_time > 0`, which stays 0 until a deadlined piece has
// completed ONCE. So it is inert for exactly the first pieces of a file. That is
// what libtorrent-wasm 0.3.8's cancel_request fix addressed, and this is the peer
// that puts it under test.
//
// The wire protocol is written out here rather than pulled from a package: the
// whole point is to violate it in one specific way, and a library's job is to
// stop you doing that.

import net from 'node:net'
import crypto from 'node:crypto'

const PROTOCOL = Buffer.from('BitTorrent protocol')
const MSG = {
  choke: 0, unchoke: 1, interested: 2, notInterested: 3,
  have: 4, bitfield: 5, request: 6, piece: 7, cancel: 8,
}

const msg = (id, payload = Buffer.alloc(0)) => {
  const b = Buffer.allocUnsafe(5 + payload.length)
  b.writeUInt32BE(1 + payload.length, 0)
  b.writeUInt8(id, 4)
  payload.copy(b, 5)
  return b
}

/**
 * @param {object} o
 * @param {string} o.infoHash    hex
 * @param {number} o.pieces      piece count in the torrent
 * @param {string} o.host        loopback address to bind
 * @param {number} o.port
 * @param {(piece: number) => boolean} [o.withhold]
 *   Return true for a piece this peer should accept requests for and never
 *   answer. Default: withhold nothing, i.e. a peer that simply has no data,
 *   which is NOT the interesting case.
 * @param {(piece: number, offset: number, length: number) => Buffer} [o.blockFor]
 *   Produce the bytes for a block it does answer. Omit and it answers nothing,
 *   which makes every piece it claims a stranded one.
 */
export class BadPeer {
  #server = null
  #sockets = new Set()

  constructor({ infoHash, pieces, host = '127.0.0.99', port = 51999, withhold = () => false, blockFor = null }) {
    this.infoHash = Buffer.from(infoHash, 'hex')
    this.pieces = pieces
    this.host = host
    this.port = port
    this.withhold = withhold
    this.blockFor = blockFor
    this.peerId = Buffer.concat([Buffer.from('-RG0001-'), crypto.randomBytes(12)])
    /** Requests received but deliberately never answered, for assertions. */
    this.stats = { connections: 0, requests: 0, withheld: 0, served: 0, cancels: 0 }
  }

  get endpoint() { return { host: this.host, port: this.port } }

  start() {
    return new Promise((resolve, reject) => {
      this.#server = net.createServer((sock) => this.#onConnection(sock))
      this.#server.on('error', reject)
      this.#server.listen(this.port, this.host, () => resolve(this.endpoint))
    })
  }

  #onConnection(sock) {
    this.stats.connections++
    this.#sockets.add(sock)
    sock.on('close', () => this.#sockets.delete(sock))
    sock.on('error', () => {})

    let buf = Buffer.alloc(0)
    let shookHands = false

    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk])

      if (!shookHands) {
        // <pstrlen=19><"BitTorrent protocol"><8 reserved><20 infohash><20 peerid>
        if (buf.length < 68) return
        const theirHash = buf.subarray(28, 48)
        if (!theirHash.equals(this.infoHash)) { sock.destroy(); return }
        buf = buf.subarray(68)
        shookHands = true

        const reserved = Buffer.alloc(8)
        sock.write(Buffer.concat([
          Buffer.from([PROTOCOL.length]), PROTOCOL, reserved, this.infoHash, this.peerId,
        ]))
        // Claim the whole torrent, then unchoke unprompted. A peer that never
        // unchokes is simply ignored; this one has to look like the best peer in
        // the swarm for its requests to be handed to it.
        const bitfield = Buffer.alloc(Math.ceil(this.pieces / 8), 0)
        for (let p = 0; p < this.pieces; p++) bitfield[p >> 3] |= 0x80 >> (p & 7)
        sock.write(msg(MSG.bitfield, bitfield))
        sock.write(msg(MSG.unchoke))
      }

      while (buf.length >= 4) {
        const len = buf.readUInt32BE(0)
        if (buf.length < 4 + len) break
        if (len === 0) { buf = buf.subarray(4); continue }  // keep-alive
        const id = buf.readUInt8(4)
        const payload = buf.subarray(5, 4 + len)
        buf = buf.subarray(4 + len)
        this.#onMessage(sock, id, payload)
      }
    })
  }

  #onMessage(sock, id, payload) {
    if (id === MSG.interested) {
      sock.write(msg(MSG.unchoke))
      return
    }
    if (id === MSG.cancel) {
      this.stats.cancels++
      return
    }
    if (id !== MSG.request) return

    const piece = payload.readUInt32BE(0)
    const offset = payload.readUInt32BE(4)
    const length = payload.readUInt32BE(8)
    this.stats.requests++

    if (this.withhold(piece)) {
      // The whole point: accept the request, answer nothing, hold the block.
      this.stats.withheld++
      return
    }
    if (!this.blockFor) return

    const data = this.blockFor(piece, offset, length)
    if (!data) return
    const head = Buffer.allocUnsafe(8)
    head.writeUInt32BE(piece, 0)
    head.writeUInt32BE(offset, 4)
    sock.write(msg(MSG.piece, Buffer.concat([head, data])))
    this.stats.served++
  }

  async stop() {
    for (const s of this.#sockets) { try { s.destroy() } catch {} }
    this.#sockets.clear()
    await new Promise((resolve) => {
      if (!this.#server) return resolve()
      this.#server.close(() => resolve())
    })
    this.#server = null
  }
}
