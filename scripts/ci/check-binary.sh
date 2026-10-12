#!/usr/bin/env bash
# Checks that a prebuilt addon only depends on system libraries (spec 0005).
#   scripts/ci/check-binary.sh <file.node> <target>
set -euo pipefail
FILE="$1"
TARGET="$2"
fail() { echo "check-binary: $*" >&2; exit 1; }

case "$TARGET" in
linux-*-musl)
    deps="$(readelf -d "$FILE" | sed -n 's/.*Shared library: \[\(.*\)\]/\1/p')"
    echo "$TARGET needs: $deps"
    for dep in $deps; do
        case "$dep" in libc.musl-*|ld-musl-*|libc.so) ;; *) fail "unexpected dependency $dep" ;; esac
    done
    ;;
linux-*)
    deps="$(readelf -d "$FILE" | sed -n 's/.*Shared library: \[\(.*\)\]/\1/p')"
    echo "$TARGET needs: $deps"
    for dep in $deps; do
        case "$dep" in libc.so.*|libm.so.*|libpthread.so.*|libdl.so.*|ld-linux*|librt.so.*) ;;
        *) fail "unexpected dependency $dep (libstdc++/libgcc should be linked statically)" ;; esac
    done
    newest="$(objdump -T "$FILE" | grep -oE 'GLIBC_[0-9]+\.[0-9]+' | sort -t. -k2 -n | tail -n 1)"
    echo "$TARGET newest glibc symbol: ${newest:-none}"
    minor="${newest#GLIBC_2.}"
    if [ -n "$newest" ] && [ "$minor" -gt 28 ]; then fail "needs $newest; the baseline is GLIBC_2.28"; fi
    ;;
darwin-*)
    otool -L "$FILE"
    otool -L "$FILE" | tail -n +2 | awk '{print $1}' | while read -r dep; do
        case "$dep" in /usr/lib/libc++*|/usr/lib/libSystem*) ;; *) fail "unexpected dependency $dep" ;; esac
    done
    lipo -info "$FILE"
    ;;
win32-*)
    vswhere="/c/Program Files (x86)/Microsoft Visual Studio/Installer/vswhere.exe"
    dumpbin="$("$vswhere" -latest -products '*' -find 'VC/Tools/MSVC/**/bin/Hostx64/x64/dumpbin.exe' | head -n 1 | tr -d '\r')"
    deps="$("$dumpbin" //dependents "$FILE" | grep -iE '^\s+\S+\.dll' | tr -d ' \r')"
    echo "$TARGET needs: $deps"
    for dep in $deps; do
        case "${dep^^}" in KERNEL32.DLL) ;; *) fail "unexpected dependency $dep" ;; esac
    done
    ;;
*)
    fail "unknown target $TARGET"
    ;;
esac
echo "check-binary: $TARGET ok"
