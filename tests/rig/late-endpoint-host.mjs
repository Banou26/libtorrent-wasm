// node's net, made to behave like @fkn/lib's on an inbound connection.
//
// This is the one fidelity gap that hid an inbound failure for a whole release. node fills an
// accepted socket's four address fields in BEFORE it emits 'connection', so anything reading them
// in that handler gets real values. @fkn/lib does not: its Server builds the Socket from a promise
// and publishes the endpoints in a `.then()`, while `emit('connection', socket)` runs synchronously
// in the same turn, and until that microtask lands every address getter THROWS
// `Socket is not connected` rather than answering undefined.
//
//   fkn/web src/lib/webvpn/net.ts:310-335   the six getters, each `if (!this._localAddress) throw`
//   fkn/web src/lib/webvpn/net.ts:420-423   `new Socket({...}); this.emit('connection', socket)`
//   fkn/web src/lib/webvpn/net.ts:62-80     `_localAddress` / `_remoteAddress` set in a `.then()`
//
// libtorrent calls remote_endpoint() the instant it accepts and returns without an alert and
// without a reply when it fails (libtorrent/src/session_impl.cpp:2989), so a socket handed over
// before its endpoints read is a peer that connects and then hears nothing. Reproducing the throw
// is the only way a node test can see that.

import { EventEmitter } from 'node:events'

import { createNodeHost } from './node-host.mjs'

const ENDPOINT_PROPERTIES = new Set([
  'localAddress', 'localPort', 'localFamily',
  'remoteAddress', 'remotePort', 'remoteFamily',
])

/** The socket a consumer sees: identical to node's, except the endpoints arrive one turn late. */
const withLateEndpoints = (socket, publish) => {
  let published = false
  publish(() => { published = true })
  return new Proxy(socket, {
    get(target, property, receiver) {
      if (!published && ENDPOINT_PROPERTIES.has(property)) {
        throw new Error('Socket is not connected')
      }
      const value = Reflect.get(target, property, receiver)
      // bound to the real socket: node's internals reject a Proxy as their own `this`
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

/**
 * @param {(ready: () => void) => void} [publish]
 *   when the endpoints become readable.
 *
 * The default is one microtask, which is @fkn/lib's own timing. Note that the shim defers its
 * accept to a tick and a tick is a task, so one microtask of lateness never reaches accept(): a
 * caller that wants to exercise the window has to pass a delay that clears the tick. See the
 * comment in tests/inbound-late-endpoints.test.mjs.
 */
export const createLateEndpointHost = (publish = (ready) => setTimeout(ready, 0)) => {
  const host = createNodeHost()
  return {
    ...host,
    net: {
      ...host.net,
      // @fkn/lib's Server is an EventEmitter carrying listen/close/address and nothing else, so the
      // facade is the whole surface rather than a subset of node's Server.
      createServer: (...args) => {
        const real = host.net.createServer(...args)
        const facade = new EventEmitter()
        real.on('connection', (socket) => facade.emit('connection', withLateEndpoints(socket, publish)))
        for (const event of ['error', 'listening', 'close']) {
          real.on(event, (...payload) => facade.emit(event, ...payload))
        }
        facade.listen = (...listenArgs) => { real.listen(...listenArgs); return facade }
        facade.close = (...closeArgs) => { real.close(...closeArgs); return facade }
        facade.address = () => real.address()
        return facade
      },
    },
  }
}
