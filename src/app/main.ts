import { relayWorker } from '@fkn/lib'

const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })

// Wait one tick for the iframe's contentWindow to attach; without this the worker's @fkn/lib/{net,dgram} calls have no transport.
setTimeout(() => {
  try { relayWorker(worker) }
  catch (e) { console.error('relayWorker failed:', e) }
}, 100)

const $ = (id: string) => document.getElementById(id)!

let lastNetRx = 0, lastNetTx = 0, lastTs = Date.now()
const fmtRate = (bytes: number) => {
  if (bytes < 1024) return bytes + ' B/s'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KiB/s'
  return (bytes / (1024 * 1024)).toFixed(2) + ' MiB/s'
}
const fmtBytes = (bytes: number) => {
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KiB'
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MiB'
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GiB'
}

worker.addEventListener('message', (ev: MessageEvent) => {
  const msg = ev.data
  if (msg.type === 'ready') {
    $('state').textContent = 'ready'
  } else if (msg.type === 'worker-error') {
    console.error('[worker]', ...(msg.args || []))
    ;(window as any).__workerErrors = (window as any).__workerErrors || []
    ;(window as any).__workerErrors.push(msg.args)
  } else if (msg.type === 'poll-result') {
    const s = msg.status
    if (!s.ready) return
    ;(window as any).__lastStatus = s
    const now = Date.now()
    const dt = (now - lastTs) / 1000
    const totalRx = (s.tcp?.rx ?? 0) + (s.udp?.rx ?? 0)
    const totalTx = (s.tcp?.tx ?? 0) + (s.udp?.tx ?? 0)
    const rxRate = dt > 0 ? (totalRx - lastNetRx) / dt : 0
    const txRate = dt > 0 ? (totalTx - lastNetTx) / dt : 0
    lastNetRx = totalRx; lastNetTx = totalTx; lastTs = now
    $('state').textContent = `${s.fds} fds  ${s.fdsByKind?.tcp ?? 0} tcp / ${s.fdsByKind?.udp ?? 0} udp / ${s.fdsByKind?.['tcp-listen'] ?? 0} listen`
    $('progress').textContent = `${s.ticks} ticks, ${s.handlers} handlers`
    $('down').textContent = fmtRate(rxRate)
    $('up').textContent = fmtRate(txRate)
    $('tcp-in').textContent = fmtBytes(s.tcp?.rx ?? 0)
    $('udp-in').textContent = fmtBytes(s.udp?.rx ?? 0)
    $('seeds').textContent = fmtBytes(totalRx)
    for (const a of msg.alerts || []) {
      // 79/80 are alert::session_log and alert::torrent_log, 57 is stats
      if (a.t === 79 || a.t === 80 || a.t === 57) continue
      console.log('ALERT', a.t, a.m)
      const el = $('alerts')
      el.textContent = (`[${a.t}] ${a.m}\n` + el.textContent).slice(0, 8000)
    }
  }
})

$('add').addEventListener('click', () => {
  const magnet = ($('magnet') as HTMLInputElement).value.trim()
  if (!magnet) return
  worker.postMessage({ type: 'add-magnet', magnet, savePath: '/dl' })
})

setInterval(() => worker.postMessage({ type: 'poll' }), 1000)
