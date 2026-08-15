// Changing what a torrent does, and being able to see that it changed.
//
// Every one of these settings is a control a user is offered, so the thing that matters is not
// only that the call lands but that the state it produces is READABLE afterwards. A checkbox that
// remembers what it last asked for looks identical to one that works, right up until the engine
// refuses the request or something else changes the flag underneath it. `status().flags` is what
// makes the difference observable, and these assert against it rather than against the setter's
// return value.
//
// The discovery flags are stored in the NEGATIVE (disable_dht, disable_pex), so a UI offering
// "find peers with the DHT" is offering the inverse. Getting that backwards silently turns a
// privacy control into its opposite, which is the kind of bug that never announces itself, so it
// is asserted explicitly here.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { TORRENT_FLAG } from '../build/index.js'
import { Rig } from './rig/harness.mjs'
import { magnetFor, makeTorrent, writeFixture } from './rig/make-torrent.mjs'
import { waitFor } from './rig/peer-handshake.mjs'

const withTorrent = async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-flags-'))
  const file = path.join(root, 'fixture.bin')
  writeFixture(file, 1024 * 1024)
  const meta = makeTorrent({ file, pieceLength: 256 * 1024 })

  const rig = new Rig({ storageDir: path.join(root, 'download'), enableDht: false })
  await rig.start()
  t.after(async () => {
    await rig.stop()
    fs.rmSync(root, { recursive: true, force: true })
  })

  const handle = rig.session.addMagnet(magnetFor(meta.infoHash, meta.name, []))
  assert.ok(handle >= 0 && handle < 0xFFFFFF00, `add failed, handle ${handle}`)
  rig.startPump([handle])
  await waitFor('the torrent to be registered', () => rig.session.status(handle) != null)
  return { rig, handle }
}

/** Flags reach JS through the ordinary status broadcast, so a change needs a pump to become visible. */
const flagsAfter = (rig, handle, predicate) =>
  waitFor('the flag change to be reported', () => {
    const flags = rig.session.status(handle)?.flags
    return flags !== undefined && predicate(flags) ? flags : null
  })

test('a flag that is set reads back as set', async (t) => {
  const { rig, handle } = await withTorrent(t)
  assert.equal((rig.session.status(handle).flags & TORRENT_FLAG.sequentialDownload) !== 0, false)

  rig.session.setFlag(handle, TORRENT_FLAG.sequentialDownload, true)
  await flagsAfter(rig, handle, (f) => f & TORRENT_FLAG.sequentialDownload)

  rig.session.setFlag(handle, TORRENT_FLAG.sequentialDownload, false)
  await flagsAfter(rig, handle, (f) => !(f & TORRENT_FLAG.sequentialDownload))
})

/**
 * The decoded `sequential` boolean and the raw flag word are two views of one value, so they must
 * never disagree. They are written from the same `st.flags` in the same statement in wrapper.cpp;
 * this is what would catch that being changed to two reads of a moving target.
 */
test('the decoded booleans agree with the flag word they came from', async (t) => {
  const { rig, handle } = await withTorrent(t)
  for (const on of [true, false, true]) {
    rig.session.setFlag(handle, TORRENT_FLAG.sequentialDownload, on)
    await flagsAfter(rig, handle, (f) => !!(f & TORRENT_FLAG.sequentialDownload) === on)
    const st = rig.session.status(handle)
    assert.equal(st.sequential, !!(st.flags & TORRENT_FLAG.sequentialDownload))
    assert.equal(st.paused, !!(st.flags & TORRENT_FLAG.paused))
    assert.equal(st.autoManaged, !!(st.flags & TORRENT_FLAG.autoManaged))
  }
})

/**
 * Bits libtorrent moves on its own, which no assertion about "nothing else changed" may include.
 *
 * `paused` and `autoManaged` are the queue's, not the caller's: an auto-managed torrent is stopped
 * and started as slots free up, and it does that on its own schedule. Measured here on 2026-08-16,
 * where a single setFlag(disablePex) run showed 0x200010 changed, the extra 0x10 being `paused`
 * flipping between the two reads with nothing having asked it to. `needSaveResume` is set by the
 * engine whenever state worth persisting moves, which any flag change is.
 */
const ENGINE_MANAGED =
  TORRENT_FLAG.paused | TORRENT_FLAG.autoManaged | TORRENT_FLAG.needSaveResume | TORRENT_FLAG.seedMode

/**
 * The mask is the whole point of setFlags: one read-modify-write, so a status update landing
 * mid-change cannot show a combination nobody asked for. Setting one bit must leave every other
 * bit the CALLER owns exactly as it was.
 */
test('setting one flag leaves the others untouched', async (t) => {
  const { rig, handle } = await withTorrent(t)
  const before = rig.session.status(handle).flags

  rig.session.setFlag(handle, TORRENT_FLAG.disablePex, true)
  const after = await flagsAfter(rig, handle, (f) => f & TORRENT_FLAG.disablePex)

  const changed = (before ^ after) & ~ENGINE_MANAGED
  assert.equal(changed, TORRENT_FLAG.disablePex,
    `expected only disablePex to move, got 0x${changed.toString(16)}`)
})

test('two flags can be changed in opposite directions in one call', async (t) => {
  const { rig, handle } = await withTorrent(t)
  rig.session.setFlag(handle, TORRENT_FLAG.disableDht, true)
  await flagsAfter(rig, handle, (f) => f & TORRENT_FLAG.disableDht)

  // dht back on, pex off, in a single mask
  const mask = TORRENT_FLAG.disableDht | TORRENT_FLAG.disablePex
  rig.session.setFlags(handle, TORRENT_FLAG.disablePex, mask)
  const after = await flagsAfter(rig, handle, (f) => !(f & TORRENT_FLAG.disableDht))

  assert.equal(after & TORRENT_FLAG.disableDht, 0, 'dht was not re-enabled')
  assert.ok(after & TORRENT_FLAG.disablePex, 'pex was not disabled')
})

/**
 * These read backwards on purpose, and the test says so out loud. `disableDht` UNSET is the DHT
 * being used. A UI checkbox labelled "find peers with the DHT" is therefore checked when the flag
 * is absent, and an implementation that forgets the inversion turns the control into its opposite
 * without any error to notice.
 */
test('the discovery flags are stored in the negative', async (t) => {
  const { rig, handle } = await withTorrent(t)
  // a fresh torrent uses the DHT and PEX, so neither disable bit is set
  const fresh = rig.session.status(handle).flags
  assert.equal(fresh & TORRENT_FLAG.disableDht, 0, 'a new torrent had the DHT already disabled')
  assert.equal(fresh & TORRENT_FLAG.disablePex, 0, 'a new torrent had PEX already disabled')

  rig.session.setFlag(handle, TORRENT_FLAG.disableDht, true)
  const off = await flagsAfter(rig, handle, (f) => f & TORRENT_FLAG.disableDht)
  assert.ok(off & TORRENT_FLAG.disableDht, 'turning the DHT OFF must SET the flag')
})

test('upload mode can be turned on and back off', async (t) => {
  const { rig, handle } = await withTorrent(t)
  rig.session.setFlag(handle, TORRENT_FLAG.uploadMode, true)
  await flagsAfter(rig, handle, (f) => f & TORRENT_FLAG.uploadMode)
  rig.session.setFlag(handle, TORRENT_FLAG.uploadMode, false)
  await flagsAfter(rig, handle, (f) => !(f & TORRENT_FLAG.uploadMode))
})

/**
 * None of these can report success, since they are asynchronous commands on a handle. What they
 * must not do is throw or take the session down, because each one sits behind a menu item a user
 * can hold down.
 */
test('the fire-and-forget controls survive being called', async (t) => {
  const { rig, handle } = await withTorrent(t)
  rig.session.forceReannounce(handle)
  for (const where of ['top', 'up', 'down', 'bottom']) rig.session.moveInQueue(handle, where)
  rig.session.setUploadLimit(handle, 64 * 1024)
  rig.session.setDownloadLimit(handle, 128 * 1024)
  // negative and fractional inputs are clamped rather than passed through to the engine
  rig.session.setUploadLimit(handle, -1)
  rig.session.setDownloadLimit(handle, 1.5)

  // the session is still alive and still reporting afterwards
  await waitFor('the session to keep reporting', () => rig.session.status(handle) != null)
})

test('an unknown handle is refused rather than crashing the session', async (t) => {
  const { rig, handle } = await withTorrent(t)
  rig.session.setFlag(0xDEADBEEF, TORRENT_FLAG.sequentialDownload, true)
  rig.session.forceReannounce(0xDEADBEEF)
  rig.session.moveInQueue(0xDEADBEEF, 'top')
  rig.session.setUploadLimit(0xDEADBEEF, 1024)
  await waitFor('the session to keep reporting', () => rig.session.status(handle) != null)
})
