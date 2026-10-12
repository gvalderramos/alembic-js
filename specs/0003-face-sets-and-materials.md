# 0003 - Face Sets and Materials

## Overview
Meshes in Alembic often carry **face sets**: named groups of polygons, usually one per material, as exported by Maya, Blender and Houdini. Some files also carry **AbcMaterial** data: material objects, shader networks and material assignments. Alembic-JS currently ignores both: every mesh comes back as one undivided triangle list, and the three.js bridge uses one material per mesh. This spec exposes face sets and material assignments, and maps them to three.js geometry groups and multi-material meshes.

## Problem Statement
A typical character or prop export has one mesh with several face sets ("skin", "eyes", "cloth"). Without face sets, users can't assign different materials to parts of a mesh, select sub-parts, or round-trip material bindings into a renderer. Spec 0001 mentions "scene data" interoperability; materials are a key part of that for three.js users.

## Goals
- List the face sets of a mesh/subd object, with their face indices.
- Map face sets to triangle ranges in the geometry returned by `getMesh()`, so they can become three.js `geometry.groups`.
- Read AbcMaterial assignments (`.material.assign`), including inherited ones, and material objects (targets, shader types, shader names, parameters).
- three.js bridge: build multi-material meshes, one material slot per face set, with an optional user callback to create materials.

## Non-Goals
- Translating renderer-specific shader networks (Arnold, RenderMan, OSL, MaterialX) into three.js materials. We expose the data; users decide how to map it.
- Writing materials back to files.
- Texture loading.

## Current State
- `IFaceSet` objects show up in the hierarchy as children of meshes, with `type: 'faceset'`. Nothing reads their contents.
- `IMaterial` objects are classified as `unknown`, because `classify()` doesn't check `AbcMaterial::IMaterial::matches`.
- `ReadMesh()` fan-triangulates in face order: the triangles of face `f` are contiguous, and `faceCount` is reported. That's the basis for mapping faces to triangle ranges.

## Proposed API

### TypeScript
```ts
interface AbcFaceSet {
  name: string
  path: string                 // e.g. "/Kettle/Circle/metal"
  faces: Int32Array            // polygon indices into the mesh's faces
  exclusive: boolean           // FaceSetExclusivity: kFaceSetExclusive
  materialPath?: string        // resolved AbcMaterial assignment, if any
}

interface AbcMesh {
  // ...existing fields...
  /** Triangle ranges in `indices` (in triangles), one per group, in order. */
  groups?: { start: number; count: number; faceSet?: string; materialIndex: number }[]
  /** Material slots referenced by groups[i].materialIndex. */
  materialSlots?: { name: string; faceSet?: string; materialPath?: string }[]
}

interface AbcMaterial {
  name: string
  path: string
  targets: string[]                         // e.g. ["arnold", "prman", "*"]
  shaders: { target: string; shaderType: string; shaderName: string }[]
  parameters: Record<string, Record<string, unknown>>   // target.shaderType -> param -> value
  network?: { nodes: unknown[]; connections: unknown[] } // flattened, raw
}

interface MeshOptions extends SampleOptions {
  /** Reorder triangles so each face set is one contiguous range. Default false. */
  groupByFaceSet?: boolean
}

class AbcFile {
  getFaceSets(meshPath: string, options?: SampleOptions): AbcFaceSet[]
  getMesh(path: string, options?: MeshOptions): AbcMesh
  getMaterial(path: string): AbcMaterial
  getMaterialAssignment(objectPath: string): string | null   // inherited, flattened
  getMaterials(): AbcMaterial[]
}
```

### three.js bridge
```ts
interface ThreeSceneOptions {
  // ...existing...
  /** Called once per material slot; return a THREE.Material. Defaults to a grey MeshStandardMaterial per slot. */
  createMaterial?: (slot: { name: string; faceSet?: string; material?: AbcMaterial }) => THREE.Material
}
```
- `toBufferGeometry()` calls `geometry.addGroup(start * 3, count * 3, materialIndex)` for each group.
- `buildThreeScene()` requests `groupByFaceSet: true` and passes an array of materials (one per slot) to `new THREE.Mesh(geometry, materials)`.
- `mesh.userData.alembic.faceSets` stores the names.

## Native Work (`addons/`)
> Shader parameter values should be decoded with the generic `AbcValue` reader from spec [0006](0006-attributes-and-properties.md).

1. **Face sets:**
   - Use `IPolyMeshSchema::getFaceSetNames()` / `getFaceSet(name)` (and the same on `ISubDSchema`).
   - Read `IFaceSetSchema::Sample::getFaces()` and `getFaceExclusivity()`.
   - Validate face indices against the mesh's face count; out-of-range indices give `ERR_ABC_MALFORMED_DATA`.
2. **Triangle mapping:**
   - While triangulating in `readMeshSchema`, record `triStart[f]` (first triangle of face `f`).
   - Faces with fewer than 3 corners produce 0 triangles and must be handled.
   - With `groupByFaceSet`, emit triangles face set by face set, followed by a final "unassigned" group for faces in no set, and return the `groups`.
   - Without it, return `groups` only when face sets are disjoint and contiguous; otherwise leave `groups` undefined and expose `faces` per set.
   - Non-exclusive (overlapping) face sets: a face belongs to the first set that lists it, and a warning flag is set on the result.
3. **Materials:**
   - Link `Alembic::AbcMaterial` (already part of `Alembic::Alembic`).
   - `classify()` returns `material` for `IMaterial::matches`.
   - Read assignments with `AbcMaterial::getMaterialAssignmentPath(obj, path)`, and inherited ones with `MaterialFlatten`.
   - Read `IMaterialSchema` targets, shader types and shader names, plus the parameter values of common POD types (float, int, string, bool, V3f/C3f, and arrays). Expose unknown types as `{ type, raw: undefined }`.
   - Face sets can carry their own `.material.assign`, so resolve per face set first, then per mesh, then inherited.
4. Add `material` to `AbcObjectType` and to the README type list.

## TypeScript Work (`src/`)
- Add the types above to `src/types.ts` and export them.
- `AbcFile` methods map native errors with `objectPath`.
- three.js: multi-material support plus the `createMaterial` callback.
- Name-based fallback: Blender doesn't write AbcMaterial, but uses face set names that match the material names. `materialSlots[i].name` is the face set name, so users can map by name.

## Testing
Extend `tools/generate_fixtures.cpp` with a new `face_sets.abc` fixture:
- `/cube/cubeShape`: the existing face-varying cube, plus face sets `top` (face 5), `sides` (faces 0–3) and `bottom` (face 4).
- `/overlap/quadShape`: two non-exclusive face sets that both include face 0.
- `/materials/red` and `/materials/blue`: `OMaterial` with target `*`, a surface shader `standard_surface` and a `base_color` parameter.
- Material assignments: `cubeShape` → `/materials/red`; face set `top` → `/materials/blue`; an xform parent with an assignment inherited by its child.
- `/bad/quadShape`: a face set with out-of-range face indices.

Unit tests:
- `getFaceSets` returns names, faces and exclusivity.
- `groupByFaceSet`: group ranges cover every triangle exactly once and are sorted. Each triangle in a group belongs to a face of that set (checked through the triangle → face map).
- Without `groupByFaceSet`, triangle order is unchanged from today, so existing tests still pass.
- `getMaterial` returns targets, shaders and parameters; `getMaterialAssignment` resolves direct, face-set-level and inherited assignments; `null` when there is none.
- `getMaterial` on a non-material gives `ERR_ABC_UNSUPPORTED_TYPE`; out-of-range face indices give `ERR_ABC_MALFORMED_DATA`.
- three.js: geometry `groups` match, `Mesh.material` is an array of the right length, and `createMaterial` is called once per slot.
- Kettle regression: no face sets, a single group or `groups` undefined, and the output is otherwise unchanged.

## Milestones
1. Face set reading + `getFaceSets` + tests.
2. Triangle mapping + `groupByFaceSet` + three.js groups/multi-material.
3. `material` classification + `getMaterialAssignment` (direct and inherited).
4. `getMaterial` with shader parameters.
5. Sandbox: color each face set differently in the viewer. README update and roadmap checkbox.

## Acceptance Criteria
- A Maya or Blender export with several materials on one mesh renders in three.js with one material slot per face set, with no triangles lost or duplicated.
- AbcMaterial assignments resolve the same way as `abcls`/`MaterialFlatten`, including inheritance.
- Existing APIs keep their output when the new options aren't used.

## Risks and Considerations
- **Overlapping face sets** have no direct three.js representation. The "first set wins" rule must be documented and flagged.
- **Animated face sets:** face indices can change per sample (heterogeneous topology). Read them at the same `time` as the mesh.
- **Shader parameters** can be large or have exotic types. Expose a safe subset first.
- **Reordering triangles** with `groupByFaceSet` changes `indices` order; consumers relying on face order must not use that option. Provide a `triangleToFace` map (`Uint32Array`) as an opt-in output.

## Open Questions
- Should `groupByFaceSet` be the default in `buildThreeScene()` only, or also in `getMesh()`?
- How deep should shader network support go in v1: flattened parameters only, or full node and connection graphs?
