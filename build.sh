#!/usr/bin/env bash
# One-shot: bake the docker image, copy dist/* out of the container, drop it.
# Mirrors libav-wasm/build.sh.
set -euo pipefail
mkdir -p dist
docker build -t libtorrent-wasm .
docker create -ti --name libtorrent-wasm-container libtorrent-wasm
docker cp libtorrent-wasm-container:/build/dist/. dist/
docker rm -fv libtorrent-wasm-container
