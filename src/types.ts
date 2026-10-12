/** Kind of an Alembic object, derived from its schema. */
export type AbcObjectType =
    'xform' | 'mesh' | 'subd' | 'camera' | 'points' | 'curves' | 'nupatch' | 'light' | 'faceset' | 'unknown';

/**
 * 4x4 matrix as 16 numbers in column-major order (translation at indices 12-14),
 * directly usable with three.js `Matrix4.fromArray()`.
 */
export type Matrix4Array = number[];

/** Archive level metadata. */
export interface AbcFileInfo {
    path: string;
    /** Storage backend: 'ogawa', 'hdf5', 'layer' or 'unknown'. */
    coreType: string;
    /** Application that wrote the file, e.g. "Blender". */
    appName: string;
    /** Alembic library version that wrote the file, e.g. 10712 for 1.7.12. */
    libraryVersion: number;
    libraryVersionString: string;
    archiveVersion: number;
    whenWritten: string;
    userDescription: string;
    /** Number of objects in the hierarchy, excluding the implicit root. */
    objectCount: number;
    /** True when at least one object has varying samples. */
    hasAnimation: boolean;
    /** Most common frame rate among animated objects with uniform sampling. */
    fps?: number;
    /** startTime/endTime in frames, when fps is known. */
    frameRange?: { start: number; end: number };
    /** Start/end time of the archive in seconds (0 when the file has no time information). */
    startTime: number;
    endTime: number;
}

/** A node of the Alembic hierarchy. */
export interface AbcObject {
    name: string;
    /** Full path, e.g. "/Kettle/Circle". */
    path: string;
    /** Path of the parent object; undefined for top-level objects. */
    parent?: string;
    /** Paths of the direct children. */
    children: string[];
    type: AbcObjectType;
    /** Raw Alembic schema name, e.g. "AbcGeom_PolyMesh_v1" (empty for plain objects). */
    schema: string;
    numSamples: number;
    /** True when the object's samples change over time. */
    animated: boolean;
    /** Time sampling of the object's schema; undefined for objects without samples. */
    timeSampling?: AbcTimeSampling;
    /** Whether the topology changes over time (meshes, subds, points, curves). */
    topology?: 'constant' | 'homogeneous' | 'heterogeneous';
}

/**
 * Triangulated mesh data ready for GPU upload.
 * Triangles are wound counter-clockwise (three.js / WebGL convention).
 * When normals or UVs are face-varying, vertices are split per face corner.
 */
export interface AbcMesh {
    name: string;
    path: string;
    type: 'mesh' | 'subd';
    /** xyz triplets, in the mesh's local space. */
    positions: Float32Array;
    /** xyz triplets, one per vertex, when the file provides normals. */
    normals?: Float32Array;
    /** uv pairs, one per vertex, when the file provides UVs. */
    uvs?: Float32Array;
    /** Triangle list indexing into positions/normals/uvs. */
    indices: Uint32Array;
    /** Number of polygons before triangulation. */
    faceCount: number;
    /** World matrix of the mesh at the sampled time. */
    transform: Matrix4Array;
    /**
     * 'points': one vertex per mesh point. 'corners': one vertex per face corner, used when
     * normals, UVs or requested attributes are stored per face corner or per face.
     */
    layout: 'points' | 'corners';
    /** Time of the sample that was read (the first one when interpolating). */
    sampleTime: number;
    /** True when positions were interpolated between two samples. */
    interpolated: boolean;
    /** Requested `.arbGeomParams`, laid out like `positions` (see MeshOptions.attributes). */
    attributes?: Record<string, AbcMeshAttribute>;
}

/**
 * Positions (and normals) of a mesh at a time, in the vertex layout of the last getMesh() with the
 * same options. Used to update a geometry in place without re-reading the topology (spec 0004).
 */
export interface AbcMeshFrame {
    name: string;
    path: string;
    layout: 'points' | 'corners';
    positions: Float32Array;
    normals?: Float32Array;
    attributes?: Record<string, AbcMeshAttribute>;
    transform: Matrix4Array;
    sampleTime: number;
    interpolated: boolean;
}

/** A geometry attribute laid out like the mesh positions. */
export interface AbcMeshAttribute {
    /** `count * itemSize` values. 64-bit integers are narrowed to 32 bits; float16/float64 become float32. */
    data: Float32Array | Int32Array | Uint32Array | Uint8Array;
    itemSize: number;
    /** One per vertex, or 1 when `constant`. */
    count: number;
    /** Stored Alembic type. */
    pod: AbcPod;
    interpretation?: string;
    /** Element the values were attached to in the file. */
    sourceScope: 'vertex' | 'facevarying' | 'uniform' | 'constant';
    /** Constant attributes are returned once instead of repeated per vertex. */
    constant: boolean;
}

export interface MeshOptions extends SampleOptions {
    /**
     * Names of `.arbGeomParams` to include, or '*' for every numeric one. Names a mesh doesn't
     * have are ignored. Default: none, so the vertex layout only changes when you ask.
     */
    attributes?: string[] | '*';
    /** Force one vertex per face corner, e.g. to keep the same layout across calls. */
    layout?: 'points' | 'corners';
}

/** Stored Alembic data type ("plain old data"). */
export type AbcPod =
    | 'bool'
    | 'uint8'
    | 'int8'
    | 'uint16'
    | 'int16'
    | 'uint32'
    | 'int32'
    | 'uint64'
    | 'int64'
    | 'float16'
    | 'float32'
    | 'float64'
    | 'string'
    | 'wstring'
    | 'unknown';

export type AbcScope = 'constant' | 'uniform' | 'varying' | 'vertex' | 'facevarying' | 'unknown';

/** A property in an object's property tree. Listing never reads sample values. */
export interface AbcPropertyInfo {
    name: string;
    /** Path relative to the object, e.g. ".geom/.arbGeomParams/Cd". */
    path: string;
    kind: 'scalar' | 'array' | 'compound';
    /** Scalar, array and indexed properties only. */
    pod?: AbcPod;
    /** Components per element, e.g. 3 for float32[3]. */
    extent?: number;
    /** e.g. 'rgb', 'point', 'normal', 'vector'. */
    interpretation?: string;
    /** Geometry parameters only. */
    scope?: AbcScope;
    /** Compound holding `.vals` and `.indices`. */
    indexed?: boolean;
    numSamples?: number;
    animated?: boolean;
    /** Array elements at the sampled time (expanded size for indexed properties). Read without loading values. */
    count?: number;
    metadata: Record<string, string>;
    /** Present for compounds when listed recursively. */
    children?: AbcPropertyInfo[];
}

/** Typed data of a property; 64-bit integers are BigInt arrays, float16 is widened to float32, bool is 0/1. */
export type AbcArrayData =
    | Float32Array
    | Float64Array
    | Int8Array
    | Uint8Array
    | Int16Array
    | Uint16Array
    | Int32Array
    | Uint32Array
    | BigInt64Array
    | BigUint64Array
    | string[];

export interface AbcArrayValue {
    pod: AbcPod;
    extent: number;
    /** Number of elements (`data.length / extent`). */
    count: number;
    data: AbcArrayData;
    scope?: AbcScope;
    interpretation?: string;
    /** Present when an indexed property is read with `expand: false`. */
    indices?: Uint32Array;
}

export type AbcPrimitive = boolean | number | bigint | string;

/** Value of a property: scalars become primitives (or arrays when extent > 1), arrays become AbcArrayValue. */
export type AbcValue = AbcPrimitive | AbcPrimitive[] | AbcArrayValue;

/** User properties as a plain object. One-element arrays are unwrapped; compounds become nested objects. */
export interface AbcUserProperties {
    [name: string]: AbcPrimitive | AbcPrimitive[] | AbcUserProperties;
}

export interface PropertyListOptions extends SampleOptions {
    /** Compound to start from, e.g. ".geom" or ".arbGeomParams". Default: the object's top compound. */
    root?: string;
    /** Include the children of compounds. Default false. */
    recursive?: boolean;
}

export interface PropertyReadOptions extends SampleOptions {
    /** Apply `.indices` to `.vals` for indexed properties. Default true. */
    expand?: boolean;
}

/** Points / particles (spec 0002). Positions are in the object's local space. */
export interface AbcPoints {
    name: string;
    path: string;
    type: 'points';
    /** Number of points (0 for an empty sample, e.g. when all particles have died). */
    count: number;
    positions: Float32Array;
    /** Stable particle ids (uint64 in Alembic). */
    ids?: BigUint64Array;
    /** xyz per point, in units per second. */
    velocities?: Float32Array;
    /** Diameters: one per point ('vertex') or a single value ('constant'). */
    widths?: Float32Array;
    widthScope?: 'vertex' | 'constant';
    /** World matrix of the object. */
    transform: Matrix4Array;
}

/** Curves (spec 0002): hair, guides, splines. */
export interface AbcCurves {
    name: string;
    path: string;
    type: 'curves';
    /** xyz per control vertex, curve after curve. */
    positions: Float32Array;
    /** Control vertices per curve. */
    vertexCounts: Int32Array;
    curveCount: number;
    curveType: 'linear' | 'cubic' | 'variableOrder';
    /** Closed curves. */
    periodic: boolean;
    basis: 'none' | 'bezier' | 'bspline' | 'catmullrom' | 'hermite' | 'power';
    /** Order per curve, for variableOrder (NURBS) curves. */
    orders?: Uint8Array;
    knots?: Float32Array;
    /** Rational weights per control vertex. */
    weights?: Float32Array;
    /** Diameters; see widthScope for how many there are. */
    widths?: Float32Array;
    /**
     * Element the widths belong to: one per curve ('uniform'), per control vertex ('vertex'),
     * per span end ('varying'), or one in total ('constant'). Inferred from the count when the
     * file labels them inconsistently (Blender writes per-vertex widths as 'constant').
     */
    widthScope?: 'constant' | 'uniform' | 'varying' | 'vertex' | 'unknown';
    uvs?: Float32Array;
    normals?: Float32Array;
    velocities?: Float32Array;
    /** World matrix of the object. */
    transform: Matrix4Array;
}

export interface AbcTransform {
    path: string;
    /** Local matrix (identity for non-xform objects). */
    local: Matrix4Array;
    /** Accumulated world matrix. */
    world: Matrix4Array;
    inheritsTransform: boolean;
    animated: boolean;
}

export interface AbcCamera {
    name: string;
    path: string;
    /** Focal length in millimetres. */
    focalLength: number;
    /** Apertures in centimetres. */
    horizontalAperture: number;
    verticalAperture: number;
    near: number;
    far: number;
    /** Vertical field of view in degrees (three.js PerspectiveCamera convention). */
    fov: number;
    aspect: number;
    transform: Matrix4Array;
}

export interface SampleOptions {
    /** Time in seconds. Defaults to 0 (the first sample). */
    time?: number;
    /** Frame number, converted to `frame / fps` with the archive frame rate. Use instead of `time`. */
    frame?: number;
    /**
     * Which sample(s) to read (spec 0004):
     * - 'near' (default): the closest sample;
     * - 'floor': the last sample at or before `time`;
     * - 'interpolate': blend the samples around `time` (transforms are decomposed and slerped;
     *   positions are interpolated when the topology matches, otherwise 'floor' is used).
     */
    mode?: 'near' | 'floor' | 'interpolate';
    /** Move positions from the chosen sample to `time` with velocities (points, curves, changing meshes). */
    useVelocities?: boolean;
    /** Multiplier for velocities. Alembic velocities are units per second; use 1 / fps for per-frame velocities. */
    velocityScale?: number;
}

/** How an object's samples are spread over time (spec 0004). */
export interface AbcTimeSampling {
    kind: 'uniform' | 'cyclic' | 'acyclic';
    /** Time of the first sample, in seconds. */
    startTime: number;
    /** Seconds per sample (uniform) or per cycle (cyclic). */
    timePerCycle?: number;
    /** Samples per second, for uniform sampling. */
    fps?: number;
    /** Time of every sample, in seconds. */
    sampleTimes: Float64Array;
}
