/**
 * Browser entry point (`alembic-js/stream`, spec 0008): decodes frames written by encodeFrames()
 * and applies them to a three.js scene. It has no native code and no Node built-ins.
 *
 * ```ts
 * import { applyFrame, decodeFrames } from 'alembic-js/stream';
 * const gltf = await new GLTFLoader().loadAsync('/scene.glb');
 * const frames = decodeFrames(await (await fetch('/frames?start=0&count=24')).arrayBuffer());
 * applyFrame(gltf.scene, frames[0]);
 * ```
 */
export { applyFrame, getTriangleToFace, getVertexToPoint } from './apply';
export { decodeFrames, FRAME_FORMAT_VERSION, FRAME_MAGIC, FrameFormatError, RECORD_KINDS, writeFrames } from './format';
export { TOPOLOGY_HASH_ALGORITHM, topologyHash } from './topology';
export type { CameraRecord, DecodedFrame, DeformRecord, FrameRecord, MeshRecord, TransformRecord } from './format';
