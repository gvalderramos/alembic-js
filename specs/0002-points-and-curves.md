# 0002 - Points and Curves Geometry

## Overview
Alembic-JS currently extracts geometry only from `mesh` (IPolyMesh) and `subd` (ISubD) objects. Points (particles, point clouds) and curves (hair, fur, guides, splines) are classified in the hierarchy as `points` and `curves`, but `getMesh()` rejects them with `ERR_ABC_UNSUPPORTED_TYPE`. This spec adds first-class readers for both, plus three.js conversion.

## Problem Statement
Particle caches and groom/hair caches are some of the most common Alembic payloads coming out of Houdini, Maya (XGen) and Blender. Without them, users can open these files and see the hierarchy, but can't visualize or process the data. Spec 0001 lists "unsupported object types" as a reason to throw; this spec moves these two types into the supported set.

## Goals
- Read `IPoints` samples: positions, ids, velocities, widths.
- Read `ICurves` samples: positions, per-curve vertex counts, curve type, periodicity, basis, widths, UVs, normals, knots/orders/weights when present.
- Provide JS-friendly data (typed arrays) consistent with `AbcMesh`.
- Provide three.js converters: `THREE.Points` for points and `THREE.LineSegments` for curves, with optional tessellation of cubic curves.
- Sample at a given time, like the existing readers.

## Non-Goals
- Rendering hair as tubes or ribbons with lighting (a later, optional enhancement).
- NURBS patches (`INuPatch`). They stay unsupported and keep throwing `ERR_ABC_UNSUPPORTED_TYPE`.
- Interpolating between samples (covered by spec 0004).
- GPU-side curve evaluation.

## Current State
- `addons/AbcScene.cpp` classifies `IPoints` as `points` and `ICurves` as `curves`, and records `numSamples`/`animated`.
- `ReadMesh()` throws `UnsupportedType` for them.
- `test/fixtures/unsupported_types.abc` already contains a 3-point `IPoints` (`/particles`) and a 3-vertex linear `ICurves` (`/curve`). The tests assert they are rejected; those assertions will move to the new readers.

## Proposed API

### TypeScript
```ts
interface AbcPoints {
  name: string
  path: string
  type: 'points'
  positions: Float32Array      // xyz per point, local space
  ids?: BigUint64Array         // stable particle ids (uint64 in Alembic)
  velocities?: Float32Array    // xyz per point, units per second
  widths?: Float32Array        // one per point, or a single constant value
  count: number
  transform: number[]          // world matrix (column-major)
}

interface AbcCurves {
  name: string
  path: string
  type: 'curves'
  positions: Float32Array            // xyz per control vertex
  vertexCounts: Int32Array           // control vertices per curve
  curveType: 'linear' | 'cubic' | 'variableOrder'
  periodic: boolean                  // closed curves
  basis: 'none' | 'bezier' | 'bspline' | 'catmullrom' | 'hermite' | 'power'
  orders?: Uint8Array                // only for variableOrder
  knots?: Float32Array               // only for NURBS-style curves
  weights?: Float32Array             // rational curves
  widths?: Float32Array              // per vertex, per curve or constant (see widthScope)
  widthScope?: 'constant' | 'uniform' | 'vertex' | 'varying'
  uvs?: Float32Array
  normals?: Float32Array
  velocities?: Float32Array
  curveCount: number
  transform: number[]
}

class AbcFile {
  getPoints(path: string, options?: SampleOptions): AbcPoints
  getCurves(path: string, options?: SampleOptions): AbcCurves
}
```

Widths in Alembic are an `IFloatGeomParam`, so their scope varies (constant, uniform/per-curve, vertex/varying). The reader returns the raw values plus the scope. A helper expands them to per-vertex when three.js needs it.

### three.js bridge (`src/three.ts`)
```ts
function toPoints(points: AbcPoints, THREE, options?: { material?, sizeFromWidths?: boolean }): THREE.Points
function toLineSegments(curves: AbcCurves, THREE, options?: {
  material?,
  segmentsPerSpan?: number     // tessellation of cubic curves (default 8)
}): THREE.LineSegments
```
- **Points:** `BufferGeometry` with `position`. If widths exist, add a `size` attribute. `PointsMaterial` only supports one size, so per-point sizes need a small custom `ShaderMaterial`, or `onBeforeCompile` on `PointsMaterial`. Ids and velocities go into `userData`, or into custom attributes when requested.
- **Curves:** one `LineSegments` per Alembic object, with an index buffer that joins consecutive vertices of each curve and stops at curve boundaries. Periodic curves get a closing segment.
  - Linear curves: use control vertices directly.
  - Cubic curves: evaluate the basis on the CPU (Bezier, B-spline, Catmull-Rom; Hermite and power as follow-ups) into `segmentsPerSpan` points per span.
- `buildThreeScene()` creates these objects for `points`/`curves` nodes, instead of the empty `Group` placeholders it creates today.

## Native Work (`addons/`)
> Widths, velocities and custom particle or curve attributes should use the generic attribute reader from spec [0006](0006-attributes-and-properties.md) when it's available, instead of separate typed readers.

1. **`AbcScene.h`:** add `PointsData` and `CurvesData` structs plus `ReadPoints()` / `ReadCurves()`, following the existing `MeshData`/`ReadMesh()` pattern (pure C++, throwing `AbcError`).
2. **`ReadPoints()`:**
   - `IPointsSchema::get(sample, sel)`.
   - Copy `getPositions()`, `getIds()` and `getVelocities()`.
   - Read widths from `getWidthsParam().getExpandedValue(sel)`, keeping the scope.
   - Throw `ERR_ABC_MALFORMED_DATA` if the ids or velocities count doesn't match the positions count.
3. **`ReadCurves()`:**
   - `ICurvesSchema::get(sample, sel)`.
   - Copy positions and `getCurvesNumVertices()`.
   - Map `getType()`, `getWrap()` and `getBasis()` to strings.
   - Copy `getOrders()`, `getKnots()` and `getPositionWeights()` when present.
   - Read widths, UVs and normals through their geom params.
   - Validate that `sum(vertexCounts) == positions.length / 3`; otherwise throw `ERR_ABC_MALFORMED_DATA`.
4. **`AbcArchive.cpp`:**
   - Expose `getPoints(path, time)` and `getCurves(path, time)`.
   - Point ids are uint64, so return them as `BigUint64Array`, which needs `Napi::TypedArrayOf<uint64_t>` (`napi_biguint64_array`).
   - Keep the world matrix via the existing `worldMatrix()`.
5. Keep returning `ERR_ABC_UNSUPPORTED_TYPE` from `getMesh()` for these types. The error message should point users at `getPoints`/`getCurves`.

## TypeScript Work (`src/`)
- Add the `AbcPoints` and `AbcCurves` types to `src/types.ts`, and export them from `src/index.ts`.
- Add `getPoints`, `getCurves`, `getAllPoints(options)` and `getAllCurves(options)` to `AbcFile`.
- Add a `NativeArchive` interface update in `src/native.ts`.
- Add `toPoints` and `toLineSegments`, with the curve evaluation helpers in a separate `src/curves.ts` so they can be unit-tested without three.js.

## Testing
Extend `tools/generate_fixtures.cpp` with a new `points_and_curves.abc` fixture:
- `/particles`: 4 points with ids, velocities, and per-point widths; animated over 2 frames.
- `/linearCurves`: 2 linear curves (3 and 4 vertices), one of them periodic.
- `/bezierCurve`: 1 cubic Bezier curve (4 control vertices) with constant width.
- `/bsplineCurve`: 1 cubic B-spline curve with per-vertex widths and UVs.
- `/badCurves`: vertex counts that don't add up to the number of positions, to check `ERR_ABC_MALFORMED_DATA`.

Unit tests:
- Points: positions, ids (`BigUint64Array`), velocities, widths and scope, world transform, sampling over time.
- Curves: vertex counts, type/basis/wrap mapping, widths scope, optional attributes absent when not written.
- Errors: `getPoints` on a mesh and `getCurves` on points both give `ERR_ABC_UNSUPPORTED_TYPE`; malformed counts give `ERR_ABC_MALFORMED_DATA`.
- Curve evaluation (`src/curves.ts`): Bezier and B-spline sample points against known values, periodic closing segment, linear passthrough.
- three.js: `toPoints` vertex count, `toLineSegments` index count (`2 * segments`), `buildThreeScene` creates `Points`/`LineSegments` nodes.
- Update `unsupported_types.abc` tests: `/particles` and `/curve` are now supported, so the "refuses to extract geometry" cases cover only `getMesh()`.

Sandbox: `yarn inspect` lists points and curves counts; the viewer renders them.

## Milestones
1. Native `ReadPoints` + `getPoints` + tests.
2. Native `ReadCurves` (linear only in three.js) + tests.
3. Cubic tessellation (Bezier, B-spline, Catmull-Rom) + `toLineSegments`.
4. Per-point sizes in three.js, plus `buildThreeScene` integration and sandbox.
5. README API tables and roadmap checkbox.

## Acceptance Criteria
- `getPoints()` and `getCurves()` return correct data for all fixture cases, at any sample time.
- `buildThreeScene()` renders points and curves from a real-world file, such as a Houdini particle cache and a groom export, without errors.
- Malformed data raises `ERR_ABC_MALFORMED_DATA` instead of crashing or returning garbage.
- No regression in existing mesh tests. CI is green on all platforms.

## Risks and Considerations
- **Hair volume:** groom caches can hold millions of control vertices. Copying into JS is O(n) and memory-heavy; consider an option to skip optional attributes. The existing typed-array copy is fine, but tessellation should stay opt-in.
- **Width conventions:** Alembic widths are diameters, while three.js point sizes are in pixels, or world units with `sizeAttenuation`. Document the conversion.
- **uint64 ids:** `BigUint64Array` isn't accepted everywhere (for example, JSON serialization). Offer `idsAsNumber` as an opt-in lossy conversion for ids below 2^53.
- **Variable order and NURBS curves** are rare. Read the raw data for them, but tessellation may be limited to linear, Bezier, B-spline and Catmull-Rom in v1.

## Open Questions
- Should curves with a very large vertex count default to "no tessellation", even for cubic bases?
- Should `getPoints()` support filtering by id, for large caches?
