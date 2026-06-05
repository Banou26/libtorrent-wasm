FROM emscripten/emsdk:4.0.3 AS build

ARG MAKEFLAGS="-j4"

# Build tooling only — the source (incl. the libtorrent submodule) is mounted at
# /build by docker-compose, and `make dist` applies the patch series + runs
# emcmake there. Nothing is baked in, so editing src/*.cpp just needs a re-run,
# and the submodule's .git gitlink resolves (it's mounted, not COPYied — copying
# it breaks the gitlink and `git apply` dies with exit 128).
RUN apt-get update && \
  apt-get install -y --no-install-recommends ninja-build curl ca-certificates git && \
  rm -rf /var/lib/apt/lists/*

# Boost is header-only for what libtorrent uses (asio + system + intrusive). We
# need a C++17-clean Boost: >=1.81 dropped std::unary_function, which emsdk
# 4.0.3's libc++ (clang 21) removed with no escape hatch. Drop the headers INTO
# the emscripten sysroot so emcc finds them natively — NOT via -I/usr/include,
# which would shadow the cross sysroot's own libc headers (host glibc <stdint.h>
# leaks → "bits/libc-header-start.h not found").
ARG BOOST_VERSION=1.84.0
RUN BV_US=$(echo "$BOOST_VERSION" | tr . _) && \
    curl -fsSL "https://archives.boost.io/release/${BOOST_VERSION}/source/boost_${BV_US}.tar.bz2" -o /tmp/boost.tar.bz2 && \
    tar xf /tmp/boost.tar.bz2 -C /tmp && \
    cp -r "/tmp/boost_${BV_US}/boost" "${EMSDK}/upstream/emscripten/cache/sysroot/include/" && \
    rm -rf /tmp/boost.tar.bz2 "/tmp/boost_${BV_US}"

# Emscripten's tools override 'llvm-*'. (emcmake also sets the toolchain, but
# these keep plain make/cmake invocations honest too.)
ENV CC=emcc CXX=em++ AR=emar NM=emnm RANLIB=emranlib

# The mounted repo is owned by the host user; let git operate on it regardless.
RUN git config --system --add safe.directory '*'

WORKDIR /build
