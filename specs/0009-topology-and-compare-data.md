# 0009 - Topology Info and Data for Comparing Caches

**Status:** In progress (slices 1-3 implemented)

## Overview
Review and pipeline tools compare two versions of the same cache: did the topology change, how far did each point move, and what does the motion look like between samples. alembic-js has most of the pieces (topology variance, per-frame reads, interpolation, frame streaming) but no cheap way to identify a mesh's topology, no way to map a viewer vertex back to its source point, and no way to stream a per-vertex value that isn't a position. This spec adds those three things, plus velocity options on the frame encoder.

## Problem Statement
- **Topology identity.** `AbcObject.topology` says whether topology changes over time, not whether two meshes (in two files, or at two samples) have the same topology. The only way today is `getMesh()` on both and comparing triangle indices, which triangulates the whole mesh and depends on the vertex layout. Other tools that check meshes (for example a C++ health checker reading the same file) need a hash they can compute the same way.
- **Per-point comparison.** A distance heatmap between two versions is computed per source point, but the geometry a viewer shows may have one vertex per face corner (`layout: 'corners'`). `AbcMesh` doesn't say which point each vertex came from, so a per-point value can't be expanded to the scene's layout.
- **Streaming per-vertex values.** The frame format (spec 0008) carries positions and normals only. A per-frame scalar such as a distance has to go through a separate, app-specific channel.
- **Sub-frames.** `encodeFrames()` already takes any time and `mode: 'interpolate'` (covered by `test/stream.test.ts`), so sub-frame playback works for xforms, cameras and meshes with constant or homogeneous topology. Heterogeneous meshes fall back to the floor sample because `EncodeOptions` doesn't pass `useVelocities`/`velocityScale` through, so particle-like meshes stutter between samples.

## Goals
- `getTopology()`: point, face and corner counts and a topology hash for a mesh/subd at a time, without triangulating; optionally the raw face counts and indices.
- `getTopologyChanges()`: the samples at which a mesh's topology changes, cheaply.
- A specified default hash, reproducible outside alembic-js, plus an exported reference implementation.
- `vertexToPoint` on `AbcMesh` (opt-in), so per-point data can be laid out like `positions`.
- An `attribute` record in the frame format, applied by `applyFrame()`.
- `useVelocities` and `velocityScale` in `EncodeOptions`.

## Non-Goals
- Computing distances or heatmap colors. Apps subtract positions; the library gives them aligned data.
- Matching points between meshes of different topology (closest point, UV transfer).
- Points and curves topology. Points use ids (spec 0002); curves can follow later with the same shape.
- Changing the meaning of `interpolate` for heterogeneous topology (still floor, plus velocities when asked).

## Proposed API

### Topology
```ts
interface AbcTopology {
  path: string
  /** Index of the sample that was read (topology is never interpolated). */
  sampleIndex: number
  sampleTime: number
  /** Number of points (P), i.e. source vertices. */
  pointCount: number
  faceCount: number
  /** Number of face indices (sum of face counts). */
  cornerCount: number
  /** Default definition below: 16 lowercase hex digits. */
  hash: string
  hashAlgorithm: 'fnv1a64-faces-v1'
  /** With `faces: true`: raw arrays as stored in the file (no rewinding). */
  faceCounts?: Int32Array
  faceIndices?: Int32Array
}

interface TopologyOptions extends SampleOptions {   // 'interpolate' is treated as 'floor'
  faces?: boolean
}

interface AbcTopologyChange {
  sampleIndex: number
  sampleTime: number
  pointCount: number
  faceCount: number
  hash: string
}

class AbcFile {
  getTopology(path: string, options?: TopologyOptions): AbcTopology
  getTopologyAsync(path: string, options?: TopologyOptions): Promise<AbcTopology>
  /** One entry for the first sample and one for every sample whose topology differs from the previous. */
  getTopologyChanges(path: string): Promise<AbcTopologyChange[]>
}

/** Reference implementation of 'fnv1a64-faces-v1', also exported from 'alembic-js/stream'. */
function topologyHash(faceCounts: ArrayLike<number>, faceIndices: ArrayLike<number>): string
```
Both throw `ERR_ABC_INVALID_ARGUMENT` for objects that aren't meshes or subds.

### Hash definition (`fnv1a64-faces-v1`)
FNV-1a 64-bit (offset basis `0xcbf29ce484222325`, prime `0x100000001b3`) over this byte stream:
1. every face count, as uint32 little-endian, in file order;
2. then every face index, as uint32 little-endian, in file order.

The arrays are hashed as stored in the Alembic sample: no rewinding (alembic-js flips winding only when triangulating), no triangulation, no dependence on normals, UVs or face sets. Point positions and the point count are not hashed; compare `pointCount` separately. The result is written as 16 lowercase hex digits, zero-padded. An empty mesh hashes to `cbf29ce484222325`.

Test vectors, shared with nitpick-health-core spec 0004 (both implementations must pass them):

| faceCounts | faceIndices | hash |
|---|---|---|
| [] | [] | `cbf29ce484222325` |
| [3] | [0,1,2] | `b623a479d2984da5` |
| [4] | [0,1,2,3] | `0e8a69ddf947c4f1` |
| [3,3] | [0,1,2,0,2,3] | `18e3a471ae049257` |
| [3,3] | [0,2,1,0,3,2] | `516fb1c0a2254197` |

The same definition is meant to be computed by other readers of the file, so a hash stored by one tool can be compared with one computed by alembic-js. Any change is a new `hashAlgorithm` name, never a silent change.

### Vertex to point
```ts
interface MeshOptions {
  // ...existing...
  /** Return `vertexToPoint`, the source point of every vertex. Default false. */
  vertexToPoint?: boolean
}
interface AbcMesh {
  // ...existing...
  /** Source point index of every vertex (identity for layout 'points'). */
  vertexToPoint?: Uint32Array
}
```
`buildThreeScene()` gets the same option and stores it in `userData.alembic.vertexToPoint` as a plain array, like `triangleToFace`. `getVertexToPoint(node)` in `alembic-js/stream` returns it as a `Uint32Array`.

### Attribute records (frame format)
```ts
type FrameRecord =
  | ...existing...
  | { kind: 'attribute'; name: string; itemSize: number; data: Float32Array }
```
- Wire kind 5. Payload: name length u16, name UTF-8, zero padding to 4 bytes, itemSize u32, count u32, data f32[count × itemSize].
- A frame still holds at most one record per path, so attribute records travel in their own packet (for example a heatmap packet fetched only while a diff view is on), next to the position packet for the same times. `applyFrame()` applies either; order doesn't matter as long as the topology is the same.
- `applyFrame()` sets `geometry.attributes[name]`, updating the existing `BufferAttribute` in place when the size matches, or replacing it otherwise. A record whose `count` doesn't match the current geometry's vertex count is skipped (the topology swapped under it).
- Decoders from before this spec skip kind 5 (unknown kinds are skipped by design), so `FRAME_FORMAT_VERSION` stays 1.
- `encodeFrames()` doesn't produce attribute records; apps build them with `writeFrames()`.

### Velocities in the encoder
```ts
interface EncodeOptions {
  // ...existing...
  useVelocities?: boolean   // passed to every mesh read, as in SampleOptions
  velocityScale?: number
}
```

## Native Work (`addons/`)
1. `ReadTopology(path, sampleIndex, withFaces)`: read only `.faceCounts` and `.faceIndices` (and the `P` array's size, not its data), hash them in one pass, return counts and, when asked, copies of the arrays.
2. Cache results per object keyed by the Alembic array digests already kept for the topology cache (`faceCountsDigest`, `faceIndicesDigest`), so identical samples are hashed once.
3. `getTopologyChanges`: walk the samples reading only the array digests (`IArrayProperty::getKey`) and call `ReadTopology` only when a digest changes. Constant and homogeneous meshes cost one read. Run as an `AsyncWorker`.
4. `vertexToPoint`: the corner-to-point map already built for `layout: 'corners'`; for `'points'` return the identity. Respect `groupByFaceSet` reordering (it reorders triangles, not vertices, so the map is unchanged).

## TypeScript Work (`src/`)
- Types, `AbcFile` methods, `topologyHash()` in `src/stream/topology.ts` (browser-safe, BigInt-free: two 32-bit halves).
- `attribute` record in `src/stream/format.ts` and `applyFrame()`; `getVertexToPoint()`.
- `vertexToPoint` in `buildThreeScene()`; `useVelocities`/`velocityScale` in `encodeFrames()`.
- README: API tables, the hash definition, roadmap entry.

## Decisions
- **Hash input is face counts then face indices, raw, FNV-1a 64.** It's the cheapest stable identity of connectivity, needs no triangulation, and is easy to reimplement in C++ and JS byte for byte. Counts are hashed before indices so `[3,3]/[0,1,2,0,2,3]` and `[6]/[...]` differ.
- **Point count is not hashed.** Unused points don't change connectivity, and keeping positions-related data out means a hash is valid across all samples of a homogeneous mesh. Callers compare `pointCount` too.
- **Hash as a hex string, not BigInt.** It must survive JSON (reports, `userData`, HTTP).
- **"Pluggable" means raw arrays plus a named algorithm, not a JS callback.** `faces: true` gives any caller the input to compute another hash; the built-in one is fixed and versioned by name, so stored hashes stay comparable.
- **Topology is read at a sample, never interpolated.** `mode: 'interpolate'` behaves as `'floor'` for `getTopology()`.
- **`vertexToPoint` instead of a points-layout scene.** Viewers keep the layout they need for normals and UVs; per-point data is expanded with one lookup per vertex.
- **Attribute records carry float32 only.** Scalars and colors cover the known uses; integer attributes can be a new kind later.
- **Sub-frames need no new API.** `encodeFrames(times, { mode: 'interpolate' })` already works; only the velocity pass-through is added.
- **A topology change is a different hash or a different point count.** `getTopologyChanges()` reports both, so its entries equal `getTopology()` at every sample with repeats dropped; a mesh that only gains unused points still needs a new vertex buffer.
- **Constant and homogeneous meshes return one entry without walking.** Their topology is fixed by definition; heterogeneous meshes are walked by `faceCounts`/`faceIndices` digest plus the size of `P` (read without its data).
- **Hashes are cached per archive by `path|faceCounts digest|faceIndices digest`**, separately from the per-frame layout cache, so `getTopology()` at any sample of a constant mesh hashes once. Files without digests (HDF5) are hashed on every read.
- **The face-read counter is internal.** `getDebugStats()` exists on the native handle for tests and isn't part of the typed API.
- **A `mesh` record drops `vertexToPoint` from the node; the next `deform` record restores it.** Mesh records don't carry the map, and the scene's map doesn't fit the new vertices; `getVertexToPoint()` returns undefined meanwhile. `AbcPlayer` rebuilds keep it, since they re-read the mesh with the scene's options.
- **Release:** ships in the same npm minor as spec 0008 (the first release with `alembic-js/stream`). Consumers pin that version.

## Implementation plan
1. **`getTopology` and `topologyHash`.** Native read and hash, TS types, JS reference implementation. Tests: on `animation.abc`, `/wave` has one hash at every sample and `/sim` differs per sample; native hash equals `topologyHash(faceCounts, faceIndices)` from `faces: true`; a hand-computed hash for a one-quad mesh (golden value in the test); empty-mesh value; `ERR_ABC_INVALID_ARGUMENT` on an xform.
2. **`getTopologyChanges`.** Digest walk, async. Tests: constant mesh → 1 entry; `/sim` → one entry per changing sample; result equals calling `getTopology` at every sample and dropping repeats; a 250-sample constant mesh (kettle body) reads face indices once (counter exposed in debug stats).
3. **`vertexToPoint`.** Native map, `buildThreeScene` option, `getVertexToPoint`. Tests: identity for `'points'`; for a corners mesh, `positions[v] == pointsLayout.positions[vertexToPoint[v]]` for every vertex; survives a JSON round trip.
4. **Attribute records.** Writer, reader, `applyFrame`. Tests: round trip; in-place update keeps the same `BufferAttribute`; size mismatch after a `mesh` record is skipped; a version-1 decoder built from `main` skips kind 5 (fixture packet checked in).
5. **Encoder velocities.** Pass-through. Test: `/sim` at `t_floor + dt` with `useVelocities` gives `P + v·dt` in the `mesh` record; without it, the floor positions.
6. **Docs and release.** README tables, hash definition, roadmap; release notes list the additions.

## Acceptance Criteria
- `getTopology()` on a 1M-face mesh takes under 50 ms and doesn't allocate triangle buffers.
- A hash computed by `topologyHash()` from raw arrays equals the native one for every mesh in the test assets.
- A per-point distance computed from two `layout: 'points'` frames, expanded with `vertexToPoint` and sent as an attribute record, colors the right vertices in a scene built with the default layout.
- No behaviour change for callers that don't use the new options.

## Risks and Considerations
- **Cross-tool agreement.** The hash is only useful if every tool that stores one uses this exact byte stream. Any reimplementation should be tested against the golden values in this repo's tests.
- **Negative indices.** Alembic stores face indices as int32; a corrupt file could hold negatives. They're hashed as their uint32 bit pattern, which other implementations must do too.
- **Packet size.** A float per vertex per frame is a quarter of a `deform` record; heatmap packets compress well because most values are near zero.
