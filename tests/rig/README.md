# Local swarm rig

Drives the real engine from node against a local swarm, so a picking change can be
measured against a swarm that is the same on every run.

## Why

Three trials of byte-identical ripple code against the public swarm gave **14.7 s,
46.3 s and 73.4 s** to first frame. That cannot resolve anything under roughly a 3x
effect at N=3, which makes every streaming change unfalsifiable.

The same measurement here:

```
run 1/5  meta=1022ms peer=1522ms byte=10522ms ...
run 2/5  meta=1008ms peer=1508ms byte=10513ms ...
run 3/5  meta=1009ms peer=1509ms byte=10512ms ...
run 4/5  meta=1010ms peer=1509ms byte=10512ms ...
run 5/5  meta=1009ms peer=1510ms byte=10512ms ...
```

`net` and `dgram` are injected (`SessionOptions.net` / `.dgram`), so in node you
pass the real ones and the WASM is the same WASM the browser ships.

## Use

```
npm run test:swarm -- --seeders 8 --size 256 --play 64 --runs 3
npm run test:bad-peer -- --seeders 2 --bad 8 --withhold 12 --runs 2
npm run test:bad-peer -- --seeders 2 --no-bad --runs 3      # the control
```

Needs transmission on PATH-ish; point `RIG_TRANSMISSION` at a store path, or:

```
nix build --no-link --print-out-paths 'nixpkgs#transmission_4'
```

## Parts

| file | what |
| --- | --- |
| `harness.mjs` | ripple's `worker.ts` behaviour: the pumps, `setStreamWindow`, the read stall loop |
| `stream-plan.mjs` | verbatim port of `ripple/src/torrent/stream-plan.ts`. Diff when either moves |
| `node-storage.mjs` | `StorageBackend` over `fs`, the readable backend node lacks |
| `node-host.mjs` | node's `net`/`dgram`, with libuv errno mapped to the shim's WASI table |
| `make-torrent.mjs` | bencode + trackerless torrent, no external tool |
| `seeders.mjs` | a fleet of real transmission daemons |
| `bad-peer.mjs` | a peer that claims pieces and does not deliver them |

## What it does not answer

OPFS and its sync access handles, ripple's read path, the player, multi-tab engine
election, and the relay data plane. Several `wrapper.cpp` settings were tuned FOR
that relay (`utp_target_delay` 600 against a default of 100, `utp_loss_multiplier`
90, `utp_min_timeout` 1200), and loopback has none of its latency profile.

**Picking results transfer. Throughput results do not.** `NodeFSStorage` is also
synchronous where OPFS awaits a handle, so the disk hop is absent here.

## Four traps, each of which silently ruins a run

Every one of these was hit while building this, and each produced plausible
numbers rather than an error.

**A leaked seeder squats its address.** A daemon from an earlier run keeps its
peer port and its rpc port, the new daemon loses the bind, and every readiness
check still passes because they all talk to the stale process. The engine then
dials a peer serving a different infohash. This read as an engine behaviour
("only 2 of 4 seeders ever connect", "6 of 8") for as long as it took to look at
the pids. `SeederFleet.start()` now refuses to start on an occupied address, and a
reaper kills the fleet on any exit path. To clear one by hand:

```
pkill -f "transmission-daem[o]n"
```

The character class is deliberate: a plain pattern matches the pkill's own command
line, so `pkill -f transmission-daemon` reports success having killed your shell.

**Trials cannot share a fleet.** The engine always listens on `0.0.0.0:6882`, so
trial 2 looks like the peer that just vanished and transmission applies reconnect
backoff. One shared fleet gave 10.5 s, 37.0 s, 42.0 s, 8.5 s, 28.0 s to first
byte. A fleet per trial gives 10512-10522 ms.

**Adding the torrent to every seeder in a tight loop phase-locks the swarm.**
transmission's rechoke runs on a fixed period anchored at the torrent add, so the
whole fleet unchokes at one instant and nothing arrives before it: first byte sat
at 10513 ms +/- 5 ms whether the fleet was 1, 3 or 8 seeders. Spreading the adds
moves it to 3009 ms and takes the stalls to zero. Staggering the daemon SPAWNS
instead does nothing, which is what made this hard to see.

**DHT on is not a local swarm.** The session announces the fixture's infohash
publicly and gets real peers back for it. Two runs of one trace diverged
completely, one reaching metadata in 906 ms and the next never reaching it. The
rig passes `enableDht: false`; production keeps the default of true.

## The private flag would break this outright

`mktorrent -p` looks like the way to isolate a rig and is a trap for a
magnet-driven one. `create_ut_metadata_plugin` returns `{}` when
`valid_metadata() && priv()` (`libtorrent/src/ut_metadata.cpp:631-637`), torrent
plugins attach exactly once at add time (`session_impl.cpp:4910-4919`), and a
seeder handed a `.torrent` already has valid metadata then. So every seeder of a
private torrent refuses to serve metadata, `ut_metadata` never reaches the
extended handshake, and the leecher parks at "Loading metadata" forever with a
completely healthy data plane. ut_metadata is the only metadata path in this tree.

Isolation does not need the flag: the infohash covers a fixture that exists only
on this machine.

## Reproducing the stall needs MANY bad peers, and a control

One bad peer proves nothing. With fast honest seeders the head is served before a
single bad peer is ever asked for it (`withheld=0`), and slowing the seeders down
to force the issue makes bandwidth the cause instead:

```
2 seeders @ 256 KB/s, 1 bad peer   stalls=3, pieces 0,1,2,7
2 seeders @ 256 KB/s, no bad peer  stalls=3, pieces 0,1,2,7   <- identical
```

Production had 28-105 peers, so capture is what strands the head, not starvation.
At full speed the same comparison separates cleanly:

```
2 seeders @ 10 MB/s, 8 bad peers   stalls=1-2, first read 9.5s / 17.0s, withheld=32-44, cancels=32-44
2 seeders @ 10 MB/s, no bad peers  stalls=0,   first read 6.5s (x3)
```

The `cancels` are the engine reclaiming blocks from the peers sitting on them,
which is what `cancelPieceRequests` was fixed to do in 0.3.8. Always run
`--no-bad` alongside; without it a bandwidth artifact reads as the bug.
