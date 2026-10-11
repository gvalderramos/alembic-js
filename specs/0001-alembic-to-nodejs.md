
```markdown
# 0001 - Alembic to Node.js Specification

## Overview
This specification defines the scope, architecture, and implementation goals for Alembic-JS, a native Node.js binding that allows JavaScript and TypeScript applications to read Alembic scene data directly from `.abc` files. The project targets interoperability with modern JavaScript tooling and 3D stacks such as Three.js while maintaining a clear and maintainable native API.

## Problem Statement
Alembic is a standard format for exchanging 3D scene data between DCC tools such as Maya, Houdini, Blender, and other CG pipelines. While the C++ SDK provides access to geometry, hierarchy, camera, and animation information, JavaScript developers often lack a straightforward way to integrate Alembic data into Node.js-based workflows.

This project aims to bridge that gap by exposing Alembic functionality to Node.js via native bindings, giving developers a practical interface for loading, parsing, and transforming Alembic assets in automated pipelines and browser/server-side 3D tooling.

## Goals
- Expose Alembic file parsing capabilities to Node.js applications.
- Support reading relevant scene data from `.abc` files without requiring a full C++ application layer in user code.
- Provide a clean TypeScript-friendly API for metadata and geometry access.
- Enable integration with Three.js and other rendering libraries when appropriate.
- Keep the binding idiomatic, extensible, and easy to test.

## Non-Goals
- Rebuilding the entire Alembic SDK in JavaScript.
- Full replacement of the Alembic C++ runtime or tooling.
- Full real-time rendering support inside the native layer.
- Immediate support for every Alembic feature in v1.0; the project should focus on a reliable subset first.

## Scope
The initial implementation should focus on the following capabilities:
- Loading a `.abc` file from disk.
- Reading file metadata and object hierarchy.
- Extracting mesh and vertex-related data when available.
- Exposing data in a structure that can be consumed by JavaScript/TypeScript.
- Supporting a minimal integration path for Three.js scene construction.

## Functional Requirements

### 1. File Loading
- The module must accept a valid file path to an Alembic asset.
- The module must validate the input and return descriptive errors for invalid or missing files.
- The module must support loading `.abc` files in a Node.js runtime.

### 2. Metadata Access
- The module must expose basic file information such as:
  - file path
  - archive version or compatibility data when available
  - top-level scene/object metadata
- Metadata access must be available through a stable JavaScript API.

### 3. Geometry Access
- The module must provide access to relevant geometry data for supported Alembic objects.
- Supported initial data should include:
  - vertex positions
  - normals when available
  - indices / topology data
  - per-object transform information
- The API must return data in a JavaScript-friendly structure, avoiding direct exposure of low-level native memory where practical.

### 4. Scene Hierarchy
- The module must expose the hierarchical structure of Alembic objects so consumers can traverse or query elements programmatically.
- Hierarchy output should include object names and parent/child relationships when the file provides them.

### 5. Three.js Integration
- The module should provide a simple bridge for converting extracted geometry into structures usable by Three.js.
- Integration must be optional and not mandatory for the core native parser.

### 6. Error Handling
- The module must throw or return structured errors with helpful messages for:
  - missing files
  - invalid Alembic archives
  - unsupported object types
  - malformed or partially readable data
- Error messages must be actionable and suitable for debugging in Node.js tooling.

## Architecture

### Native Layer
- The project will use the Alembic C++ SDK through a native binding layer.
- The native layer is responsible for reading `.abc` files and exposing data to Node.js.
- Node-API (N-API) should be used to minimize ABI compatibility issues across Node.js versions.

### JavaScript / TypeScript Layer
- A TypeScript interface will wrap native access and provide ergonomic methods.
- This layer should define stable models for metadata, objects, transforms, and geometry.
- The JS layer should be the primary API surface for end users.

### Data Flow
1. User provides an Alembic file path.
2. The native module loads the archive.
3. The native layer extracts readable metadata and geometry.
4. Data is converted into plain JavaScript structures.
5. TS consumers can either use the raw data directly or pass it to Three.js utilities.

## Proposed API

### `AbcFile`
Represents a single Alembic archive.

```ts
class AbcFile {
  constructor(path: string)

  load(): void
  getInfo(): AbcFileInfo
  getChildren(): AbcObject[]
  getObject(path: string): AbcObject | null
  close(): void
}
```

### `AbcObject`
Represents a node in the Alembic hierarchy.

```ts
interface AbcObject {
  name: string
  path: string
  parent?: string
  children: string[]
  type: 'xform' | 'mesh' | 'camera' | 'unknown'
}
```

### `AbcMesh`
Represents mesh-related geometry data.

```ts
interface AbcMesh {
  name: string
  positions: number[]
  normals?: number[]
  indices?: number[]
  transform?: number[]
}
```

### `AbcFileInfo`
Represents archive metadata.

```ts
interface AbcFileInfo {
  path: string
  objectCount: number
  hasAnimation: boolean
}
```

## Design Constraints
- The API must remain usable from modern JavaScript and TypeScript projects.
- Memory ownership and lifecycle management must be explicit to avoid native leaks.
- Data conversion should favor plain arrays and objects over complex native objects in the JS layer.
- Performance-sensitive logic should remain in native code where appropriate.

## Testing Requirements

### Unit Tests
- Unit tests must cover:
  - valid file loading
  - invalid path handling
  - metadata extraction
  - hierarchy traversal
  - geometry extraction for supported mesh data
  - error propagation and validation failures

### Integration Tests
- A minimal sandbox or fixture-based integration test should verify that extracted Alembic geometry can be used with Three.js in a Node.js environment.
- Test fixtures should include multiple Alembic sample files covering:
  - simple mesh
  - transformed mesh
  - nested hierarchy
  - unsupported object types

### Validation Strategy
- Tests should run in CI for every relevant Node.js version supported by the project.
- Integration checks must validate end-to-end parsing and conversion behavior.

## Milestones

### Phase 1: Foundation
- project setup
- native build configuration
- basic Alembic archive load path
- minimal metadata API

### Phase 2: Geometry Extraction
- mesh parsing
- vertex position export
- transforms and hierarchy extraction

### Phase 3: JS API and Integration
- TypeScript wrapper and public API refinement
- Three.js compatibility layer
- documentation and examples

### Phase 4: Stabilization
- CI validation
- test coverage growth
- performance tuning and bug fixes

## Acceptance Criteria
The project is considered ready for a first public release when all of the following are true:
- The module can load a valid `.abc` file from Node.js.
- Metadata and hierarchy can be retrieved through a documented API.
- Mesh vertex and transform data can be read for supported cases.
- Failures produce informative and structured errors.
- Unit and integration tests cover the core functionality.
- A usage example demonstrates loading and processing a file in TypeScript.

## Risks and Considerations
- Different Alembic versions may expose incompatible object structures.
- Geometry extraction can be complex for non-trivial scenes with animation and instancing.
- Performance may vary depending on file size and how much data is converted into JS objects.
- Native build complexity may differ across operating systems and Node versions.

## Success Metrics
- Users can load and inspect a basic Alembic file in under a few lines of code.
- Core mesh data is successfully exposed to JavaScript without requiring custom native code.
- The project supports a clean and maintainable TypeScript developer experience.

## Summary
Alembic-JS should provide a practical bridge between Alembic files and modern JavaScript development. The initial scope focuses on reliable file loading, metadata access, hierarchy traversal, and mesh extraction while keeping the API simple enough for real-world Node.js and Three.js workflows.
