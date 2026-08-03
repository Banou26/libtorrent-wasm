// The UDP socket under a fd does not survive losing the connection, and nothing above the
// shim can see that happen: a dead socket still accepts send(). These cover the shim healing itself.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import test from 'node:test'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'src', 'library_fkn.js'), 'utf8')

const makeDgram = () => {
  const sockets = []
  return {
    sockets,
    createSocket() {
      const sock = new EventEmitter()
      sock.bindCalls = []
      sock.sent = []
      sock.closed = false
      sock.bind = (port, address) => { sock.bindCalls.push({ port, address }); sock.emit('listening') }
      sock.send = (buf, offset, length, port, address) => { sock.sent.push({ length, port, address }) }
      sock.close = () => { sock.closed = true }
      sock.address = () => ({ address: '0.0.0.0', port: 6882, family: 'IPv4' })
      sockets.push(sock)
      return sock
    },
  }
}

const loadShim = (dgram) => {
  const heap = new Uint8Array(1 << 16)
  let library
  const addToLibrary = (obj) => { library = obj }
  const fn = new Function(
    'addToLibrary', 'Module', 'HEAPU8', 'HEAPU16', 'HEAPU32', 'performance', 'console',
    source + '\nreturn null',
  )
  fn(addToLibrary, { fkn: { net: {}, dgram, storage: null } }, heap,
    new Uint16Array(heap.buffer), new Uint32Array(heap.buffer),
    { now: () => 0 }, { log() {}, warn() {}, error() {} })

  // Emscripten emits `$FKN` as a module-level `var FKN`, so the member functions refer to the bare identifier
  const FKN = library.$FKN
  globalThis.FKN = FKN
  // $FKN__postset is what fills the fd table at link time; there is no linker here.
  const postset = library.$FKN__postset
  new Function('FKN', postset)(FKN)
  FKN.dgram = dgram
  FKN.net = {}
  FKN.scheduleTick = () => {}
  return { FKN, library, heap }
}

// Timers outlive the test that scheduled them, and every shim shares one global FKN
const settled = (st) => { st.closed = true }

const boundUdpState = (FKN) => {
  const st = { kind: 'udp', family: 'IPv4', nonblock: false, socket: null, udpRecv: [], reopenAttempts: 0 }
  FKN._dbgWorkerUdpPkts = 0
  FKN._dbgWorkerUdpBytes = 0
  FKN._dbgJsBusyUs = 0
  FKN._dbgJsHandlerCalls = 0
  FKN.attachUdp(st)
  st.socket.bind(6882, '0.0.0.0')
  st.localAddr = '0.0.0.0'
  st.localPort = 6882
  st.localFamily = 'IPv4'
  st.bound = true
  return st
}

test('a closed socket is replaced and re-bound to the same port', async () => {
  const dgram = makeDgram()
  const { FKN } = loadShim(dgram)
  const st = boundUdpState(FKN)
  assert.equal(dgram.sockets.length, 1)

  st.socket.emit('error', Object.assign(new Error('WebVPN session closed'), { errno: 5 }))
  st.socket.emit('close')
  assert.equal(st.dead, true, 'the socket is marked dead straight away')

  await new Promise((resolve) => setTimeout(resolve, 400))

  assert.equal(dgram.sockets.length, 2, 'a replacement socket was created')
  assert.equal(st.socket, dgram.sockets[1], 'the fd now points at the replacement')
  assert.deepEqual(dgram.sockets[1].bindCalls, [{ port: 6882, address: '0.0.0.0' }],
    'the replacement is back on the endpoint peers and trackers already have')
  assert.equal(st.dead, false, 'the fd is usable again')
  settled(st)
})

test('error and close together only produce one replacement', async () => {
  const dgram = makeDgram()
  const { FKN } = loadShim(dgram)
  const st = boundUdpState(FKN)

  st.socket.emit('error', new Error('WebVPN session closed'))
  st.socket.emit('close')
  st.socket.emit('close')
  await new Promise((resolve) => setTimeout(resolve, 400))

  assert.equal(dgram.sockets.length, 2, 'the three events are one outage, not three')
  assert.equal(st.reopenAttempts, 1)
  settled(st)
})

test('sends report EAGAIN while the socket is gone instead of claiming success', async () => {
  const dgram = makeDgram()
  const { FKN, library, heap } = loadShim(dgram)
  const st = boundUdpState(FKN)
  const fd = FKN.newFd(st)

  // A sockaddr_in for 1.2.3.4:6881
  const addrPtr = 1024
  heap[addrPtr] = 2
  heap[addrPtr + 1] = 0
  new DataView(heap.buffer).setUint16(addrPtr + 2, 6881, false)
  heap.set([1, 2, 3, 4], addrPtr + 4)

  const sendto = library.$FKN_sendto.bind({})
  const before = sendto(fd, 2048, 16, 0, addrPtr, 16)
  assert.equal(before, 16, 'a healthy socket reports the bytes sent')

  st.socket.emit('close')
  const during = sendto(fd, 2048, 16, 0, addrPtr, 16)
  assert.equal(during, -FKN.err.AGAIN,
    'a send over a socket that is gone must not be reported as delivered')

  await new Promise((resolve) => setTimeout(resolve, 400))
  const after = sendto(fd, 2048, 16, 0, addrPtr, 16)
  assert.equal(after, 16, 'once the replacement is up, sends work again')
  assert.equal(dgram.sockets[1].sent.length, 1, 'and they go out over the new socket')
  settled(st)
})

test('repeated failures back off, and traffic resets the schedule', async () => {
  const dgram = makeDgram()
  const { FKN } = loadShim(dgram)
  const st = boundUdpState(FKN)

  st.socket.emit('close')
  await new Promise((resolve) => setTimeout(resolve, 400))
  assert.equal(st.reopenAttempts, 1)

  st.socket.emit('close')
  await new Promise((resolve) => setTimeout(resolve, 400))
  // 400 is chosen against UDP_REOPEN_DELAYS[1] = 1000: the second delay is a full second, so nothing has been rebuilt yet at 400ms, and changing the delay table breaks this assertion
  assert.equal(st.reopenAttempts, 2)
  assert.equal(dgram.sockets.length, 2, 'the second attempt waits longer than the first')

  await new Promise((resolve) => setTimeout(resolve, 900))
  assert.equal(dgram.sockets.length, 3)

  st.socket.emit('message', new Uint8Array([1, 2, 3]), { address: '1.2.3.4', port: 6881, family: 'IPv4' })
  assert.equal(st.reopenAttempts, 0)
  settled(st)
})

test('closing the fd does not trigger a reopen', async () => {
  const dgram = makeDgram()
  const { FKN } = loadShim(dgram)
  const st = boundUdpState(FKN)
  const fd = FKN.newFd(st)

  FKN.closeFd(fd)
  st.socket.emit('close')
  await new Promise((resolve) => setTimeout(resolve, 400))

  assert.equal(dgram.sockets.length, 1, 'a deliberate close is not an outage')
})
