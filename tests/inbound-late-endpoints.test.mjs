// The same inbound peer as inbound-accept.test.mjs, against a host that names its peer late.
//
// node hands 'connection' a socket that already knows its endpoints. @fkn/lib hands over one whose
// four address getters THROW `Socket is not connected` until a promise behind them resolves
// (see rig/late-endpoint-host.mjs). Measured in a browser against the live relay on 2026-08-15,
// on every accepted socket, in the page realm and in a worker realm.
//
// The shim used to read all six endpoints inside ONE try block, so the first throw abandoned the
// rest and the accepted fd was left with no remote address at all. getpeername then answered
// ENOTCONN, and libtorrent calls remote_endpoint() the instant it accepts and returns with no alert
// and no reply when that fails (libtorrent/src/session_impl.cpp:2989). The peer sees its connection
// accepted and then silence.
//
// The delay below is 60ms, not @fkn/lib's one microtask, and the number is load-bearing. The shim
// defers its accept to a tick, which is a task, so a microtask of lateness never reaches accept()
// and the old code survived it by scheduling rather than by design. 60ms clears the tick and shows
// what the old code does when that luck runs out: measured against the pre-fix build, this exact
// test fails with `no handshake back within 15s`, which is the reported symptom verbatim.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { Rig } from './rig/harness.mjs'
import { createLateEndpointHost } from './rig/late-endpoint-host.mjs'
import { magnetFor, makeTorrent, writeFixture } from './rig/make-torrent.mjs'
import { PROTOCOL, handshake, waitFor } from './rig/peer-handshake.mjs'

test('an inbound peer is served even when the socket names its peer a turn late', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-inbound-late-'))

  const file = path.join(root, 'fixture.bin')
  writeFixture(file, 4 * 1024 * 1024)
  const meta = makeTorrent({ file, pieceLength: 256 * 1024 })

  const rig = new Rig({
    storageDir: path.join(root, 'download'),
    enableDht: false,
    host: createLateEndpointHost((ready) => setTimeout(ready, 60)),
  })
  await rig.start()
  t.diagnostic('accepted sockets in this run cannot name their peer for 60ms after connection')

  // order is load-bearing, see inbound-accept.test.mjs
  let peerSocket = null
  t.after(async () => {
    peerSocket?.destroy()
    await rig.stop()
    fs.rmSync(root, { recursive: true, force: true })
  })

  const handle = rig.session.addMagnet(magnetFor(meta.infoHash, meta.name, []))
  assert.ok(handle >= 0 && handle < 0xFFFFFF00, `add failed, handle ${handle}`)
  rig.startPump([handle])

  const endpoint = await waitFor('listen_succeeded_alert', () => rig.metrics.listening.tcp)
  assert.equal(rig.metrics.listenFailed.length, 0, 'a listen failed')

  const LISTEN_PORT = rig.session.reachable().port
  assert.ok(LISTEN_PORT, 'no port was reserved, so there is nothing for a peer to dial')
  assert.match(endpoint, new RegExp(`:${LISTEN_PORT}$`), `listening on ${endpoint}, reserved ${LISTEN_PORT}`)

  await waitFor('the torrent to be registered', () => rig.session.status(handle) != null)
  assert.equal(rig.session.status(handle)?.numPeers ?? 0, 0, 'a peer arrived before the dial')

  const peerId = '-qB4650-latetest'.padEnd(20, '0').slice(0, 20)
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

  // The endpoint is the point: an accepted socket that could not name its peer is the failure this
  // covers, and libtorrent prints the peer it accepted into the alert.
  await waitFor('an incoming_connection_alert', () => rig.metrics.incoming.length > 0)
  const inbound = rig.metrics.incoming[0]
  assert.match(inbound.endpoint, /^127\.0\.0\.1:\d+$/, `unexpected endpoint ${inbound.endpoint}`)
  assert.equal(inbound.transport, 'tcp')

  await waitFor('numPeers to reach 1', () => (rig.session.status(handle)?.numPeers ?? 0) >= 1)

  const reachable = rig.session.reachable()
  assert.equal(reachable.inbound, 1, 'Session.reachable() missed the inbound peer')
  assert.equal(reachable.inboundByTransport.tcp, 1)
  assert.deepEqual(reachable.listenFailed, [])
})
