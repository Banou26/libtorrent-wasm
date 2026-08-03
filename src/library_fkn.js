addToLibrary({
  $FKN__deps: ['$ERRNO_CODES'],
  // emscripten's jsifier JSON-serializes this object's data members, so a live `new Map()` in the literal below becomes `{}`
  $FKN__postset: 'FKN.fds = new Map(); FKN.freeFds = [];',
  $FKN: {
    initialized: false,
    debug: false,

    // Emscripten uses WASI errno values, NOT Linux's; anything we set/return as an errno from this file MUST use these
    err: {
      AGAIN: 6,
      BADF: 8,
      CONNREFUSED: 14,
      CONNRESET: 15,
      FAULT: 21,
      INPROGRESS: 26,
      INVAL: 28,
      IO: 29,
      MFILE: 33,
      NOTCONN: 53,
      NOTSOCK: 57,
      TIMEDOUT: 73,
    },

    // Asio's select_reactor on Emscripten uses select() with FD_SETSIZE=1024, so fds must stay strictly below that
    // start at 16 to leave libc room for stdio (0-2) and any sockfs entries Emscripten allocates before the shim takes over; closeFd's `fd >= 16 && fd < 1024` reuse guard is coupled to this value and to FD_SETSIZE
    nextFd: 16,
    fds: null,
    freeFds: null,

    pendingTick: false,
    // a MessageChannel post has no 4ms setTimeout-min-delay floor and doesn't starve macrotasks the way self-rearming queueMicrotask does
    scheduleTick() {
      FKN.stats.schedule++
      if (FKN.pendingTick) return
      FKN.pendingTick = true
      if (FKN.tickIdle) {
        setTimeout(FKN._doTick, 16)
      } else {
        FKN._mc.port2.postMessage(null)
      }
    },
    tickIdle: true,
    _doTick() {
      FKN.pendingTick = false
      if (!Module._lt_session_tick) return
      FKN.stats.tick++
      const ran = Module._lt_session_tick()
      FKN.tickIdle = (ran === 0)
      if (ran > 0) FKN.scheduleTick()
    },
    _mcInit() {
      if (FKN._mc) return
      FKN._mc = new MessageChannel()
      FKN._mc.port1.onmessage = FKN._doTick
    },

    stats: {
      socket: 0, bind: 0, listen: 0, accept: 0, connect: 0, close: 0,
      recv: 0, recvfrom: 0, send: 0, sendto: 0,
      poll: 0, pollReady: 0, pollCalls: 0,
      setsockopt: 0, getsockopt: 0, getsockname: 0, getpeername: 0, fcntl: 0, ioctl: 0,
      schedule: 0, tick: 0,
      udpRx: 0, udpTx: 0, tcpRx: 0, tcpTx: 0,
      dnsReq: 0, dnsDone: 0,
      diskRead: 0, diskWrite: 0,
    },

    storage: null,

    newFd(state) {
      const fd = FKN.freeFds.length
        ? FKN.freeFds.pop()
        : FKN.nextFd < 1024 ? FKN.nextFd++ : -1
      if (fd < 0) {
        FKN.closeState(state)
        return -FKN.err.MFILE
      }
      state.error = 0
      state.recv = state.recv || { chunks: [], total: 0, fin: false, error: 0 }
      state.writable = true
      FKN.fds.set(fd, state)
      return fd
    },

    closeState(state) {
      try {
        if (state.socket?.destroy) state.socket.destroy()
        else if (state.socket?.close) state.socket.close()
        if (state.server) state.server.close()
      } catch (e) {}
    },

    closeFd(fd) {
      const s = FKN.fds.get(fd)
      if (!s) return
      FKN.fds.delete(fd)
      if (fd >= 16 && fd < 1024) FKN.freeFds.push(fd)
      // marked before tearing it down, so the close handler reads this as the fd going away rather than an outage worth reopening for
      s.closed = true
      FKN.closeState(s)
    },

    // the datagram socket under a udp fd does not survive losing the connection, so the fd keeps its identity and the socket underneath is replaced, re-bound to the same local port
    UDP_REOPEN_DELAYS: [250, 1000, 3000, 10000, 30000],

    attachUdp(st) {
      const sock = FKN.dgram.createSocket({ type: st.family === 'IPv6' ? 'udp6' : 'udp4' })
      st.socket = sock
      st.dead = false

      sock.on('message', (data, rinfo) => {
        const _t0 = performance.now()
        FKN._dbgWorkerUdpPkts++
        FKN._dbgWorkerUdpBytes += data.length || data.byteLength || 0
        // CRITICAL: copy the buffer - @fkn/lib's WebTransport datagram reader re-uses backing buffers across reads
        const src = data instanceof Uint8Array ? data : new Uint8Array(data.buffer || data)
        const copy = new Uint8Array(src.length)
        copy.set(src)
        st.udpRecv.push({
          data: copy,
          address: rinfo.address, port: rinfo.port, family: rinfo.family,
        })
        st.reopenAttempts = 0
        FKN.scheduleTick()
        FKN._dbgJsBusyUs += (performance.now() - _t0) * 1000
        FKN._dbgJsHandlerCalls++
      })
      sock.on('error', (err) => {
        st.error = err.errno || FKN.err.IO
        FKN.reopenUdp(st, 'error')
      })
      // a dropped tunnel usually looks like a clean close rather than an error
      sock.on('close', () => FKN.reopenUdp(st, 'close'))
      sock.on('listening', () => {
        const a = sock.address()
        st.localAddr = a.address; st.localPort = a.port; st.localFamily = a.family
      })

      if (st.bound) {
        try { sock.bind(st.localPort, st.localAddr) }
        catch (e) { FKN.reopenUdp(st, 'bind') }
      }
      return sock
    },

    reopenUdp(st, why) {
      if (st.closed || st.reopening) return
      st.dead = true
      st.reopening = true
      FKN.stats.udpReopen = (FKN.stats.udpReopen || 0) + 1
      const attempt = st.reopenAttempts || 0
      st.reopenAttempts = attempt + 1
      const delay = FKN.UDP_REOPEN_DELAYS[Math.min(attempt, FKN.UDP_REOPEN_DELAYS.length - 1)]
      console.warn('[FKN] udp socket ' + why + ', reopening in ' + delay + 'ms (attempt ' + st.reopenAttempts + ')')
      setTimeout(() => {
        st.reopening = false
        if (st.closed) return
        try { st.socket?.close?.() } catch (e) {}
        try {
          FKN.attachUdp(st)
          FKN.scheduleTick()
        } catch (e) {
          FKN.reopenUdp(st, 'reopen-failed')
        }
      }, delay)
    },

    init() {
      if (FKN.initialized) return
      const host = Module.fkn
      if (!host || !host.net || !host.dgram) {
        throw new Error('Module.fkn = { net, dgram, storage } must be set before _lt_session_create()')
      }
      FKN.debug = !!host.debug
      if (FKN.debug) console.log('[FKN] init')
      FKN.host = host
      FKN.net = host.net
      FKN.dgram = host.dgram
      FKN.storage = host.storage || null
      FKN.initialized = true
      if (typeof Module === 'object') Module.__FKN = FKN
      FKN._mcInit()
    },

    // sockaddr_in: u16 family, u16 port (BE), u32 addr (BE), 8 pad; sockaddr_in6: u16 family, u16 port (BE), u32 flowinfo, 16 addr, u32 scope
    readSockaddr(ptr, len) {
      const fam = HEAPU16[ptr >> 1]
      if (fam === 2) {
        const port = (HEAPU8[ptr + 2] << 8) | HEAPU8[ptr + 3]
        const a = HEAPU8[ptr + 4], b = HEAPU8[ptr + 5]
        const c = HEAPU8[ptr + 6], d = HEAPU8[ptr + 7]
        return { family: 'IPv4', port, address: `${a}.${b}.${c}.${d}` }
      }
      if (fam === 10) {
        const port = (HEAPU8[ptr + 2] << 8) | HEAPU8[ptr + 3]
        const bytes = HEAPU8.subarray(ptr + 8, ptr + 24)
        const groups = []
        for (let i = 0; i < 16; i += 2) {
          groups.push(((bytes[i] << 8) | bytes[i + 1]).toString(16))
        }
        return { family: 'IPv6', port, address: groups.join(':') }
      }
      return null
    },

    writeSockaddr(ptr, lenPtr, ep) {
      if (!ptr || !ep) return
      const max = lenPtr ? HEAP32[lenPtr >> 2] : 16
      if (ep.family === 'IPv4' && max >= 16) {
        HEAPU16[ptr >> 1] = 2
        HEAPU8[ptr + 2] = (ep.port >> 8) & 0xff
        HEAPU8[ptr + 3] = ep.port & 0xff
        const parts = ep.address.split('.').map(Number)
        HEAPU8[ptr + 4] = parts[0] | 0
        HEAPU8[ptr + 5] = parts[1] | 0
        HEAPU8[ptr + 6] = parts[2] | 0
        HEAPU8[ptr + 7] = parts[3] | 0
        for (let i = 8; i < 16; i++) HEAPU8[ptr + i] = 0
        if (lenPtr) HEAP32[lenPtr >> 2] = 16
      } else if (ep.family === 'IPv6' && max >= 28) {
        HEAPU16[ptr >> 1] = 10
        HEAPU8[ptr + 2] = (ep.port >> 8) & 0xff
        HEAPU8[ptr + 3] = ep.port & 0xff
        HEAP32[(ptr + 4) >> 2] = 0
        const fullGroups = parseIPv6(ep.address)
        for (let i = 0; i < 8; i++) {
          HEAPU8[ptr + 8 + i * 2] = (fullGroups[i] >> 8) & 0xff
          HEAPU8[ptr + 8 + i * 2 + 1] = fullGroups[i] & 0xff
        }
        HEAP32[(ptr + 24) >> 2] = 0
        if (lenPtr) HEAP32[lenPtr >> 2] = 28
      }
    },
  },

  $FKN_socket__deps: ['$FKN'],
  $FKN_socket(domain, type) {
    FKN.init()
    if (FKN.debug) console.log('[FKN] socket(domain=' + domain + ', type=' + type + ')')
    // SOCK_STREAM = 1, SOCK_DGRAM = 2 (Linux values; Emscripten matches)
    const SOCK_TYPE = type & 0xf
    const family = domain === 10 ? 'IPv6' : 'IPv4'
    if (SOCK_TYPE === 1) {
      const fd = FKN.newFd({
        kind: 'tcp-unbound', family, nonblock: false,
        diag: { polled: 0, polledOut: 0, polledIn: 0, dataChunks: 0, sendCalls: 0, recvCalls: 0, connectAt: 0, connectedAt: 0 }
      })
      return fd
    }
    if (SOCK_TYPE === 2) {
      const st = {
        kind: 'udp', family, nonblock: false,
        socket: null, udpRecv: [], reopenAttempts: 0,
      }
      FKN._dbgWorkerUdpPkts = FKN._dbgWorkerUdpPkts || 0
      FKN._dbgWorkerUdpBytes = FKN._dbgWorkerUdpBytes || 0
      if (FKN.debug && !FKN._dbgWorkerUdpStarted) {
        FKN._dbgWorkerUdpStarted = true
        setInterval(() => {
          if (FKN._dbgWorkerUdpPkts || FKN._dbgWorkerUdpBytes) {
            console.log('[fkn-udp-worker] pkts/s=' + FKN._dbgWorkerUdpPkts + ' KiB/s=' + Math.round(FKN._dbgWorkerUdpBytes / 1024))
          }
          FKN._dbgWorkerUdpPkts = 0
          FKN._dbgWorkerUdpBytes = 0
        }, 1000)
      }
      if (FKN.debug && !FKN._dbgJsBusyStarted) {
        FKN._dbgJsBusyStarted = true
        FKN._dbgJsBusyUs = 0
        FKN._dbgJsHandlerCalls = 0
        setInterval(() => {
          if (FKN._dbgJsBusyUs) {
            console.log('[fkn-js] handler_calls/s=' + FKN._dbgJsHandlerCalls
              + ' busy_ms=' + Math.round(FKN._dbgJsBusyUs / 1000)
              + ' avg_us/call=' + Math.round(FKN._dbgJsBusyUs / (FKN._dbgJsHandlerCalls || 1)))
          }
          FKN._dbgJsBusyUs = 0
          FKN._dbgJsHandlerCalls = 0
        }, 1000)
      }
      FKN.attachUdp(st)
      return FKN.newFd(st)
    }
    return -FKN.err.INVAL
  },

  $FKN_connect__deps: ['$FKN'],
  $FKN_connect(fd, addrPtr, addrLen) {
    const st = FKN.fds.get(fd)
    if (!st) return -FKN.err.BADF
    const ep = FKN.readSockaddr(addrPtr, addrLen)
    if (!ep) return -FKN.err.INVAL

    if (st.kind === 'udp') {
      st.remoteAddr = ep.address
      st.remotePort = ep.port
      st.remoteFamily = ep.family
      return 0
    }
    if (st.kind !== 'tcp-unbound') return -FKN.err.INVAL

    const sock = FKN.net.connect({ host: ep.address, port: ep.port })
    st.kind = 'tcp'
    st.socket = sock
    st.connecting = true
    st.remoteAddr = ep.address
    st.remotePort = ep.port
    st.remoteFamily = ep.family
    st.diag.connectAt = Date.now()
    st.diag.nonblockAtConnect = st.nonblock

    sock.on('connect', () => {
      st.connecting = false
      st.connected = true
      st.diag.connectedAt = Date.now()
      try {
        st.localAddr = sock.localAddress
        st.localPort = sock.localPort
        st.localFamily = sock.localFamily
      } catch (e) {}
      FKN.scheduleTick()
    })
    sock.on('data', (chunk) => {
      st.diag.dataChunks++
      // CRITICAL: copy the chunk - @fkn/lib's TCP stream re-uses backing buffers across reads, and stashing the original surfaces as hash-piece-failed alerts and instant peer bans
      const src = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk)
      const copy = new Uint8Array(src.length)
      copy.set(src)
      st.recv.chunks.push(copy)
      st.recv.total += copy.length
      FKN.scheduleTick()
    })
    sock.on('end', () => { st.recv.fin = true; FKN.scheduleTick() })
    sock.on('close', () => { st.recv.fin = true; FKN.scheduleTick() })
    sock.on('error', (err) => {
      st.error = err.errno || FKN.err.CONNRESET
      st.recv.error = st.error
      FKN.scheduleTick()
    })

    return st.nonblock ? -FKN.err.INPROGRESS : 0
  },

  $FKN_bind__deps: ['$FKN'],
  $FKN_bind(fd, addrPtr, addrLen) {
    if (FKN.debug) console.log('[FKN] bind(fd=' + fd + ')')
    const st = FKN.fds.get(fd)
    if (!st) return -FKN.err.BADF
    const ep = FKN.readSockaddr(addrPtr, addrLen)
    if (!ep) return -FKN.err.INVAL
    if (st.kind === 'udp') {
      st.socket.bind(ep.port, ep.address)
      st.localAddr = ep.address; st.localPort = ep.port; st.localFamily = ep.family
      st.bound = true
      return 0
    }
    if (st.kind === 'tcp-unbound') {
      // Asio calls getsockname inside setup_listener, so expose the bind address before the deferred listen()
      st.pendingBindAddr = ep.address
      st.pendingBindPort = ep.port
      st.family = ep.family
      st.localAddr = ep.address
      st.localPort = ep.port
      st.localFamily = ep.family
      return 0
    }
    return -FKN.err.INVAL
  },

  $FKN_listen__deps: ['$FKN'],
  $FKN_listen(fd) {
    if (FKN.debug) console.log('[FKN] listen(fd=' + fd + ')')
    const st = FKN.fds.get(fd)
    if (!st || st.kind !== 'tcp-unbound') return -FKN.err.INVAL
    const server = FKN.net.createServer()
    st.kind = 'tcp-listen'
    st.server = server
    st.acceptQueue = []
    server.on('connection', (sock) => {
      st.acceptQueue.push(sock)
      FKN.scheduleTick()
    })
    server.on('error', (err) => {
      st.error = err.errno || FKN.err.IO
      FKN.scheduleTick()
    })
    server.listen(st.pendingBindPort, st.pendingBindAddr)
    return 0
  },

  $FKN_accept__deps: ['$FKN'],
  $FKN_accept(fd, addrPtr, addrLenPtr) {
    const st = FKN.fds.get(fd)
    if (!st || st.kind !== 'tcp-listen') return -FKN.err.BADF
    const sock = st.acceptQueue.shift()
    if (!sock) return -FKN.err.AGAIN
    const newSt = {
      kind: 'tcp', family: st.family, nonblock: false,
      socket: sock, connected: true,
    }
    try {
      newSt.localAddr = sock.localAddress
      newSt.localPort = sock.localPort
      newSt.localFamily = sock.localFamily
      newSt.remoteAddr = sock.remoteAddress
      newSt.remotePort = sock.remotePort
      newSt.remoteFamily = sock.remoteFamily
    } catch (e) {}
    const newFd = FKN.newFd(newSt)
    sock.on('data', (chunk) => {
      // CRITICAL: copy the chunk - @fkn/lib's TCP stream re-uses backing buffers across reads, and stashing the original surfaces as hash-piece-failed alerts and instant peer bans
      const src = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk)
      const copy = new Uint8Array(src.length)
      copy.set(src)
      newSt.recv.chunks.push(copy)
      newSt.recv.total += copy.length
      FKN.scheduleTick()
    })
    sock.on('end', () => { newSt.recv.fin = true; FKN.scheduleTick() })
    sock.on('close', () => { newSt.recv.fin = true; FKN.scheduleTick() })
    sock.on('error', (err) => {
      newSt.error = err.errno || FKN.err.CONNRESET; newSt.recv.error = newSt.error
      FKN.scheduleTick()
    })
    if (addrPtr && newSt.remoteAddr) {
      FKN.writeSockaddr(addrPtr, addrLenPtr, {
        family: newSt.remoteFamily, address: newSt.remoteAddr, port: newSt.remotePort,
      })
    }
    return newFd
  },

  $FKN_recv__deps: ['$FKN'],
  $FKN_recv(fd, bufPtr, len) {
    FKN.stats.recv++
    {
      const st = FKN.fds.get(fd)
      if (st && st.diag) st.diag.recvCalls++
    }
    const st = FKN.fds.get(fd)
    if (!st) return -FKN.err.BADF
    if (st.error) { const e = st.error; st.error = 0; return -e }
    const r = st.recv
    if (r.total === 0) {
      if (r.fin) return 0
      return -FKN.err.AGAIN
    }
    let need = Math.min(len, r.total)
    let written = 0
    while (written < need && r.chunks.length) {
      const chunk = r.chunks[0]
      const take = Math.min(chunk.length, need - written)
      HEAPU8.set(chunk.subarray(0, take), bufPtr + written)
      if (take === chunk.length) {
        r.chunks.shift()
      } else {
        r.chunks[0] = chunk.subarray(take)
      }
      r.total -= take
      written += take
    }
    FKN.stats.tcpRx += written
    // CRITICAL: data still buffered has to re-arm the tick, otherwise asio waits for a poll edge that never comes
    if (r.total > 0) FKN.scheduleTick()
    return written
  },

  $FKN_recvfrom__deps: ['$FKN'],
  $FKN_recvfrom(fd, bufPtr, len, _f, addrPtr, addrLenPtr) {
    FKN.stats.recvfrom++
    const st = FKN.fds.get(fd)
    if (!st || st.kind !== 'udp') return -FKN.err.BADF
    if (!st.udpRecv.length) return -FKN.err.AGAIN
    const pkt = st.udpRecv.shift()
    const take = Math.min(pkt.data.length, len)
    HEAPU8.set(pkt.data.subarray(0, take), bufPtr)
    if (addrPtr) {
      FKN.writeSockaddr(addrPtr, addrLenPtr, {
        family: pkt.family, address: pkt.address, port: pkt.port,
      })
    }
    FKN.stats.udpRx += take
    return take
  },

  $FKN_send__deps: ['$FKN'],
  $FKN_send(fd, bufPtr, len) {
    FKN.stats.send++
    {
      const st = FKN.fds.get(fd)
      if (st && st.diag) st.diag.sendCalls++
    }
    const st = FKN.fds.get(fd)
    if (!st) {
      FKN.stats._sendBadFd = (FKN.stats._sendBadFd || 0) + 1
      return -FKN.err.BADF
    }
    if (st.kind !== 'tcp' || !st.socket) {
      FKN.stats._sendNotConn = (FKN.stats._sendNotConn || 0) + 1
      return -FKN.err.NOTCONN
    }
    const chunk = HEAPU8.slice(bufPtr, bufPtr + len)
    const ok = st.socket.write(chunk)
    if (!ok) FKN.stats._writeBackpressure = (FKN.stats._writeBackpressure || 0) + 1
    FKN.stats.tcpTx += len
    if (st.diag) {
      st.diag.tcpTxBytes = (st.diag.tcpTxBytes || 0) + len
      st.diag.firstSendLen = st.diag.firstSendLen ?? len
    }
    return len
  },

  $FKN_sendto__deps: ['$FKN'],
  $FKN_sendto(fd, bufPtr, len, _f, addrPtr, addrLen) {
    FKN.stats.sendto++
    const st = FKN.fds.get(fd)
    if (!st || st.kind !== 'udp') return -FKN.err.BADF
    const ep = addrPtr
      ? FKN.readSockaddr(addrPtr, addrLen)
      : (st.remoteAddr
          ? { address: st.remoteAddr, port: st.remotePort, family: st.remoteFamily }
          : null)
    if (!ep) return -FKN.err.INVAL
    // EAGAIN is the honest answer while the socket is being replaced; reporting a send as delivered over a socket that is gone makes the loss invisible
    if (st.dead || !st.socket) {
      FKN.reopenUdp(st, 'send-on-dead')
      return -FKN.err.AGAIN
    }
    const chunk = HEAPU8.slice(bufPtr, bufPtr + len)
    try {
      st.socket.send(chunk, 0, len, ep.port, ep.address)
    } catch (e) {
      FKN.reopenUdp(st, 'send-threw')
      return -FKN.err.AGAIN
    }
    FKN.stats.udpTx += len
    return len
  },

  $FKN_close__deps: ['$FKN'],
  $FKN_close(fd) {
    FKN.closeFd(fd)
    return 0
  },

  $FKN_getsockname__deps: ['$FKN'],
  $FKN_getsockname(fd, addrPtr, addrLenPtr) {
    const st = FKN.fds.get(fd)
    if (!st || !st.localAddr) return -FKN.err.BADF
    FKN.writeSockaddr(addrPtr, addrLenPtr, {
      family: st.localFamily, address: st.localAddr, port: st.localPort,
    })
    return 0
  },

  $FKN_getpeername__deps: ['$FKN'],
  $FKN_getpeername(fd, addrPtr, addrLenPtr) {
    const st = FKN.fds.get(fd)
    if (!st || !st.remoteAddr) return -FKN.err.NOTCONN
    FKN.writeSockaddr(addrPtr, addrLenPtr, {
      family: st.remoteFamily, address: st.remoteAddr, port: st.remotePort,
    })
    return 0
  },

  // most options don't apply over a WebVPN tunnel: accept everything and forward only the few the underlying polyfill can
  $FKN_setsockopt__deps: ['$FKN'],
  $FKN_setsockopt(fd, level, optname, optvalPtr, optvalLen) {
    const st = FKN.fds.get(fd)
    if (!st) return -FKN.err.BADF
    if (!st.socket) return 0
    if (level === 6 && optname === 1 && st.socket.setNoDelay) {
      const on = optvalLen >= 4 ? HEAP32[optvalPtr >> 2] : 1
      try { st.socket.setNoDelay(!!on) } catch (e) {}
      return 0
    }
    if (level === 1 && optname === 9 && st.socket.setKeepAlive) {
      const on = optvalLen >= 4 ? HEAP32[optvalPtr >> 2] : 1
      try { st.socket.setKeepAlive(!!on) } catch (e) {}
      return 0
    }
    return 0
  },

  $FKN_getsockopt__deps: ['$FKN'],
  $FKN_getsockopt(fd, level, optname, optvalPtr, optvalLenPtr) {
    const st = FKN.fds.get(fd)
    if (!st) return -FKN.err.BADF
    if (level === 1 && optname === 4) {
      const err = st.error || 0
      st.error = 0
      HEAP32[optvalPtr >> 2] = err
      HEAP32[optvalLenPtr >> 2] = 4
      return 0
    }
    HEAP32[optvalPtr >> 2] = 0
    HEAP32[optvalLenPtr >> 2] = 4
    return 0
  },

  // F_GETFL = 3, F_SETFL = 4, O_NONBLOCK = 0x800
  $FKN_fcntl__deps: ['$FKN'],
  $FKN_fcntl(fd, cmd, arg) {
    const st = FKN.fds.get(fd)
    if (!st) return -FKN.err.BADF
    if (cmd === 3) return st.nonblock ? 0x800 : 0
    if (cmd === 4) { st.nonblock = !!(arg & 0x800); return 0 }
    return 0
  },

  // pollfd: { i32 fd, i16 events, i16 revents } -> 8 bytes; POLLIN=1, POLLOUT=4, POLLERR=8, POLLHUP=16
  $FKN_poll__deps: ['$FKN'],
  $FKN_poll(fdsPtr, nfds) {
    FKN.stats.poll++
    FKN.stats.pollCalls += nfds
    let ready = 0
    for (let i = 0; i < nfds; i++) {
      const off = fdsPtr + i * 8
      const fd = HEAP32[off >> 2]
      const events = HEAP16[(off + 4) >> 1]
      let revents = 0
      const st = FKN.fds.get(fd)
      if (!st) {
        revents = 0x20 /* POLLNVAL */
      } else {
        if ((events & 1) && (
          (st.kind === 'tcp' && (st.recv.total > 0 || st.recv.fin)) ||
          (st.kind === 'udp' && st.udpRecv.length > 0) ||
          (st.kind === 'tcp-listen' && st.acceptQueue.length > 0)
        )) revents |= 1
        if ((events & 4) && (
          (st.kind === 'tcp' && st.connected) ||
          (st.kind === 'udp' && true)
        )) revents |= 4
        if (st.error) revents |= 8
        if (st.kind === 'tcp') {
          if (st.connected) FKN.stats._tcpPolledConnected = (FKN.stats._tcpPolledConnected || 0) + 1
          else FKN.stats._tcpPolledConnecting = (FKN.stats._tcpPolledConnecting || 0) + 1
          if (events & 4) FKN.stats._tcpPolledOut = (FKN.stats._tcpPolledOut || 0) + 1
          if (events & 1) FKN.stats._tcpPolledIn = (FKN.stats._tcpPolledIn || 0) + 1
          if (st.diag) {
            st.diag.polled++
            if (events & 4) st.diag.polledOut++
            if (events & 1) st.diag.polledIn++
          }
        }
      }
      HEAP16[(off + 6) >> 1] = revents
      if (revents) ready++
    }
    FKN.stats.pollReady += ready
    return ready
  },

  // unused hook, not the live DNS path (that is js_resolver_async + the C++ resolver): this synthesized addrinfo is a placeholder returning the input for the WebVPN server to resolve on connect
  $FKN_resolve__deps: ['$FKN'],
  $FKN_resolve(hostPtr, port, isV6) {
    const ai = _malloc(48 + 28)
    const sa = ai + 48
    HEAPU16[sa >> 1] = isV6 ? 10 : 2
    HEAPU8[sa + 2] = (port >> 8) & 0xff
    HEAPU8[sa + 3] = port & 0xff
    for (let i = 4; i < 28; i++) HEAPU8[sa + i] = 0
    return ai
  },

  // the C++ side calls js_disk_* via extern "C", so these names are a contract
  js_disk_new_storage__deps: ['$FKN'],
  js_disk_new_storage(id, savePathPtr, fileListPtr, fileListLen) {
    if (!FKN.storage) return
    const savePath = UTF8ToString(savePathPtr)
    const json = UTF8ToString(fileListPtr, fileListLen)
    let files = []
    try { files = JSON.parse(json) } catch (e) {}
    Promise.resolve(FKN.storage.onNewStorage(id, savePath, files))
      .catch((e) => console.error('[fkn] onNewStorage error', e))
  },

  js_disk_remove_storage__deps: ['$FKN'],
  js_disk_remove_storage(id) {
    if (!FKN.storage) return
    Promise.resolve(FKN.storage.onRemoveStorage(id))
      .catch((e) => console.error('[fkn] onRemoveStorage error', e))
  },

  js_disk_read__deps: ['$FKN'],
  js_disk_read(id, jobLo, jobHi, fileIdx, offsetLo, offsetHi, len) {
    FKN.stats.diskRead++
    const offset = offsetLo + offsetHi * 0x100000000
    if (!FKN.storage) {
      // mirror libtorrent's built-in disabled_disk_io: returning EINVAL instead makes libtorrent retry forever
      const ptr = _malloc(len)
      HEAPU8.fill(0, ptr, ptr + len)
      Module._lt_disk_complete_read(jobLo, jobHi, ptr, len, 0)
      return
    }
    const onBytes = (bytes) => {
      // the disk_buffer_holder owns this buffer and lt_disk_complete_read schedules its free()
      const ptr = _malloc(bytes.length)
      HEAPU8.set(bytes, ptr)
      Module._lt_disk_complete_read(jobLo, jobHi, ptr, bytes.length, 0)
    }
    const onErr = (e) => {
      console.error('[fkn] disk read error', e)
      Module._lt_disk_complete_read(jobLo, jobHi, 0, 0, e.errno || FKN.err.IO)
      FKN.scheduleTick()
    }
    let result
    try { result = FKN.storage.read(id, fileIdx, offset, len) }
    catch (e) { onErr(e); return }
    if (result && typeof result.then === 'function') {
      result.then(onBytes, onErr).then(() => FKN.scheduleTick())
    } else {
      onBytes(result)
    }
  },

  js_disk_write__deps: ['$FKN'],
  js_disk_write(id, jobLo, jobHi, fileIdx, offsetLo, offsetHi, dataPtr, len) {
    FKN.stats.diskWrite++
    const offset = offsetLo + offsetHi * 0x100000000
    if (!FKN.storage) {
      Module._lt_disk_complete_write(jobLo, jobHi, 0)
      return
    }
    // the copy must live independent of WASM heap reuse
    const bytes = HEAPU8.slice(dataPtr, dataPtr + len)
    const onErr = (e) => {
      Module._lt_disk_complete_write(jobLo, jobHi, e?.errno || FKN.err.IO)
      FKN.scheduleTick()
    }
    let result
    try { result = FKN.storage.write(id, fileIdx, offset, bytes) }
    catch (e) { onErr(e); return }
    if (result && typeof result.then === 'function') {
      result.then(
        () => { Module._lt_disk_complete_write(jobLo, jobHi, 0); FKN.scheduleTick() },
        onErr,
      )
    } else {
      Module._lt_disk_complete_write(jobLo, jobHi, 0)
    }
  },

  js_disk_release__deps: ['$FKN'],
  js_disk_release(id, jobLo, jobHi) {
    const finish = () => { Module._lt_disk_complete_simple(jobLo, jobHi); FKN.scheduleTick() }
    if (!FKN.storage || !FKN.storage.release) { finish(); return }
    Promise.resolve(FKN.storage.release(id)).then(finish, finish)
  },

  js_disk_check__deps: ['$FKN'],
  js_disk_check(id, jobLo, jobHi) {
    if (!FKN.storage || !FKN.storage.check) {
      Module._lt_disk_complete_status(jobLo, jobHi, 0, 0); FKN.scheduleTick(); return
    }
    Promise.resolve(FKN.storage.check(id))
      .then((st) => { Module._lt_disk_complete_status(jobLo, jobHi, st | 0, 0); FKN.scheduleTick() })
      .catch((e) => { Module._lt_disk_complete_status(jobLo, jobHi, 0, e.errno || FKN.err.IO); FKN.scheduleTick() })
  },

  js_disk_move__deps: ['$FKN'],
  js_disk_move(id, jobLo, jobHi, newPathPtr) {
    const newPath = UTF8ToString(newPathPtr)
    const finish = (err) => {
      const ptr = stringToNewUTF8(newPath)
      Module._lt_disk_complete_move(jobLo, jobHi, ptr, 0, err || 0)
      _free(ptr); FKN.scheduleTick()
    }
    if (!FKN.storage || !FKN.storage.move) { finish(0); return }
    Promise.resolve(FKN.storage.move(id, newPath)).then(() => finish(0), (e) => finish(e.errno || FKN.err.IO))
  },

  js_disk_delete__deps: ['$FKN'],
  js_disk_delete(id, jobLo, jobHi, flags) {
    const finish = (err) => { Module._lt_disk_complete_delete(jobLo, jobHi, err || 0); FKN.scheduleTick() }
    if (!FKN.storage || !FKN.storage.deleteFiles) { finish(0); return }
    Promise.resolve(FKN.storage.deleteFiles(id, flags)).then(() => finish(0), (e) => finish(e.errno || FKN.err.IO))
  },

  js_disk_rename__deps: ['$FKN'],
  js_disk_rename(id, jobLo, jobHi, fileIdx, newNamePtr) {
    const newName = UTF8ToString(newNamePtr)
    const finish = (err) => {
      const ptr = stringToNewUTF8(newName)
      Module._lt_disk_complete_rename(jobLo, jobHi, ptr, err || 0)
      _free(ptr); FKN.scheduleTick()
    }
    if (!FKN.storage || !FKN.storage.rename) { finish(0); return }
    Promise.resolve(FKN.storage.rename(id, fileIdx, newName)).then(() => finish(0), (e) => finish(e.errno || FKN.err.IO))
  },

  js_disk_stop__deps: ['$FKN'],
  js_disk_stop(id, jobLo, jobHi) {
    const finish = () => { Module._lt_disk_complete_simple(jobLo, jobHi); FKN.scheduleTick() }
    if (!FKN.storage || !FKN.storage.stop) { finish(); return }
    Promise.resolve(FKN.storage.stop(id)).then(finish, finish)
  },

  __syscall_socket__deps: ['$FKN', '$FKN_socket'],
  __syscall_socket: function(domain, type, _protocol) { return FKN_socket(domain, type) },

  __syscall_connect__deps: ['$FKN', '$FKN_connect'],
  __syscall_connect: function(fd, addr, addrLen) {
    if (!FKN.fds.has(fd)) return -FKN.err.BADF
    return FKN_connect(fd, addr, addrLen)
  },

  __syscall_bind__deps: ['$FKN', '$FKN_bind'],
  __syscall_bind: function(fd, addr, addrLen) {
    if (!FKN.fds.has(fd)) return -FKN.err.BADF
    return FKN_bind(fd, addr, addrLen)
  },

  __syscall_listen__deps: ['$FKN', '$FKN_listen'],
  __syscall_listen: function(fd, backlog) {
    if (!FKN.fds.has(fd)) return -FKN.err.BADF
    return FKN_listen(fd, backlog)
  },

  __syscall_accept4__deps: ['$FKN', '$FKN_accept'],
  __syscall_accept4: function(fd, addr, addrLen, _flags) {
    if (!FKN.fds.has(fd)) return -FKN.err.BADF
    return FKN_accept(fd, addr, addrLen)
  },

  __syscall_recvfrom__deps: ['$FKN', '$FKN_recv', '$FKN_recvfrom'],
  __syscall_recvfrom: function(fd, buf, len, flags, addr, addrLen) {
    const st = FKN.fds.get(fd)
    if (!st) return -FKN.err.BADF
    return st.kind === 'udp'
      ? FKN_recvfrom(fd, buf, len, flags, addr, addrLen)
      : FKN_recv(fd, buf, len, flags)
  },

  // Boost.Asio uses sendmsg on Emscripten for every TCP write; without an override Emscripten's default fails with ENOSYS
  // musl msghdr layout (32-bit): msg_name@0, msg_namelen@4, msg_iov@8, msg_iovlen@12, msg_control@16, msg_controllen@20, msg_flags@24; iovec: iov_base@0, iov_len@4
  __syscall_sendmsg__deps: ['$FKN', '$FKN_send', '$FKN_sendto'],
  __syscall_sendmsg: function(fd, msgPtr, _flags) {
    const st = FKN.fds.get(fd)
    if (!st) {
      if (FKN.stats._unknownSendmsg === undefined) FKN.stats._unknownSendmsg = 0
      FKN.stats._unknownSendmsg++
      return -FKN.err.BADF
    }
    if (st.kind === 'tcp') FKN.stats._tcpSendmsgCalls = (FKN.stats._tcpSendmsgCalls || 0) + 1
    const namePtr   = HEAPU32[(msgPtr +  0) >> 2]
    const nameLen   = HEAPU32[(msgPtr +  4) >> 2]
    const iovPtr    = HEAPU32[(msgPtr +  8) >> 2]
    const iovLen    = HEAPU32[(msgPtr + 12) >> 2]
    let total = 0
    if (iovLen === 1) {
      const iovBase = HEAPU32[(iovPtr + 0) >> 2]
      const iovL    = HEAPU32[(iovPtr + 4) >> 2]
      if (st.kind === 'udp') {
        return FKN_sendto(fd, iovBase, iovL, 0, namePtr || 0, nameLen || 0)
      }
      return FKN_send(fd, iovBase, iovL, 0)
    }
    // stitch JS-side rather than via _malloc, which can grow the heap and detach HEAPU8/HEAPU32
    const iovs = []
    for (let i = 0; i < iovLen; i++) {
      const base = HEAPU32[(iovPtr + i * 8 + 0) >> 2]
      const len  = HEAPU32[(iovPtr + i * 8 + 4) >> 2]
      iovs.push({ base, len })
      total += len
    }
    const merged = new Uint8Array(total)
    let mOff = 0
    for (const { base, len } of iovs) {
      merged.set(HEAPU8.subarray(base, base + len), mOff)
      mOff += len
    }
    if (st.kind === 'udp') {
      FKN.stats.sendto++
      const ep = namePtr
        ? FKN.readSockaddr(namePtr, nameLen)
        : (st.remoteAddr
            ? { address: st.remoteAddr, port: st.remotePort, family: st.remoteFamily }
            : null)
      if (!ep) return -FKN.err.INVAL
      st.socket.send(merged, 0, total, ep.port, ep.address)
      FKN.stats.udpTx += total
      return total
    }
    FKN.stats.send++
    if (st.diag) st.diag.sendCalls++
    if (!st.socket) return -FKN.err.NOTCONN
    st.socket.write(merged)
    FKN.stats.tcpTx += total
    if (st.diag) {
      st.diag.tcpTxBytes = (st.diag.tcpTxBytes || 0) + total
      st.diag.firstSendLen = st.diag.firstSendLen ?? total
    }
    return total
  },

  __syscall_sendto__deps: ['$FKN', '$FKN_send', '$FKN_sendto'],
  __syscall_sendto: function(fd, buf, len, flags, addr, addrLen) {
    const st = FKN.fds.get(fd)
    if (!st) return -FKN.err.BADF
    return st.kind === 'udp'
      ? FKN_sendto(fd, buf, len, flags, addr, addrLen)
      : FKN_send(fd, buf, len, flags)
  },

  __syscall_getsockname__deps: ['$FKN', '$FKN_getsockname'],
  __syscall_getsockname: function(fd, addr, addrLen) {
    if (!FKN.fds.has(fd)) return -FKN.err.BADF
    return FKN_getsockname(fd, addr, addrLen)
  },

  __syscall_getpeername__deps: ['$FKN', '$FKN_getpeername'],
  __syscall_getpeername: function(fd, addr, addrLen) {
    if (!FKN.fds.has(fd)) return -FKN.err.BADF
    return FKN_getpeername(fd, addr, addrLen)
  },

  __syscall_setsockopt__deps: ['$FKN', '$FKN_setsockopt'],
  __syscall_setsockopt: function(fd, level, optname, optval, optlen) {
    if (!FKN.fds.has(fd)) return -FKN.err.BADF
    return FKN_setsockopt(fd, level, optname, optval, optlen)
  },

  __syscall_getsockopt__deps: ['$FKN', '$FKN_getsockopt'],
  __syscall_getsockopt: function(fd, level, optname, optval, optlenPtr) {
    if (!FKN.fds.has(fd)) return -FKN.err.BADF
    return FKN_getsockopt(fd, level, optname, optval, optlenPtr)
  },

  __syscall_poll__deps: ['$FKN', '$FKN_poll'],
  __syscall_poll: function(fdsPtr, nfds, _timeout) {
    return FKN_poll(fdsPtr, nfds, 0)
  },

  // Boost.Asio's reactor on Emscripten is the SELECT reactor, and Emscripten's own select doesn't know our fake fds
  // fd_set bit arrays: fd N = byte N>>3, bit N&7, valid on little-endian wasm regardless of NFDBITS word size
  __syscall__newselect__deps: ['$FKN'],
  __syscall__newselect: function(nfds, readPtr, writePtr, exceptPtr, _timeoutPtr) {
    FKN.stats.poll++
    if (nfds < 0) nfds = 0
    if (nfds > 4096) nfds = 4096
    const getBit = (ptr, fd) => ptr ? ((HEAPU8[ptr + (fd >>> 3)] >>> (fd & 7)) & 1) : 0
    const setBit = (ptr, fd) => { if (ptr) HEAPU8[ptr + (fd >>> 3)] |= (1 << (fd & 7)) }
    const wantR = [], wantW = [], wantE = []
    for (let fd = 0; fd < nfds; fd++) {
      if (getBit(readPtr, fd)) wantR.push(fd)
      if (getBit(writePtr, fd)) wantW.push(fd)
      if (getBit(exceptPtr, fd)) wantE.push(fd)
    }
    const nbytes = (nfds + 7) >>> 3
    for (let i = 0; i < nbytes; i++) {
      if (readPtr) HEAPU8[readPtr + i] = 0
      if (writePtr) HEAPU8[writePtr + i] = 0
      if (exceptPtr) HEAPU8[exceptPtr + i] = 0
    }
    const readable = (st) => st && (
      (st.kind === 'tcp' && (st.recv.total > 0 || st.recv.fin)) ||
      (st.kind === 'udp' && st.udpRecv.length > 0) ||
      (st.kind === 'tcp-listen' && st.acceptQueue.length > 0)
    )
    const writable = (st) => st && (
      (st.kind === 'tcp' && st.connected) ||
      st.kind === 'udp'
    )
    let total = 0
    for (const fd of wantR) { const st = FKN.fds.get(fd); if (readable(st) || (st && st.error)) { setBit(readPtr, fd); total++ } }
    for (const fd of wantW) { const st = FKN.fds.get(fd); if (writable(st) || (st && st.error)) { setBit(writePtr, fd); total++ } }
    for (const fd of wantE) { const st = FKN.fds.get(fd); if (st && st.error) { setBit(exceptPtr, fd); total++ } }
    FKN.stats.pollReady += total
    return total
  },

  __syscall_fcntl64__deps: ['$FKN', '$FKN_fcntl'],
  __syscall_fcntl64: function(fd, cmd, varargs) {
    if (!FKN.fds.has(fd)) return -FKN.err.BADF
    const arg = (cmd === 4) ? HEAP32[varargs >> 2] : 0
    return FKN_fcntl(fd, cmd, arg)
  },

  // FKN sockets are NOT Emscripten FS streams, so the default __syscall_ioctl throws ErrnoError(EBADF) per call, which burned ~70% of the worker's CPU on Firefox
  // musl's first-write ioctl(1, TIOCGWINSZ) probe must return 0 or stdout goes fully buffered
  __syscall_ioctl__deps: ['$FKN'],
  __syscall_ioctl: function(fd, op, varargs) {
    const st = FKN.fds.get(fd)
    if (!st) return (fd <= 2 && op === 0x5413) ? 0 : -FKN.err.BADF
    FKN.stats.ioctl++
    // FIONREAD (0x541B): bytes available to read, written to the int* argp
    if (op === 0x541B) {
      const avail = st.kind === 'tcp'
        ? st.recv.total
        : st.kind === 'udp'
          ? (st.udpRecv.length ? st.udpRecv[0].data.length : 0)
          : 0
      const argp = HEAP32[varargs >> 2]
      if (argp) HEAP32[argp >> 2] = avail
      return 0
    }
    // FIONBIO (0x5421): set/clear non-blocking from the int* argp
    if (op === 0x5421) {
      const argp = HEAP32[varargs >> 2]
      st.nonblock = !!(argp ? HEAP32[argp >> 2] : 0)
      return 0
    }
    return 0
  },

  // async DNS bridge kicked off by resolver.cpp: the C++ resolver parks the pending callback in m_callbacks until Module._lt_dns_complete(host, ip_csv) fires with a comma-separated IP list, empty string meaning failure
  js_resolver_async__deps: ['$FKN'],
  js_resolver_async: function(hostPtr, wantV6) {
    if (!FKN.initialized) FKN.init()
    FKN.stats.dnsReq++
    const hostname = UTF8ToString(hostPtr)
    const family = wantV6 ? 6 : 4
    const finish = (ipCsv) => {
      FKN.stats.dnsDone++
      const hPtr = stringToNewUTF8(hostname)
      const cPtr = stringToNewUTF8(ipCsv || '')
      Module._lt_dns_complete(hPtr, cPtr)
      _free(hPtr); _free(cPtr)
      FKN.scheduleTick()
    }
    const fknLookup = FKN.host && FKN.host.dnsLookup
    if (fknLookup) {
      Promise.resolve(fknLookup(hostname, { family }))
        .then((r) => {
          if (!r) return finish('')
          const ips = Array.isArray(r) ? r : [r]
          finish(ips.map((x) => x.address).join(','))
        })
        .catch(() => finish(''))
      return
    }
    const rrType = wantV6 ? 'AAAA' : 'A'
    fetch('https://1.1.1.1/dns-query?name=' + encodeURIComponent(hostname) + '&type=' + rrType,
          { headers: { 'Accept': 'application/dns-json' } })
      .then((r) => r.ok ? r.json() : null)
      .then((j) => {
        if (!j) return finish('')
        const t = wantV6 ? 28 : 1
        const ips = (j.Answer || []).filter((a) => a.type === t).map((a) => a.data)
        finish(ips.join(','))
      })
      .catch(() => finish(''))
  },

  fd_close__deps: ['$FKN', '$FKN_close', '$FS', '$SYSCALLS'],
  fd_close: function(fd) {
    if (FKN.fds.has(fd)) return FKN_close(fd)
    try {
      const stream = SYSCALLS.getStreamFromFD(fd)
      FS.close(stream)
      return 0
    } catch (e) {
      if (typeof FS === 'undefined' || e.name !== 'ErrnoError') throw e
      return e.errno
    }
  },

  __syscall_close__deps: ['$FKN', '$FKN_close'],
  __syscall_close: function(fd) {
    if (FKN.fds.has(fd)) return FKN_close(fd)
    return 0
  },
})

// minimal - handles "::" expansion; the host normalises with ip-address before we see it
function parseIPv6(addr) {
  if (addr.indexOf('::') !== -1) {
    const [head, tail] = addr.split('::')
    const h = head ? head.split(':').map((x) => parseInt(x, 16)) : []
    const t = tail ? tail.split(':').map((x) => parseInt(x, 16)) : []
    const fill = 8 - h.length - t.length
    return h.concat(new Array(fill).fill(0)).concat(t)
  }
  return addr.split(':').map((x) => parseInt(x, 16))
}
