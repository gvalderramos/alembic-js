export { AbcFile } from './AbcFile';
export { AlembicError, isAlembicError } from './errors';
export type { AbcErrorCode } from './errors';
export type {
    AbcCamera,
    AbcCurves,
    AbcFaceSet,
    AbcArrayData,
    AbcArrayValue,
    AbcFileInfo,
    AbcMaterial,
    AbcMesh,
    AbcMeshAttribute,
    AbcMeshFrame,
    AbcObject,
    AbcObjectType,
    AbcPoints,
    AbcPod,
    AbcPrimitive,
    AbcPropertyInfo,
    AbcScope,
    AbcTimeSampling,
    AbcTransform,
    AbcUserProperties,
    AbcValue,
    MeshOptions,
    PropertyListOptions,
    PropertyReadOptions,
    Matrix4Array,
    SampleOptions,
} from './types';
export { AbcPlayer, createTransformClip } from './animation';
export type { PlayerOptions, ThreeAnimationModule } from './animation';
export { encodeFrames } from './encode';
export type { EncodeOptions } from './encode';
export { applyFrame, decodeFrames, FrameFormatError, getTriangleToFace, writeFrames } from './stream';
export type { CameraRecord, DecodedFrame, DeformRecord, FrameRecord, MeshRecord, TransformRecord } from './stream';
export { tessellateCurves, widthsPerVertex } from './curves';
export type { TessellatedCurves, TessellateOptions } from './curves';
export {
    buildThreeScene,
    DEFAULT_COLOR_ATTRIBUTES,
    threeAttributeName,
    toBufferGeometry,
    toLineSegments,
    toPoints,
    usePointWidths,
} from './three';
export type { GeometryOptions, PointsOptions, ThreeModule, ThreeSceneOptions } from './three';
