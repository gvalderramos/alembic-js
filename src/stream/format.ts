/**
 * Binary frame format (spec 0008). Browser-safe: no Node built-ins, no native addon.
 *
 * ```
 * header   magic 'ABCF' | version u16 | frame count u16
 * frame    time f64 | record count u32 | records...
 * record   path length u16 | path utf-8 | kind u8 | payload length u32 | zero padding | payload
 * ```
 * Everything is little-endian. The padding (0-3 bytes) makes every payload start at a multiple of
 * 4 bytes from the start of the buffer, so arrays are decoded as typed-array views without copying.
 */

export const FRAME_MAGIC = 'ABCF';
export const FRAME_FORMAT_VERSION = 1;

/** Record kind codes on the wire. */
export const RECORD_KINDS = { transform: 1, deform: 2, mesh: 3, camera: 4 } as const;

const FLAG_NORMALS = 1;
const FLAG_TRIANGLE_TO_FACE = 2;
const FLAG_GROUPS = 4;

/** Local matrix of an xform: 16 floats, column-major (three.js `Matrix4.fromArray()` order). */
export interface TransformRecord {
    kind: 'transform';
    matrix: Float32Array;
}

/** New positions (and normals) in the vertex layout of the mesh in the scene (GLB). */
export interface DeformRecord {
    kind: 'deform';
    positions: Float32Array;
    normals?: Float32Array;
}

/** A mesh whose topology differs from the one in the scene: the full triangulated geometry. */
export interface MeshRecord {
    kind: 'mesh';
    positions: Float32Array;
    normals?: Float32Array;
    indices: Uint32Array;
    /** Source polygon of every triangle, when requested from the encoder. */
    triangleToFace?: Uint32Array;
    /** Triangle ranges per material slot (as in AbcMesh.groups), when the mesh has face sets. */
    groups?: { start: number; count: number; materialIndex: number }[];
}

export interface CameraRecord {
    kind: 'camera';
    /** Vertical field of view in degrees. */
    fov: number;
    near: number;
    far: number;
}

export type FrameRecord = TransformRecord | DeformRecord | MeshRecord | CameraRecord;

export interface DecodedFrame {
    /** Time in seconds. */
    time: number;
    /** Records keyed by Alembic object path. */
    objects: Map<string, FrameRecord>;
}

/** Thrown by decodeFrames() for buffers that are not in the frame format. */
export class FrameFormatError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'FrameFormatError';
    }
}

const align4 = (n: number) => (n + 3) & ~3;

function payloadLength(record: FrameRecord): number {
    switch (record.kind) {
        case 'transform':
            return 16 * 4;
        case 'deform':
            return 8 + (record.positions.length + (record.normals?.length ?? 0)) * 4;
        case 'mesh':
            return (
                16 +
                (record.positions.length +
                    (record.normals?.length ?? 0) +
                    record.indices.length +
                    (record.triangleToFace?.length ?? 0) +
                    (record.groups?.length ?? 0) * 3) *
                    4
            );
        case 'camera':
            return 3 * 4;
    }
}

function checkNormals(path: string, positions: Float32Array, normals: Float32Array | undefined): void {
    if (positions.length % 3 !== 0) {
        throw new FrameFormatError(`'${path}': positions length ${positions.length} is not a multiple of 3`);
    }
    if (normals && normals.length !== positions.length) {
        throw new FrameFormatError(`'${path}': ${normals.length} normal values for ${positions.length} positions`);
    }
}

/**
 * Writes frames in the binary format. encodeFrames() uses this in Node; it is exported for apps
 * that build records themselves.
 */
export function writeFrames(frames: readonly DecodedFrame[]): ArrayBuffer {
    if (frames.length > 0xffff) {
        throw new FrameFormatError(`At most 65535 frames per buffer, got ${frames.length}`);
    }
    const encoder = new TextEncoder();
    const encoded = frames.map((frame) =>
        [...frame.objects].map(([path, record]) => {
            const pathBytes = encoder.encode(path);
            if (pathBytes.length > 0xffff) {
                throw new FrameFormatError(`Object path is longer than 65535 bytes: '${path.slice(0, 80)}...'`);
            }
            if (record.kind === 'deform' || record.kind === 'mesh') {
                checkNormals(path, record.positions, record.normals);
            }
            if (
                record.kind === 'mesh' &&
                record.triangleToFace &&
                record.triangleToFace.length * 3 !== record.indices.length
            ) {
                throw new FrameFormatError(`'${path}': triangleToFace needs one value per triangle`);
            }
            if (record.kind === 'transform' && record.matrix.length !== 16) {
                throw new FrameFormatError(`'${path}': a matrix has 16 values, got ${record.matrix.length}`);
            }
            return { pathBytes, record, payload: payloadLength(record) };
        }),
    );

    let size = 8;
    for (const records of encoded) {
        size += 12;
        for (const { pathBytes, payload } of records) {
            size = align4(size + 2 + pathBytes.length + 1 + 4) + payload;
        }
    }

    const buffer = new ArrayBuffer(size);
    const view = new DataView(buffer);
    const bytes = new Uint8Array(buffer);
    let offset = 0;
    const u32 = (value: number) => {
        view.setUint32(offset, value, true);
        offset += 4;
    };
    const f32s = (values: ArrayLike<number>) => {
        new Float32Array(buffer, offset, values.length).set(values);
        offset += values.length * 4;
    };
    const u32s = (values: ArrayLike<number>) => {
        new Uint32Array(buffer, offset, values.length).set(values);
        offset += values.length * 4;
    };

    bytes.set(encoder.encode(FRAME_MAGIC), 0);
    view.setUint16(4, FRAME_FORMAT_VERSION, true);
    view.setUint16(6, frames.length, true);
    offset = 8;
    frames.forEach((frame, f) => {
        view.setFloat64(offset, frame.time, true);
        view.setUint32(offset + 8, encoded[f].length, true);
        offset += 12;
        for (const { pathBytes, record, payload } of encoded[f]) {
            view.setUint16(offset, pathBytes.length, true);
            bytes.set(pathBytes, offset + 2);
            offset += 2 + pathBytes.length;
            view.setUint8(offset, RECORD_KINDS[record.kind]);
            view.setUint32(offset + 1, payload, true);
            offset = align4(offset + 5); // the padding bytes stay zero
            switch (record.kind) {
                case 'transform':
                    f32s(record.matrix);
                    break;
                case 'deform':
                    u32(record.normals ? FLAG_NORMALS : 0);
                    u32(record.positions.length / 3);
                    f32s(record.positions);
                    if (record.normals) f32s(record.normals);
                    break;
                case 'mesh': {
                    const flags =
                        (record.normals ? FLAG_NORMALS : 0) |
                        (record.triangleToFace ? FLAG_TRIANGLE_TO_FACE : 0) |
                        (record.groups ? FLAG_GROUPS : 0);
                    u32(flags);
                    u32(record.positions.length / 3);
                    u32(record.indices.length);
                    u32(record.groups?.length ?? 0);
                    f32s(record.positions);
                    if (record.normals) f32s(record.normals);
                    u32s(record.indices);
                    if (record.triangleToFace) u32s(record.triangleToFace);
                    for (const group of record.groups ?? []) {
                        u32s([group.start, group.count, group.materialIndex]);
                    }
                    break;
                }
                case 'camera':
                    f32s([record.fov, record.near, record.far]);
                    break;
            }
        }
    });
    return buffer;
}

/**
 * Reads frames written by encodeFrames()/writeFrames(). Arrays are views into `buffer`, so keep the
 * buffer alive (and unmodified) as long as the records are used. Records of unknown kinds (from a
 * newer encoder) are skipped.
 */
export function decodeFrames(buffer: ArrayBuffer | ArrayBufferView): DecodedFrame[] {
    if (ArrayBuffer.isView(buffer)) {
        // Views (e.g. a Node Buffer) may start at an unaligned offset: copy them into a fresh buffer.
        const view = buffer;
        buffer =
            view.byteOffset === 0 && view.byteLength === view.buffer.byteLength && view.buffer instanceof ArrayBuffer
                ? view.buffer
                : new Uint8Array(view.buffer, view.byteOffset, view.byteLength).slice().buffer;
    }
    const data = buffer as ArrayBuffer;
    const view = new DataView(data);
    const decoder = new TextDecoder();
    const fail = (message: string): never => {
        throw new FrameFormatError(message);
    };
    if (data.byteLength < 8 || decoder.decode(new Uint8Array(data, 0, 4)) !== FRAME_MAGIC) {
        fail("Not an alembic-js frame buffer (missing 'ABCF' magic)");
    }
    const version = view.getUint16(4, true);
    if (version !== FRAME_FORMAT_VERSION) {
        fail(`Unsupported frame format version ${version} (this decoder reads version ${FRAME_FORMAT_VERSION})`);
    }
    const need = (offset: number, length: number) => {
        if (offset + length > data.byteLength) fail(`Truncated frame buffer at byte ${offset}`);
    };

    const frameCount = view.getUint16(6, true);
    const frames: DecodedFrame[] = [];
    let offset = 8;
    for (let f = 0; f < frameCount; f++) {
        need(offset, 12);
        const time = view.getFloat64(offset, true);
        const recordCount = view.getUint32(offset + 8, true);
        offset += 12;
        const objects = new Map<string, FrameRecord>();
        for (let r = 0; r < recordCount; r++) {
            need(offset, 2);
            const pathLength = view.getUint16(offset, true);
            need(offset + 2, pathLength + 5);
            const path = decoder.decode(new Uint8Array(data, offset + 2, pathLength));
            offset += 2 + pathLength;
            const kind = view.getUint8(offset);
            const length = view.getUint32(offset + 1, true);
            offset = align4(offset + 5);
            need(offset, length);
            const end = offset + length;
            let p = offset;
            const u32 = () => {
                const value = view.getUint32(p, true);
                p += 4;
                return value;
            };
            const f32s = (count: number) => {
                if (p + count * 4 > end) fail(`Record '${path}' is shorter than its arrays`);
                const array = new Float32Array(data, p, count);
                p += count * 4;
                return array;
            };
            const u32s = (count: number) => {
                if (p + count * 4 > end) fail(`Record '${path}' is shorter than its arrays`);
                const array = new Uint32Array(data, p, count);
                p += count * 4;
                return array;
            };
            switch (kind) {
                case RECORD_KINDS.transform:
                    objects.set(path, { kind: 'transform', matrix: f32s(16) });
                    break;
                case RECORD_KINDS.deform: {
                    const flags = u32();
                    const vertexCount = u32();
                    const positions = f32s(vertexCount * 3);
                    const record: DeformRecord = { kind: 'deform', positions };
                    if (flags & FLAG_NORMALS) record.normals = f32s(vertexCount * 3);
                    objects.set(path, record);
                    break;
                }
                case RECORD_KINDS.mesh: {
                    const flags = u32();
                    const vertexCount = u32();
                    const indexCount = u32();
                    const groupCount = u32();
                    const positions = f32s(vertexCount * 3);
                    const normals = flags & FLAG_NORMALS ? f32s(vertexCount * 3) : undefined;
                    const record: MeshRecord = { kind: 'mesh', positions, indices: u32s(indexCount) };
                    if (normals) record.normals = normals;
                    if (flags & FLAG_TRIANGLE_TO_FACE) record.triangleToFace = u32s(indexCount / 3);
                    if (flags & FLAG_GROUPS) {
                        const raw = u32s(groupCount * 3);
                        record.groups = Array.from({ length: groupCount }, (_, g) => ({
                            start: raw[g * 3],
                            count: raw[g * 3 + 1],
                            materialIndex: raw[g * 3 + 2],
                        }));
                    }
                    objects.set(path, record);
                    break;
                }
                case RECORD_KINDS.camera: {
                    const [fov, near, far] = f32s(3);
                    objects.set(path, { kind: 'camera', fov, near, far });
                    break;
                }
                default:
                    break; // unknown kind: skip its payload
            }
            offset = end;
        }
        frames.push({ time, objects });
    }
    return frames;
}
