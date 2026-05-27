# libtorrent-wasm

[arvidn/libtorrent](https://github.com/arvidn/libtorrent) compiled to a
single-threaded WebAssembly module that runs in a Web Worker. Networking is
plumbed through the [FKN WebVPN](https://github.com/Banou26/fkn) via the
`@webvpn/net` and `@webvpn/dgram` polyfills, so a browser-hosted session can
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
example/       # browser harness with diagnostic pages
dist/          # emcc output (gitignored)
build/         # vite output + copied wasm artefacts (gitignored)
```

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

After `dist/libtorrent.{js,wasm}` exists, the example harness can run:

```sh
cd example
npm install
npm run dev    # vite dev server on :4560
```

## Patches

`patches/*.patch` carry the WASM-specific edits on top of pinned upstream
libtorrent — uTP LEDBAT bypass, WASI errno values, FIONREAD tolerance, etc.
They're applied via `git apply` at build time (`make apply-patches`). To
rebase against a newer upstream, bump the submodule and rerun `make
apply-patches`; rejected hunks must be reconciled manually.
