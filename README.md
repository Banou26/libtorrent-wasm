# libtorrent-wasm

[arvidn/libtorrent](https://github.com/arvidn/libtorrent) compiled to a
single-threaded WebAssembly module that runs in a Web Worker. Networking is
plumbed through the [FKN WebVPN](https://github.com/Banou26/fkn) via the
`@fkn/lib/net` and `@fkn/lib/dgram` polyfills, so a browser-hosted session can
talk real TCP and uTP to internet peers.

## Layout

```
libtorrent/    # git submodule, pinned at the merge base from upstream RC_2_0
patches/       # *.patch files applied to libtorrent/ at build time
src/           # the WASM port itself
  wrapper.cpp        - C++ entry points exposed to JS
  disk_io.{cpp,hpp}  - libtorrent disk_interface impl backed by a JS callback
  library_fkn.js     - emscripten js-library: socket syscalls + disk bridge
  index.ts           - public JS API (Session)
  opfs.ts            - StorageBackend impl backed by the OPFS
  types.ts           - shared TS types
src/app/       # browser harness with diagnostic pages
dist/          # emcc output (gitignored)
build/         # vite output + copied wasm artefacts (gitignored)
```

## Streaming

To play a file while it downloads, tell the session where each reader is and let
it plan:

```js
session.setStreamWindow(handle, [{ fileIndex, offset: playheadByte }])
const header = await session.read(handle, fileIndex, 0, 256 * 1024)
```

Call `setStreamWindow` again on every seek and as playback advances, on a real
position change rather than on every read: each call empties the time-critical
set, so the next deadline re-posts a cancel of every outstanding non-critical
block request, and it copies a full piece-count vector across the boundary.

`read()` resolves once the covering pieces have landed and rejects after 60 s
(`timeoutMs`) rather than waiting forever. Placing a deadline also raises the
piece to top priority and un-filters it, so reading into a file you set to
priority 0 starts downloading that range; pass `deadlineMs: null` to read
without touching priorities.

`popAlerts()` (or `alerts()`) has to be pumped for a `read()` to ever resolve:
that is where a state update lands and the have-bits are read. `tick()` asks for
the status updates on its own.

### Priority does not mean order

This is the part that catches people. In libtorrent a piece priority is a
*weight*, not a position:

- A band of top-priority (7) pieces is bucketed by how many peers have each one
  and shuffled inside each bucket, so it is served in effectively random order.
- Sequential mode's in-order walk **skips** top-priority pieces, on the
  assumption the priority pass already took them. Painting a whole file 7
  therefore removes it from the only in-order path there is.
- Ordering comes from `set_piece_deadline`, which is the mechanism upstream
  points at for streaming.

So `setStreamWindow` keeps the bulk of the claimed file at normal priority,
where the sequential cursor walks it in index order, and promotes only a small
window at the playhead with a staggered deadline ladder behind it. Widening
`windowPieces` past a couple of dozen makes playback worse, not better.

The other half of the surprise: under sequential mode only **0 versus not 0**
changes picking. Priority 1 and priority 4 pick identically, so demoting what is
behind the playhead buys nothing.

`deadlineStepMs` defaults to 1000, which is a placeholder. The honest value is
`pieceLength / playbackBytesPerSecond * 1000`, and only the caller knows the
bitrate. For small pieces the default authorizes falling behind real time.

Three sharp edges the API handles for you, worth knowing if you drive the
primitives directly:

- `clearPieceDeadlines()` leaves every cleared piece at priority **1**, below
  the default 4. Always clear *before* writing priorities, never after.
- `resetPieceDeadline()` demotes that one piece the same way, so put its
  priority back afterwards.
- A deadline is an absolute instant, and nothing removes it but the piece
  arriving. An expired deadline from an abandoned seek outranks every range
  requested after it, so retire deadlines you no longer want.

### When a read waits on a piece nobody will deliver

One peer can claim every block of a piece and then stop sending them. Nothing in
libtorrent recovers that on its own:

- The picker walks straight past it. Its "is this piece available" test checks
  only have/filtered, with no "already being downloaded" case, so the in-order
  walk keeps downloading ahead at full speed while the piece sits there. Bytes
  keep climbing and playback does not start.
- No other peer may duplicate the blocks while its own request queue is
  non-empty, which in a live swarm is always.
- The sweep that cancels stale requests deliberately skips pieces that have a
  deadline, so marking a piece urgent is what protects the stall.
- The duplicate-request rescue only engages once a deadlined piece has already
  completed, so it is inert exactly when it is needed, at startup.

`cancelPieceRequests(handle, piece)` is the way out: it drops every outstanding
request for that piece so any peer can pick it up again. Call it for a read that
has already been waiting several seconds, not on the first attempt, since it
discards partial blocks from peers that were merely slow.

### API

| Call | Purpose |
| --- | --- |
| `setStreamWindow(handle, claims, opts?)` | Plan priorities + deadlines from reader positions. The one to use. |
| `clearStreamWindow(handle)` | Drop the plan, everything back to normal, sequential off. |
| `read(handle, fileIndex, offset, len, opts?)` | Await a byte range. Clamps to EOF; `{ timeoutMs, signal, deadlineMs }`. |
| `setSequential(handle, on)` | The `sequential_download` flag on its own. |
| `setPieceDeadline(handle, piece, ms, alertWhenAvailable?)` | One deadline. `ms` is relative to now. |
| `resetPieceDeadline(handle, piece)` | Retire one deadline, leaving the rest. |
| `cancelPieceRequests(handle, piece)` | Take a piece back from peers sitting on it. See below. |
| `clearPieceDeadlines(handle)` | Retire all of them. Demotes to priority 1. |
| `prioritizePieces(handle, prios)` | Positional map, one byte per piece from 0. |
| `prioritizePieceList(handle, entries)` | Sparse update; other pieces keep what they have. |
| `setFilePriorities(handle, prios)` | One byte per file. Rewrites piece priorities. |
| `setFilePriority(handle, fileIndex, prio)` | One file. Also rewrites its piece priorities. |
| `piecePriorities(handle)` | What this Session last wrote, or null. |
| `prioritizeRange(handle, fileIndex, offset, len)` | One-off prefetch. REPLACES an active window. |

Priorities are `PRIORITY.skip` (0), `low` (1), `normal` (4), `top` (7). Values
above 7 truncate into a 3-bit field, and 8 lands as 0 (never download), so stay
on those. Everything except `setSequential`, `setPieceDeadline` and
`setFilePriority` needs the file layout, so wait for `files(handle)` to be
non-null.

### Multi-file torrents

Pass `unclaimedPriority: PRIORITY.skip`. This is not just a bandwidth
optimization: sequential mode's cursor sits at the first piece the torrent does
not have, so with everything at the default 4 the capacity beyond the window
goes to the **first file in the torrent**, not the one being watched. Skipping
is what moves the cursor onto the watched file.

Pieces straddling a file boundary keep the claimed priority, so no byte the
watched file needs is ever skipped. Skipping files shrinks `totalWanted`, so
`progress` and the finished state then describe the selection rather than the
whole torrent, and the selection is persisted into resume data.

## Building

The full build runs inside Docker so the host needs nothing but Docker +
Node:

```sh
./build.sh     # one-shot: builds the image, copies dist/* out
```

For iterative C++ development:

```sh
npm install
npm run dev    # rebuilds dist/ + vite on change
```

After `dist/libtorrent.{js,wasm}` exists, the app harness can run:

```sh
cp dist/libtorrent.{js,wasm} src/app/
cd src/app
npm install
npm run dev    # vite dev server on :4560
```

## Patches

`patches/*.patch` carry the WASM-specific edits on top of pinned upstream
libtorrent: uTP LEDBAT bypass, WASI errno values, FIONREAD tolerance, etc.
They're applied via `git apply` at build time (`make apply-patches`). To
rebase against a newer upstream, bump the submodule and rerun `make
apply-patches`; rejected hunks must be reconciled manually.
