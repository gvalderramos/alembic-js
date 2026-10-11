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

Object `type` is one of `xform`, `mesh`, `subd`, `camera`, `points`, `curves`, `nupatch`, `light`, `faceset` or `unknown`.

Mesh notes:
- Polygons are fan-triangulated, and Alembic's clockwise winding becomes counter-clockwise (three.js/WebGL).
- When normals or UVs are face-varying, vertices are split per face corner. Otherwise the original points are shared.
- Data is copied into JS-owned typed arrays, so no native memory is exposed.

---

## 🛠️ Build Requirements

- Node.js ≥ 18 (the sandbox needs ≥ 22.18 because it runs `.ts` files directly)
- Yarn 1.22
- CMake ≥ 3.22 and a C++17 compiler
- Alembic SDK (and Imath) discoverable by `find_package(Alembic)`

> **Windows note:** if the installed Alembic SDK only provides a Debug build, CMake builds the addon against the debug CRT so it links. Such a binary needs the Visual Studio debug runtime, so it only runs on developer machines. Install a Release build of Alembic before you ship binaries.

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
- [ ] Points and curves geometry
- [ ] Face sets / materials
- [ ] Velocity-based motion and animation helpers
- [ ] Prebuilt binaries and CI matrix

---

## 🧑‍💻 Author

Gabriel Valderramos  
[LinkedIn](https://www.linkedin.com/in/gabrielvalderramos) • [GitHub](https://github.com/gvalderramos)

---

## 📄 License

MIT
