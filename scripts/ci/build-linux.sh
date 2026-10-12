#!/bin/sh
# Builds the addon for a Linux prebuild target inside its container (spec 0005):
#   docker run -v "$PWD:/w" -w /w <image> sh scripts/ci/build-linux.sh <target>
# glibc targets run in manylinux_2_28 images (glibc 2.28 baseline), musl targets in node:alpine.
# Expects ALEMBIC_VERSION, IMATH_VERSION and NODE_VERSION in the environment.
set -eu
TARGET="$1"
PREFIX="$(pwd)/.deps/alembic-sdk-$TARGET"

case "$TARGET" in
*-musl)
    apk add --no-cache bash build-base cmake git binutils linux-headers >/dev/null
    ;;
*)
    case "$TARGET" in linux-arm64) NODE_ARCH=arm64 ;; *) NODE_ARCH=x64 ;; esac
    curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-$NODE_ARCH.tar.xz" | tar -xJ -C /opt
    export PATH="/opt/node-v$NODE_VERSION-linux-$NODE_ARCH/bin:$PATH"
    npm install --global --silent yarn@1.22.22
    ;;
esac

if [ ! -f "$PREFIX/lib/cmake/Alembic/AlembicConfig.cmake" ]; then
    JOBS="$(nproc)" bash scripts/ci/build-alembic.sh "$PREFIX" "$IMATH_VERSION" "$ALEMBIC_VERSION"
fi
yarn install --frozen-lockfile --silent
yarn build:native --CDCMAKE_PREFIX_PATH="$PREFIX"
bash scripts/ci/check-binary.sh build/alembic-js.node "$TARGET"
