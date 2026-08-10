#!/usr/bin/env node
// Deterministic streaming runs against a local swarm.
//
//   node tests/rig/run.mjs [--seeders N] [--size MB] [--piece KB] [--up KBPS]
//                          [--play MB] [--runs N] [--dht] [--keep] [--json out.json]
//
// The public swarm gave 14.7 s, 46.3 s and 73.4 s to first frame from BYTE
// IDENTICAL ripple code, so it cannot resolve anything under a ~3x effect at
// N=3. This exists so a picking change can be measured against a swarm that is
// the same on every run.
//
// Every trial gets its OWN seeder fleet, not just a fresh download directory.
//
// Sharing a fleet looks like an easy saving and silently destroys the run. The
// engine always listens on 0.0.0.0:6882 (wrapper.cpp pins it), so trial 2 looks
// to a seeder like the same peer that just vanished, and transmission applies
// its reconnect backoff to it. Measured on one shared fleet: 10.5 s, 37.0 s,
// 42.0 s, 8.5 s, 28.0 s to first byte, with one trial not seeing a peer for
// 33 s. With a fleet per trial the same measurement is stable.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { Rig } from './harness.mjs'
import { SeederFleet } from './seeders.mjs'
import { makeTorrent, magnetFor, writeFixture } from './make-torrent.mjs'

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] != null ? process.argv[i + 1] : fallback
}
const flag = (name) => process.argv.includes(`--${name}`)

const SEEDERS = Number(arg('seeders', 8))
const SIZE_MB = Number(arg('size', 256))
const PIECE_KB = Number(arg('piece', 1024))
const UP_KBPS = Number(arg('up', 10 * 1024))
const PLAY_MB = Number(arg('play', 32))
const RUNS = Number(arg('runs', 1))
const ENABLE_DHT = flag('dht')
const KEEP = flag('keep')

const root = path.join(os.tmpdir(), 'lt-rig')
const fixtureDir = path.join(root, 'fixture')
fs.mkdirSync(fixtureDir, { recursive: true })
const runDir = fs.mkdtempSync(path.join(root, 'run-'))

const median = (xs) => {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  return s[s.length >> 1]
}

const trial = async (meta, torrentFile, index) => {
  const downloadDir = path.join(runDir, `download-${index}`)
  fs.mkdirSync(downloadDir, { recursive: true })
  const fleet = new SeederFleet({
    dir: path.join(runDir, `seeders-${index}`),
    dataDir: fixtureDir,
    torrentFile,
    count: SEEDERS,
    uploadKBps: UP_KBPS,
  })
  const rig = new Rig({ storageDir: downloadDir, enableDht: ENABLE_DHT })
  try {
    const peers = await fleet.start()
    await fleet.waitSeeding()
    await rig.start()
    const handle = rig.session.addMagnet(magnetFor(meta.infoHash, meta.name, peers), '/dl')
    if (handle >= 0xFFFFFF00) throw new Error(`addMagnet failed: ${handle}`)
    rig.startPump([handle])

    await rig.waitForMetadata(handle)
    // Ripple's player issues its first watch at offset 0 as soon as the layout
    // lands (use-player-torrent.ts:52-55), before any read.
    rig.watch('rig', handle, 0, 0)
    const played = await rig.playFrom(handle, 0, { from: 0, bytes: PLAY_MB * 1024 * 1024 })

    const summary = rig.summary()
    summary.playedMB = Number((played / 1024 / 1024).toFixed(1))
    summary.seedersConnected = (await fleet.uploaded()).filter((s) => s.uploaded !== 'None').length
    return { summary, metrics: rig.metrics }
  } finally {
    await rig.stop()
    await fleet.stop()
    if (!KEEP) fs.rmSync(downloadDir, { recursive: true, force: true })
  }
}

const main = async () => {
  const payloadName = `fixture-${SIZE_MB}mb-${PIECE_KB}k.bin`
  const payload = path.join(fixtureDir, payloadName)
  process.stdout.write(`fixture ${SIZE_MB} MB ... `)
  writeFixture(payload, SIZE_MB * 1024 * 1024)
  const meta = makeTorrent({ file: payload, pieceLength: PIECE_KB * 1024 })
  const torrentFile = path.join(fixtureDir, `${payloadName}.torrent`)
  fs.writeFileSync(torrentFile, meta.torrent)
  console.log(`${meta.pieces} pieces of ${PIECE_KB} KB, infohash ${meta.infoHash.slice(0, 12)}`)

  console.log(`${SEEDERS} seeders per trial, dht=${ENABLE_DHT}`)
  const results = []
  try {
    for (let i = 0; i < RUNS; i++) {
      const r = await trial(meta, torrentFile, i)
      results.push(r)
      const s = r.summary
      console.log(
        `run ${i + 1}/${RUNS}  meta=${s.metadataMs}ms peer=${s.firstPeerMs}ms byte=${s.firstByteMs}ms `
        + `read=${s.firstReadMs}ms stalls=${s.stalls} peers=${s.maxPeers}/${s.seedersConnected} `
        + `peak=${(s.peakRate / 1e6).toFixed(1)}MB/s`,
      )
    }

    if (RUNS > 1) {
      const pick = (k) => results.map((r) => r.summary[k]).filter((v) => v != null)
      const spread = (k) => {
        const v = pick(k)
        if (!v.length) return 'n/a'
        return `median ${median(v)}  min ${Math.min(...v)}  max ${Math.max(...v)}`
      }
      console.log('\nacross runs:')
      for (const k of ['metadataMs', 'firstPeerMs', 'firstByteMs', 'firstReadMs', 'stalls', 'maxPeers']) {
        console.log(`  ${k.padEnd(13)} ${spread(k)}`)
      }
    } else {
      console.log('\n' + JSON.stringify(results[0].summary, null, 2))
    }

    // With DHT off and a trackerless torrent, the engine cannot learn any address
    // it was not handed, so anything beyond the fleet is a seeder dialling back
    // (allowed: peer_list keys on address, and an incoming connection is the
    // opposite direction from our outgoing one). Past 2x the fleet, something
    // else is in the swarm.
    const worst = Math.max(...results.map((r) => r.summary.maxPeers))
    if (worst > SEEDERS * 2) {
      console.error(`\nWARNING: peaked at ${worst} peers for a ${SEEDERS}-seeder fleet. The swarm is not isolated.`)
    }

    const jsonOut = arg('json', null)
    if (jsonOut) {
      fs.writeFileSync(jsonOut, JSON.stringify({
        config: { SEEDERS, SIZE_MB, PIECE_KB, UP_KBPS, PLAY_MB, RUNS, ENABLE_DHT },
        meta: { ...meta, torrent: undefined },
        results,
      }, null, 2))
      console.log(`\nwrote ${jsonOut}`)
    }
  } finally {
    if (!KEEP) fs.rmSync(runDir, { recursive: true, force: true })
    else console.log(`\nkept ${runDir}`)
  }
}

main().then(
  () => process.exit(0),
  (err) => { console.error(err); process.exit(1) },
)
