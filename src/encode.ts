/**
 * Node side of frame streaming (spec 0008): samples animated objects and writes them in the binary
 * frame format read by `alembic-js/stream`.
 *
 * ```ts
 * const glb = await toGlb(buildThreeScene(file, THREE));           // sent once
 * const packet = await encodeFrames(file, [0, 1 / 24, 2 / 24]);    // sent per batch of frames
 * ```
 */
import type { AbcFile } from './AbcFile';
import { AlembicError } from './errors';
import { writeFrames, type DecodedFrame, type FrameRecord } from './stream/format';
import { DEFAULT_COLOR_ATTRIBUTES } from './three';
import type { AbcMesh, AbcObject, AbcObjectType, MeshOptions, SampleOptions } from './types';

export interface EncodeOptions {
    /**
     * Objects to include. Default: every animated xform, mesh, subd and camera, which is what
     * `AbcPlayer.animatedPaths` lists for a scene from buildThreeScene() (points and curves are
     * not in the format yet).
     */
    paths?: string[];
    /** Include normals in mesh records. Default true; without them applyFrame() recomputes normals. */
    normals?: boolean;
    mode?: SampleOptions['mode'];
    /**
     * The `attributes` option the scene was built with, so positions are in the same vertex layout.
     * Default: DEFAULT_COLOR_ATTRIBUTES, as in buildThreeScene().
     */
    attributes?: MeshOptions['attributes'];
    /** Add `triangleToFace` to 'mesh' records (topology changes). Default false. */
    triangleToFace?: boolean;
    /**
     * Time the scene was built at (buildThreeScene's `time`, default 0). 'deform' records are only
     * written for frames whose topology matches the mesh at this time; other frames get 'mesh' records.
     */
    referenceTime?: number;
}

const STREAMED_TYPES = new Set<AbcObjectType>(['xform', 'mesh', 'subd', 'camera']);

function sameIndices(a: Uint32Array, b: Uint32Array): boolean {
    if (a.length !== b.length) {
        return false;
    }
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) {
            return false;
        }
    }
    return true;
}

interface MeshStream {
    object: AbcObject;
    /** Topology of the mesh in the scene. */
    reference: { vertexCount: number; indices: Uint32Array };
}

/**
 * Samples `paths` at each time and writes the frames in the binary format (see decodeFrames()).
 * Meshes that keep the scene's topology become 'deform' records (positions and normals, read with
 * the per-frame path of spec 0004); a mesh whose topology differs becomes a full 'mesh' record.
 */
export async function encodeFrames(file: AbcFile, times: number[], options: EncodeOptions = {}): Promise<ArrayBuffer> {
    for (const time of times) {
        if (typeof time !== 'number' || !Number.isFinite(time)) {
            throw new AlembicError('ERR_ABC_INVALID_ARGUMENT', `encodeFrames expects finite times, got ${time}`, {
                file: file.path,
            });
        }
    }
    const objects = options.paths
        ? options.paths.map((objectPath) => {
              const object = file.getObject(objectPath);
              if (!object) {
                  throw new AlembicError(
                      'ERR_ABC_OBJECT_NOT_FOUND',
                      `Object '${objectPath}' does not exist in ${file.path}`,
                      { file: file.path, objectPath },
                  );
              }
              if (!STREAMED_TYPES.has(object.type)) {
                  throw new AlembicError(
                      'ERR_ABC_INVALID_ARGUMENT',
                      `encodeFrames streams xforms, meshes, subds and cameras; '${objectPath}' is a ${object.type}`,
                      { file: file.path, objectPath },
                  );
              }
              return object;
          })
        : file.getObjects().filter((object) => object.animated && STREAMED_TYPES.has(object.type));

    const { mode } = options;
    const withNormals = options.normals !== false;
    const meshOptions: MeshOptions = {
        attributes: options.attributes ?? DEFAULT_COLOR_ATTRIBUTES,
        groupByFaceSet: true,
    };

    // Read each mesh at the reference time: it gives the scene's topology and primes the per-frame path.
    const meshes = new Map<string, MeshStream>();
    for (const object of objects) {
        if (object.type === 'mesh' || object.type === 'subd') {
            const mesh = await file.getMeshAsync(object.path, { ...meshOptions, time: options.referenceTime ?? 0 });
            meshes.set(object.path, {
                object,
                reference: { vertexCount: mesh.positions.length / 3, indices: mesh.indices },
            });
        }
    }

    const fullRecord = (stream: MeshStream, mesh: AbcMesh): FrameRecord => {
        const normals = withNormals ? mesh.normals : undefined;
        if (
            mesh.positions.length / 3 === stream.reference.vertexCount &&
            sameIndices(mesh.indices, stream.reference.indices)
        ) {
            return { kind: 'deform', positions: mesh.positions, normals };
        }
        return {
            kind: 'mesh',
            positions: mesh.positions,
            normals,
            indices: mesh.indices,
            triangleToFace: options.triangleToFace ? mesh.triangleToFace : undefined,
            groups: mesh.groups?.map(({ start, count, materialIndex }) => ({ start, count, materialIndex })),
        };
    };

    const readMesh = async (stream: MeshStream, time: number): Promise<FrameRecord> => {
        const sample: MeshOptions = { ...meshOptions, time, mode };
        if (stream.object.topology !== 'heterogeneous') {
            try {
                const frame = await file.getMeshFrameAsync(stream.object.path, sample);
                if (frame.positions.length / 3 === stream.reference.vertexCount) {
                    return {
                        kind: 'deform',
                        positions: frame.positions,
                        normals: withNormals ? frame.normals : undefined,
                    };
                }
            } catch (error) {
                if (!(error instanceof AlembicError && error.code === 'ERR_ABC_TOPOLOGY_CHANGED')) {
                    throw error;
                }
            }
        }
        // The topology may change: read it and compare with the scene's.
        const mesh = await file.getMeshAsync(stream.object.path, {
            ...sample,
            triangleToFace: options.triangleToFace,
        });
        return fullRecord(stream, mesh);
    };

    const frames: DecodedFrame[] = [];
    for (const time of times) {
        const records = await Promise.all(
            objects.map(async (object): Promise<FrameRecord> => {
                switch (object.type) {
                    case 'mesh':
                    case 'subd':
                        return readMesh(meshes.get(object.path)!, time);
                    case 'camera': {
                        const camera = file.getCamera(object.path, { time, mode });
                        return { kind: 'camera', fov: camera.fov, near: camera.near, far: camera.far };
                    }
                    default:
                        return {
                            kind: 'transform',
                            matrix: Float32Array.from(file.getTransform(object.path, { time, mode }).local),
                        };
                }
            }),
        );
        frames.push({ time, objects: new Map(objects.map((object, i) => [object.path, records[i]])) });
    }
    return writeFrames(frames);
}
