// The streaming surface: what setStreamWindow writes to libtorrent, in what order, and how read()
// behaves at the edges of a file and when it is abandoned.
//
// Every _lt_* export is mocked here, so green does NOT mean the C++ in src/wrapper.cpp ran. What it
// pins is the JS planning, the record decoding, and the call sequence crossing the boundary. The
// record builders below are hand-copies of emit_torrent_ready and emit_state_update: if the wire
// format changes on one side and not the other, these tests keep passing against a format the wasm
// no longer emits.
//
// The order is the point. clear_piece_deadlines leaves every cleared piece at priority 1 rather
// than the default 4, so a clear AFTER the priority write silently undoes it. And priority does not
// express order in libtorrent: a wide top-priority band is shuffled within each availability bucket
// and skipped by the sequential picker's in-order walk, so the window has to stay small and the
// ordering has to come from the deadline ladder.

import assert from 'node:assert/strict'
import test from 'node:test'

const { createSession, PRIORITY, TORRENT_STATE } = await import('../build/index.js')

const REC_TORRENT_READY = 0xf0000001
const REC_STATE_UPDATE = 0xf0000002

const ALERTS_AT = 1024
const HEAP_AT = 1 << 16

// A stand-in for the WASM module: a real heap so the DataView decoding in popAlerts is exercised,
// a bump allocator, and a log of every call the Session makes.
const makeModule = () => {
  const buffer = new ArrayBuffer(4 << 20)
  const HEAPU8 = new Uint8Array(buffer)
  let brk = HEAP_AT
  let alertLen = 0
  const calls = []
  const log = (name, ...args) => { calls.push({ name, args }); return 0 }

  const mod = {
    HEAPU8,
    HEAP32: new Int32Array(buffer),
    HEAPU32: new Uint32Array(buffer),
    calls,
    _malloc: (n) => { const p = brk; brk += (n + 7) & ~7; return p },
    _free: () => {},
    stringToNewUTF8: () => 0,
    UTF8ToString: () => '',
    _lt_set_log: () => {},
    _lt_set_utp_receive_buffer: () => {},
    _lt_session_create: () => 0,
    _lt_session_destroy: () => log('destroy'),
    _lt_session_tick: () => log('tick'),
    _lt_session_pump_alerts: () => {},
    _lt_alerts_size: () => alertLen,
    _lt_alerts_data: () => ALERTS_AT,
    _lt_alerts_clear: () => { alertLen = 0 },
    _lt_torrent_post_status: (h) => log('post_status', h),
    _lt_torrent_set_sequential: (h, on) => log('set_sequential', h, on),
    _lt_torrent_set_piece_deadline: (h, p, ms) => log('set_deadline', h, p, ms),
    _lt_torrent_clear_piece_deadlines: (h) => log('clear_deadlines', h),
    _lt_torrent_reset_piece_deadline: (h, p) => log('reset_deadline', h, p),
    _lt_torrent_prioritize_pieces: (h, ptr, n) => log('prioritize_pieces', h, HEAPU8.slice(ptr, ptr + n)),
    // decode the two parallel arrays the way the wrapper does, so the pointer arithmetic is tested
    _lt_torrent_prioritize_piece_list: (h, piecesPtr, priosPtr, n) => {
      const HEAP32 = new Int32Array(buffer)
      const entries = []
      for (let i = 0; i < n; i++) {
        entries.push({ piece: HEAP32[(piecesPtr >> 2) + i], priority: HEAPU8[priosPtr + i] })
      }
      return log('prioritize_list', h, entries)
    },
    _lt_torrent_prioritize_files: (h, ptr, n) => log('prioritize_files', h, HEAPU8.slice(ptr, ptr + n)),
    _lt_torrent_set_file_priority: (h, f, prio) => log('set_file_priority', h, f, prio),
    _lt_torrent_cancel_piece_requests: (h, p) => log('cancel_piece_requests', h, p),
    _lt_session_remove_torrent_ex: (h) => log('remove', h),

    // push a record into the alert buffer the next popAlerts() will drain
    pushRecord (type, payload) {
      const view = new DataView(buffer)
      view.setUint32(ALERTS_AT + alertLen, type, true)
      view.setUint32(ALERTS_AT + alertLen + 4, payload.length, true)
      HEAPU8.set(payload, ALERTS_AT + alertLen + 8)
      alertLen += 8 + payload.length
    },
  }
  return mod
}

// matches emit_torrent_ready in src/wrapper.cpp
const torrentReady = ({ handle = 1, pieceLength = 1024, files = [] }) => {
  const total = files.reduce((n, f) => n + f.size, 0)
  const numPieces = Math.ceil(total / pieceLength)
  const parts = []
  const u32 = (v) => { const b = new DataView(new ArrayBuffer(4)); b.setUint32(0, v, true); parts.push(new Uint8Array(b.buffer)) }
  const i64 = (v) => { const b = new DataView(new ArrayBuffer(8)); b.setBigInt64(0, BigInt(v), true); parts.push(new Uint8Array(b.buffer)) }
  u32(handle); u32(7); u32(pieceLength); u32(numPieces); i64(total); u32(files.length)
  let offset = 0
  for (const f of files) {
    i64(offset); i64(f.size)
    const path = new TextEncoder().encode(f.path)
    u32(path.length); parts.push(path)
    offset += f.size
  }
  return { bytes: concat(parts), numPieces }
}

// matches emit_state_update in src/wrapper.cpp
const stateUpdate = ({ handle = 1, numPieces, have = [], sequential = false, state = TORRENT_STATE.downloading }) => {
  const parts = []
  const u32 = (v) => { const b = new DataView(new ArrayBuffer(4)); b.setUint32(0, v, true); parts.push(new Uint8Array(b.buffer)) }
  const i32 = (v) => { const b = new DataView(new ArrayBuffer(4)); b.setInt32(0, v, true); parts.push(new Uint8Array(b.buffer)) }
  const i64 = (v) => { const b = new DataView(new ArrayBuffer(8)); b.setBigInt64(0, BigInt(v), true); parts.push(new Uint8Array(b.buffer)) }
  const f32 = (v) => { const b = new DataView(new ArrayBuffer(4)); b.setFloat32(0, v, true); parts.push(new Uint8Array(b.buffer)) }
  u32(handle); i32(state); i64(0); i64(0); f32(0); i32(0); i32(0); i32(0); i32(0)
  u32(0); u32(0); u32(sequential ? 1 : 0); u32(sequential ? 1 << 9 : 0); i32(0); i32(0); u32(0)
  const bytes = new Uint8Array((numPieces + 7) >> 3)
  for (const p of have) bytes[p >> 3] |= 0x80 >> (p & 7)
  u32(numPieces); u32(bytes.length); parts.push(bytes)
  return concat(parts)
}

const concat = (parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) { out.set(p, at); at += p.length }
  return out
}

const storage = { onNewStorage () {}, onRemoveStorage () {}, write () {}, read: (_id, _f, _o, len) => new Uint8Array(len) }

// a session whose handle 1 already has a layout, plus the module so tests can read the call log
const setup = async ({ pieceLength = 1024, files = [{ path: 'a.mkv', size: 100 * 1024 }] } = {}) => {
  const mod = makeModule()
  const session = await createSession({ net: {}, dgram: {}, storage, moduleFactory: async () => mod })
  const { bytes, numPieces } = torrentReady({ pieceLength, files })
  mod.pushRecord(REC_TORRENT_READY, bytes)
  session.popAlerts()
  mod.calls.length = 0
  return { mod, session, numPieces, pieceLength }
}

const names = (mod) => mod.calls.map((c) => c.name)
const lastPrios = (mod) => [...mod.calls].reverse().find((c) => c.name === 'prioritize_pieces')?.args[1]
const deadlines = (mod) => mod.calls.filter((c) => c.name === 'set_deadline').map((c) => ({ piece: c.args[1], ms: c.args[2] }))

test('setStreamWindow clears deadlines BEFORE writing priorities, then lays the ladder', async () => {
  const { mod, session } = await setup()
  try {
    session.setStreamWindow(1, [{ fileIndex: 0, offset: 0 }])
    const order = names(mod).filter((n) => n !== 'post_status')
    assert.equal(order[0], 'clear_deadlines', 'a clear after the map would demote it all to priority 1')
    assert.equal(order[1], 'prioritize_pieces')
    assert.equal(order[2], 'set_deadline')
    assert.equal(order.at(-1), 'set_sequential')
    assert.deepEqual(mod.calls.at(-1).args, [1, 1])
  } finally { session.destroy() }
})

test('a playhead at the start of the file does not paint the whole file top priority', async () => {
  // the shape that matters: an offset of 0 is what a player sends before playback begins
  const { mod, session, numPieces } = await setup()
  try {
    session.setStreamWindow(1, [{ fileIndex: 0, offset: 0 }], { windowPieces: 8 })
    const prios = lastPrios(mod)
    assert.equal(prios.length, numPieces, 'exactly one byte per piece, never longer')
    const top = [...prios].filter((p) => p === PRIORITY.top).length
    assert.equal(top, 8)
    const normal = [...prios].filter((p) => p === PRIORITY.normal).length
    assert.equal(normal, numPieces - 8, 'the rest of the file stays on the in-order path')
  } finally { session.destroy() }
})

test('the top-priority band is a fixed size, not a fraction of the file', async () => {
  for (const size of [50 * 1024, 5000 * 1024]) {
    const { mod, session } = await setup({ files: [{ path: 'a.mkv', size }] })
    try {
      session.setStreamWindow(1, [{ fileIndex: 0, offset: 0 }], { windowPieces: 6 })
      assert.equal([...lastPrios(mod)].filter((p) => p === PRIORITY.top).length, 6)
    } finally { session.destroy() }
  }
})

test('the deadline ladder is staggered, ascending, and starts at once', async () => {
  const { mod, session } = await setup()
  try {
    session.setStreamWindow(1, [{ fileIndex: 0, offset: 0 }], { windowPieces: 4, deadlineStepMs: 250 })
    assert.deepEqual(deadlines(mod), [
      { piece: 0, ms: 0 }, { piece: 1, ms: 250 }, { piece: 2, ms: 500 }, { piece: 3, ms: 750 },
    ])
  } finally { session.destroy() }
})

test('the window follows the playhead', async () => {
  const { mod, session, pieceLength } = await setup()
  try {
    session.setStreamWindow(1, [{ fileIndex: 0, offset: 40 * pieceLength }], { windowPieces: 3 })
    assert.deepEqual(deadlines(mod).map((d) => d.piece), [40, 41, 42])
    const prios = lastPrios(mod)
    assert.equal(prios[39], PRIORITY.normal, 'what is behind the playhead stays at default, not below it')
    assert.equal(prios[40], PRIORITY.top)
    assert.equal(prios[43], PRIORITY.normal)
  } finally { session.destroy() }
})

test('two readers merge to the more urgent deadline per piece', async () => {
  const { mod, session, pieceLength } = await setup()
  try {
    session.setStreamWindow(1, [
      { fileIndex: 0, offset: 0 },
      { fileIndex: 0, offset: 2 * pieceLength },
    ], { windowPieces: 4, deadlineStepMs: 100 })
    const byPiece = new Map(deadlines(mod).map((d) => [d.piece, d.ms]))
    // piece 2 is the 3rd of the first claim (200ms) and the 1st of the second (0ms)
    assert.equal(byPiece.get(2), 0)
    assert.equal(byPiece.get(0), 0)
    assert.equal(byPiece.get(5), 300)
  } finally { session.destroy() }
})

test('skipping unclaimed files never skips a piece the claimed file shares', async () => {
  // 1.5 pieces of ep1, so ep2 starts halfway through piece 1 and piece 1 carries both
  const { mod, session } = await setup({
    files: [{ path: 'ep1.mkv', size: 1536 }, { path: 'ep2.mkv', size: 4096 }],
  })
  try {
    session.setStreamWindow(1, [{ fileIndex: 1, offset: 0 }], {
      windowPieces: 1, unclaimedPriority: PRIORITY.skip,
    })
    const prios = lastPrios(mod)
    assert.equal(prios[0], PRIORITY.skip, 'a piece wholly inside the unwatched file is skipped')
    assert.notEqual(prios[1], PRIORITY.skip, 'the straddling piece carries bytes ep2 needs')
    assert.equal(prios[2], PRIORITY.normal)
  } finally { session.destroy() }
})

test('read clamps to the end of the file instead of parking on pieces past it', async () => {
  const { mod, session, numPieces } = await setup({ files: [{ path: 'a.mkv', size: 3000 }] })
  try {
    mod.pushRecord(REC_STATE_UPDATE, stateUpdate({ numPieces, have: [0, 1, 2] }))
    session.popAlerts()
    const tail = await session.read(1, 0, 2900, 1 << 20)
    assert.equal(tail.length, 100, 'a tail probe asks for more than exists and gets what exists')
    assert.equal((await session.read(1, 0, 3000, 4096)).length, 0, 'at EOF, empty rather than a hang')
  } finally { session.destroy() }
})

test('read rejects on timeout and retires the deadlines it placed', async () => {
  const { mod, session } = await setup()
  try {
    await assert.rejects(
      session.read(1, 0, 0, 2048, { timeoutMs: 30 }),
      /did not arrive within 30ms/,
    )
    const reset = mod.calls.filter((c) => c.name === 'reset_deadline').map((c) => c.args[1])
    assert.deepEqual(reset, [0, 1], 'an expired deadline left behind outranks every later one')
  } finally { session.destroy() }
})

test('read rejects on abort', async () => {
  const { session } = await setup()
  try {
    const ac = new AbortController()
    const pending = session.read(1, 0, 0, 2048, { signal: ac.signal, timeoutMs: 0 })
    ac.abort()
    await assert.rejects(pending, /aborted/)
  } finally { session.destroy() }
})

test('a read that overlaps another keeps its deadline until both are done', async () => {
  const { mod, session } = await setup()
  try {
    const ac = new AbortController()
    const first = session.read(1, 0, 0, 2048, { signal: ac.signal, timeoutMs: 0 })
    const second = session.read(1, 0, 1024, 1024, { timeoutMs: 30 })
    ac.abort()
    await assert.rejects(first, /aborted/)
    assert.deepEqual(
      mod.calls.filter((c) => c.name === 'reset_deadline').map((c) => c.args[1]),
      [0],
      'piece 1 is still wanted by the read that is still parked',
    )
    await assert.rejects(second, /did not arrive/)
    assert.deepEqual(mod.calls.filter((c) => c.name === 'reset_deadline').map((c) => c.args[1]), [0, 1])
  } finally { session.destroy() }
})

test('destroy rejects a parked read rather than handing back bytes that were never written', async () => {
  const { session } = await setup()
  const pending = session.read(1, 0, 0, 2048, { timeoutMs: 0 })
  session.destroy()
  await assert.rejects(pending, /session destroyed/)
})

test('removeTorrent rejects the reads parked on it', async () => {
  const { session } = await setup()
  try {
    const pending = session.read(1, 0, 0, 2048, { timeoutMs: 0 })
    session.removeTorrent(1)
    await assert.rejects(pending, /was removed/)
  } finally { session.destroy() }
})

test('tick asks for a status update while a read is parked', async () => {
  const { mod, session } = await setup()
  try {
    session.tick()
    assert.equal(names(mod).includes('post_status'), false)
    const pending = session.read(1, 0, 0, 2048, { timeoutMs: 0 })
    mod.calls.length = 0
    session.tick()
    assert.equal(names(mod).filter((n) => n === 'post_status').length, 1)
    session.destroy()
    await assert.rejects(pending, /destroyed/)
  } finally { session.destroy() }
})

test('an over-long priority array is truncated to the torrent, never handed on', async () => {
  const { mod, session, numPieces } = await setup()
  try {
    session.prioritizePieces(1, new Uint8Array(numPieces + 500).fill(PRIORITY.normal))
    assert.equal(lastPrios(mod).length, numPieces)
    assert.equal(session.piecePriorities(1).length, numPieces)
  } finally { session.destroy() }
})

test('a resolved read reports the sequential flag back from the status', async () => {
  const { mod, session, numPieces } = await setup()
  try {
    mod.pushRecord(REC_STATE_UPDATE, stateUpdate({ numPieces, sequential: true }))
    session.popAlerts()
    assert.equal(session.status(1).sequential, true)
    mod.pushRecord(REC_STATE_UPDATE, stateUpdate({ numPieces, sequential: false }))
    session.popAlerts()
    assert.equal(session.status(1).sequential, false)
  } finally { session.destroy() }
})

test('a parked read resolves once the pieces land', async () => {
  const { mod, session, numPieces } = await setup()
  try {
    const pending = session.read(1, 0, 0, 2048, { timeoutMs: 1000 })
    mod.pushRecord(REC_STATE_UPDATE, stateUpdate({ numPieces, have: [0, 1] }))
    session.popAlerts()
    assert.equal((await pending).length, 2048)
  } finally { session.destroy() }
})

test('an abandoned read puts back the priority it had, it does not leave the range demoted', async () => {
  // retiring a deadline drops the piece to priority 1 inside libtorrent, so the release path has to
  // restore the plan or every timed-out read quietly deprioritizes the range it wanted most
  const { mod, session } = await setup()
  try {
    session.setStreamWindow(1, [{ fileIndex: 0, offset: 0 }], { windowPieces: 4 })
    mod.calls.length = 0
    await assert.rejects(session.read(1, 0, 0, 2048, { timeoutMs: 20 }), /did not arrive/)
    const restored = mod.calls.find((c) => c.name === 'prioritize_list')
    assert.ok(restored, 'the reset has to be followed by a priority restore')
    assert.deepEqual(restored.args[1], [
      { piece: 0, priority: PRIORITY.top }, { piece: 1, priority: PRIORITY.top },
    ], 'restored to what the window planned, not to a bare default')
  } finally { session.destroy() }
})

test('prioritizePieceList marshals both arrays and leaves other pieces alone', async () => {
  const { mod, session, numPieces } = await setup()
  try {
    session.prioritizePieces(1, new Uint8Array(numPieces).fill(PRIORITY.normal))
    mod.calls.length = 0
    session.prioritizePieceList(1, [
      { piece: 3, priority: PRIORITY.top },
      { piece: numPieces + 99, priority: PRIORITY.top },
      { piece: -1, priority: PRIORITY.top },
      { piece: 5, priority: 250 },
    ])
    const call = mod.calls.find((c) => c.name === 'prioritize_list')
    assert.deepEqual(call.args[1], [
      { piece: 3, priority: PRIORITY.top },
      { piece: 5, priority: PRIORITY.top },
    ], 'out-of-range indices dropped, values clamped into the 3-bit field')
    const mirror = session.piecePriorities(1)
    assert.equal(mirror[3], PRIORITY.top)
    assert.equal(mirror[4], PRIORITY.normal)
  } finally { session.destroy() }
})

test('a short priority array is padded to the torrent, never handed on short', async () => {
  // libtorrent indexes this array by absolute piece number on its deadline bookkeeping path, so a
  // short one is an out-of-bounds read there
  const { mod, session, numPieces } = await setup()
  try {
    session.prioritizePieces(1, new Uint8Array(numPieces).fill(PRIORITY.top))
    mod.calls.length = 0
    session.prioritizePieces(1, Uint8Array.from([PRIORITY.skip, PRIORITY.skip]))
    const prios = lastPrios(mod)
    assert.equal(prios.length, numPieces)
    assert.equal(prios[0], PRIORITY.skip)
    assert.equal(prios[2], PRIORITY.top, 'the pieces the short array did not mention keep what they had')
  } finally { session.destroy() }
})

test('clearStreamWindow and prioritizeRange clear before they write, like setStreamWindow', async () => {
  const { mod, session } = await setup()
  try {
    session.clearStreamWindow(1)
    let order = names(mod).filter((n) => n !== 'post_status')
    assert.equal(order[0], 'clear_deadlines')
    assert.equal(order[1], 'prioritize_pieces')
    assert.deepEqual(mod.calls.at(-1).args, [1, 0], 'and turns sequential back off')

    mod.calls.length = 0
    session.prioritizeRange(1, 0, 0, 2048)
    order = names(mod).filter((n) => n !== 'post_status')
    assert.equal(order[0], 'clear_deadlines')
    assert.equal(order[1], 'prioritize_pieces')
    assert.equal(order[2], 'set_deadline')
  } finally { session.destroy() }
})

test('setStreamWindow changes nothing when no claim resolves', async () => {
  const { mod, session } = await setup()
  try {
    assert.equal(session.setStreamWindow(1, []), false)
    assert.equal(session.setStreamWindow(1, [{ fileIndex: 9, offset: 0 }]), false)
    assert.deepEqual(names(mod), [], 'no clear, no map: an all-skip map would stop the torrent')
  } finally { session.destroy() }
})

test('read with deadlineMs null touches neither priorities nor deadlines', async () => {
  const { mod, session } = await setup()
  try {
    const pending = session.read(1, 0, 0, 2048, { deadlineMs: null, timeoutMs: 20 })
    await assert.rejects(pending, /did not arrive/)
    assert.equal(names(mod).includes('set_deadline'), false)
    assert.equal(names(mod).includes('reset_deadline'), false)
  } finally { session.destroy() }
})

test('cancelPieceRequests reaches the engine and reports whether it landed', async () => {
  const { mod, session } = await setup()
  try {
    assert.equal(session.cancelPieceRequests(1, 7), true)
    assert.deepEqual(mod.calls.at(-1), { name: 'cancel_piece_requests', args: [1, 7] })
  } finally { session.destroy() }
})

test('setFilePriorities sends one byte per file and invalidates the priority mirror', async () => {
  const { mod, session, numPieces } = await setup({
    files: [{ path: 'ep1.mkv', size: 4096 }, { path: 'ep2.mkv', size: 4096 }],
  })
  try {
    session.prioritizePieces(1, new Uint8Array(numPieces).fill(PRIORITY.normal))
    session.setFilePriorities(1, Uint8Array.from([PRIORITY.skip, PRIORITY.normal]))
    const call = mod.calls.find((c) => c.name === 'prioritize_files')
    assert.deepEqual([...call.args[1]], [PRIORITY.skip, PRIORITY.normal])
    assert.equal(session.piecePriorities(1), null, 'file priorities rewrite the piece map underneath us')
  } finally { session.destroy() }
})
