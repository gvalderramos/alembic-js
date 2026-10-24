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
