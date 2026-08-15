// Is the port we are telling people to dial one anybody can still reach?
//
// `Reachability` is otherwise entirely history: every field accumulates from alerts and stays true
// for the life of the session. That is the right shape for counters and for the last inbound peer,
// and exactly the wrong shape for the port, because the port is the one thing that can quietly
// stop being true with no alert at all.
//
// The mechanism behind that: libtorrent snapshots a listen socket's endpoint between bind and
// listen (session_impl.cpp:1790) and never refreshes it, so the announced number is fixed for the
// session. The sockets under it are not. When the tunnel drops, both reopens try to reclaim the
// same number and, after a couple of refusals, take whatever is free, which heals the socket and
// leaves the announce naming a port that now belongs to somebody else. Nothing is in an error
// state, nothing recovers, and a readout built only from alerts keeps reporting the dead number
// with total confidence.
//
// `portOpen` is that question answered against the fd table instead. See the sibling shim tests in
// listen-port.test.mjs for the fd table's own half.

import assert from 'node:assert/strict'
import test from 'node:test'

import { Session } from '../build/index.js'

/**
 * Enough of an LtModule to build a Session. Nothing here is reached by reachable(), which is the
 * point: the readout has to work off the shim and the alert stream, not off the wasm.
 */
const stubModule = (listeners) => ({
  HEAPU8: new Uint8Array(1024),
  HEAP32: new Int32Array(256),
  HEAPU32: new Uint32Array(256),
  _malloc: () => 0,
  _free: () => {},
  stringToNewUTF8: () => 0,
  UTF8ToString: () => '',
  _lt_set_utp_receive_buffer: () => {},
  _lt_set_dht: () => {},
  _lt_set_listen_port: () => {},
  _lt_session_create: () => 0,
  _lt_session_destroy: () => {},
  _lt_session_tick: () => {},
  _lt_session_pump_alerts: () => {},
  _lt_alerts_size: () => 0,
  _lt_alerts_data: () => 0,
  _lt_alerts_clear: () => {},
  _lt_set_log: () => {},
  __FKN: listeners === null ? undefined : { listeners: () => listeners, teardown() {} },
})

const PORT = 41337

const sessionOn = (listeners) => {
  const session = new Session(stubModule(listeners), { tickIntervalMs: 1 << 30 })
  session.setReservedPort(PORT)
  return session
}

const up = (transport, port) => ({ transport, port, up: true, healing: false, attempts: 0 })

test('a reservation held by live sockets reads as open', (t) => {
  const session = sessionOn([up('udp', PORT), up('tcp', PORT)])
  t.after(() => session.destroy())
  const reach = session.reachable()
  assert.equal(reach.port, PORT)
  assert.equal(reach.portOpen, true)
  assert.equal(reach.listeners.length, 2)
})

/**
 * A UDP-only reservation is a supported outcome, not a degraded one worth hiding. Peers dial uTP
 * first, so inbound works over the datagram socket with no acceptor at all, and reserve() gives up
 * TCP rather than the whole reservation for exactly that reason.
 */
test('a reservation with only its udp half still reads as open', (t) => {
  const session = sessionOn([up('udp', PORT)])
  t.after(() => session.destroy())
  assert.equal(session.reachable().portOpen, true)
})

test('a tunnel drop closes the port even though the announce cannot change', (t) => {
  const session = sessionOn([
    { transport: 'udp', port: PORT, up: false, healing: true, attempts: 1 },
    { transport: 'tcp', port: PORT, up: false, healing: true, attempts: 1 },
  ])
  t.after(() => session.destroy())
  const reach = session.reachable()
  // the number is still the honest answer to "what did we announce", so it stays
  assert.equal(reach.port, PORT, 'the announced port was rewritten, which the announce cannot be')
  assert.equal(reach.portOpen, false, 'a port nothing is bound to is being reported as reachable')
  assert.ok(reach.listeners.every((l) => l.healing), 'the reopen is invisible to a caller')
})

/**
 * The permanent case, and the one that motivated all of this. Everything reads healthy: sockets
 * up, no error, no failed listen, no reopen pending. The port is simply not the one that was
 * published, and it never will be again.
 */
test('an acceptor healed onto another port closes the announced one', (t) => {
  const session = sessionOn([up('udp', 45678), up('tcp', 45678)])
  t.after(() => session.destroy())
  const reach = session.reachable()
  assert.equal(reach.portOpen, false, 'a moved acceptor is being reported as holding the announce')
  assert.deepEqual(reach.listeners.map((l) => l.port), [45678, 45678])
})

test('no reservation is never open, whatever is bound', (t) => {
  const session = new Session(stubModule([up('udp', 51234)]), { tickIntervalMs: 1 << 30 })
  t.after(() => session.destroy())
  session.setReservedPort(null)
  const reach = session.reachable()
  assert.equal(reach.port, null)
  // an ephemeral socket receives nothing inbound: wrapper.cpp announced the placeholder, and
  // make_announce_port turns that into 1, a port that belongs to nobody
  assert.equal(reach.portOpen, false)
})

/**
 * A module with no shim is the unit-test case, and it has to answer rather than throw. Session is
 * built directly from stub modules in several suites, and reachable() is called on the way past.
 */
test('a module with no shim reports no listeners instead of throwing', (t) => {
  const session = sessionOn(null)
  t.after(() => session.destroy())
  const reach = session.reachable()
  assert.deepEqual(reach.listeners, [])
  assert.equal(reach.portOpen, false)
})

test('a shim whose listeners() throws is treated as having none', (t) => {
  const mod = stubModule([])
  mod.__FKN.listeners = () => { throw new Error('fd table is gone') }
  const session = new Session(mod, { tickIntervalMs: 1 << 30 })
  t.after(() => session.destroy())
  session.setReservedPort(PORT)
  assert.deepEqual(session.reachable().listeners, [])
  assert.equal(session.reachable().portOpen, false)
})

test('every read goes back to the fd table rather than to a cache', (t) => {
  let listeners = [up('tcp', PORT)]
  const mod = stubModule([])
  mod.__FKN.listeners = () => listeners
  const session = new Session(mod, { tickIntervalMs: 1 << 30 })
  t.after(() => session.destroy())
  session.setReservedPort(PORT)

  assert.equal(session.reachable().portOpen, true)
  listeners = [{ transport: 'tcp', port: PORT, up: false, healing: true, attempts: 1 }]
  assert.equal(session.reachable().portOpen, false, 'the readout answered from a snapshot taken earlier')
  listeners = [up('tcp', PORT)]
  assert.equal(session.reachable().portOpen, true, 'the readout never recovered')
})
