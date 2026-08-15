// Transfer ceilings, measured against a real swarm rather than asserted from the setter.
//
// Nothing in the engine can be asked what its limits are. `session_handle::get_settings()` and
// `torrent_handle::download_limit()` are both sync calls into an io_context that only runs inside
// lt_session_tick(), so reading either from JS blocks the thread that has to tick for the answer to
// come back. That is the deadlock lt_diag_listen_port() shipped with, and it is why the setters here
// are write-only and why these tests measure BYTES rather than read a value back.
//
// So a ceiling is only observable as a transfer that obeys it, which means a real seeder and a real
// download. Every rate here is computed from `totalDone` deltas rather than from `downloadRate`,
// because the latter is libtorrent's own smoothed average and would let a smoothing change pass for
// a throttling change.
//
// EVERY ceiling assertion is two-sided, and that is the point rather than caution. A test that only
// checks "the rate stayed under the cap" passes perfectly against an engine that transfers nothing
// at all, which is the exact failure a rate limit bug produces. Each one asserts a FLOOR as well, so
// it can only pass while the download is genuinely running.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { Rig } from './rig/harness.mjs'
import { SeederFleet } from './rig/seeders.mjs'
import { magnetFor, makeTorrent, writeFixture } from './rig/make-torrent.mjs'
import { waitFor } from './rig/peer-handshake.mjs'

const MB = 1_000_000

// Large enough that no window below finishes it, because a torrent that completes stops transferring
// and the measurement that follows reads as a throttle that is working.
const FIXTURE_BYTES = 192 * MB
const SEEDERS = 2
// Per seeder, and deliberately far above every ceiling under test: the fleet must never be the thing
// limiting the rate, or a passing test says nothing about the engine.
const SEEDER_UP_KBPS = 60 * 1024

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Bytes per second actually transferred over `ms`, from the torrent's own byte counter.
 *
 * Returns null if the torrent finished mid-window, since a completed download is not a measurement
 * of anything and silently reads as a very effective rate limit.
 */
const measure = async (rig, handle, ms) => {
  const before = rig.session.status(handle)
  const startedAt = Date.now()
  await sleep(ms)
  const after = rig.session.status(handle)
  if (after.progress >= 1) return null
  const elapsed = (Date.now() - startedAt) / 1000
  return (after.totalDone - before.totalDone) / elapsed
}

const rate = (bytesPerSecond) => `${(bytesPerSecond / MB).toFixed(2)} MB/s`

/**
 * A fixture, a seeder fleet holding all of it, and an engine downloading it.
 *
 * The fixture is built once per test rather than shared, and each test gets its OWN fleet. Sharing
 * one is what tests/rig/run.mjs found destroys a measurement: a seeder remembers the previous
 * session by address and applies its reconnect backoff to what looks like the same peer coming back,
 * so the second run spends its window waiting rather than transferring.
 */
const withSwarm = async (t, { rateLimits = null } = {}) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-rate-'))
  const fixtureDir = path.join(root, 'fixture')
  fs.mkdirSync(fixtureDir, { recursive: true })
  const file = path.join(fixtureDir, 'fixture.bin')
  writeFixture(file, FIXTURE_BYTES)
  const meta = makeTorrent({ file, pieceLength: 1024 * 1024 })
  // beside the payload, as tests/rig/run.mjs does, so the fleet's data directory and the metadata
  // it is handed describe the same place
  const torrentFile = path.join(fixtureDir, 'fixture.torrent')
  fs.writeFileSync(torrentFile, meta.torrent)

  const fleet = new SeederFleet({
    dir: path.join(root, 'seeders'),
    dataDir: fixtureDir,
    torrentFile,
    count: SEEDERS,
    uploadKBps: SEEDER_UP_KBPS,
  })
  const rig = new Rig({ storageDir: path.join(root, 'download'), enableDht: false, rateLimits })

  t.after(async () => {
    await fleet.stop()
    await rig.stop()
    fs.rmSync(root, { recursive: true, force: true })
  })

  const peers = await fleet.start()
  await fleet.waitSeeding()
  await rig.start()

  const handle = rig.session.addMagnet(magnetFor(meta.infoHash, meta.name, peers), '/dl')
  assert.ok(handle >= 0 && handle < 0xFFFFFF00, `add failed, handle ${handle}`)
  rig.startPump([handle])
  await rig.waitForMetadata(handle)
  // measuring from the first byte rather than from the add keeps the connect and handshake out of
  // the window, which at a 1 MB/s ceiling would otherwise be a large share of it
  await waitFor('the first byte to arrive', () => (rig.session.status(handle)?.totalDone ?? 0) > 0, 60_000)
  return { rig, handle, meta }
}

/**
 * The engine keeps running after the settings pack is applied.
 *
 * Cheap and worth having on its own, because the way this call fails is not a wrong number, it is a
 * thread that never returns. apply_settings is an async_call (session_handle.cpp:1001) so it posts
 * and returns, but nothing about the signature says so, and the sync_call next to it in the same
 * file is what hung the engine forever last time. No swarm, so this answers in under a second.
 */
test('setting a ceiling leaves the engine ticking', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-rate-tick-'))
  const rig = new Rig({ storageDir: path.join(root, 'download'), enableDht: false })
  t.after(async () => { await rig.stop(); fs.rmSync(root, { recursive: true, force: true }) })
  await rig.start()

  rig.session.setRateLimits({ download: 1 * MB, upload: 512_000 })
  rig.session.setRateLimits({ download: 0, upload: 0 })
  // one direction alone, which is the form the UI uses when only one field was edited
  rig.session.setRateLimits({ download: 2 * MB })

  for (let i = 0; i < 30; i++) rig.session.tick()
  const file = path.join(root, 'fixture.bin')
  writeFixture(file, 1024 * 1024)
  const meta = makeTorrent({ file, pieceLength: 256 * 1024 })
  const handle = rig.session.addMagnet(magnetFor(meta.infoHash, meta.name, []), '/dl')
  assert.ok(handle >= 0 && handle < 0xFFFFFF00, `add failed after setting limits, handle ${handle}`)
  rig.startPump([handle])
  // a torrent registering at all requires the io_context to have run, which is exactly what a
  // sync_call would have prevented
  await waitFor('the torrent to register after limits were set', () => rig.session.status(handle) != null)
})

/**
 * The two halves of the global ceiling, on one fleet: it holds a transfer down, and raising it lets
 * the transfer back up.
 *
 * The second half is what makes the first half mean something. On its own, "the rate stayed under
 * 1 MB/s" is equally consistent with a swarm that could only manage 1 MB/s anyway, and loopback
 * throughput is not something a test should assume. Raising the ceiling on the SAME session, the
 * same peers and the same torrent, and watching the rate follow it, rules that out from inside the
 * test rather than from an assumption about the machine.
 *
 * The ceiling is given to the constructor here, so this also covers the pre-session path: the value
 * is held in a static and read when the settings pack is built (wrapper.cpp lt_session_create), and
 * a torrent added seconds later must still see it.
 */
test('a global download ceiling holds the transfer, and raising it releases it', async (t) => {
  const CAP = 1 * MB
  const { rig, handle } = await withSwarm(t, { rateLimits: { download: CAP } })

  // the ceiling is a token bucket refilled per tick, so the first moments after the first byte can
  // run ahead of it; the window starts after that has settled
  await sleep(3000)
  const capped = await measure(rig, handle, 10_000)
  assert.ok(capped != null, 'the torrent finished during the capped window, so the fixture is too small')

  // 1.5x, not 1.05x: libtorrent accounts a rate limit over its own tick and lets a burst through
  // within one, and this measures wire bytes over a wall clock that does not line up with those
  // ticks. The number that matters is that it is nowhere near what the swarm can actually serve,
  // which the second half of this test establishes rather than assumes.
  assert.ok(
    capped <= CAP * 1.5,
    `capped at ${rate(CAP)} but transferred ${rate(capped)}`,
  )
  // the floor, without which this passes against an engine that downloads nothing
  assert.ok(
    capped >= CAP * 0.4,
    `capped at ${rate(CAP)} and only transferred ${rate(capped)}, so the download was not really running`,
  )

  const RAISED = 8 * MB
  rig.session.setRateLimits({ download: RAISED })
  await sleep(3000)
  const released = await measure(rig, handle, 8000)
  assert.ok(released != null, 'the torrent finished during the raised window, so the fixture is too small')

  assert.ok(
    released > CAP * 2,
    `raising the ceiling to ${rate(RAISED)} left the rate at ${rate(released)}, barely above the ${rate(CAP)} it was capped to`,
  )
  assert.ok(
    released <= RAISED * 1.5,
    `raised the ceiling to ${rate(RAISED)} and the transfer ran at ${rate(released)}, so it is not being honoured`,
  )
})

/**
 * A per-torrent ceiling under an open global one.
 *
 * These are separate limiters in libtorrent, not one setting with two names, and a torrent gets the
 * smaller of the two. This is the half ripple already had wired and never once exercised, so it is
 * worth its own measurement rather than an assumption that a shipped setter works.
 */
test('a per torrent ceiling holds that torrent below an unlimited session', async (t) => {
  const CAP = 1 * MB
  // no session ceiling at all, so anything observed here is the per-torrent limiter alone
  const { rig, handle } = await withSwarm(t)

  rig.session.setDownloadLimit(handle, CAP)
  await sleep(3000)
  const capped = await measure(rig, handle, 10_000)
  assert.ok(capped != null, 'the torrent finished during the window, so the fixture is too small')

  assert.ok(
    capped <= CAP * 1.5,
    `the torrent was capped at ${rate(CAP)} but transferred ${rate(capped)}`,
  )
  assert.ok(
    capped >= CAP * 0.4,
    `the torrent was capped at ${rate(CAP)} and only transferred ${rate(capped)}, so the download was not really running`,
  )

  // 0 is how every caller says unlimited, and it has to CLEAR a limit rather than mean "no change",
  // or a UI can set a ceiling and never take it off again
  rig.session.setDownloadLimit(handle, 0)
  await sleep(3000)
  const released = await measure(rig, handle, 8000)
  assert.ok(released != null, 'the torrent finished during the released window, so the fixture is too small')
  assert.ok(
    released > CAP * 2,
    `clearing the ceiling with 0 left the rate at ${rate(released)}, so 0 did not mean unlimited`,
  )
})
