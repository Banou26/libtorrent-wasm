// ES module imports are hoisted, so any shim has to live in a separately-imported file.
// `process.nextTick` MUST forward trailing args - readable-stream calls `process.nextTick(resume_, stream, state)`.

const root: any = typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : {}))

if (!root.global) root.global = root
if (!root.process) {
  root.process = {
    env: { NODE_DEBUG: '' },
    version: '',
    nextTick: (fn: any, ...args: any[]) => queueMicrotask(() => fn(...args)),
  }
}
