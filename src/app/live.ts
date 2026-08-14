import * as net from '@fkn/lib/net'
import * as dgram from '@fkn/lib/dgram'

import factory from './libtorrent.js'

const $ = (id: string) => document.getElementById(id)!
const log = (msg: string, cls = '') => {
  const line = document.createElement('div')
  if (cls) line.className = cls
  line.textContent = msg
  $('alerts').insertBefore(line, $('alerts').firstChild)
  console.log('[live]', msg)
}

window.addEventListener('error', e => log('window error: ' + e.message, 'bad'))
window.addEventListener('unhandledrejection', e => log('unhandled: ' + (e.reason?.message ?? e.reason), 'bad'))

;(async () => {
  log('importing wasm…', 'info')
  const fkn = { net, dgram, storage: null }
  const inst = await (factory as any)({ fkn })
  ;(window as any).__inst = inst
  inst._lt_session_create()
  for (let i = 0; i < 30; i++) inst._lt_session_tick()
  log('session up', 'ok')

  const rxLog: any[] = []
  ;(window as any).__rxLog = rxLog

  const hookUdp = () => {
    const fkn = (inst as any).__FKN
    if (!fkn) return false
    const udp = [...fkn.fds.values()].find((s: any) => s.kind === 'udp')
    if (!udp || !udp.socket) return false
    udp.socket.on('message', (data: any, rinfo: any) => {
      rxLog.push({ when: Date.now(), from: rinfo?.address + ':' + rinfo?.port, len: data?.length, head: Array.from((data || []).slice(0, 8)) })
    })
    return true
  }

  ;(window as any).__tick = (n = 50) => { for (let i = 0; i < n; i++) inst._lt_session_tick() }
  ;(window as any).__drain = () => {
    inst._lt_session_pump_alerts()
    const sz = inst._lt_alerts_size(); const ptr = inst._lt_alerts_data()
    const v = new DataView(inst.HEAPU8.buffer, ptr, sz)
    const a = []
    for (let o = 0; o < sz; ) {
      const t = v.getUint32(o, true); o += 4
      const l = v.getUint32(o, true); o += 4
      a.push({ t, m: inst.UTF8ToString(ptr + o, l) }); o += l
    }
    inst._lt_alerts_clear()
    return a
  }
  ;(window as any).__add = () => {
    const magnet = ($('magnet') as HTMLInputElement).value
    const mp = inst.stringToNewUTF8(magnet); const pp = inst.stringToNewUTF8('/dl')
    const rc = inst._lt_session_add_magnet(mp, pp)
    inst._free(mp); inst._free(pp)
    hookUdp()
    ;(inst as any).__FKN.scheduleTick()
    return rc
  }

  /**
   * Standing record of who dialled in, for the reachability measurement.
   *
   * Auto-drained on a timer, because __drain() clears the buffer and a hand-driven poll loses every
   * alert that landed between calls. Everything drained here is pushed to __alertLog too, so
   * __drain() stays useful for anything else.
   *
   * Formats are libtorrent/src/alert.cpp:1733, :1290 and :1179. Socket type names are capitalised
   * ("TCP", "uTP", socket_type.cpp:47-51), hence the lowercasing.
   */
  const inbound: any[] = []
  const listening: Record<string, string> = {}
  const dialled = new Set<string>()
  const alertLog: any[] = []
  ;(window as any).__alertLog = alertLog
  ;(window as any).__inbound = () => ({
    listening,
    inbound: inbound.length,
    byTransport: inbound.reduce((n: any, c: any) => ({ ...n, [c.transport]: (n[c.transport] ?? 0) + 1 }), {}),
    peers: inbound,
    // an endpoint we dialled ourselves is not evidence of reachability, so keep the two apart
    dialledOut: dialled.size,
    inboundNotDialled: inbound.filter((c: any) => !dialled.has(c.endpoint)).length,
  })

  setInterval(() => {
    for (const a of (window as any).__drain()) {
      alertLog.push(a)
      if (alertLog.length > 5000) alertLog.shift()
      const m = String(a.m ?? '')
      const inc = /^incoming connection from (\S+) \(([^)]*)\)/.exec(m)
      if (inc) { inbound.push({ at: Date.now(), endpoint: inc[1], transport: inc[2].toLowerCase() }); continue }
      const lis = /^successfully listening on \[([^\]]*)\] (\S+)/.exec(m)
      if (lis) { listening[lis[1].toLowerCase()] = lis[2]; continue }
      // peer_connect_alert is "<torrent> peer [ <endpoint> client: <id> ] outgoing connection to
      // peer (TCP)" (alert.cpp:154 and :1753). Matching on the words rather than a position,
      // because the torrent name and the client string are both free text.
      const out = /peer \[ (\S+) client: .*? \] outgoing connection to peer/.exec(m)
      if (out) dialled.add(out[1])
    }
  }, 1000)

  setInterval(() => (inst as any).__FKN.scheduleTick(), 1000)
  ;(window as any).__status = () => {
    const fkn = (inst as any).__FKN
    const fdsByKind: Record<string, number> = {}
    for (const st of fkn.fds.values()) fdsByKind[st.kind] = (fdsByKind[st.kind] || 0) + 1
    return {
      fds: fkn.fds.size,
      fdsByKind,
      ticks: Number(inst._lt_diag_tick_count()),
      handlers: Number(inst._lt_diag_total_handlers()),
      udp: { rx: fkn.stats.udpRx, tx: fkn.stats.udpTx },
      tcp: { rx: fkn.stats.tcpRx, tx: fkn.stats.tcpTx, recv: fkn.stats.recv, send: fkn.stats.send },
      pkts: { udpRx: rxLog.length },
    }
  }
  ;(window as any).__rx = () => rxLog

  $('add').addEventListener('click', () => log('add rc=' + (window as any).__add(), 'info'))
  $('stat').innerHTML = 'Driving manually: call <code>__add()</code>, <code>__tick()</code>, <code>__drain()</code>, <code>__status()</code>, <code>__rx()</code> from the console.'
  log('READY', 'ok')
})().catch(e => log('init FAIL: ' + (e?.stack ?? e), 'bad'))
