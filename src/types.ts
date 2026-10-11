/** Kind of an Alembic object, derived from its schema. */
export type AbcObjectType =
    | 'xform'
    | 'mesh'
    | 'subd'
    | 'camera'
    | 'points'
    | 'curves'
    | 'nupatch'
    | 'light'
    | 'faceset'
    | 'unknown';

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
}
