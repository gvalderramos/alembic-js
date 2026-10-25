/**
 * Animation helpers for three.js (spec 0004). Like the rest of the bridge, three is
 * passed in by the caller.
 *
 * ```ts
 * const root = buildThreeScene(file, THREE);
 * const player = new AbcPlayer(file, root, THREE, { mode: 'interpolate' });
 * renderer.setAnimationLoop((ms) => { player.update(clock.getDelta()); renderer.render(scene, camera); });
 * ```
 */
import type { AbcFile } from './AbcFile';
import { AlembicError } from './errors';
import { toBufferGeometry, toLineSegments, toPoints, type ThreeModule, type ThreeSceneOptions } from './three';
import type { AbcObject, SampleOptions } from './types';

type Ctor = new (...args: any[]) => any;

/** three.js classes needed by createTransformClip(), in addition to ThreeModule. */
export interface ThreeAnimationModule extends ThreeModule {
    AnimationClip: Ctor;
    VectorKeyframeTrack: Ctor;
    QuaternionKeyframeTrack: Ctor;
    Vector3: Ctor;
    Quaternion: Ctor;
}

export interface PlayerOptions extends Pick<SampleOptions, 'mode' | 'useVelocities' | 'velocityScale'> {
    /** Loop between startTime and endTime. Default true. */
    loop?: boolean;
    /** Playback speed multiplier. Default 1. */
    speed?: number;
}

interface Binding {
    object: AbcObject;
    node: any;
}

/** Options buildThreeScene() stored on the root, so frames are read with the same layout. */
function sceneOptions(root: any): ThreeSceneOptions {
    return (root.userData?.alembicSceneOptions as ThreeSceneOptions | undefined) ?? {};
}

/**
 * Plays an archive's animation on a scene built by buildThreeScene(): transforms, cameras,
 * points and curves are re-sampled, and mesh positions are updated in place (the geometry is
 * only rebuilt when the topology changes).
 */
export class AbcPlayer {
    readonly startTime: number;
    readonly endTime: number;
    /** Current time in seconds. */
    time: number;
    playing = true;

    private readonly bindings: Binding[] = [];
    private readonly options: PlayerOptions;

    constructor(
        private readonly file: AbcFile,
        private readonly root: any,
        private readonly THREE: ThreeModule,
        options: PlayerOptions = {},
    ) {
        this.options = { loop: true, speed: 1, ...options };
        const info = file.getInfo();
        this.startTime = info.startTime;
        this.endTime = info.endTime;
        this.time = info.startTime;
        root.traverse((node: any) => {
            const path = node.userData?.alembic?.path as string | undefined;
            const object = path ? file.getObject(path) : null;
            if (object?.animated) {
                this.bindings.push({ object, node });
            }
        });
    }

    get duration(): number {
        return this.endTime - this.startTime;
    }

    /** Paths of the animated objects the player updates. */
    get animatedPaths(): string[] {
        return this.bindings.map((binding) => binding.object.path);
    }

    play(): void {
        this.playing = true;
    }

    pause(): void {
        this.playing = false;
    }

    /** Advances by `deltaSeconds` (scaled by `speed`) and updates the scene, when playing. */
    update(deltaSeconds: number): void {
        if (!this.playing) {
            return;
        }
        let time = this.time + deltaSeconds * (this.options.speed ?? 1);
        if (time > this.endTime) {
            time =
                this.options.loop && this.duration > 0
                    ? this.startTime + ((time - this.startTime) % this.duration)
                    : this.endTime;
            if (!this.options.loop) {
                this.playing = false;
            }
        }
        this.setTime(time);
    }

    /** Samples every animated object at `seconds` and updates the scene. */
    setTime(seconds: number): void {
        this.time = seconds;
        const { mode, useVelocities, velocityScale } = this.options;
        const sample = { time: seconds, mode, useVelocities, velocityScale };
        const scene = sceneOptions(this.root);
        for (const { object, node } of this.bindings) {
            switch (object.type) {
                case 'xform': {
                    const m = new this.THREE.Matrix4().fromArray(this.file.getTransform(object.path, sample).local);
                    m.decompose(node.position, node.quaternion, node.scale);
                    break;
                }
                case 'mesh':
                case 'subd':
                    this.updateMesh(object, node, sample, scene);
                    break;
                case 'points':
                    this.replaceGeometry(
                        node,
                        toPoints(this.file.getPoints(object.path, sample), this.THREE, { material: node.material })
                            .geometry,
                    );
                    break;
                case 'curves':
                    this.replaceGeometry(
                        node,
                        toLineSegments(this.file.getCurves(object.path, sample), this.THREE, {
                            material: node.material,
                            segmentsPerSpan: scene.segmentsPerSpan,
                        }).geometry,
                    );
                    break;
                case 'camera': {
                    if (node.isPerspectiveCamera) {
                        const cam = this.file.getCamera(object.path, sample);
                        Object.assign(node, { fov: cam.fov, aspect: cam.aspect, near: cam.near, far: cam.far });
                        node.updateProjectionMatrix();
                    }
                    break;
                }
            }
        }
    }

    private updateMesh(object: AbcObject, node: any, sample: SampleOptions, scene: ThreeSceneOptions): void {
        const attributes = scene.attributes ?? ['Cd', 'Col', 'color', 'displayColor'];
        const geometry = node.geometry;
        const position = geometry.getAttribute('position');
        try {
            const frame = this.file.getMeshFrame(object.path, { ...sample, attributes, groupByFaceSet: true });
            if (frame.positions.length === position.array.length) {
                position.array.set(frame.positions);
                position.needsUpdate = true;
                const normal = geometry.getAttribute('normal');
                if (frame.normals && normal && frame.normals.length === normal.array.length) {
                    normal.array.set(frame.normals);
                    normal.needsUpdate = true;
                } else if (!frame.normals && scene.computeNormals !== false) {
                    geometry.computeVertexNormals();
                }
                geometry.computeBoundingSphere();
                return;
            }
        } catch (error) {
            if (!(error instanceof AlembicError && error.code === 'ERR_ABC_TOPOLOGY_CHANGED')) {
                throw error;
            }
        }
        // Topology changed: rebuild the geometry.
        const mesh = this.file.getMesh(object.path, {
            ...sample,
            attributes,
            groupByFaceSet: true,
            triangleToFace: scene.triangleToFace,
        });
        this.replaceGeometry(node, toBufferGeometry(mesh, this.THREE, scene));
        if (mesh.triangleToFace) {
            node.userData.alembic.triangleToFace = Array.from(mesh.triangleToFace);
        }
    }

    private replaceGeometry(node: any, geometry: any): void {
        node.geometry.dispose?.();
        node.geometry = geometry;
    }
}

/**
 * Bakes the animated transforms of a scene built by buildThreeScene() into an AnimationClip
 * (position, quaternion and scale tracks, bound by object uuid). Keys are at each object's
 * sample times, or every 1/fps seconds when `fps` is given. Times are in seconds, as in the file.
 */
export function createTransformClip(
    file: AbcFile,
    root: any,
    THREE: ThreeAnimationModule,
    options: { name?: string; fps?: number } & Pick<SampleOptions, 'mode'> = {},
): any {
    const info = file.getInfo();
    const tracks: any[] = [];
    root.traverse((node: any) => {
        const path = node.userData?.alembic?.path as string | undefined;
        const object = path ? file.getObject(path) : null;
        if (!object || object.type !== 'xform' || !object.animated || !object.timeSampling) {
            return;
        }
        const times = options.fps
            ? Array.from(
                  { length: Math.floor((info.endTime - info.startTime) * options.fps + 1e-6) + 1 },
                  (_, i) => info.startTime + i / options.fps!,
              )
            : Array.from(object.timeSampling.sampleTimes);
        const positions: number[] = [];
        const quaternions: number[] = [];
        const scales: number[] = [];
        const p = new THREE.Vector3();
        const q = new THREE.Quaternion();
        const s = new THREE.Vector3();
        for (const time of times) {
            const local = file.getTransform(object.path, { time, mode: options.mode ?? 'interpolate' }).local;
            new THREE.Matrix4().fromArray(local).decompose(p, q, s);
            positions.push(p.x, p.y, p.z);
            quaternions.push(q.x, q.y, q.z, q.w);
            scales.push(s.x, s.y, s.z);
        }
        tracks.push(
            new THREE.VectorKeyframeTrack(`${node.uuid}.position`, times, positions),
            new THREE.QuaternionKeyframeTrack(`${node.uuid}.quaternion`, times, quaternions),
            new THREE.VectorKeyframeTrack(`${node.uuid}.scale`, times, scales),
        );
    });
    return new THREE.AnimationClip(options.name ?? 'alembic', -1, tracks);
}
