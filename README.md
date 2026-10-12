# Alembic-JS

**Alembic-JS** is a native Node.js module that reads Alembic (`.abc`) files from JavaScript/TypeScript. It gives you the metadata, hierarchy, transforms, cameras and triangulated mesh data, and includes an optional bridge to [three.js](https://threejs.org/).

> Powered by the [Alembic C++ SDK](https://github.com/alembic/alembic) and [Node-API (N-API)](https://nodejs.org/api/n-api.html)

---

## 📦 Installation

```bash
git clone https://github.com/gvalderramos/alembic-js.git
cd alembic-js
yarn install
yarn build      # native addon (cmake-js) + TypeScript (tsc)
yarn test       # unit + three.js integration tests
```

`yarn build` compiles the addon to `build/alembic-js.node` and copies its runtime DLLs (for example Imath on Windows) next to it.

---

## 🧠 Usage

```ts
import { AbcFile, AlembicError } from 'alembic-js';

const file = AbcFile.open('resource/Ancient_Kettle.abc'); // or: await AbcFile.openAsync(path)

console.log(file.getInfo());            // appName, libraryVersion, objectCount, hasAnimation, ...
file.traverse((obj, depth) => console.log('  '.repeat(depth) + obj.name, obj.type));

const mesh = file.getMesh('/Kettle/Circle', { time: 0 });
mesh.positions;  // Float32Array (xyz)
mesh.normals;    // Float32Array | undefined
mesh.uvs;        // Float32Array | undefined
mesh.indices;    // Uint32Array, counter-clockwise triangles
mesh.transform;  // world matrix, column-major (THREE.Matrix4.fromArray)

file.close();    // releases the native archive
```

### three.js

`three` is not a dependency. Pass your own module in:

```ts
import * as THREE from 'three';
import { AbcFile, buildThreeScene, toBufferGeometry } from 'alembic-js';

const file = AbcFile.open('scene.abc');
scene.add(buildThreeScene(file, THREE, { time: 0 }));   // Groups, Meshes and PerspectiveCameras
const geometry = toBufferGeometry(file.getMesh('/geo/shape'), THREE);
```

A runnable example lives in [`sandbox/`](sandbox/README.md). It includes a CLI inspector, a GLB exporter and a browser viewer.

alembic-js is a native addon, so it runs in Node, Electron, or another process with Node integration, but not in a plain browser page. To show Alembic data in a browser, read it in Node and send it to the page. The sandbox converts the scene to GLB for this; [its README](sandbox/README.md#why-the-viewer-uses-glb) explains why and lists the alternatives.

### Errors

Every failure throws an `AlembicError` with a `code` (plus `file`/`objectPath` when known):

| Code | When |
|------|------|
| `ERR_ABC_INVALID_ARGUMENT` | bad path/time argument, path is a directory |
| `ERR_ABC_FILE_NOT_FOUND` | the file does not exist |
| `ERR_ABC_INVALID_ARCHIVE` | the file is not a readable Alembic archive |
| `ERR_ABC_NOT_LOADED` | reading before `load()` or after `close()` |
| `ERR_ABC_OBJECT_NOT_FOUND` | unknown object path |
| `ERR_ABC_UNSUPPORTED_TYPE` | e.g. `getMesh()` on points/curves/cameras |
| `ERR_ABC_MALFORMED_DATA` | out-of-range indices, inconsistent face counts |
| `ERR_ABC_PROPERTY_NOT_FOUND` | unknown property path in `getProperty()` / `getProperties()` |
| `ERR_ABC_READ_FAILED` | other errors raised by the Alembic SDK |
| `ERR_ABC_NATIVE_MODULE` | the addon is not built or failed to load |

---

## 🧱 API

| `AbcFile` | |
|---|---|
| `new AbcFile(path)` / `AbcFile.open(path)` / `AbcFile.openAsync(path)` | create (and load) an archive |
| `load()` / `loadAsync()` / `close()` / `isLoaded` | lifecycle |
| `getInfo()` | `AbcFileInfo`: path, coreType, appName, library/archive version, whenWritten, userDescription, objectCount, hasAnimation, startTime, endTime |
| `getObjects()` / `getChildren(path?)` / `getObject(path)` / `traverse(fn)` | hierarchy (`AbcObject`: name, path, parent, children, type, schema, numSamples, animated) |
| `getMesh(path, {time})` / `getMeshes({time})` | `AbcMesh` for `mesh` and `subd` objects |
| `getTransform(path, {time})` | local and world matrices, `inheritsTransform` |
| `getCamera(path, {time})` | focal length, apertures, near/far, vertical fov, aspect, world matrix |
| `getPoints(path, {time})` / `getAllPoints()` | `AbcPoints`: positions, ids (`BigUint64Array`), velocities, widths |
| `getCurves(path, {time})` / `getAllCurves()` | `AbcCurves`: control vertices, vertex counts, type, basis, periodic, orders/knots/weights, widths (with scope), UVs, normals |
| `getProperties(path, {root, recursive, time})` | property tree (name, kind, type, interpretation, scope, sample count, element count), without reading values |
| `getAttributes(path)` | the object's geometry attributes (`.arbGeomParams`) |
| `getProperty(path, propertyPath, {time, expand})` | one property as typed data, e.g. `getProperty('/geo/shape', '.arbGeomParams/Cd')` |
| `getUserProperties(path, {time})` | user properties as a plain object (single-value arrays unwrapped) |

`getMesh()` on a `points` or `curves` object throws `ERR_ABC_UNSUPPORTED_TYPE` and names the right method.

Object `type` is one of `xform`, `mesh`, `subd`, `camera`, `points`, `curves`, `nupatch`, `light`, `faceset` or `unknown`.

Mesh notes:
- Polygons are fan-triangulated, and Alembic's clockwise winding becomes counter-clockwise (three.js/WebGL).
- When normals or UVs are face-varying, vertices are split per face corner. Otherwise the original points are shared.
- Data is copied into JS-owned typed arrays, so no native memory is exposed.
- `getMesh(path, { attributes: ['Cd', 'uv2'] })` (or `'*'`) adds geometry attributes laid out like `positions`. Attributes stored per face corner or per face switch the mesh to one vertex per corner; `mesh.layout` tells you which (`'points'` or `'corners'`). Nothing is added unless you ask.

### Points and curves
- `tessellateCurves(curves, { segmentsPerSpan })` evaluates curves into polylines without three.js: linear, cubic Bezier, B-spline and Catmull-Rom, and NURBS (`variableOrder`, de Boor with rational weights). Hermite and power bases fall back to the control polygon.
- `widthsPerVertex(curves)` expands widths to one per control vertex, whatever their scope. Exporters don't always label widths correctly (Blender writes per-vertex widths as `constant`), so `widthScope` is inferred from the count when the label doesn't match.
- three.js: `toPoints()` creates a `THREE.Points` whose point sizes come from the widths, and `toLineSegments()` creates a `THREE.LineSegments`. `buildThreeScene()` uses both.

### Attributes in three.js
`buildThreeScene()` reads vertex colors by default (`Cd`, `Col`, `color`, `displayColor`) and enables `vertexColors` on its default materials. Pass `attributes: '*'` for everything, or `[]` for none. Names are mapped to three.js attributes as follows (override with `attributeNames`):

| Alembic | three.js |
|---|---|
| `Cd`, `Col`, `color`, `displayColor`, or `rgb`/`rgba` interpretation | `color` |
| second UV set (`uv1`, `uv2`, `st1`, `UVMap_001`, …) | `uv1` |
| `Pref`, `rest` | `restPosition` |
| anything else | same name |

Colors are assumed to be linear; pass `colorSpace: 'srgb'` to convert.

---

## 💻 Supported platforms

`npm install alembic-js` ships prebuilt binaries, so no compiler is needed on:

| Platform | Prebuild | Notes |
|---|---|---|
| Linux x64 / arm64 (glibc) | `linux-x64`, `linux-arm64` | glibc 2.28 or newer (RHEL/Rocky 8, Debian 10, Ubuntu 18.10 and later) |
| Linux x64 / arm64 (musl) | `linux-x64-musl`, `linux-arm64-musl` | Alpine |
| macOS Apple Silicon / Intel | `darwin-arm64`, `darwin-x64` | macOS 11 or newer |
| Windows x64 / ARM64 | `win32-x64`, `win32-arm64` | static C runtime, no redistributable needed |

Node.js 22 or newer, and Electron (any version with Node-API 8).

### Build from source
On other platforms, reinstall with `ALEMBIC_JS_BUILD_FROM_SOURCE=1` (or `npm install --build-from-source`). That runs `cmake-js` at install time and needs CMake ≥ 3.22, a C++17 compiler, and the Alembic SDK; set `ALEMBIC_SDK` (or `CMAKE_PREFIX_PATH`) to its install prefix. [`scripts/ci/build-alembic.sh`](scripts/ci/build-alembic.sh) builds a static SDK: `bash scripts/ci/build-alembic.sh <prefix> 3.2.3 1.8.12`.

---

## 🛠️ Build Requirements

- Node.js ≥ 22 (the sandbox needs ≥ 22.18 because it runs `.ts` files directly)
- Yarn 1.22
- CMake ≥ 3.22 and a C++17 compiler
- Alembic SDK (and Imath) discoverable by `find_package(Alembic)`

> **Windows note:** if the installed Alembic SDK only provides a Debug build, CMake builds the addon against the debug CRT so it links. Such a binary needs the Visual Studio debug runtime, so it only runs on developer machines. To build like CI does, run `yarn build:sdk` once (static Release SDK in `.deps/alembic-sdk`) and then `yarn build:native:release`.

### Code style

```bash
yarn lint       # ESLint + Prettier check (TypeScript, scripts, sandbox)
yarn lint:cpp   # clang-format check of addons/ and tools/ (pip install clang-format==22.1.8)
yarn format     # fix both
```

### CI and releases

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs on every push and pull request:

- **Code style:** `yarn lint`, a TypeScript type check, and `yarn lint:cpp`.
- **Tests:** builds the addon and runs `yarn test` on Linux (Node 22, 24, 26), Windows and macOS (Node 22, 26). The Linux Node 22 job also runs the sandbox.
- **Build:** one prebuilt addon per platform in the table above. Linux builds run in `manylinux_2_28` (glibc) and Alpine (musl) containers; the Intel Mac build is cross-compiled on Apple Silicon. Alembic and Imath are built from source as static Release libraries and cached. [`scripts/ci/check-binary.sh`](scripts/ci/check-binary.sh) fails the build if a binary needs anything but system libraries, or a glibc symbol newer than 2.28.
- **Package and verify:** the npm tarball is packed once with all eight binaries, then installed and smoke-tested on every platform without a compiler (Rocky Linux 8 for the glibc baseline, Alpine, macOS on Apple Silicon and under Rosetta, Windows x64 and ARM64), and in Electron.
- **Release:** every push to `main` that passes the jobs above runs [semantic-release](https://semantic-release.gitbook.io/). It works out the next version from [Conventional Commits](https://www.conventionalcommits.org/) (`feat:` is a minor bump, `fix:`/`chore:`/`docs:`/… is a patch, `BREAKING CHANGE` is a major) and stops before tagging if that version is already on npm. It then writes the version into **the tarball that was verified**, publishes it to [npm](https://www.npmjs.com/package/alembic-js) with provenance, and creates a GitHub release with the tarball and `SHA256SUMS`. If publishing fails, the tag is removed again.
- **PR titles** must follow Conventional Commits ([`pr-title.yml`](.github/workflows/pr-title.yml)), because the squash-merge commit uses the title. [Dependabot](.github/dependabot.yml) updates actions and npm dependencies weekly.

Repository settings that can't live in files:
- **npm publishing:** configure npm trusted publishing for this repository and `ci.yml` (package settings on npmjs.com), then delete the `NPM_TOKEN` secret. Until then, an `NPM_TOKEN` granular token with *Bypass 2FA* also works.
- **Branch protection on `main`:** require the `Code style`, `Test …`, `Verify …` and `Conventional Commits title` checks, require squash merges, and block direct pushes.

Install a release with:

```bash
npm install alembic-js
```

### Test fixtures

`test/fixtures/*.abc` are written by [`tools/generate_fixtures.cpp`](tools/generate_fixtures.cpp). Regenerate them with:

```bash
yarn fixtures
```

---

## 📌 Roadmap

- [x] Archive metadata and hierarchy
- [x] Mesh / SubD geometry, transforms and cameras
- [x] Sampling at a given time
- [x] three.js bridge
- [x] Points and curves geometry ([spec](specs/0002-points-and-curves.md))
- [ ] Face sets / materials ([spec](specs/0003-face-sets-and-materials.md))
- [ ] Velocity-based motion and animation helpers ([spec](specs/0004-animation-and-velocity.md))
- [x] Prebuilt binaries and CI matrix ([spec](specs/0005-prebuilt-binaries-and-ci.md))
- [x] Attributes and properties: vertex colors, custom attributes, user properties ([spec](specs/0006-attributes-and-properties.md))
- [ ] Test assets: real-world files for every feature ([spec](specs/0007-test-assets.md), [catalog](resource/README.md))
- [ ] Alembic instancing (found while building the test assets; see spec 0007)

---

## 🧑‍💻 Author

Gabriel Valderramos  
[LinkedIn](https://www.linkedin.com/in/gabrielvalderramos) • [GitHub](https://github.com/gvalderramos)

---

## 📄 License

MIT
