FROM emscripten/emsdk:4.0.3 AS build

ARG MAKEFLAGS="-j4"

# Boost is header-only for what libtorrent needs (asio + system + intrusive).
# Debian's libboost-dev installs headers under /usr/include/boost — visible to
# emcc by default because Emscripten's sysroot inherits the host include path
# during cross-compile.
RUN apt-get update && \
  apt-get install -y --no-install-recommends \
    build-essential \
    cmake \
    ninja-build \
    libboost-dev \
    git && \
  rm -rf /var/lib/apt/lists/*

# Ensure Emscripten's tools override 'llvm-*'.
ENV CC=emcc \
    CXX=em++ \
    AR=emar \
    NM=emnm \
    RANLIB=emranlib

# Bring in the submodule (mounted at build time by docker-compose) plus our
# top-level files. We copy in two layers so editing src/*.cpp doesn't
# invalidate the submodule layer.
COPY libtorrent /build/libtorrent
COPY patches /build/patches
COPY CMakeLists.txt /build/CMakeLists.txt
COPY src /build/src

WORKDIR /build

# Apply the upstream-touching patches against the pinned libtorrent submodule.
# These are WASM-specific hacks that can't go upstream (uTP timestamp clamp,
# WASI errno values, etc) — kept here as a transparent patch series.
RUN cd libtorrent && \
    for p in /build/patches/*.patch; do \
      echo "applying $p" && git apply --whitespace=nowarn "$p"; \
    done

# Build.
RUN cmake -S . -B build -G Ninja -DCMAKE_BUILD_TYPE=Release \
      -DCMAKE_TOOLCHAIN_FILE=${EMSDK}/upstream/emscripten/cmake/Modules/Platform/Emscripten.cmake \
      -DBOOST_ROOT=/usr/include && \
    cmake --build build
