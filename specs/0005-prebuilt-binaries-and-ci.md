# 0005 - Prebuilt Binaries and CI Matrix

## Overview
Alembic-JS ships a native addon, so its usability depends on users never having to compile Alembic themselves. The first version of CI/CD exists (PR #1/#2): lint, tests on Linux/Windows/macOS, static Release Alembic/Imath builds, and semantic-release publishing to npm with three prebuilt binaries. This spec covers what's left to make the prebuilt story complete and the pipeline robust: more platforms, glibc and musl coverage, a fallback when no prebuild matches, verifying the published package, and hardening the release process.

## Problem Statement
Today the npm package contains prebuilds for `linux-x64`, `win32-x64` and `darwin-arm64` only:
- Intel Macs, ARM Linux (Raspberry Pi, Graviton, Docker on Apple Silicon), Windows on ARM and Alpine (musl) get `ERR_ABC_NATIVE_MODULE` with no way forward.
- The Linux binary is built on Ubuntu 22.04, so it needs glibc ≥ 2.35. Older distros (Debian 11, RHEL/Rocky 8, Amazon Linux 2) can't load it.
- Nothing checks that the *published* tarball works on a clean machine without a compiler.
- The first releases showed process gaps: failed publishes leave orphaned tags (`v1.0.0`, `v1.0.1` with nothing on npm), PR titles aren't checked against Conventional Commits, and publishing depends on a long-lived `NPM_TOKEN`.

## Goals
- Prebuilds for: `linux-x64`, `linux-arm64`, `linux-x64-musl`, `linux-arm64-musl`, `darwin-x64`, `darwin-arm64`, `win32-x64`, `win32-arm64`.
- A glibc baseline of 2.28 (manylinux_2_28 / RHEL 8 era) for the glibc builds.
- The loader selects the right binary, including libc detection, and gives an actionable error when none matches.
- An optional build-from-source fallback for unsupported platforms.
- A verify stage: install the packed tarball on each target, without a toolchain, before publishing.
- Release hardening: trusted publishing (OIDC), PR-title linting, publishing only after every check passes, recovery for failed releases, Dependabot for actions.
- Test matrix: all supported Node versions (22, 24, plus current) on every OS, and Electron. Node 20 reached end of life in April 2026; drop it from the matrix and `engines`.

## Non-Goals
- 32-bit platforms (ia32, armv7).
- FreeBSD and other OSes without GitHub-hosted runners.
- Bundling HDF5 support (Ogawa only, as today).

## Current State
- `.github/workflows/ci.yml`:
  - `lint` job.
  - `test` matrix: ubuntu-22.04 with Node 20/22/24, windows-2022 with Node 22, macos-14 with Node 22.
  - `release` job on `main` that collects `prebuild-*` artifacts into `prebuilds/<platform>-<arch>/` and runs `npx semantic-release@24`.
- `.github/actions/setup-alembic` + `scripts/ci/build-alembic.sh`: static Release Imath 3.2.3 + Alembic 1.8.12, `/MT` on Windows, cached by key.
- `src/native.ts`: tries `build/alembic-js.node`, then `prebuilds/${platform}-${arch}/alembic-js.node`.
- `package.json`: `publishConfig: { access: public, provenance: true }`, Node-API 8, `engines.node >= 20`.

## Design

### Platform matrix
| Prebuild | Runner / environment | Notes |
|---|---|---|
| linux-x64 | `ubuntu-latest` + `quay.io/pypa/manylinux_2_28_x86_64` container | glibc 2.28 baseline; install Node in the container |
| linux-arm64 | `ubuntu-24.04-arm` + `manylinux_2_28_aarch64` container | native ARM runner, no QEMU |
| linux-x64-musl | `ubuntu-latest` + `node:22-alpine` container | `apk add build-base cmake git` |
| linux-arm64-musl | `ubuntu-24.04-arm` + `node:22-alpine` container | |
| darwin-arm64 | `macos-14` (or newer) | `MACOSX_DEPLOYMENT_TARGET=11.0` |
| darwin-x64 | `macos-14` cross-compile with `CMAKE_OSX_ARCHITECTURES=x86_64` | tests run under Rosetta (`arch -x86_64 node`), or on an Intel runner while one is available |
| win32-x64 | `windows-2022` | `/MT` static CRT (current) |
| win32-arm64 | `windows-11-arm` | Node ARM64 build, `/MT` |

- Set `MACOSX_DEPLOYMENT_TARGET` explicitly in both `build-alembic.sh` and the addon build, so the binaries load on older macOS versions.
- Strip symbols on Linux/macOS (`-s` / `strip -x`) to shrink the binaries. The Linux one is 2.0 MB today.
- The SDK cache key must include platform, libc and deployment target.

### Binary layout and loading
- Keep `prebuilds/<platform>-<arch>[-musl]/alembic-js.node`.
- Detect musl in `src/native.ts` with `process.report.getReport().header.glibcVersionRuntime === undefined` on Linux, or reading `/usr/bin/ldd`, as `detect-libc` does. Prefer the `-musl` directory there.
- Improve the error message when nothing matches: list the platforms that are available, link to the build-from-source docs, and include `process.versions.napi`.
- Optional: adopt the `node-gyp-build` layout and naming (`prebuilds/linux-x64/node.napi.glibc.node`) to align with the ecosystem. Decide before adding musl, to avoid two migrations.

### Build-from-source fallback
- Add `"install": "node scripts/install.js"`. If no prebuild matches and `ALEMBIC_JS_BUILD_FROM_SOURCE=1` (or `npm install --build-from-source`) is set, it runs `cmake-js compile`. This needs `cmake-js` and `node-addon-api` in `dependencies` (today they're devDependencies) and an Alembic SDK on `CMAKE_PREFIX_PATH`.
- Without the flag, the install script does nothing, so installs never fail because of a missing toolchain. The runtime error explains how to opt in.
- Document the source build, including `scripts/ci/build-alembic.sh` for building the SDK.

### Verification stage
A new `verify` job matrix runs after the builds and before `release`:
1. Pack the tarball once (`npm pack`) with all prebuilds.
2. On each OS/arch/libc (using the same containers for Linux, without a compiler installed): `npm install ./alembic-js-*.tgz` into an empty project, then run a smoke script that opens `test/fixtures/simple_mesh.abc` and the kettle, and checks the counts.
3. Also run the smoke test under Electron (`electron --no-sandbox` with `ELECTRON_RUN_AS_NODE=1`, using the latest Electron) on linux-x64.

`release` depends on `verify` and publishes **that exact tarball** (semantic-release `@semantic-release/npm` with `pkgRoot`, or publish the tgz with `npm publish <tgz>`), so what's tested is what's shipped.

### Test matrix
- Node 22, 24 and the current Node release on Linux x64, Windows x64 and macOS arm64.
- One Node version (22) on the other targets, in the verify stage.
- Keep `fail-fast: false`.
- Cache the SDK per target; the first cold build per target is about 5–15 minutes.

### Release hardening
1. **Trusted publishing:**
   - Configure npm trusted publishing for `gvalderramos/alembic-js` / `ci.yml`.
   - Remove `NPM_TOKEN` from the workflow and from repository secrets.
   - Keep `id-token: write` and `provenance: true`.
   - Use a semantic-release version whose npm plugin supports OIDC, or publish with `npm publish` (npm ≥ 11.5) in an `@semantic-release/exec` step.
2. **No orphaned tags:**
   - Run semantic-release with `--dry-run` in PR CI, to catch config and auth problems early.
   - Before publishing on `main`, check that the npm version doesn't exist yet.
   - On failure, a recovery job (or a documented manual step) deletes the tag created by the failed run.
3. **PR title lint:** `amannn/action-semantic-pull-request` on `pull_request`, so squash merges always produce releasable Conventional Commit messages. Require squash merges in the branch protection settings.
4. **Branch protection on `main`:** required checks (`Code style`, all `Test` jobs, `verify`), and no direct pushes.
5. **Dependabot:** weekly updates for `github-actions` and `npm` (root and `sandbox/`).
6. **SBOM / checksums:** attach `SHA256SUMS` for each `.node` to the GitHub release.

### Local developer experience
- Document that a local `yarn build` against a Debug-only SDK (Windows) is for development only.
- Add `yarn build:sdk` (a wrapper around `scripts/ci/build-alembic.sh`) to build the static Release SDK locally into `.deps/`, plus `yarn build:native:release` using it, so contributors can reproduce CI binaries.

## Work Items
1. `src/native.ts`: libc detection, better error, unit tests for path selection (mock `process.platform`/`arch`/report).
2. `build-alembic.sh`: deployment target, strip, `CMAKE_OSX_ARCHITECTURES` passthrough, Alpine compatibility (no `cygpath`, busybox `mktemp`).
3. `ci.yml`:
   - Split into a `build` matrix (per prebuild target, including containers), a `test` matrix (Node versions), `verify`, and `release`.
   - Move the release logic into a reusable workflow if it grows.
4. `.github/workflows/pr-title.yml` (semantic PR title).
5. `.github/dependabot.yml`.
6. `scripts/install.js` + `dependencies` changes for the source build (behind the flag).
7. Trusted publishing migration + removing `NPM_TOKEN`.
8. Orphaned-tag protection (dry run in PRs, a version-exists check).
9. README: supported platforms table, build-from-source section, release process; tick the roadmap checkbox.

## Testing
- Unit tests for the loader's path selection across platform/arch/libc combinations, including the "no match" message.
- The `verify` matrix is the integration test for every published binary.
- `ldd` / `otool -L` / `dumpbin /dependents` checks in CI that each binary only links system libraries:
  - Linux: libc, libm, libstdc++, libgcc_s. Consider `-static-libstdc++ -static-libgcc` for musl and older glibc.
  - macOS: libc++, libSystem.
  - Windows: KERNEL32 only.
- `objdump -T | grep GLIBC_` to assert that the maximum required glibc symbol version is at most 2.28.

## Milestones
1. Release hardening: PR title lint, semantic-release dry run on PRs, trusted publishing, Dependabot.
2. Verify stage with the existing three targets, publishing the verified tarball.
3. manylinux_2_28 for linux-x64 + glibc check.
4. linux-arm64, darwin-x64, win32-arm64.
5. musl targets + libc-aware loader.
6. Build-from-source fallback + docs.

## Acceptance Criteria
- `npm install alembic-js` followed by opening a file works without a compiler on every target in the platform table, as proven by the verify matrix.
- The Linux glibc binaries load on glibc 2.28 (Rocky/RHEL 8 container smoke test).
- A failed release leaves no tag behind; a PR with a non-conventional title can't be merged.
- No long-lived npm token is stored in GitHub.

## Risks and Considerations
- **Runner availability:** ARM Linux, Windows ARM and macOS runners have queue times and may change labels. Keep runner names in one `env` block.
- **Cold SDK builds** in containers are slow; mitigate with caches per target and possibly a shared prebuilt-SDK artifact.
- **Package size** grows with eight binaries (about 1–2 MB each). If that becomes an issue, consider per-platform optional-dependency packages (`@alembic-js/linux-x64`, …), like esbuild and swc.
- **Rosetta testing** for darwin-x64 depends on Rosetta being installed on the runner. Fall back to build-only checks plus `lipo -info` if not.

## Open Questions
- Single package with all prebuilds (current) or per-platform optional dependencies?
- Node 20 is already past its end of life (April 2026). Drop it now (`engines.node >= 22`), or keep testing it for one more release cycle?
