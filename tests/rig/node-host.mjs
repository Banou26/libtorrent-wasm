// node's net/dgram, adapted to what the WASM socket shim expects.
//
// The shim in src/library_fkn.js was written against @fkn/lib, whose modules are
// node-API-shaped by design, so the call surface already matches: net.connect,
// net.createServer, dgram.createSocket, and the connect/data/end/close/error and
// message/listening events. Nothing needs wrapping there.
//
// One thing does. The shim reads `err.errno` off an error event and later hands
// it back to libtorrent negated (`return -e`, library_fkn.js:443). Its table is
// WASI's (library_fkn.js:10-23, EAGAIN 6, ECONNRESET 15), while node reports
// libuv's NEGATIVE errno (ECONNRESET is -104 on linux). Passed through raw, a
// failure is negated into a POSITIVE value, which libtorrent reads as a
// successful short result instead of an error, so a refused or reset peer looks
// like a working one that returned nothing.

import net from 'node:net'
import dgram from 'node:dgram'

// library_fkn.js:10-23. Only the codes the shim itself can produce are listed;
// anything else maps to EIO, which is the shim's own fallback.
const WASI_EIO = 29
const CODE_TO_WASI = {
  EAGAIN: 6,
  EWOULDBLOCK: 6,
  EBADF: 8,
  ECONNREFUSED: 14,
  ECONNRESET: 15,
  EPIPE: 15,
  ECONNABORTED: 15,
  EFAULT: 21,
  EINPROGRESS: 26,
  EINVAL: 28,
  EIO: 29,
  EMFILE: 33,
  ENFILE: 33,
  ENOTCONN: 53,
  ENOTSOCK: 57,
  ETIMEDOUT: 73,
  EHOSTUNREACH: 73,
  ENETUNREACH: 73,
  EADDRINUSE: 28,
  EADDRNOTAVAIL: 28,
}

// Registered before the shim's own handler, so mutating in place is enough:
// EventEmitter runs listeners in registration order.
const normalizeErrno = (err) => {
  if (err && typeof err === 'object') err.errno = CODE_TO_WASI[err.code] ?? WASI_EIO
}

/**
 * @param {{ onError?: (kind: string, err: Error) => void }} [opts]
 *   onError observes every socket error for diagnostics. It does not suppress
 *   anything; the shim still sees the event.
 */
export const createNodeHost = (opts = {}) => {
  const seen = { tcpErrors: 0, udpErrors: 0, serverErrors: 0 }
  const watch = (kind, emitter, counter) => {
    emitter.on('error', (err) => {
      normalizeErrno(err)
      seen[counter]++
      opts.onError?.(kind, err)
    })
    return emitter
  }

  return {
    stats: seen,
    net: {
      connect: (options, ...rest) => watch('tcp', net.connect(options, ...rest), 'tcpErrors'),
      createServer: (...args) => watch('server', net.createServer(...args), 'serverErrors'),
    },
    dgram: {
      createSocket: (options, ...rest) => watch('udp', dgram.createSocket(options, ...rest), 'udpErrors'),
    },
  }
}
