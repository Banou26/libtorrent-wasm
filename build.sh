#!/usr/bin/env bash
set -euo pipefail
mkdir -p dist
docker build -t libtorrent-wasm .
docker create -ti --name libtorrent-wasm-container libtorrent-wasm
docker cp libtorrent-wasm-container:/build/dist/. dist/
docker rm -fv libtorrent-wasm-container
