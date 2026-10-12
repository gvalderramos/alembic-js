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
| `ERR_ABC_TOPOLOGY_CHANGED` | `getMeshFrame()` at a time whose topology differs from the last `getMesh()` |
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
| `getFaceSets(path, {time})` | face sets of a mesh/subd: faces, exclusivity, resolved material path |
| `getMaterialAssignment(path)` | AbcMaterial assignment, inherited from ancestors (`null` if none) |
| `getMaterial(path)` / `getMaterials()` | AbcMaterial: targets, shaders, parameters (flattened with parent materials), network nodes |
| `getProperties(path, {root, recursive, time})` | property tree (name, kind, type, interpretation, scope, sample count, element count), without reading values |
| `getAttributes(path)` | the object's geometry attributes (`.arbGeomParams`) |
| `getProperty(path, propertyPath, {time, expand})` | one property as typed data, e.g. `getProperty('/geo/shape', '.arbGeomParams/Cd')` |
| `getUserProperties(path, {time})` | user properties as a plain object (single-value arrays unwrapped) |

`getMesh()` on a `points` or `curves` object throws `ERR_ABC_UNSUPPORTED_TYPE` and names the right method.

Object `type` is one of `xform`, `mesh`, `subd`, `camera`, `points`, `curves`, `nupatch`, `light`, `faceset`, `material` or `unknown`.

Mesh notes:
- Polygons are fan-triangulated, and Alembic's clockwise winding becomes counter-clockwise (three.js/WebGL).
- When normals or UVs are face-varying, vertices are split per face corner. Otherwise the original points are shared.
- Data is copied into JS-owned typed arrays, so no native memory is exposed.
- `getMesh(path, { attributes: ['Cd', 'uv2'] })` (or `'*'`) adds geometry attributes laid out like `positions`. Attributes stored per face corner or per face switch the mesh to one vertex per corner; `mesh.layout` tells you which (`'points'` or `'corners'`). Nothing is added unless you ask.

### Animation
Every reader takes sample options:

```ts
file.getMesh(path, { time: 0.5 });                    // seconds, closest sample ('near', the default)
file.getMesh(path, { frame: 12 });                    // frames, using info.fps
file.getMesh(path, { time: 0.51, mode: 'interpolate' }); // blend the samples around the time
file.getPoints(path, { time: 0.51, mode: 'floor', useVelocities: true }); // move points with velocities
```

- `getInfo()` reports `fps` (most common rate among animated objects), `frameRange`, and a `startTime`/`endTime` computed from the objects' own samples. Each `AbcObject` has `timeSampling` (kind, fps, sample times) and `topology` (`constant`, `homogeneous` or `heterogeneous`).
- `'interpolate'` decomposes transforms and slerps their rotations; positions and normals are blended when the topology matches (points are matched by id); otherwise the floor sample is used, and `useVelocities` moves positions by `velocity × (time − sampleTime) × velocityScale`. Alembic velocities are units per second.
- `getMeshFrame(path, options)` returns positions (and normals and requested attributes) in the layout of the last `getMesh()` with the same options, without re-triangulating. It throws `ERR_ABC_TOPOLOGY_CHANGED` when the topology differs.
- `getMeshAsync()` / `getMeshFrameAsync()` read on a worker thread; `close()` while they run is safe.
- three.js: `new AbcPlayer(file, root, THREE, { mode: 'interpolate' })` plays a scene built by `buildThreeScene()` (call `player.update(delta)` each frame, or `setTime(seconds)`). It updates geometry in place and rebuilds it only when the topology changes. `createTransformClip(file, root, THREE)` bakes animated transforms into a regular `AnimationClip` for `AnimationMixer`.

### Face sets and materials
- `getMesh()` returns `groups` (triangle ranges) and `materialSlots` when a mesh's face sets are contiguous runs of faces. With `groupByFaceSet: true` the triangles are reordered so every face set is one range, which is what Blender's per-material face sets need. Faces in no set form a final `default` slot. Overlapping (non-exclusive) sets are flagged with `faceSetsOverlap`, and each face goes to the first set listing it. `triangleToFace: true` adds the source polygon of every triangle.
- `buildThreeScene()` creates one material per slot (three.js geometry groups). Pass `createMaterial({ name, faceSet, material })` to build them from the assigned AbcMaterial (`material.parameters['*.surface'].base_color`, …); Blender doesn't write AbcMaterial, but its face sets are named after the materials.
- `onError(error, object)` lets `buildThreeScene()` skip objects it can't read instead of throwing.

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

## 🛠️ Build Requirements

- Node.js ≥ 18 (the sandbox needs ≥ 22.18 because it runs `.ts` files directly)
- Yarn 1.22
- CMake ≥ 3.22 and a C++17 compiler
- Alembic SDK (and Imath) discoverable by `find_package(Alembic)`

> **Windows note:** if the installed Alembic SDK only provides a Debug build, CMake builds the addon against the debug CRT so it links. Such a binary needs the Visual Studio debug runtime, so it only runs on developer machines. Install a Release build of Alembic before you ship binaries.

### Code style

```bash
yarn lint       # ESLint + Prettier check (TypeScript, scripts, sandbox)
yarn lint:cpp   # clang-format check of addons/ and tools/ (pip install clang-format==22.1.8)
yarn format     # fix both
```

### CI and releases

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs on every push and pull request:

- **Code style:** `yarn lint`, a TypeScript type check, and `yarn lint:cpp`.
- **Tests:** builds the addon and runs `yarn test` on Linux (Node 20, 22, 24), Windows and macOS. The Linux Node 22 job also runs the sandbox. CI builds Alembic and Imath from source as static Release libraries (see [`scripts/ci/build-alembic.sh`](scripts/ci/build-alembic.sh)) and caches them, so the addon has no runtime library dependencies.
- **Release:** every push to `main` that passes the jobs above runs [semantic-release](https://semantic-release.gitbook.io/). It works out the next version from [Conventional Commits](https://www.conventionalcommits.org/) (`feat:` is a minor bump, `fix:`/`chore:`/`docs:`/… is a patch, `BREAKING CHANGE` is a major). It then tags `vX.Y.Z`, publishes the package to [npm](https://www.npmjs.com/package/alembic-js) with provenance, and creates a GitHub release with the same package attached. The package includes prebuilt addons for `linux-x64`, `win32-x64` and `darwin-arm64`. Publishing needs an `NPM_TOKEN` repository secret (an npm granular access token with read and write access). Commit messages that don't follow the convention, such as a default merge commit, don't trigger a release, so squash-merge PRs with a conventional title.

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
- [x] Sampling at a given time, interpolation and velocities
- [x] three.js bridge
- [x] Points and curves geometry ([spec](specs/0002-points-and-curves.md))
- [x] Face sets / materials ([spec](specs/0003-face-sets-and-materials.md))
- [x] Velocity-based motion and animation helpers ([spec](specs/0004-animation-and-velocity.md))
- [ ] Prebuilt binaries and CI matrix ([spec](specs/0005-prebuilt-binaries-and-ci.md))
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
