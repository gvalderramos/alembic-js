# 0004 - Velocity-Based Motion and Animation Helpers

## Overview
Alembic is mostly used to move animated geometry between tools. Alembic-JS can already read any sample by time (`{ time }` on every reader), but it gives users little help to *play* animation: there's no frame rate, no list of sample times, no interpolation, no use of velocities, and every frame goes through the full mesh read and triangulation path. This spec adds time-sampling metadata, interpolation, velocity-based motion, efficient per-frame updates, and three.js playback helpers.

## Problem Statement
Playing back a cache today means calling `getMesh(path, { time })` every frame and rebuilding a `BufferGeometry`, which is slow and allocates heavily. Time snaps to the nearest sample (`ISampleSelector` default), so playback at a rate other than the cache's stutters. Particle and fluid caches with changing topology can only be shown frame by frame, because the velocities that make sub-frame motion possible are ignored.

## Goals
- Expose time sampling: start/end, frame rate (when uniform), the list of sample times per object, and topology variance.
- Interpolate between samples: transforms (decompose and blend), and positions for meshes with homogeneous topology.
- Velocity-based motion: extrapolate positions from the floor sample using `velocities` for points, curves and meshes with changing topology.
- Fast path for animation: read only positions (and normals) for a frame, reusing cached topology and triangulation.
- three.js helpers: a playback controller that updates geometry in place, and baking transforms into `AnimationClip`s.
- Async reads, so heavy frames don't block the event loop.

## Non-Goals
- Skinning or skeletal animation (not part of Alembic).
- Motion-blur rendering itself; we provide data (velocities, sub-frame positions), not a renderer.
- Writing animated files.

## Current State
- `ReadMesh/ReadTransform/ReadCamera` take a `time` and use `ISampleSelector(time)` (near index).
- `ObjectRecord` stores `numSamples` and `animated` (`!schema.isConstant()`).
- `ArchiveData` stores `startTime`, `endTime` and `hasAnimation`.
- Known quirk: the Ancient Kettle body has 250 samples but `isConstant()` is true, and the archive start time equals its end time (`GetArchiveStartAndEndTime` only uses the max sample count per time sampling). Archive-level time ranges must be computed from the objects instead.
- `test/fixtures/nested_hierarchy.abc` has one animated xform (3 samples at 24 fps), which can be reused.

## Proposed API

### Time sampling
```ts
interface AbcTimeSampling {
  /** 'uniform' | 'cyclic' | 'acyclic' (TimeSamplingType). */
  kind: 'uniform' | 'cyclic' | 'acyclic'
  startTime: number
  /** Seconds per sample for uniform sampling (1 / fps). */
  timePerCycle?: number
  fps?: number
  sampleTimes: Float64Array          // all sample times for this object
}

interface AbcObject {
  // ...existing...
  timeSampling?: AbcTimeSampling     // undefined for objects without samples
  topology?: 'constant' | 'homogeneous' | 'heterogeneous'   // meshes, subd, points, curves
}

interface AbcFileInfo {
  // ...existing...
  fps?: number                       // most common uniform rate across animated objects
  frameRange?: { start: number; end: number }   // in frames, when fps is known
}
```
`startTime`/`endTime` in `AbcFileInfo` are recomputed from the min/max sample times of the animated objects, so the kettle's inconsistent archive-level metadata no longer matters.

### Sampling options
```ts
interface SampleOptions {
  time?: number
  /** Alternatively, a frame number using the archive fps. */
  frame?: number
  /** 'near' (current behaviour), 'floor', or 'interpolate'. Default 'near' for compatibility. */
  mode?: 'near' | 'floor' | 'interpolate'
  /** Use velocities to move positions from the floor sample to `time` (points, curves, heterogeneous meshes). */
  useVelocities?: boolean
}
```
- `mode: 'interpolate'`:
  - Transforms: decompose the floor/ceil matrices into translation, rotation (quaternion slerp) and scale, then recompose.
  - Homogeneous meshes, points with matching ids, and curves: lerp positions between the floor and ceil samples, and renormalize normals.
  - Heterogeneous topology: fall back to `floor`, plus velocities if `useVelocities` is set.
- `useVelocities`: `P(t) = P(floor) + v * (t - t_floor)`. Velocities are in units per second (Alembic convention); document the per-frame alternative.

### Fast per-frame reads
```ts
interface AbcMeshFrame {
  positions: Float32Array            // same vertex layout as the AbcMesh it came from
  normals?: Float32Array
  time: number
}

class AbcFile {
  getMeshFrame(path: string, options?: SampleOptions): AbcMeshFrame
  getMeshFrameAsync(path: string, options?: SampleOptions): Promise<AbcMeshFrame>
  getMeshAsync(path: string, options?: SampleOptions): Promise<AbcMesh>
  getTimeSampling(path: string): AbcTimeSampling | undefined
}
```
`getMeshFrame` reuses a native per-object cache: the corner → point mapping and triangulation computed by the first `getMesh()` at the same topology. It throws `ERR_ABC_TOPOLOGY_CHANGED` (a new error code) when the topology at `time` differs, so callers know to call `getMesh()` again.

### three.js helpers (`src/three.ts`)
```ts
class AbcPlayer {
  constructor(file: AbcFile, root: THREE.Object3D, THREE, options?: { fps?: number; loop?: boolean; mode?: SampleOptions['mode']; useVelocities?: boolean })
  readonly duration: number
  setTime(seconds: number): void     // updates xforms and mesh positions in place (attribute.needsUpdate)
  update(deltaSeconds: number): void // advances and calls setTime, for use in a render loop
  play(): void; pause(): void
}

/** Bakes animated xforms into an AnimationClip with position/quaternion/scale tracks. */
function createTransformClip(file: AbcFile, THREE, options?: { name?: string; fps?: number }): THREE.AnimationClip
```
- `AbcPlayer` updates `BufferAttribute`s in place with `getMeshFrame`, and recreates the geometry only when the topology changes.
- `createTransformClip` gives standard `AnimationMixer` playback for rigid animation, with no per-frame native calls.
- Optional morph-target baking for short homogeneous mesh caches (`geometry.morphAttributes.position`), for GPU playback without per-frame uploads. Opt-in, because memory grows by frames × vertices.

## Native Work (`addons/`)
1. **Time sampling metadata:**
   - For each schema, read `getTimeSampling()` and `getTimeSamplingType()` (`isUniform`, `isCyclic`, `getTimePerCycle`), and `getSampleTime(i)` for each `i < numSamples`.
   - Store the result in `ObjectRecord`.
   - Read topology variance from `getTopologyVariance()` (`kConstantTopology`, `kHomogeneousTopology`, `kHeterogeneousTopology`).
2. **Archive time range and fps:** min/max over the objects' sample times; fps is the most common `1 / timePerCycle` among uniform samplings.
3. **Sample selection:**
   - Use `TimeSampling::getFloorIndex`, `getCeilIndex` and `getNearIndex` to compute `(index0, index1, alpha)`.
   - Read with `ISampleSelector(index)` instead of time.
4. **Interpolation:**
   - Xform: decompose the Imath matrices (`Imath::extractSHRT`, or a TRS decomposition), slerp, then recompose.
   - Positions: SIMD-friendly lerp loop.
   - Points: match by `ids` when both samples have them; otherwise lerp only if the counts match.
5. **Velocities:** read `getVelocities()` from the `IPolyMesh`, `ISubD`, `IPoints` and `ICurves` samples. Apply them to positions before expanding per corner.
6. **Topology cache:**
   - Per `(object path, topology sample index)`, cache the `perCorner` flag, the corner → point indices and the triangle index buffer.
   - `ReadMeshFrame` then only reads `P` (and `N`) and scatters into the cached layout.
   - Guard the cache with a mutex, because async workers may read concurrently.
   - Invalidate it on `close()`.
7. **Async:** `Napi::AsyncWorker` subclasses for `getMesh`/`getMeshFrame`, like `OpenWorker`. They keep a `shared_ptr<ArchiveData>` so `close()` during a read is safe. Ogawa supports concurrent reads from multiple threads on one archive.
8. Add the new error code `ERR_ABC_TOPOLOGY_CHANGED` to `AbcScene.h`, `src/errors.ts` and the README.

## TypeScript Work (`src/`)
- Types, `SampleOptions` extensions and `frame` → `time` conversion using `info.fps` (error if fps is unknown and `frame` is used).
- `AbcPlayer` and `createTransformClip` in `src/three.ts` (or `src/three/animation.ts`).
- Keep defaults backward compatible (`mode: 'near'`).

## Testing
Extend `tools/generate_fixtures.cpp` with a new `animation.abc` fixture:
- `/spin`: xform rotating 0° → 90° → 180° about Y over 3 frames at 24 fps, plus translation, to test slerp versus matrix lerp.
- `/wave/waveShape`: homogeneous mesh (a 4×4 grid) whose y-values change per frame.
- `/sim/simShape`: heterogeneous mesh (face count changes per frame) with velocities.
- `/particles`: points with ids and velocities, where a point is born on frame 2.
- `/acyclic`: xform with acyclic sample times (0, 0.1, 0.35), to test non-uniform sampling.
- A second time sampling at 30 fps, to test the fps choice and the per-object sampling.

Unit tests:
- Sample times, fps, kind, topology variance and recomputed archive range. Kettle regression: `startTime` equals `endTime` today; with the new computation it follows its samples (or stays 0 if they're constant).
- `mode`:
  - `near` keeps the current behaviour.
  - `floor` uses the floor sample.
  - `interpolate` at mid-frame gives a 45° rotation for `/spin` (slerp, not a skewed lerp) and averaged y-values for `/wave`.
- Velocities: positions at `t_floor + dt` equal `P + v * dt`; heterogeneous fallback; points born mid-cache.
- `getMeshFrame`:
  - Same layout as `getMesh`, and equal positions at sample times.
  - Throws `ERR_ABC_TOPOLOGY_CHANGED` on `/sim`.
  - Faster than `getMesh` on the kettle body. This is a benchmark logged in CI, not asserted.
- Async: `getMeshAsync` results equal `getMesh`; `close()` while a read is pending doesn't crash and rejects or resolves cleanly.
- three.js:
  - `AbcPlayer.setTime` updates attributes in place, with the same `BufferAttribute` instance and `needsUpdate` set.
  - `createTransformClip` tracks sampled with `AnimationMixer` match `getTransform` at sample times.

Sandbox: add a timeline (play/pause, scrub) to the viewer. This means streaming frames over the network: serve `/frame?time=` returning positions as binary, which also implements the "send raw buffers" idea discussed for the viewer.

## Milestones
1. Time sampling metadata + archive range/fps + `frame` option.
2. Index-based sample selection + `floor`/`interpolate` for xforms.
3. Position interpolation (homogeneous meshes, points by id, curves).
4. Velocities.
5. Topology cache + `getMeshFrame`.
6. Async readers.
7. `AbcPlayer`, `createTransformClip`, sandbox timeline, docs and roadmap checkbox.

## Acceptance Criteria
- A 24 fps cache plays smoothly at 60 fps in the sandbox with `mode: 'interpolate'`.
- A heterogeneous particle or fluid cache plays with sub-frame motion using velocities.
- Per-frame updates of a ~100k-vertex mesh avoid re-triangulation, with a benchmark showing the gain over `getMesh`.
- No behaviour change for existing callers that don't pass the new options.

## Risks and Considerations
- **Velocity units:** most DCCs write units per second, but some exporters write units per frame. Provide `velocityScale` as an option.
- **Interpolating heterogeneous topology** is undefined; the floor + velocity fallback must be clear in the docs.
- **Memory:** the topology cache and morph-target baking can be large. Make the cache bounded (LRU per archive) and baking opt-in.
- **Thread safety:** Alembic's Ogawa reader supports concurrent reads, but our caches and `ArchiveData` lifetime must be guarded. Add a stress test with many concurrent `getMeshFrameAsync` calls.
- **Cyclic time sampling** (several samples per cycle, for motion blur) needs careful floor/ceil handling.

## Open Questions
- Should `AbcPlayer` live in the core package, or in a separate `alembic-js/three` entry point?
- Is `frame` 0-based or 1-based relative to `startTime`? Proposal: frames are `time * fps`, with no offset, matching DCC frame numbers.
