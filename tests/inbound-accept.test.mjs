// Can a peer dial IN to the engine and complete a handshake?
//
// This is the only part of the inbound path that can be settled without a relay, and it has to be
// settled first: every later failure is then attributable to the relay or the network rather than
// to the C++ or the socket shim.
//
// The isolation is the whole point. The fixture is trackerless, DHT is off, and the magnet names
// NO peers, so the engine has nobody to dial and cannot manufacture a connection. If numPeers
// reaches 1, that peer arrived through accept().
//
// See roadmap/ripple-inbound-peers.md in the agent repo for where this sits.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { Rig } from './rig/harness.mjs'
import { magnetFor, makeTorrent, writeFixture } from './rig/make-torrent.mjs'

const PROTOCOL = 'BitTorrent protocol'

/** BEP 3: 1 byte pstrlen, 19 byte pstr, 8 reserved, 20 infohash, 20 peer id. */
const handshake = (infoHash, peerId) => Buffer.concat([
  Buffer.from([PROTOCOL.length]),
  Buffer.from(PROTOCOL, 'ascii'),
  // reserved: bit 20 of byte 5 is the extension protocol (BEP 10). libtorrent answers either way,
  // but announcing it keeps this a connection a real client would make.
  Buffer.from([0, 0, 0, 0, 0, 0x10, 0, 0]),
  Buffer.from(infoHash, 'hex'),
  Buffer.from(peerId, 'ascii'),
])

const waitFor = async (what, predicate, timeoutMs = 20_000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = predicate()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`)
}

test('an inbound peer reaches libtorrent through accept()', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-inbound-'))

  const file = path.join(root, 'fixture.bin')
  writeFixture(file, 4 * 1024 * 1024)
  const meta = makeTorrent({ file, pieceLength: 256 * 1024 })

  const rig = new Rig({ storageDir: path.join(root, 'download'), enableDht: false })
  await rig.start()

  /**
   * One teardown, in order, because the order is load-bearing.
   *
   * The peer socket has to go first: while it is open so is the accepted socket inside the engine,
   * which holds the event loop and leaves node's test runner reporting the file as interrupted
   * rather than finished. The storage directory has to go last, since removing it under a live
   * session is a disk error in the middle of teardown. Three separate t.after hooks got this
   * exactly backwards.
   */
  let peerSocket = null
  t.after(async () => {
    peerSocket?.destroy()
    await rig.stop()
    fs.rmSync(root, { recursive: true, force: true })
  })

  // No x.pe entries: the engine is given no peer to dial, so it cannot reach anyone outbound.
  const handle = rig.session.addMagnet(magnetFor(meta.infoHash, meta.name, []))
  assert.ok(handle >= 0 && handle < 0xFFFFFF00, `add failed, handle ${handle}`)
  rig.startPump([handle])

  // The listener is asynchronous even here, so wait for libtorrent to say it is up rather than
  // assuming it. An empty `listening` means the acceptor never came up, which is a different
  // failure from nobody dialling and has to be reported as one.
  const endpoint = await waitFor(
    'listen_succeeded_alert',
    () => rig.metrics.listening.tcp,
  )
  assert.equal(rig.metrics.listenFailed.length, 0, 'a listen failed')

  /**
   * The port is reserved before the session exists and libtorrent is told to listen on it, so the
   * announced port and the port something is actually bound to are the same number. Asserting they
   * agree is the whole point: the engine used to announce a hardcoded 6882 that nothing listened
   * on, which is why inbound TCP was dark. A mismatch here means the announce is a fiction again.
   *
   * Dialling the reserved port rather than a constant is also what keeps this test honest, since a
   * constant would pass against an engine listening somewhere else entirely.
   */
  const LISTEN_PORT = rig.session.reachable().port
  assert.ok(LISTEN_PORT, 'no port was reserved, so there is nothing for a peer to dial')
  assert.match(endpoint, new RegExp(`:${LISTEN_PORT}$`), `listening on ${endpoint}, reserved ${LISTEN_PORT}`)

  /**
   * The acceptor being up is NOT enough: wait until the torrent is registered.
   *
   * Measured 2026-08-14. Dialling as soon as the listening alert lands (about +500ms) connects at
   * the TCP level and is then dropped roughly 27ms later with zero bytes back and no
   * incoming_connection_alert, because libtorrent has no torrent for that infohash yet and refuses
   * the peer. Dialling at +1000ms handshakes normally.
   *
   * `status()` is the signal that separates them, and it is the ONLY one that does: `infohash()`
   * reads straight off the handle and answers correctly in both cases, so it looks like a
   * readiness check and is not one. A fixed sleep would work here and would rot into a flake on a
   * slower machine.
   *
   * This costs nothing in production, where torrents outlive the gap by hours. It matters because
   * measuring inbound in the first second after an add reports a false negative.
   */
  await waitFor('the torrent to be registered', () => rig.session.status(handle) != null)

  // Nothing can have connected yet: no tracker, no DHT, no peers in the magnet.
  assert.equal(rig.session.status(handle)?.numPeers ?? 0, 0, 'a peer arrived before the dial')

  const peerId = '-qB4650-inboundtest'.padEnd(20, '0').slice(0, 20)
  const reply = await new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port: LISTEN_PORT })
    peerSocket = socket
    const chunks = []
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('no handshake back within 15s')) }, 15_000)
    socket.on('connect', () => socket.write(handshake(meta.infoHash, peerId)))
    socket.on('data', (chunk) => {
      chunks.push(chunk)
      const all = Buffer.concat(chunks)
      if (all.length < 68) return
      clearTimeout(timer)
      // held open deliberately: closing here would drop numPeers before it can be observed
      resolve(all)
    })
    socket.on('error', (error) => { clearTimeout(timer); reject(error) })
  })

  assert.equal(reply[0], PROTOCOL.length, 'reply is not a BitTorrent handshake')
  assert.equal(reply.subarray(1, 20).toString('ascii'), PROTOCOL)
  assert.equal(
    reply.subarray(28, 48).toString('hex'),
    meta.infoHash.toLowerCase(),
    'the engine handshook for a different torrent',
  )

  const peers = await waitFor(
    'numPeers to reach 1',
    () => (rig.session.status(handle)?.numPeers ?? 0) >= 1,
  )
  assert.ok(peers, 'numPeers never reached 1')

  // The alert is what ripple will read in production, so assert the classifier sees it too. This
  // also guards the regex in harness.mjs #onAlert, which was matching against a numeric type and
  // silently counting zero for everything before 2026-08-14.
  await waitFor('an incoming_connection_alert', () => rig.metrics.incoming.length > 0)
  const inbound = rig.metrics.incoming[0]
  assert.match(inbound.endpoint, /^127\.0\.0\.1:\d+$/, `unexpected endpoint ${inbound.endpoint}`)
  assert.equal(inbound.transport, 'tcp')

  // The same thing read off the Session itself, which is what ripple will show rather than
  // reimplementing the parsing. It is fed from popAlerts, so the rig's pump has already driven it.
  const reachable = rig.session.reachable()
  assert.equal(reachable.inbound, 1, 'Session.reachable() missed the inbound peer')
  assert.equal(reachable.inboundByTransport.tcp, 1)
  assert.equal(reachable.lastInbound?.endpoint, inbound.endpoint)
  assert.match(reachable.listening.tcp ?? '', new RegExp(`:${LISTEN_PORT}$`))
  assert.deepEqual(reachable.listenFailed, [])
})
