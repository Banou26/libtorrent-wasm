// check() is what tells libtorrent whether to trust a torrent's recorded pieces or hash
// them back off the disk, and both wrong answers are expensive: no_error over real files
// turns a force_recheck into a full re-download, need_full_check over an empty directory
// hashes a whole torrent's worth of nothing.
//
// Runs the built build/opfs.js against a fake OPFS, so none of this needs a browser.
//
// Run: node --test tests/opfs-check.test.mjs

import assert from 'node:assert/strict'
import test from 'node:test'

const NO_ERROR = 0
const NEED_FULL_CHECK = 2

class NotFound extends Error {
  constructor() { super('not found'); this.name = 'NotFoundError' }
}

// Directory tree of { [name]: number | Directory }, where a number is a file's size.
const makeDir = (entries = {}) => ({
  entries,
  async getDirectoryHandle(name, opts) {
    const existing = this.entries[name]
    if (existing && typeof existing !== 'number') return existing
    if (!opts?.create) throw new NotFound()
    const dir = makeDir()
    this.entries[name] = dir
    return dir
  },
  async getFileHandle(name, opts) {
    const size = this.entries[name]
    if (typeof size !== 'number') {
      if (!opts?.create) throw new NotFound()
      this.entries[name] = 0
      return { getFile: async () => ({ size: 0 }) }
    }
    return { getFile: async () => ({ size }) }
  },
})

// node exposes navigator as a getter-only global, so it has to be redefined rather than
// assigned.
const withRoot = async (root, run) => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { storage: { getDirectory: async () => root } },
  })
  try { return await run() } finally {
    if (previous) Object.defineProperty(globalThis, 'navigator', previous)
    else delete globalThis.navigator
  }
}

const { OPFSStorage } = await import('../build/opfs.js')

const files = [{ path: 'movie.mkv', size: 1_000 }, { path: 'extras/sample.mkv', size: 10 }]

test('asks for a hash pass when a file holds bytes', async () => {
  const root = makeDir({ dl: makeDir({ 'movie.mkv': 512 }) })
  await withRoot(root, async () => {
    const storage = new OPFSStorage()
    await storage.onNewStorage(1, '/dl', files)
    assert.equal(await storage.check(1), NEED_FULL_CHECK)
  })
})

test('trusts an empty storage rather than hashing nothing', async () => {
  const root = makeDir({ dl: makeDir() })
  await withRoot(root, async () => {
    const storage = new OPFSStorage()
    await storage.onNewStorage(1, '/dl', files)
    assert.equal(await storage.check(1), NO_ERROR)
  })
})

// openFile creates files on demand, so a torrent that was only ever read from leaves
// zero-length files behind. Counting those as data would hash every one of them.
test('treats a zero-length file as no data', async () => {
  const root = makeDir({ dl: makeDir({ 'movie.mkv': 0, extras: makeDir({ 'sample.mkv': 0 }) }) })
  await withRoot(root, async () => {
    const storage = new OPFSStorage()
    await storage.onNewStorage(1, '/dl', files)
    assert.equal(await storage.check(1), NO_ERROR)
  })
})

test('finds bytes in a nested file, not just the first one', async () => {
  const root = makeDir({ dl: makeDir({ 'movie.mkv': 0, extras: makeDir({ 'sample.mkv': 4 }) }) })
  await withRoot(root, async () => {
    const storage = new OPFSStorage()
    await storage.onNewStorage(1, '/dl', files)
    assert.equal(await storage.check(1), NEED_FULL_CHECK)
  })
})

// libtorrent calls async_check_files from inside the same synchronous pass that creates
// the storage, so this is the ordering that actually happens on every add, not a corner.
test('waits for a storage that is still opening', async () => {
  const root = makeDir({ dl: makeDir({ 'movie.mkv': 512 }) })
  await withRoot(root, async () => {
    const storage = new OPFSStorage()
    const opening = storage.onNewStorage(1, '/dl', files)
    // Deliberately not awaited first: this is the caller libtorrent actually is.
    const status = await storage.check(1)
    await opening
    assert.equal(status, NEED_FULL_CHECK)
  })
})

test('answers for a storage it has never heard of instead of throwing', async () => {
  const root = makeDir({})
  await withRoot(root, async () => {
    const storage = new OPFSStorage()
    // A rejection reaches libtorrent as a disk error, which stops the torrent outright.
    assert.equal(await storage.check(99), NO_ERROR)
  })
})

// Never opening is not the same as opening and finding nothing, and only one of the two
// answers is safe to guess at.
test('asks for a hash pass when the storage failed to open', async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { storage: { getDirectory: async () => { throw new Error('opfs unavailable') } } },
  })
  try {
    const storage = new OPFSStorage()
    await storage.onNewStorage(1, '/dl', files).catch(() => {})
    assert.equal(await storage.check(1), NEED_FULL_CHECK)
  } finally {
    if (previous) Object.defineProperty(globalThis, 'navigator', previous)
    else delete globalThis.navigator
  }
})

test('does not create the files it is checking for', async () => {
  const dl = makeDir()
  const root = makeDir({ dl })
  await withRoot(root, async () => {
    const storage = new OPFSStorage()
    await storage.onNewStorage(1, '/dl', files)
    await storage.check(1)
    assert.deepEqual(Object.keys(dl.entries), [])
  })
})
