#!/usr/bin/env bash
# Builds static Release Imath + Alembic into <prefix>, so the addon links without
# runtime DLL/.so dependencies. Used by .github/actions/setup-alembic.
#   scripts/ci/build-alembic.sh <prefix> <imath-version> <alembic-version>
set -euo pipefail

# cmake on Windows needs native paths, not MSYS ones.
native() { if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else echo "$1"; fi; }

PREFIX="$(native "$1")"
IMATH_VERSION="$2"
ALEMBIC_VERSION="$3"
WORK="$(native "$(mktemp -d)")"
JOBS="${JOBS:-4}"

COMMON=(
    -DCMAKE_BUILD_TYPE=Release
    -DCMAKE_INSTALL_PREFIX="$PREFIX"
    -DCMAKE_PREFIX_PATH="$PREFIX"
    -DCMAKE_POSITION_INDEPENDENT_CODE=ON
    -DBUILD_SHARED_LIBS=OFF
    # cmake-js links Windows addons against the static CRT (/MT); the SDK must match.
    -DCMAKE_POLICY_DEFAULT_CMP0091=NEW
    -DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded
)
# macOS: cross-compile (OSX_ARCHITECTURES=x86_64 on Apple Silicon) and target older macOS versions.
if [ -n "${OSX_ARCHITECTURES:-}" ]; then COMMON+=(-DCMAKE_OSX_ARCHITECTURES="$OSX_ARCHITECTURES"); fi
if [ -n "${MACOSX_DEPLOYMENT_TARGET:-}" ]; then COMMON+=(-DCMAKE_OSX_DEPLOYMENT_TARGET="$MACOSX_DEPLOYMENT_TARGET"); fi

git clone --quiet --depth 1 --branch "v$IMATH_VERSION" https://github.com/AcademySoftwareFoundation/Imath.git "$WORK/imath"
cmake -S "$WORK/imath" -B "$WORK/imath-build" "${COMMON[@]}" -DBUILD_TESTING=OFF -DIMATH_INSTALL_PKG_CONFIG=OFF
cmake --build "$WORK/imath-build" --config Release --target install --parallel "$JOBS"

git clone --quiet --depth 1 --branch "$ALEMBIC_VERSION" https://github.com/alembic/alembic.git "$WORK/alembic"
cmake -S "$WORK/alembic" -B "$WORK/alembic-build" "${COMMON[@]}" \
    -DALEMBIC_SHARED_LIBS=OFF -DUSE_HDF5=OFF -DUSE_TESTS=OFF -DUSE_BINARIES=OFF \
    -DUSE_PYALEMBIC=OFF -DUSE_ARNOLD=OFF -DUSE_PRMAN=OFF -DUSE_MAYA=OFF
cmake --build "$WORK/alembic-build" --config Release --target install --parallel "$JOBS"

rm -rf "$WORK"
echo "Alembic $ALEMBIC_VERSION and Imath $IMATH_VERSION installed to $PREFIX"
