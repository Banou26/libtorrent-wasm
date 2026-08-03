import { relayWorker } from '@fkn/lib'

const $ = (id: string) => document.getElementById(id)!
const log = (msg: string, cls = '') => {
  const line = document.createElement('div')
  if (cls) line.className = cls
  line.textContent = msg
  $('alerts').insertBefore(line, $('alerts').firstChild)
  while ($('alerts').childNodes.length > 200) $('alerts').removeChild($('alerts').lastChild!)
}

window.addEventListener('error', e => log('window error: ' + e.message, 'bad'))
window.addEventListener('unhandledrejection', e => log('unhandled: ' + (e.reason?.message ?? e.reason), 'bad'))

log('spawning worker…', 'info')
const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })

worker.onerror = (e) => log('worker onerror: ' + e.message, 'bad')

setTimeout(() => {
  try {
    relayWorker(worker)
    log('relayWorker installed', 'ok')
  } catch (e: any) {
    log('relayWorker FAIL: ' + (e?.message ?? e), 'bad')
  }
}, 100)

worker.onmessage = (e) => {
  const m = e.data
  if (m.type === 'ready') {
    log('worker ready', 'ok')
    setInterval(() => worker.postMessage({ type: 'poll' }), 500)
  } else if (m.type === 'add-result') {
    log('add rc=' + m.rc, m.rc === 0 ? 'ok' : 'bad')
  } else if (m.type === 'poll-result') {
    const { status, alerts, rx } = m
    $('stat').innerHTML =
      `<b>fds:</b> ${status.fds} <b>ticks:</b> ${status.ticks} ` +
      `<b>handlers:</b> ${status.handlers} <b>rx:</b> ${status.rxCount}` +
      (rx[0] ? ` &nbsp; first: ${rx[0].from} len=${rx[0].len}` : '')
    for (const a of alerts) {
      if (a.t === 79 || a.t === 80) continue
      log('[' + a.t + '] ' + a.m)
    }
  } else if (m.type === 'error') {
    log('worker error: ' + m.message, 'bad')
  }
}

$('add').addEventListener('click', () => {
  const magnet = ($('magnet') as HTMLInputElement).value.trim()
  if (!magnet) return
  worker.postMessage({ type: 'add-magnet', magnet, savePath: '/dl' })
})
