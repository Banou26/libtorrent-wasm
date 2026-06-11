# libtorrent → WASM build orchestration.
#
# Most builds run inside Docker (see `docker-compose.yml` + `make make-docker`)
# so the host doesn't need emsdk + cmake + boost installed. The build inside
# the container invokes the rules in this Makefile.
#
# Layered:
#   dist/libtorrent.{js,wasm}   - emscripten output (this Makefile, inside docker)
#   build/index.js              - vite library bundle of src/index.ts
#   build/libtorrent.{js,wasm}  - copied from dist/ by `make copy-wasm`

.PHONY: all clean apply-patches reset-submodule cmake-build dist

all: dist

# ---- patch series ----------------------------------------------------------
# patches/*.patch are applied on top of the pinned libtorrent submodule. They
# carry WASM-specific changes that can't go upstream (uTP LEDBAT bypass, WASI
# errno values, etc). Reset first so re-running is idempotent.
apply-patches: reset-submodule
	@for p in patches/*.patch; do \
	  echo "applying $$p" && \
	  (cd libtorrent && git apply --whitespace=nowarn ../$$p) || exit 1; \
	done

reset-submodule:
	@if [ -d libtorrent/.git ] || [ -f libtorrent/.git ]; then \
	  cd libtorrent && git checkout -- . && git clean -fd; \
	fi

# ---- emscripten compile (inside docker) -----------------------------------
# emcmake wires the Emscripten toolchain (compiler + sysroot include order, so
# Boost - staged into the sysroot by the Dockerfile - resolves without leaking
# host headers). Build in `cmake-out`, NOT `build/`: that's the npm package dir
# vite + copy-wasm write into, and a shared dir collides (root-owned cmake
# intermediates then block the host vite write).
cmake-build:
	emcmake cmake -S . -B cmake-out -G Ninja -DCMAKE_BUILD_TYPE=Release && \
	cmake --build cmake-out

dist: apply-patches cmake-build

clean:
	rm -rf cmake-out dist build
