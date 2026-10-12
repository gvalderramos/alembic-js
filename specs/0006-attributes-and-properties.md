# 0006 - Attributes and Properties

## Overview
Besides the schema data Alembic-JS already reads (positions, topology, normals, UVs, transforms, cameras), every Alembic object carries a tree of **properties**. Two compounds in that tree matter most to users:

- **`.arbGeomParams` (arbitrary geometry parameters):** per-point, per-face, per-face-corner or constant data attached to geometry. Examples: vertex colors (`Cd`, Blender's `Col`, Maya color sets), extra UV sets, rest positions (`Pref`), and custom simulation attributes such as `id`, `age`, `temperature` or masks.
- **`.userProperties`:** free-form metadata on any object, such as asset ids, shot names and DCC flags (Blender writes `meshtype` on meshes; cameras get `stereoDistance`/`eyeSeparation`).

This spec adds a generic way to list and read any property, an attribute-aware path that returns geometry attributes in the same vertex layout as `getMesh()`, and a three.js mapping. It's meant as a shared foundation for specs 0002–0004: widths, velocities and face-set data are attributes too.

## Problem Statement
Files exported from Houdini, Maya and Blender often carry their color and simulation data only in `.arbGeomParams`. Alembic-JS drops it today, so meshes render without vertex colors and pipelines can't read their metadata. The first native prototype had a `getProperties()` stub that never returned data; this spec replaces it with a complete, typed design.

## Goals
- List the property tree of any object without reading sample data: names, kinds, data types, interpretation, geometry scope, sample counts.
- Read any scalar or array property at a given time, as typed arrays matching the stored data type.
- Read geometry attributes with their index buffer applied and their scope resolved, in the same vertex layout as the mesh positions (`getMesh(path, { attributes })`).
- Convenience access to user properties as a plain JS object.
- three.js: map well-known attribute names to standard three.js attributes, and keep everything else as named custom attributes.

## Non-Goals
- Writing or editing properties.
- Interpreting every DCC-specific convention. We provide a default name mapping that users can override.
- Exposing the internal schema properties (`.geom/P`, `.faceIndices`, `.xform/.vals`, …) as the main way to read geometry. They're listable for debugging, but the typed readers stay the supported path.

## Current State
- `addons/AbcScene.cpp` reads `getNormalsParam()` and `getUVsParam()` through their typed geom params (`IN3fGeomParam`, `IV2fGeomParam`) with `getExpandedValue()`, and splits vertices per face corner when either one is face-varying (`perCorner`).
- Nothing reads `getArbGeomParams()` or `getUserProperties()` (both on `IGeomBaseSchema`), nor plain object properties (`IObject::getProperties()`).
- The Ancient Kettle has an empty `.arbGeomParams` and a `.userProperties` with a `meshtype` bool on each mesh, which makes a good real-world regression case.

## Alembic Background
- Properties are scalar, array, or compound. `ICompoundProperty::getNumProperties()` and `getPropertyHeader(i)` give each child's `PropertyHeader`: name, `isScalar/isArray/isCompound()`, `getDataType()` (a `PlainOldDataType` plus an extent, e.g. `float32_t[3]`), and `getMetaData()`.
- Metadata carries `interpretation` (`point`, `vector`, `normal`, `rgb`, `rgba`, `box`, `matrix`, …), `geoScope` and `arrayExtent`.
- A **geometry parameter** is either:
  - an array property, or
  - an *indexed* compound containing `.vals` (values) and `.indices` (uint32 index per element).
- **Geometry scope** (`GetGeometryScope(metadata)`) says what each value is attached to:

  | Scope | One value per | Count for a polygon mesh |
  |---|---|---|
  | `constant` | object | 1 |
  | `uniform` | face (or curve) | faceCount |
  | `varying` / `vertex` | point | point count |
  | `facevarying` | face corner | `faceIndices.length` |
- **Plain data types:** bool, uint8/int8, uint16/int16, uint32/int32, uint64/int64, float16/float32/float64, string, wstring.
- The typed geom params (`ITypedGeomParam<TRAITS>`) only cover known types. Arbitrary attributes therefore need a **generic** reader: `IArrayProperty::get(AbcA::ArraySamplePtr&, sel)` returns raw bytes plus a `DataType`, and `IScalarProperty::get(void*, sel)` fills a buffer sized `podSize * extent`.

## Proposed API

### Property tree
```ts
type AbcPod =
  | 'bool' | 'uint8' | 'int8' | 'uint16' | 'int16' | 'uint32' | 'int32'
  | 'uint64' | 'int64' | 'float16' | 'float32' | 'float64' | 'string' | 'wstring' | 'unknown'

type AbcScope = 'constant' | 'uniform' | 'varying' | 'vertex' | 'facevarying' | 'unknown'

interface AbcPropertyInfo {
  name: string
  path: string                         // relative to the object, e.g. ".arbGeomParams/Cd"
  kind: 'scalar' | 'array' | 'compound'
  pod?: AbcPod                         // scalar/array only
  extent?: number                      // components per element, e.g. 3 for float32[3]
  interpretation?: string              // 'rgb', 'point', 'normal', ...
  scope?: AbcScope                     // geometry parameters only
  indexed?: boolean                    // compound with .vals/.indices
  numSamples?: number
  animated?: boolean                   // !isConstant()
  metadata: Record<string, string>     // raw metadata
  children?: AbcPropertyInfo[]         // compounds (when requested recursively)
}

class AbcFile {
  /** Lists properties of an object. `root` defaults to the top compound. */
  getProperties(objectPath: string, options?: { root?: string; recursive?: boolean }): AbcPropertyInfo[]
}
```
A convenience listing for geometry attributes and user properties:
```ts
getAttributes(objectPath: string): AbcPropertyInfo[]       // children of .arbGeomParams
getUserProperties(objectPath: string, options?: SampleOptions): Record<string, AbcValue>
```

### Values
```ts
type AbcValue =
  | boolean | number | bigint | string                      // scalar, extent 1
  | number[] | bigint[] | string[] | boolean[]                // scalar, extent > 1
  | AbcArrayValue                                            // array property

interface AbcArrayValue {
  pod: AbcPod
  extent: number
  /** Flat typed data. float16 is widened to Float32Array, bool to Uint8Array, (u)int64 to Big(Ui|I)nt64Array, strings to string[]. */
  data: Float32Array | Float64Array | Int8Array | Uint8Array | Int16Array | Uint16Array
      | Int32Array | Uint32Array | BigInt64Array | BigUint64Array | string[]
  count: number                                              // elements (data.length / extent)
  scope?: AbcScope
  /** Present when the property is indexed and `expand: false` was requested. */
  indices?: Uint32Array
}

class AbcFile {
  getProperty(objectPath: string, propertyPath: string, options?: SampleOptions & { expand?: boolean }): AbcValue
}
```
- For indexed geometry parameters, `expand` (default `true`) applies `.indices` to `.vals`.
- Strings are returned as JS strings (UTF-8). Wide strings are converted from `std::wstring` (UTF-16 on Windows, UTF-32 elsewhere).

### Attributes in the mesh layout
```ts
interface MeshOptions extends SampleOptions {
  /** Names (or '*') of .arbGeomParams to include, laid out like `positions`. */
  attributes?: string[] | '*'
}

interface AbcMesh {
  // ...existing...
  attributes?: Record<string, {
    data: Float32Array | Int32Array | Uint32Array | Uint8Array   // per output vertex
    itemSize: number
    pod: AbcPod
    interpretation?: string
    sourceScope: AbcScope
  }>
}
```
How each scope maps to the output vertex layout (one output vertex per point, or per face corner when split):
- `vertex`/`varying` → the value of the vertex's point.
- `facevarying` → the value of the corner. This forces the per-corner split, like face-varying normals and UVs today.
- `uniform` → the value of the corner's face. This also forces the per-corner split, because points shared between faces need different values.
- `constant` → the value repeated for every vertex, or with `compactConstants: true` (default), returned once with `itemSize` and `count: 1`, and the converter uses a uniform instead.

Only numeric types are laid out per vertex. 64-bit integers are narrowed to 32-bit with an overflow check (`ERR_ABC_UNSUPPORTED_TYPE` when they don't fit), and strings aren't allowed in `attributes` (use `getProperty`).

**Layout stability:** requesting an attribute can change the vertex count (from points to corners). To avoid surprises, `AbcMesh` gets a `layout: 'points' | 'corners'` field, and `getMesh` accepts `layout: 'corners'` to force a consistent layout across calls, for example when comparing frames or switching attribute sets.

### three.js mapping
```ts
interface ThreeSceneOptions {
  // ...existing...
  attributes?: string[] | '*'
  /** Map Alembic attribute names to three.js attribute names. Merged over the defaults. */
  attributeNames?: Record<string, string>
}
```
Default mapping (case-sensitive, first match wins):

| Alembic name(s) | three.js attribute | Notes |
|---|---|---|
| `Cd`, `Col`, `color`, `displayColor`, `rgb`/`rgba` interpretation | `color` | `itemSize` 3 or 4; sets `material.vertexColors = true` on default materials |
| second UV set (`uv1`, `st1`, `map1`'s siblings, `UVMap.001`) | `uv1` | Only V2f; the primary UV stays in `uv` |
| `Pref`, `rest` | `restPosition` | custom attribute |
| anything else | same name | custom attribute, usable in `ShaderMaterial`/`onBeforeCompile` |

Colors are assumed to be linear. A `colorSpace` option (`'linear' | 'srgb'`) converts sRGB input for three.js.

## Native Work (`addons/`)
1. **Property walker:**
   - Recursive `ListProperties(ICompoundProperty, recursive)` → `PropertyRecord` structs.
   - Detect indexed geometry parameters: a compound with `.vals` and `.indices` children.
   - Detect scope with `GetGeometryScope(metadata)`.
2. **Property path resolution:** split on `/` and walk `getPropertyHeader(name)`. Unknown paths give a new error code, `ERR_ABC_PROPERTY_NOT_FOUND`.
3. **Generic readers:**
   - Arrays: `IArrayProperty::get(ArraySamplePtr, ISampleSelector)` → copy raw bytes into the matching typed buffer.
   - Scalars: `IScalarProperty::get(buffer, sel)`.
   - Strings: read into `std::string` / `std::wstring` arrays.
   - float16: widen with `half` → `float` (Imath's `half` type).
   - bool: Alembic stores 1 byte per value; copy into `Uint8Array`.
4. **Indexed expansion:** read `.indices` (uint32) and gather from `.vals`. Out-of-range indices give `ERR_ABC_MALFORMED_DATA`.
5. **Mesh layout integration in `readMeshSchema`:**
   - Generalize the current `N`/`UV` logic into a list of "attribute sources", each with scope, extent and expanded data.
   - `perCorner` becomes true if any requested source is `facevarying` or `uniform`.
   - Use the face → corner range already computed during triangulation to scatter `uniform` values.
   - Keep normals and UVs on the same path, so there is one code path for every attribute.
6. **N-API (`AbcArchive.cpp`):**
   - `getProperties`, `getProperty`, `getUserProperties`, and the `attributes` option on `getMesh`.
   - Typed arrays via `Napi::TypedArrayOf<T>`; 64-bit via `napi_bigint64_array` / `napi_biguint64_array`.
   - Strings via `Napi::String`.
7. **Size guard:** `getProperty` on very large arrays is fine (typed copy), but `recursive` listing must not read samples. Listing only reads headers and metadata.

## TypeScript Work (`src/`)
- Types above in `src/types.ts`, exported from `src/index.ts`.
- `AbcFile.getProperties/getAttributes/getProperty/getUserProperties`, with errors carrying `objectPath`. Consider adding `propertyPath` to `AlembicError`.
- three.js: extend `toBufferGeometry` to add the mapped attributes. When `color` is present and the material is the default one, set `vertexColors: true`.
- Sandbox: show the property tree and user properties of the selected object in the viewer panel. Add an option to color a mesh by any numeric attribute (a heatmap), which helps when debugging simulation caches.

## Testing
Extend `tools/generate_fixtures.cpp` with a new `attributes.abc` fixture. On `/cube/cubeShape` (the existing face-varying cube):
- `Cd`: C3f, `facevarying`, **indexed** (6 values, 24 indices: one color per face, written per corner).
- `pointWeight`: float32, `vertex` (8 values).
- `faceId`: int32, `uniform` (6 values).
- `uv2`: V2f, `facevarying`, non-indexed (second UV set).
- `tint`: C4f, `constant`.
- `bigId`: uint64, `vertex`, to test BigInt and the overflow rule in mesh layout.
- `half`: float16, `vertex`.

User properties on `/cube`:
- `assetId` (string), `version` (int32), `scale` (float64), `enabled` (bool), `tags` (string array).
- An animated user property, `frameLabel`, with 3 samples.

On `/cube/plainShape`: a mesh with no arbitrary geometry parameters and no user properties.

Unit tests:
- **Listing:** names, kinds, pod/extent, interpretation (`rgb` for `Cd`), scope, `indexed`, sample counts. Recursive listing includes `.vals`/`.indices`.
- **Reading:**
  - Every POD type round-trips: float16 widened, bool as 0/1, uint64 as `BigUint64Array`, string arrays.
  - Indexed `Cd`: with `expand: false`, returns `indices` and 6 values; expanded, returns 24 values.
- **User properties:** returned as a plain object with the right JS types; animated values change with `time`.
- **Mesh layout:**
  - `vertex`-scope attributes keep the point layout (8 vertices).
  - Requesting `faceId` (uniform) or `Cd` (facevarying) switches to corners (24 vertices), and `layout` reports it.
  - Values match the source per corner and per face.
  - `constant` is compacted.
- **Errors:**
  - Unknown property → `ERR_ABC_PROPERTY_NOT_FOUND`.
  - String attribute in `attributes` → `ERR_ABC_UNSUPPORTED_TYPE`.
  - Out-of-range indices → `ERR_ABC_MALFORMED_DATA`.
  - `bigId` above 2^32 in mesh layout → `ERR_ABC_UNSUPPORTED_TYPE` with a clear message.
- **three.js:**
  - `Cd` becomes `color` with `itemSize` 3, and the default material has `vertexColors`.
  - `uv2` becomes `uv1`.
  - Unknown names stay custom attributes.
  - The `attributeNames` override works.
- **Kettle regression:** `getUserProperties('/Kettle/Circle')` returns `{ meshtype: <bool> }`; `getAttributes` returns `[]`; `getMesh` output is unchanged when `attributes` isn't passed.

## Relationship to Other Specs
- **0002 (points and curves):** widths and velocities can be read with the generic reader and laid out by scope (curves: `uniform` = per curve, `vertex` = per control vertex). Custom particle attributes such as `age` and `id` come for free.
- **0003 (face sets and materials):** material parameters reuse the same value decoding (`AbcValue`).
- **0004 (animation):** attribute values are sampled at the same `time`. Interpolation of numeric vertex attributes follows the position rules (homogeneous topology only), and `getMeshFrame` can return requested attributes alongside positions.

Implementing this spec first reduces the work in 0002–0004.

## Milestones
1. Property listing (`getProperties`, `getAttributes`) + `ERR_ABC_PROPERTY_NOT_FOUND`.
2. Generic value reader (`getProperty`, `getUserProperties`) for all POD types, including indexed expansion.
3. Refactor `readMeshSchema` around attribute sources; `attributes` option and `layout`.
4. three.js mapping + `vertexColors`.
5. Sandbox property panel and attribute heatmap; README API table and roadmap checkbox.

## Acceptance Criteria
- A Houdini export with `Cd` and a custom float attribute renders with vertex colors in three.js through `buildThreeScene(file, THREE, { attributes: '*' })`, and the custom attribute is available on the geometry.
- Every fixture property can be listed and read with the correct type and values, at every sample time.
- Existing API output is byte-identical when the new options aren't used.

## Risks and Considerations
- **Vertex count changes** when an attribute forces the per-corner split. That's a source of bugs for users who cache layouts, so `layout` must be explicit and documented.
- **Memory:** `attributes: '*'` on a large mesh can multiply memory use. Default to no attributes, and document the cost.
- **DCC naming varies** a lot (Maya color sets, Blender `Col`/`Attribute`, Houdini `Cd`), so the default mapping will never be complete. The override option is the escape hatch.
- **Color spaces:** Alembic doesn't record a color space. Most DCCs write linear values, but some write sRGB. Expose `colorSpace` instead of guessing.
- **Exotic types** (boxes, matrices, quaternions, and compounds that aren't indexed parameters) are listed with their pod and extent, and readable as raw numeric arrays, but don't get special treatment in v1.

## Open Questions
- Should `getMesh()` include `Cd` automatically when present, since vertex colors are the most common request? Proposal: no, keep it opt-in for predictable layouts; `buildThreeScene()` could default to `['Cd', 'Col', 'color', 'displayColor']`.
- Do we need a streaming or partial read for very large arrays (for example, the first N elements for previews)?
