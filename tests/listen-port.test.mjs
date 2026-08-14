// Making the announced port true.
//
// The engine used to tell libtorrent it was listening on a hardcoded 6882 that nothing was bound
// to, so every peer that tried to dial in over TCP reached nothing. The port cannot be discovered
// after the fact either: libtorrent snapshots a listen socket's endpoint from getsockname between
// bind and listen and never refreshes it, and the shim's bind is asynchronous, so by the time the
// relay answers the number is already baked in.
//
// So it is reserved first. The host binds a UDP socket and a TCP listener on one shared number
// before the session exists, hands that number to wrapper.cpp, and the shim adopts those exact
// sockets rather than binding its own. These cover both halves: the reservation, and the adoption.
//
// The shared number matters as much as the truth does. The DHT stores exactly ONE port per peer,
// and implied_port makes storing nodes record the port our datagrams came from, so a TCP listener
// on a different number would still never be dialled.

import assert from 'node:assert/strict'
import dgramReal from 'node:dgram'
import netReal from 'node:net'
import { readFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import test from 'node:test'

import { reserveListenPort } from '../build/index.js'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'src', 'library_fkn.js'), 'utf8')

// ---------------------------------------------------------------- the reservation

test('reserves one port number held on both TCP and UDP', async () => {
  const reservation = await reserveListenPort(netReal, dgramReal)
  assert.ok(reservation, 'nothing was reserved')
  try {
    assert.equal(typeof reservation.port, 'number')
    assert.ok(reservation.port > 1024, `expected a high port, got ${reservation.port}`)
    // the point of the whole exercise: one number, both protocols, both actually bound
    assert.equal(reservation.udp.address().port, reservation.port, 'the UDP socket moved')
    assert.equal(reservation.server.address().port, reservation.port, 'the TCP listener moved')
  } finally {
    reservation.server.close()
    reservation.udp.close()
  }
})

test('the reserved TCP port really accepts a connection', async () => {
  const reservation = await reserveListenPort(netReal, dgramReal)
  assert.ok(reservation)
  try {
    const outcome = await new Promise((resolve) => {
      const socket = netReal.createConnection({ host: '127.0.0.1', port: reservation.port })
      const timer = setTimeout(() => { socket.destroy(); resolve('timeout') }, 3000)
      socket.on('connect', () => { clearTimeout(timer); socket.destroy(); resolve('connected') })
      socket.on('error', (e) => { clearTimeout(timer); resolve(`error ${e.code}`) })
    })
    assert.equal(outcome, 'connected')
  } finally {
    reservation.server.close()
    reservation.udp.close()
  }
})

/**
 * A stub host is the ordinary no-reservation case, not an error. Unit tests hand in net/dgram
 * objects that cannot make sockets at all, and a session still has to start: without a reservation
 * the engine runs on the placeholder port exactly as it did before any of this existed.
 */
test('a host that cannot bind yields no reservation instead of throwing', async () => {
  assert.equal(await reserveListenPort({}, {}), null)
  assert.equal(await reserveListenPort({ createServer: () => { throw new Error('nope') } }, {}), null)
})

test('a relay that grants a port other than the one asked for keeps only the udp half', async () => {
  // The contract is bind-exactly-or-fail. A third answer would put the announce back to being a
  // fiction, silently, so a mismatch is treated exactly like a refusal: the TCP half is dropped and
  // the announce is anchored on the UDP port, which is the one that must be true.
  const dgram = {
    createSocket: () => {
      const s = new EventEmitter()
      s.bind = () => setImmediate(() => s.emit('listening'))
      s.address = () => ({ address: '0.0.0.0', port: 41000, family: 'IPv4' })
      s.close = () => {}
      return s
    },
  }
  const net = {
    createServer: () => {
      const s = new EventEmitter()
      s.listen = () => setImmediate(() => s.emit('listening'))
      // grants something other than the 41000 it was asked for
      s.address = () => ({ address: '0.0.0.0', port: 41001, family: 'IPv4' })
      s.close = () => {}
      return s
    },
  }
  const reservation = await reserveListenPort(net, dgram, 2)
  assert.ok(reservation, 'a mismatched TCP grant threw away the working UDP reservation')
  assert.equal(reservation.server, null, 'kept a listener bound to a port other than the announced one')
  assert.equal(reservation.port, 41000, 'the announce must name the port the UDP socket really holds')
})

test('a refused TCP bind draws a fresh pair rather than giving up', async () => {
  let udpPort = 41000
  const dgram = {
    createSocket: () => {
      const s = new EventEmitter()
      const port = udpPort++
      s.bind = () => setImmediate(() => s.emit('listening'))
      s.address = () => ({ address: '0.0.0.0', port, family: 'IPv4' })
      s.close = () => {}
      return s
    },
  }
  let tcpAttempts = 0
  const net = {
    createServer: () => {
      const s = new EventEmitter()
      const mine = ++tcpAttempts
      s.listen = (port) => setImmediate(() => {
        // the host already holds the first number on TCP; the second draw succeeds
        if (mine === 1) s.emit('error', new Error('Address already in use (os error 98)'))
        else { s.granted = port; s.emit('listening') }
      })
      s.address = () => ({ address: '0.0.0.0', port: s.granted, family: 'IPv4' })
      s.close = () => {}
      return s
    },
  }
  const reservation = await reserveListenPort(net, dgram, 4)
  assert.ok(reservation, 'gave up instead of redrawing')
  assert.equal(reservation.port, 41001, 'kept the number whose TCP bind failed')
  assert.equal(tcpAttempts, 2)
})

// ---------------------------------------------------------------- the adoption

const makeDgram = (grantedPort) => {
  const sockets = []
  return {
    sockets,
    createSocket() {
      const sock = new EventEmitter()
      sock.bindCalls = []
      sock.closed = false
      sock.bind = (port, address) => { sock.bindCalls.push({ port, address }); sock.emit('listening') }
      sock.send = () => {}
      sock.close = () => { sock.closed = true }
      sock.address = () => ({ address: '0.0.0.0', port: grantedPort, family: 'IPv4' })
      sockets.push(sock)
      return sock
    },
  }
}

const makeNet = () => {
  const servers = []
  return {
    servers,
    createServer() {
      const srv = new EventEmitter()
      srv.listenCalls = []
      srv.closed = false
      srv.listen = (port, address) => { srv.listenCalls.push({ port, address }); srv.emit('listening') }
      srv.close = () => { srv.closed = true }
      srv.address = () => ({ address: '0.0.0.0', port: srv.listenCalls[0]?.port ?? 0, family: 'IPv4' })
      servers.push(srv)
      return srv
    },
  }
}

/**
 * `init` starts the tick MessageChannel, which keeps node's event loop alive and leaves the test
 * runner reporting every file as interrupted, so it is opt-in and the one test that uses it tears
 * it down. The others wire the same fields by hand, exactly as tests/udp-reopen.test.mjs does.
 */
const loadShim = (host, useInit = false) => {
  const heap = new Uint8Array(1 << 16)
  let library
  const addToLibrary = (obj) => { library = obj }
  const fn = new Function(
    'addToLibrary', 'Module', 'HEAPU8', 'HEAPU16', 'HEAPU32', 'performance', 'console',
    source + '\nreturn null',
  )
  const Module = { fkn: host }
  fn(addToLibrary, Module, heap, new Uint16Array(heap.buffer), new Uint32Array(heap.buffer),
    { now: () => 0 }, { log() {}, warn() {}, error() {} })

  const FKN = library.$FKN
  globalThis.FKN = FKN
  new Function('FKN', library.$FKN__postset)(FKN)
  globalThis.HEAPU8 = heap
  globalThis.HEAPU16 = new Uint16Array(heap.buffer)
  globalThis.HEAPU32 = new Uint32Array(heap.buffer)
  if (useInit) {
    // exactly what a real link does: read the host object rather than being handed the pieces
    FKN.init()
  } else {
    FKN.host = host
    FKN.net = host.net
    FKN.dgram = host.dgram
    FKN.storage = host.storage || null
    FKN.prebound = host.prebound || null
    FKN.initialized = true
  }
  FKN.scheduleTick = () => {}
  return { FKN, library, heap }
}

/** sockaddr_in as readSockaddr parses it: u16 family, u16 port big endian, 4 address bytes. */
const writeSockaddrIn = (heap, ptr, port, address) => {
  new Uint16Array(heap.buffer)[ptr >> 1] = 2
  heap[ptr + 2] = (port >> 8) & 0xff
  heap[ptr + 3] = port & 0xff
  address.split('.').forEach((octet, i) => { heap[ptr + 4 + i] = Number(octet) })
  return ptr
}

const PORT = 41337
const ADDR_PTR = 1024

const prebound = (net, dgram) => {
  const udp = dgram.createSocket({ type: 'udp4' })
  const server = net.createServer()
  return { port: PORT, server, udp, backlog: [], adopted: false }
}

test('init reads the reservation off the host object', (t) => {
  const dgram = makeDgram(PORT)
  const net = makeNet()
  const pre = prebound(net, dgram)
  const { FKN } = loadShim({ net, dgram, storage: null, prebound: pre }, true)
  // teardown closes the tick channel init just opened; without it node never exits
  t.after(() => FKN.teardown?.())
  assert.equal(FKN.prebound, pre)
})

test('a udp bind on the reserved port adopts the socket already holding it', () => {
  const dgram = makeDgram(PORT)
  const net = makeNet()
  const pre = prebound(net, dgram)
  const { FKN, library, heap } = loadShim({ net, dgram, storage: null, prebound: pre })

  const st = { kind: 'udp', family: 'IPv4', nonblock: false, socket: null, udpRecv: [], reopenAttempts: 0 }
  FKN._dbgWorkerUdpPkts = 0; FKN._dbgWorkerUdpBytes = 0
  FKN._dbgJsBusyUs = 0; FKN._dbgJsHandlerCalls = 0
  FKN.attachUdp(st)
  const throwaway = st.socket
  const fd = FKN.newFd(st)

  writeSockaddrIn(heap, ADDR_PTR, PORT, '0.0.0.0')
  assert.equal(library.$FKN_bind(fd, ADDR_PTR, 16), 0)

  assert.equal(st.socket, pre.udp, 'the fd did not take over the reserved socket')
  assert.equal(pre.udpTaken, true)
  assert.deepEqual(pre.udp.bindCalls, [], 'the reserved socket was re-bound, which the relay would refuse')
  assert.equal(throwaway.closed, true, 'the unbound socket made at socket() time was left open')
  assert.equal(st.localPort, PORT, 'getsockname would not report the reserved port')
  st.closed = true
})

/**
 * The bug this locks down: attachUdp's handlers close over the STATE, not over the socket they were
 * registered on. The socket discarded at adoption still carried handlers pointing at this same
 * state, so its 'close' fired reopenUdp and tore down the socket that had just been adopted.
 */
test('the discarded socket cannot tear down the one adopted in its place', async () => {
  const dgram = makeDgram(PORT)
  const net = makeNet()
  const pre = prebound(net, dgram)
  const { FKN, library, heap } = loadShim({ net, dgram, storage: null, prebound: pre })

  const st = { kind: 'udp', family: 'IPv4', nonblock: false, socket: null, udpRecv: [], reopenAttempts: 0 }
  FKN._dbgWorkerUdpPkts = 0; FKN._dbgWorkerUdpBytes = 0
  FKN._dbgJsBusyUs = 0; FKN._dbgJsHandlerCalls = 0
  FKN.attachUdp(st)
  const throwaway = st.socket
  const fd = FKN.newFd(st)
  writeSockaddrIn(heap, ADDR_PTR, PORT, '0.0.0.0')
  library.$FKN_bind(fd, ADDR_PTR, 16)

  const before = dgram.sockets.length
  throwaway.emit('close')
  throwaway.emit('error', new Error('late failure on a socket nobody is using'))
  await new Promise((resolve) => setTimeout(resolve, 350))

  assert.equal(st.socket, pre.udp, 'the adopted socket was replaced')
  assert.equal(st.dead, false, 'the fd was marked dead by a socket it no longer uses')
  assert.equal(dgram.sockets.length, before, 'a reopen was scheduled for a healthy socket')
  st.closed = true
})

test('a tcp listen on the reserved port adopts the listener and does not re-listen', () => {
  const dgram = makeDgram(PORT)
  const net = makeNet()
  const pre = prebound(net, dgram)
  // the reservation already listened on it, which is how it came to hold the port
  pre.server.listenCalls.push({ port: PORT, address: '0.0.0.0' })
  const { FKN, library } = loadShim({ net, dgram, storage: null, prebound: pre })

  const st = { kind: 'tcp-unbound', family: 'IPv4', nonblock: false, pendingBindPort: PORT, pendingBindAddr: '0.0.0.0' }
  const fd = FKN.newFd(st)

  assert.equal(library.$FKN_listen(fd), 0)
  assert.equal(st.server, pre.server, 'a second listener was created instead of adopting')
  assert.equal(pre.serverTaken, true)
  assert.equal(pre.adopted, true)
  assert.equal(net.servers.length, 1, 'createServer was called again')
  assert.deepEqual(pre.server.listenCalls, [{ port: PORT, address: '0.0.0.0' }],
    'listen() was called on a socket already holding the port, which the relay would refuse')
  assert.equal(st.localPort, PORT)
})

test('a connection accepted before the session existed is not dropped', () => {
  const dgram = makeDgram(PORT)
  const net = makeNet()
  const pre = prebound(net, dgram)
  // a socket, not a marker object: the queue now carries the endpoint snapshot beside it, and a
  // socket that cannot name its peer is deliberately held back rather than queued
  const early = {
    id: 'dialled during startup',
    localAddress: '0.0.0.0', localPort: PORT, localFamily: 'IPv4',
    remoteAddress: '203.0.113.7', remotePort: 51413, remoteFamily: 'IPv4',
  }
  pre.backlog.push(early)
  const { FKN, library } = loadShim({ net, dgram, storage: null, prebound: pre })

  const st = { kind: 'tcp-unbound', family: 'IPv4', nonblock: false, pendingBindPort: PORT, pendingBindAddr: '0.0.0.0' }
  const fd = FKN.newFd(st)
  library.$FKN_listen(fd)

  assert.equal(st.acceptQueue.length, 1, 'the parked connection was lost')
  assert.equal(st.acceptQueue[0].sock, early)
  assert.equal(st.acceptQueue[0].endpoints.remoteAddr, '203.0.113.7')
  assert.deepEqual(pre.backlog, [], 'the backlog was not drained')
})

/**
 * The live regression this closes. wrapper.cpp's placeholder port is host-global on the relay, which
 * runs with hostNetwork, so before the relay honoured a named port every client silently got an
 * ephemeral one and nobody collided. Once it started honouring the request, the second client to
 * ask for the placeholder was refused on BOTH protocols, taking out the UDP socket that carries the
 * working inbound uTP path. With no reservation the shim must ask for 0, never the placeholder.
 */
test('with no reservation the relay is asked for an ephemeral port, not the placeholder', () => {
  const dgram = makeDgram(50505)
  const net = makeNet()
  const { FKN, library, heap } = loadShim({ net, dgram, storage: null })
  assert.equal(FKN.prebound, null)

  const st = { kind: 'udp', family: 'IPv4', nonblock: false, socket: null, udpRecv: [], reopenAttempts: 0 }
  FKN._dbgWorkerUdpPkts = 0; FKN._dbgWorkerUdpBytes = 0
  FKN._dbgJsBusyUs = 0; FKN._dbgJsHandlerCalls = 0
  FKN.attachUdp(st)
  const fd = FKN.newFd(st)
  writeSockaddrIn(heap, ADDR_PTR, 6882, '0.0.0.0')
  library.$FKN_bind(fd, ADDR_PTR, 16)

  assert.deepEqual(st.socket.bindCalls, [{ port: 0, address: '0.0.0.0' }],
    'asked the relay for the host-global placeholder port')

  const tcp = { kind: 'tcp-unbound', family: 'IPv4', nonblock: false, pendingBindPort: 6882, pendingBindAddr: '0.0.0.0' }
  const tcpFd = FKN.newFd(tcp)
  library.$FKN_listen(tcpFd)
  assert.deepEqual(net.servers[0].listenCalls, [{ port: 0, address: '0.0.0.0' }],
    'asked the relay for the host-global placeholder port')
  st.closed = true
})

/**
 * Keeping the port across a reopen is worth one try, since peers learned it from implied_port. But
 * a named bind is a real bind now, and the socket just closed may not have been released yet, so
 * after one refusal take anything rather than lose the socket entirely.
 */
test('a reopen keeps the port once, then takes whatever is free', async () => {
  const dgram = makeDgram(PORT)
  const net = makeNet()
  const { FKN } = loadShim({ net, dgram, storage: null })

  const st = { kind: 'udp', family: 'IPv4', nonblock: false, socket: null, udpRecv: [], reopenAttempts: 0 }
  FKN._dbgWorkerUdpPkts = 0; FKN._dbgWorkerUdpBytes = 0
  FKN._dbgJsBusyUs = 0; FKN._dbgJsHandlerCalls = 0
  FKN.attachUdp(st)
  st.localAddr = '0.0.0.0'; st.localPort = PORT; st.localFamily = 'IPv4'; st.bound = true

  st.socket.emit('close')
  await new Promise((resolve) => setTimeout(resolve, 350))
  assert.deepEqual(dgram.sockets[1].bindCalls, [{ port: PORT, address: '0.0.0.0' }],
    'the first reopen gave up the port peers already know')

  st.socket.emit('close')
  await new Promise((resolve) => setTimeout(resolve, 1100))
  assert.deepEqual(dgram.sockets[2].bindCalls, [{ port: 0, address: '0.0.0.0' }],
    'kept asking for a port the relay had already refused')
  st.closed = true
})

// ------------------------------------------------------- naming the peer that dialled in

/**
 * @fkn/lib's Socket, in the one respect the shim depends on and node does not share.
 *
 * node fills an accepted socket's four endpoints in BEFORE it emits 'connection', so a consumer
 * reading them in that handler gets real values. @fkn/lib builds the Socket from a promise and
 * publishes them in a `.then()` while the emit is synchronous, and until that lands every address
 * getter THROWS `Socket is not connected` rather than answering undefined
 * (fkn/web src/lib/webvpn/net.ts:310-335 and :420-423). Measured in a browser against the live
 * relay on 2026-08-15, on every accepted socket, in both the page and the worker realm.
 */
const lateEndpointSocket = (publish) => {
  const endpoints = {
    localAddress: '0.0.0.0', localPort: PORT, localFamily: 'IPv4',
    remoteAddress: '198.51.100.9', remotePort: 6881, remoteFamily: 'IPv4',
  }
  let published = false
  publish(() => { published = true })
  const sock = new EventEmitter()
  sock.destroyed = false
  sock.destroy = () => { sock.destroyed = true }
  for (const [name, value] of Object.entries(endpoints)) {
    Object.defineProperty(sock, name, {
      get() {
        if (!published) throw new Error('Socket is not connected')
        return value
      },
    })
  }
  return sock
}

const listenFd = (FKN, library, net) => {
  const st = { kind: 'tcp-unbound', family: 'IPv4', nonblock: false, pendingBindPort: PORT, pendingBindAddr: '0.0.0.0' }
  const fd = FKN.newFd(st)
  assert.equal(library.$FKN_listen(fd), 0)
  return { st, fd, server: net.servers[net.servers.length - 1] }
}

/**
 * The regression. libtorrent calls remote_endpoint() the instant it accepts and, when that fails,
 * returns with NO alert and NO reply (libtorrent/src/session_impl.cpp:2989), so an accepted fd that
 * cannot name its peer is a peer whose connection is accepted and then hears nothing back. That is
 * indistinguishable, from outside, from the relay never delivering the connection at all.
 *
 * Before this, accept() read all six endpoints inside ONE try block, so the first throw abandoned
 * the other five and the fd was left with no remote address whatsoever.
 */
test('an accepted socket is never handed over before it can name its peer', async () => {
  const dgram = makeDgram(PORT)
  const net = makeNet()
  const { FKN, library, heap } = loadShim({ net, dgram, storage: null })
  const { st, fd, server } = listenFd(FKN, library, net)

  let release = () => {}
  const sock = lateEndpointSocket((ready) => { release = ready })
  server.emit('connection', sock)

  // a whole macrotask later and still unreadable: nothing may have been queued
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(st.acceptQueue.length, 0, 'a socket that cannot name its peer was queued')
  assert.equal(library.$FKN_accept(fd, ADDR_PTR, 0), -FKN.err.AGAIN)

  release()
  await new Promise((resolve) => setTimeout(resolve, 40))
  assert.equal(st.acceptQueue.length, 1, 'the socket was never queued once its endpoints landed')

  const newFd = library.$FKN_accept(fd, ADDR_PTR, 0)
  assert.ok(newFd > 0, `accept failed with ${newFd}`)
  const accepted = FKN.fds.get(newFd)
  assert.equal(accepted.remoteAddr, '198.51.100.9')
  assert.equal(accepted.remotePort, 6881)
  assert.equal(accepted.localPort, PORT)
  // what libtorrent actually calls: a null answer here is the silent drop this test exists for
  assert.equal(library.$FKN_getpeername(newFd, ADDR_PTR, 0), 0)
  assert.equal(heap[ADDR_PTR + 4], 198)
})

test('a socket whose endpoints never land is dropped rather than queued', async () => {
  const dgram = makeDgram(PORT)
  const net = makeNet()
  const { FKN, library } = loadShim({ net, dgram, storage: null })
  FKN.ACCEPT_ENDPOINT_ATTEMPTS = 2
  const { st, server } = listenFd(FKN, library, net)

  const sock = lateEndpointSocket(() => {})
  server.emit('connection', sock)

  await new Promise((resolve) => setTimeout(resolve, 120))
  assert.equal(st.acceptQueue.length, 0)
  assert.equal(sock.destroyed, true, 'the socket was leaked instead of being closed')
})
