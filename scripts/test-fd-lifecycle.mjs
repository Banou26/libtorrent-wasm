import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const emitter = (extra = {}) => {
  const listeners = new Map()
  return {
    on(event, listener) {
      const entries = listeners.get(event) ?? []
      entries.push(listener)
      listeners.set(event, entries)
      return this
    },
    ...extra,
  }
}

const main = async () => {
  let udpCloses = 0
  const net = {
    createServer: () => emitter({ listen() {}, close() {} }),
    connect: () => emitter({
      write: () => true,
      destroy() {},
      setNoDelay() {},
      setKeepAlive() {},
    }),
  }
  const dgram = {
    createSocket: () => emitter({
      bind() {},
      close() { udpCloses++ },
      send() {},
      address: () => ({ address: '0.0.0.0', family: 'IPv4', port: 6882 }),
    }),
  }

  globalThis.window = {}
  const { default: factory } = await import(resolve(root, 'build/libtorrent.js'))
  const wasmBinary = await readFile(resolve(root, 'build/libtorrent.wasm'))
  const nodeProcess = globalThis.process
  globalThis.process = undefined
  const mod = await factory({ wasmBinary, fkn: { net, dgram, storage: null } })
  globalThis.process = nodeProcess

  const originalLog = console.log
  console.log = () => {}
  try {
    assert.equal(mod._lt_session_create(), 0)
    for (let iteration = 0; iteration < 30; iteration++) mod._lt_session_tick()

    const baseline = mod.__FKN.fds.size
    let maxFd = 0
    for (let iteration = 0; iteration < 2_500; iteration++) {
      const fd = mod._lt_diag_open_tcp()
      maxFd = Math.max(maxFd, fd)
      assert.ok(fd >= 16 && fd < 1024, `TCP fd out of range: ${fd}`)
      assert.equal(mod.__FKN.fds.size, baseline)
    }

    const closesBefore = udpCloses
    for (let iteration = 0; iteration < 100; iteration++) {
      const fd = mod._lt_diag_open_udp()
      maxFd = Math.max(maxFd, fd)
      assert.ok(fd >= 16 && fd < 1024, `UDP fd out of range: ${fd}`)
      assert.equal(mod.__FKN.fds.size, baseline)
    }
    assert.equal(udpCloses - closesBefore, 100)
    originalLog(`fd lifecycle passed: max fd ${maxFd}, active ${baseline}`)
  } finally {
    mod._lt_session_destroy()
    mod.__FKN?._mc?.port1.close()
    mod.__FKN?._mc?.port2.close()
    console.log = originalLog
  }
}

main().then(
  () => process.exit(0),
  error => {
    console.error(error)
    process.exit(1)
  },
)
