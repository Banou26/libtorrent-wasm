// Who are we connected to, and where did we hear about them?
//
// A torrent client shows this and ripple could not, because nothing in the engine exposed it: the
// only per-peer datum that crossed into JS was a session-wide count. These cover the two new
// records that carry the lists.
//
// Both are ASYNCHRONOUS, and that is not a style choice. `torrent_handle::get_peer_info()` and
// `::trackers()` are sync_calls on an io_context that only runs inside lt_session_tick(), so
// reading either from JS blocks the very thread that has to tick for it to return. The engine
// posts the answer onto the alert stream instead, exactly as it does for status. The failure mode
// when this is got wrong is a permanent hang, which lt_diag_listen_port() shipped with and which
// is why it no longer exists.
//
// The consequence for a caller: THESE ONLY RESOLVE IF SOMETHING IS PUMPING ALERTS. Every test here
// runs the rig's pump for that reason.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { PEER_FLAG, PEER_SOURCE } from '../build/index.js'
import { Rig } from './rig/harness.mjs'
import { magnetFor, makeTorrent, writeFixture } from './rig/make-torrent.mjs'
import { handshake, waitFor } from './rig/peer-handshake.mjs'

const TRACKERS = [
  'udp://tracker.example.invalid:6969/announce',
  'http://tracker2.example.invalid:80/announce',
]

/**
 * waitFor() for an ASYNC predicate.
 *
 * The rig's waitFor calls its predicate and tests the result for truthiness without awaiting it, so
 * an async predicate hands it a Promise, which is always truthy: it returns on the first tick with
 * a Promise the caller then awaits down to whatever the answer actually was. That reads as a
 * passing wait followed by a failing assertion, which is a confusing way to be told the wait never
 * happened. Everything peers() and trackers() answer is a promise, so they need this.
 */
const pollUntil = async (what, predicate, timeoutMs = 20_000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`)
}

const withRig = async (t, { trackers = [] } = {}) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-peers-'))
  const file = path.join(root, 'fixture.bin')
  writeFixture(file, 2 * 1024 * 1024)
  const meta = makeTorrent({ file, pieceLength: 256 * 1024 })

  const rig = new Rig({ storageDir: path.join(root, 'download'), enableDht: false })
  await rig.start()

  const sockets = []
  t.after(async () => {
    for (const s of sockets) s.destroy()
    await rig.stop()
    fs.rmSync(root, { recursive: true, force: true })
  })

  let magnet = magnetFor(meta.infoHash, meta.name, [])
  // the trackers are unresolvable on purpose: this asserts that the LIST is reported, and a
  // reachable tracker would make the assertions depend on the network
  for (const tr of trackers) magnet += `&tr=${encodeURIComponent(tr)}`

  const handle = rig.session.addMagnet(magnet)
  assert.ok(handle >= 0 && handle < 0xFFFFFF00, `add failed, handle ${handle}`)
  rig.startPump([handle])
  await waitFor('the torrent to be registered', () => rig.session.status(handle) != null)
  return { rig, meta, handle, sockets }
}

// ---------------------------------------------------------------- peers

test('an inbound peer shows up in the peer list, named and attributed', async (t) => {
  const { rig, meta, handle, sockets } = await withRig(t)

  // Nobody is connected yet, and an empty list is a real answer rather than a missing one
  assert.deepEqual(await rig.session.peers(handle), [], 'a peer existed before anything dialled')

  const port = rig.session.reachable().port
  assert.ok(port, 'no port was reserved, so there is nothing to dial')

  const peerId = '-qB4650-peerlisttest'.padEnd(20, '0').slice(0, 20)
  await new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port })
    sockets.push(socket)
    const timer = setTimeout(() => reject(new Error('no handshake back within 15s')), 15_000)
    socket.on('connect', () => socket.write(handshake(meta.infoHash, peerId)))
    socket.on('data', () => { clearTimeout(timer); resolve() })
    socket.on('error', (error) => { clearTimeout(timer); reject(error) })
  })

  await waitFor('numPeers to reach 1', () => (rig.session.status(handle)?.numPeers ?? 0) >= 1)

  const peers = await rig.session.peers(handle)
  assert.equal(peers.length, 1, `expected one peer, got ${JSON.stringify(peers)}`)
  const peer = peers[0]

  assert.match(peer.endpoint, /^127\.0\.0\.1:\d+$/, `unexpected endpoint ${peer.endpoint}`)
  // whatever the remote called itself, which here is the peer id we sent
  assert.equal(typeof peer.client, 'string')

  // The attribution is the interesting half. This peer dialled US, so it must NOT be flagged as a
  // local connection and its source must be `incoming`; getting these backwards would make an
  // inbound peer indistinguishable from one we found on a tracker.
  assert.equal(peer.flags & PEER_FLAG.localConnection, 0, 'an inbound peer was flagged as outgoing')
  assert.ok(peer.source & PEER_SOURCE.incoming, `source ${peer.source} does not include incoming`)

  // every numeric field decoded as a number rather than as NaN or undefined, which is what a
  // one-field offset error in the decoder looks like
  for (const key of [
    'downloadRate', 'uploadRate', 'payloadDownloadRate', 'payloadUploadRate',
    'totalDownload', 'totalUpload', 'progress', 'rtt', 'numPieces', 'requestsInFlight', 'failCount',
  ]) {
    assert.equal(typeof peer[key], 'number', `${key} is ${peer[key]}`)
    assert.ok(Number.isFinite(peer[key]), `${key} is ${peer[key]}`)
  }
  // a fresh peer has nothing yet, and progress is a fraction rather than the ppm on the wire
  assert.ok(peer.progress >= 0 && peer.progress <= 1, `progress ${peer.progress} is not a fraction`)
})

test('the peer list survives a peer going away', async (t) => {
  const { rig, meta, handle, sockets } = await withRig(t)
  const port = rig.session.reachable().port

  const socket = net.createConnection({ host: '127.0.0.1', port })
  sockets.push(socket)
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no handshake back within 15s')), 15_000)
    socket.on('connect', () => socket.write(handshake(meta.infoHash, '-qB4650-goesaway000')))
    socket.on('data', () => { clearTimeout(timer); resolve() })
    socket.on('error', (error) => { clearTimeout(timer); reject(error) })
  })
  await pollUntil('the peer to appear', async () => (await rig.session.peers(handle)).length === 1)

  socket.destroy()
  await pollUntil('the peer to disappear', async () => (await rig.session.peers(handle)).length === 0)
})

test('lastPeers answers from the previous reply without asking again', async (t) => {
  const { rig, handle } = await withRig(t)
  assert.deepEqual(rig.session.lastPeers(handle), [], 'a list existed before anything was asked for')
  await rig.session.peers(handle)
  assert.deepEqual(rig.session.lastPeers(handle), [], 'the cached list disagrees with the fetched one')
})

// ---------------------------------------------------------------- trackers

test('the tracker list reports every tracker in the magnet, in tier order', async (t) => {
  const { rig, handle } = await withRig(t, { trackers: TRACKERS })

  const trackers = await rig.session.trackers(handle)
  assert.equal(trackers.length, TRACKERS.length, `got ${JSON.stringify(trackers.map((x) => x.url))}`)
  assert.deepEqual(trackers.map((t) => t.url).sort(), [...TRACKERS].sort())

  for (const tracker of trackers) {
    assert.equal(typeof tracker.tier, 'number')
    assert.equal(typeof tracker.updating, 'boolean')
    assert.equal(typeof tracker.verified, 'boolean')
    assert.equal(typeof tracker.message, 'string')
    // never scraped, so every count is the -1 that says so rather than a zero that reads as real
    assert.equal(tracker.seeders, -1, 'an unscraped tracker reported a seeder count')
    assert.equal(tracker.leechers, -1)
    assert.equal(tracker.downloaded, -1)
  }
})

test('a torrent with no trackers reports none rather than failing', async (t) => {
  const { rig, handle } = await withRig(t)
  assert.deepEqual(await rig.session.trackers(handle), [])
})

/**
 * A handle that does not exist must ANSWER, not hang. The post is refused in C++ (lookup_handle
 * returns null), so no alert is ever emitted and nothing would settle the promise; the timeout is
 * what makes that a bounded empty answer instead of a leak. Deliberately resolves rather than
 * rejecting: a caller polling a panel wants the last list, not an exception every tick.
 */
test('an unknown handle resolves empty instead of hanging', async (t) => {
  const { rig } = await withRig(t)
  const started = Date.now()
  assert.deepEqual(await rig.session.peers(0xDEADBEEF, 300), [])
  assert.deepEqual(await rig.session.trackers(0xDEADBEEF, 300), [])
  assert.ok(Date.now() - started < 5_000, 'the timeouts did not bound the wait')
})

/**
 * Two callers asking at once must both get the answer. The reply carries a handle and nothing
 * else, so a decoder that settled only the first waiter would leave the second hanging until its
 * own timeout, which reads as a slow engine rather than as a bug.
 */
test('concurrent askers all get the reply', async (t) => {
  const { rig, handle } = await withRig(t, { trackers: TRACKERS })
  const [a, b, c] = await Promise.all([
    rig.session.trackers(handle),
    rig.session.trackers(handle),
    rig.session.trackers(handle),
  ])
  assert.equal(a.length, TRACKERS.length)
  assert.deepEqual(a, b)
  assert.deepEqual(b, c)
})
