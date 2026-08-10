#!/usr/bin/env node
// The scenario the rig exists for: a swarm that is healthy except for one peer
// sitting on the head of the file.
//
//   node tests/rig/bad-swarm.mjs [--seeders N] [--withhold K] [--size MB] [--runs N]
//
// A fleet of honest seeders serves everything; one peer claims the whole torrent,
// unchokes immediately, accepts requests for the first K pieces and answers none
// of them. That is the production symptom ("168 MB downloaded, still 0:00"):
// the head stranded while the rest of the torrent runs at full speed.
//
// What to look at: `stalls` and `firstReadMs`. The engine is supposed to notice
// the parked read, reclaim the blocks from the peer holding them
// (cancelPieceRequests, which only became effective in 0.3.8) and re-request them
// from someone else. If reclaim works, the read completes after a bounded number
// of 6 s attempts. If it does not, the read burns all 18 attempts.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { Rig } from './harness.mjs'
import { SeederFleet } from './seeders.mjs'
import { BadPeer } from './bad-peer.mjs'
import { makeTorrent, magnetFor, writeFixture } from './make-torrent.mjs'

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] != null ? process.argv[i + 1] : fallback
}
const flag = (name) => process.argv.includes(`--${name}`)

const SEEDERS = Number(arg('seeders', 4))
const WITHHOLD = Number(arg('withhold', 4))
const SIZE_MB = Number(arg('size', 128))
const PIECE_KB = Number(arg('piece', 1024))
const PLAY_MB = Number(arg('play', 16))
const UP_KBPS = Number(arg('up', 10 * 1024))
const RUNS = Number(arg('runs', 1))
const BAD_COUNT = flag('no-bad') ? 0 : Number(arg('bad', 1))

const root = path.join(os.tmpdir(), 'lt-rig')
const fixtureDir = path.join(root, 'fixture')
fs.mkdirSync(fixtureDir, { recursive: true })
const runDir = fs.mkdtempSync(path.join(root, 'bad-'))

const trial = async (meta, torrentFile, index) => {
  const downloadDir = path.join(runDir, `download-${index}`)
  fs.mkdirSync(downloadDir, { recursive: true })
  const fleet = new SeederFleet({
    dir: path.join(runDir, `seeders-${index}`),
    dataDir: fixtureDir, torrentFile, count: SEEDERS, uploadKBps: UP_KBPS,
  })
  // 127.0.0.100+ so the range never collides with the fleet's 127.0.0.2+.
  // Several of them, because ONE is not enough to reproduce anything: with fast
  // honest seeders the head is served before a single bad peer is ever asked for
  // it (measured: withheld=0), and slowing the seeders down to force the issue
  // just makes bandwidth the cause instead. The control proves that trap: at
  // 256 KB/s the stall pattern (pieces 0, 1, 2, 7) was IDENTICAL with and without
  // the bad peer. Production had 28-105 peers, so capture, not starvation, is
  // what strands the head.
  const bads = Array.from({ length: BAD_COUNT }, (_, i) => new BadPeer({
    infoHash: meta.infoHash,
    pieces: meta.pieces,
    host: `127.0.0.${100 + i}`,
    port: 51999,
    withhold: (piece) => piece < WITHHOLD,
  }))
  const rig = new Rig({ storageDir: downloadDir, enableDht: false })

  try {
    const peers = await fleet.start()
    await fleet.waitSeeding()
    for (const b of bads) peers.push(await b.start())

    await rig.start()
    const handle = rig.session.addMagnet(magnetFor(meta.infoHash, meta.name, peers), '/dl')
    if (handle >= 0xFFFFFF00) throw new Error(`addMagnet failed: ${handle}`)
    rig.startPump([handle])
    await rig.waitForMetadata(handle)
    rig.watch('rig', handle, 0, 0)

    const played = await rig.playFrom(handle, 0, { from: 0, bytes: PLAY_MB * 1024 * 1024 })
    const summary = rig.summary()
    summary.playedMB = Number((played / 1024 / 1024).toFixed(1))
    summary.badPeer = bads.reduce((a, b) => ({
      connections: a.connections + b.stats.connections,
      requests: a.requests + b.stats.requests,
      withheld: a.withheld + b.stats.withheld,
      served: a.served + b.stats.served,
      cancels: a.cancels + b.stats.cancels,
    }), { connections: 0, requests: 0, withheld: 0, served: 0, cancels: 0 })
    return summary
  } finally {
    await rig.stop()
    for (const b of bads) await b.stop()
    await fleet.stop()
    fs.rmSync(downloadDir, { recursive: true, force: true })
  }
}

const main = async () => {
  const payloadName = `fixture-${SIZE_MB}mb-${PIECE_KB}k.bin`
  const payload = path.join(fixtureDir, payloadName)
  writeFixture(payload, SIZE_MB * 1024 * 1024)
  const meta = makeTorrent({ file: payload, pieceLength: PIECE_KB * 1024 })
  const torrentFile = path.join(fixtureDir, `${payloadName}.torrent`)
  fs.writeFileSync(torrentFile, meta.torrent)
  console.log(
    `${meta.pieces} pieces of ${PIECE_KB} KB; ${SEEDERS} honest seeders`
    + `${BAD_COUNT === 0 ? ', NO bad peers (control)' : `, ${BAD_COUNT} peers withholding pieces 0-${WITHHOLD - 1}`}`
    + ` @ ${UP_KBPS} KB/s each`,
  )

  try {
    for (let i = 0; i < RUNS; i++) {
      const s = await trial(meta, torrentFile, i)
      console.log(
        `run ${i + 1}/${RUNS}  byte=${s.firstByteMs}ms read=${s.firstReadMs}ms stalls=${s.stalls} `
        + `maxRead=${s.maxReadMs}ms peers=${s.maxPeers} `
        + `bad{conn=${s.badPeer.connections} req=${s.badPeer.requests} withheld=${s.badPeer.withheld} cancels=${s.badPeer.cancels}}`,
      )
      if (s.stalls) console.log(`     stalled on pieces: ${s.stalledPieces.join(', ')}`)
    }
  } finally {
    fs.rmSync(runDir, { recursive: true, force: true })
  }
}

main().then(() => process.exit(0), (err) => { console.error(err); process.exit(1) })
