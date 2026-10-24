# 0008 - Streaming Frames to the Browser

## Overview
alembic-js runs in Node, but three.js usually renders in a browser. The sandbox already bridges the two: it sends the first frame as GLB and serves later frames from `/frame?time=` as base64 JSON. This spec turns that pattern into a supported API: a compact binary frame format, a Node encoder, and a browser-safe decoder that applies frames to a scene loaded from the GLB.

## Problem Statement
Every app that shows Alembic in a browser has to reinvent the sandbox's bridge. The sandbox version also sends base64 (a third larger than the data), re-sends meshes that only move, and fetches one frame per request, which is too slow for scrubbing real caches. Nitpick's review viewer is the first consumer.

## Goals
- A documented binary format for one or more frames, with only the data that changed per object.
- `encodeFrames()` in Node, built on `AbcPlayer`, `getMeshFrame()` and transforms.
- A browser entry point (`alembic-js/stream`) with no native code: `decodeFrames()` and `applyFrame()`.
- GLB export that keeps what the decoder needs to find objects: the Alembic path in `userData.alembic` and, optionally, `triangleToFace` per mesh.

## Non-Goals
- An HTTP or WebSocket server. Apps choose their own transport; the sandbox shows one.
- Compression beyond what HTTP already offers (gzip/brotli on the response).

## Proposed API

### Node
```ts
interface EncodeOptions {
  /** Objects to include. Default: player.animatedPaths. */
  paths?: string[]
  normals?: boolean            // default true
  mode?: 'near' | 'floor' | 'interpolate'
}
function encodeFrames(file: AbcFile, times: number[], options?: EncodeOptions): Promise<ArrayBuffer>
```

### Browser (`alembic-js/stream`)
```ts
interface DecodedFrame {
  time: number
  objects: Map<string, FrameRecord>
}
type FrameRecord =
  | { kind: 'transform'; matrix: Float32Array }                          // 16 floats
  | { kind: 'deform'; positions: Float32Array; normals?: Float32Array }  // same layout as the GLB mesh
  | { kind: 'mesh'; positions: Float32Array; normals?: Float32Array; indices: Uint32Array; triangleToFace?: Uint32Array }  // topology changed
  | { kind: 'camera'; fov: number; near: number; far: number }
function decodeFrames(buffer: ArrayBuffer): DecodedFrame[]
function applyFrame(root: THREE.Object3D, frame: DecodedFrame): void   // updates attributes in place
```

### Wire format (little-endian)
```
header   magic 'ABCF' | version u16 | frame count u16
frame    time f64 | record count u32 | records...
record   path length u16 | path utf-8 | kind u8 | payload length u32 | payload (4-byte aligned)
```
Arrays in payloads are raw `Float32Array` / `Uint32Array` bytes, so the decoder creates views without copying.

## Work Items
1. Format writer and reader with round-trip tests, including a topology change.
2. `encodeFrames()` using the existing fast per-frame path from spec 0004.
3. Browser entry point and package `exports` entry that doesn't import the native addon.
4. Sandbox switched to the binary format with a prefetch window, as the reference implementation.

## Acceptance Criteria
- Decoding `encodeFrames()` output and applying it gives the same positions as `AbcPlayer.setTime()` in Node, within float tolerance.
- A frame of a deforming 100k-vertex mesh is under 40% of the sandbox's current JSON payload.
- `import { decodeFrames } from 'alembic-js/stream'` bundles for the browser without Node built-ins.

## Open Questions
- Should the encoder skip objects whose data didn't change since the previous frame in the same packet?
  - Answer from the implementation: no. Within a packet every requested object gets a record in every frame. The viewer jumps to any frame of a packet when scrubbing, so a frame must not depend on the frames before it. HTTP compression removes most of the repetition for objects that don't move.

## Implementation Notes
Implemented in `src/stream/` (browser-safe: `format.ts`, `apply.ts`) and `src/encode.ts` (Node). Changes from the proposal above:

### API
- `EncodeOptions` has three more options. `attributes` (default `DEFAULT_COLOR_ATTRIBUTES`) must match the `attributes` the scene was built with, because they decide the vertex layout (per-point or per-corner). `triangleToFace` (default false) adds `triangleToFace` to `mesh` records. `referenceTime` (default 0) is the time the scene was built at.
- `encodeFrames()` doesn't create an `AbcPlayer`, because that needs a three.js scene and module, and the proposed signature has neither. It reads data the way `AbcPlayer` does: the same mesh options (`groupByFaceSet: true`), `getMeshFrameAsync()` for meshes that keep their topology, and local matrices for xforms. The default `paths` are the animated xforms, meshes, subds and cameras, which is what `player.animatedPaths` returns for a scene from `buildThreeScene()`. Points and curves are not in the format yet; passing one in `paths` throws `ERR_ABC_INVALID_ARGUMENT`.
- `MeshRecord` has optional `groups` (triangle ranges per material slot, as in `AbcMesh.groups`), so a mesh with face sets keeps its materials after a topology change.
- `decodeFrames()` also accepts an `ArrayBufferView`; a Node `Buffer` at an unaligned offset is copied once. Unknown record kinds are skipped, and a newer format version is rejected with `FrameFormatError`.
- `alembic-js/stream` also exports `writeFrames(frames)` (the format writer) and `getTriangleToFace(node)`. The main entry re-exports all of them.
- `applyFrame(root, frame)` takes `any` for `root`, like the rest of the three.js bridge, so `@types/three` isn't required.
- `buildThreeScene()` has a `triangleToFace` option. It stores the array in `userData.alembic.triangleToFace` as a plain array, because GLTFExporter serializes userData as JSON and a typed array wouldn't survive.

### Deform vs mesh records
`deform` records are always relative to the scene's topology, which is the mesh at `referenceTime`. The topology of the previous frame isn't used, because a viewer may apply frames in any order. For meshes with `constant` or `homogeneous` topology the encoder uses the per-frame path. For `heterogeneous` meshes (or when the per-frame path reports `ERR_ABC_TOPOLOGY_CHANGED`) it reads the full mesh. If the vertex count and indices equal the reference, it writes a `deform` record; otherwise a `mesh` record.

`applyFrame()` keeps the original geometry of each mesh. A `mesh` record swaps in a new geometry (created with the constructors of the scene's own objects, so no `three` import is needed), and the next `deform` record restores the original before updating it. For a mesh with several materials, GLTFLoader creates a Group with one Mesh per material; `applyFrame()` updates their shared position attribute, and gives each primitive its own group's triangles on a `mesh` record.

### Payloads
All payloads start at a multiple of 4 bytes from the start of the buffer. Zero padding goes after the payload length, so arrays decode as views. Kind codes: 1 `transform`, 2 `deform`, 3 `mesh`, 4 `camera`.

| Kind | Payload |
|---|---|
| `transform` | 16 × f32, column-major local matrix |
| `deform` | flags u32 (bit 0: normals), vertex count u32, positions f32[3n], normals f32[3n]? |
| `mesh` | flags u32 (bit 0: normals, bit 1: triangleToFace, bit 2: groups), vertex count u32, index count u32, group count u32, positions f32[3n], normals f32[3n]?, indices u32[i], triangleToFace u32[i/3]?, groups (start, count, materialIndex) u32[3g]? |
| `camera` | fov, near, far as f32 |

### Payload size
The acceptance test uses a 317 × 317 grid (100,489 vertices, per-point layout, with normals). The binary frame is about 37% of the old base64 JSON frame. The ratio depends on the vertex layout. A `deform` record drops the indices, which made up half of the old payload for a per-point grid. Meshes with one vertex per face corner have fewer indices per vertex, so the saving is smaller: `cloth_deform.abc` (2,116 corner vertices) is about 60% of its JSON frame, or 13% after gzip. Leaving out normals (`normals: false`) halves a `deform` record again.

### Browser build
`bin/stream/` is the CommonJS build from `tsc`. `bin/stream.mjs` is an ES module bundled by esbuild (`scripts/build-stream.js`), so a page can load it with an import map, as the sandbox does. The `exports` map maps `import` to `stream.mjs` and everything else (`require`) to `bin/stream/index.js`. A unit test bundles `src/stream` with esbuild for the browser and checks that only `src/stream/` files are included.
