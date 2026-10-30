import * as path from 'path';

import { AlembicError, wrapNativeError } from './errors';
import { loadNative, type NativeArchive, type NativeSampleOptions } from './native';
import type {
    AbcCamera,
    AbcCurves,
    AbcFaceSet,
    AbcFileInfo,
    AbcMaterial,
    AbcMesh,
    AbcMeshFrame,
    AbcObject,
    AbcPoints,
    AbcPropertyInfo,
    AbcTimeSampling,
    AbcTopology,
    AbcTopologyChange,
    AbcTransform,
    AbcUserProperties,
    AbcValue,
    MeshOptions,
    PropertyListOptions,
    PropertyReadOptions,
    SampleOptions,
    TopologyOptions,
} from './types';

function copyObject(obj: AbcObject): AbcObject {
    return { ...obj, children: [...obj.children] };
}

/**
 * A single Alembic archive.
 *
 * ```ts
 * const file = AbcFile.open('scene.abc');
 * for (const obj of file.getObjects()) console.log(obj.path, obj.type);
 * const mesh = file.getMesh('/Kettle/Circle');
 * file.close();
 * ```
 *
 * The native archive (and its file handle) stays open until `close()` is called.
 */
export class AbcFile {
    /** Absolute path of the archive. */
    readonly path: string;

    private readonly native: NativeArchive;
    private objects: AbcObject[] | null = null;
    private byPath = new Map<string, AbcObject>();

    constructor(filePath: string) {
        if (typeof filePath !== 'string' || filePath.trim() === '') {
            throw new AlembicError('ERR_ABC_INVALID_ARGUMENT', 'AbcFile expects a non-empty file path string');
        }
        this.path = path.resolve(filePath);
        const { AbcArchive } = loadNative();
        this.native = new AbcArchive(this.path);
    }

    /** Creates an AbcFile and loads it synchronously. */
    static open(filePath: string): AbcFile {
        const file = new AbcFile(filePath);
        file.load();
        return file;
    }

    /** Creates an AbcFile and loads it on a worker thread. */
    static async openAsync(filePath: string): Promise<AbcFile> {
        const file = new AbcFile(filePath);
        await file.loadAsync();
        return file;
    }

    /** Opens the archive and indexes its hierarchy. Throws AlembicError on failure. */
    load(): void {
        this.call(() => this.native.open());
        this.indexObjects();
    }

    /** Same as `load()` but the archive is read off the main thread. */
    async loadAsync(): Promise<void> {
        try {
            await this.native.openAsync();
        } catch (error) {
            throw wrapNativeError(error, { file: this.path });
        }
        this.indexObjects();
    }

    get isLoaded(): boolean {
        return this.native.isOpen();
    }

    /** Releases the native archive. The instance can be loaded again afterwards. */
    close(): void {
        this.native.close();
        this.objects = null;
        this.byPath.clear();
    }

    getInfo(): AbcFileInfo {
        const info = this.call(() => this.native.getInfo());
        if (info.fps) {
            info.frameRange = { start: info.startTime * info.fps, end: info.endTime * info.fps };
        }
        return info;
    }

    /** Time sampling of an object, or undefined for objects without samples. */
    getTimeSampling(objectPath: string): AbcTimeSampling | undefined {
        const obj = this.getObject(objectPath);
        if (!obj) {
            throw new AlembicError(
                'ERR_ABC_OBJECT_NOT_FOUND',
                `Object '${objectPath}' does not exist in ${this.path}`,
                {
                    file: this.path,
                    objectPath,
                },
            );
        }
        return obj.timeSampling;
    }

    /** Every object in the archive, depth-first. */
    getObjects(): AbcObject[] {
        return this.requireObjects().map(copyObject);
    }

    /** Direct children of `parentPath`, or the top-level objects when omitted. */
    getChildren(parentPath?: string): AbcObject[] {
        const objects = this.requireObjects();
        if (parentPath === undefined || parentPath === '/') {
            return objects.filter((obj) => obj.parent === undefined).map(copyObject);
        }
        const parent = this.byPath.get(parentPath);
        if (!parent) {
            throw new AlembicError(
                'ERR_ABC_OBJECT_NOT_FOUND',
                `Object '${parentPath}' does not exist in ${this.path}`,
                { file: this.path, objectPath: parentPath },
            );
        }
        return parent.children.map((child) => copyObject(this.byPath.get(child)!));
    }

    /** Looks an object up by its full path; returns null when it does not exist. */
    getObject(objectPath: string): AbcObject | null {
        this.requireObjects();
        const obj = this.byPath.get(objectPath);
        return obj ? copyObject(obj) : null;
    }

    /** Visits every object depth-first. Return `false` from the visitor to skip an object's children. */
    traverse(visitor: (obj: AbcObject, depth: number) => void | boolean): void {
        const walk = (obj: AbcObject, depth: number) => {
            if (visitor(copyObject(obj), depth) === false) {
                return;
            }
            for (const child of obj.children) {
                walk(this.byPath.get(child)!, depth + 1);
            }
        };
        for (const top of this.requireObjects().filter((obj) => obj.parent === undefined)) {
            walk(top, 0);
        }
    }

    /** Triangulated geometry of a 'mesh' or 'subd' object. */
    getMesh(objectPath: string, options: MeshOptions = {}): AbcMesh {
        const [time, sample] = this.sample(options);
        const { attributes, layout, groupByFaceSet, triangleToFace } = options;
        return this.call(
            () =>
                this.native.getMesh(objectPath, time, {
                    ...sample,
                    attributes,
                    layout,
                    groupByFaceSet,
                    triangleToFace,
                }),
            objectPath,
        );
    }

    /** Same as getMesh() but read on a worker thread. */
    async getMeshAsync(objectPath: string, options: MeshOptions = {}): Promise<AbcMesh> {
        const [time, sample] = this.sample(options);
        const { attributes, layout, groupByFaceSet, triangleToFace } = options;
        try {
            return await this.native.getMeshAsync(objectPath, time, {
                ...sample,
                attributes,
                layout,
                groupByFaceSet,
                triangleToFace,
            });
        } catch (error) {
            throw wrapNativeError(error, { file: this.path, objectPath });
        }
    }

    /**
     * Positions (and normals and requested attributes) at a time, in the vertex layout of the last
     * getMesh() with the same `attributes`/`layout` options, skipping triangulation. Throws
     * ERR_ABC_TOPOLOGY_CHANGED when the topology differs; call getMesh() again then.
     */
    getMeshFrame(objectPath: string, options: MeshOptions = {}): AbcMeshFrame {
        const [time, sample] = this.sample(options);
        const { attributes, layout, groupByFaceSet, triangleToFace } = options;
        return this.call(
            () =>
                this.native.getMeshFrame(objectPath, time, {
                    ...sample,
                    attributes,
                    layout,
                    groupByFaceSet,
                    triangleToFace,
                }),
            objectPath,
        );
    }

    /** Same as getMeshFrame() but read on a worker thread. */
    async getMeshFrameAsync(objectPath: string, options: MeshOptions = {}): Promise<AbcMeshFrame> {
        const [time, sample] = this.sample(options);
        const { attributes, layout, groupByFaceSet, triangleToFace } = options;
        try {
            return await this.native.getMeshFrameAsync(objectPath, time, {
                ...sample,
                attributes,
                layout,
                groupByFaceSet,
                triangleToFace,
            });
        } catch (error) {
            throw wrapNativeError(error, { file: this.path, objectPath });
        }
    }

    /**
     * Point, face and corner counts and the topology hash of a 'mesh' or 'subd' at a time (spec 0009),
     * without triangulating. `faces: true` also returns the raw face arrays. Throws
     * ERR_ABC_INVALID_ARGUMENT for other object types.
     */
    getTopology(objectPath: string, options: TopologyOptions = {}): AbcTopology {
        const [time, sample] = this.sample(options);
        return this.call(
            () => this.native.getTopology(objectPath, time, { ...sample, faces: options.faces }),
            objectPath,
        );
    }

    /** Same as getTopology() but read on a worker thread. */
    async getTopologyAsync(objectPath: string, options: TopologyOptions = {}): Promise<AbcTopology> {
        const [time, sample] = this.sample(options);
        try {
            return await this.native.getTopologyAsync(objectPath, time, { ...sample, faces: options.faces });
        } catch (error) {
            throw wrapNativeError(error, { file: this.path, objectPath });
        }
    }

    /**
     * The samples at which a mesh's topology changes: one entry for the first sample and one for every
     * sample whose hash or point count differs from the previous one. Constant and homogeneous meshes
     * cost one read; changing meshes are walked by array digest and hashed only when the faces change.
     */
    async getTopologyChanges(objectPath: string): Promise<AbcTopologyChange[]> {
        try {
            return await this.native.getTopologyChanges(objectPath);
        } catch (error) {
            throw wrapNativeError(error, { file: this.path, objectPath });
        }
    }

    /** Geometry of every mesh/subd object in the archive. */
    getMeshes(options: MeshOptions = {}): AbcMesh[] {
        return this.requireObjects()
            .filter((obj) => obj.type === 'mesh' || obj.type === 'subd')
            .map((obj) => this.getMesh(obj.path, options));
    }

    /** Local and world matrices of any object (local is identity for non-xform objects). */
    getTransform(objectPath: string, options: SampleOptions = {}): AbcTransform {
        const [time, sample] = this.sample(options);
        return this.call(() => this.native.getTransform(objectPath, time, sample), objectPath);
    }

    getCamera(objectPath: string, options: SampleOptions = {}): AbcCamera {
        const [time, sample] = this.sample(options);
        return this.call(() => this.native.getCamera(objectPath, time, sample), objectPath);
    }

    /** Points of a 'points' object (particles, point clouds). */
    getPoints(objectPath: string, options: SampleOptions = {}): AbcPoints {
        const [time, sample] = this.sample(options);
        return this.call(() => this.native.getPoints(objectPath, time, sample), objectPath);
    }

    /** Every 'points' object in the archive. */
    getAllPoints(options: SampleOptions = {}): AbcPoints[] {
        return this.requireObjects()
            .filter((obj) => obj.type === 'points')
            .map((obj) => this.getPoints(obj.path, options));
    }

    /** Control vertices and curve data of a 'curves' object (use tessellateCurves() to evaluate them). */
    getCurves(objectPath: string, options: SampleOptions = {}): AbcCurves {
        const [time, sample] = this.sample(options);
        return this.call(() => this.native.getCurves(objectPath, time, sample), objectPath);
    }

    /** Every 'curves' object in the archive. */
    getAllCurves(options: SampleOptions = {}): AbcCurves[] {
        return this.requireObjects()
            .filter((obj) => obj.type === 'curves')
            .map((obj) => this.getCurves(obj.path, options));
    }

    /** Face sets of a mesh or subd (spec 0003). */
    getFaceSets(objectPath: string, options: SampleOptions = {}): AbcFaceSet[] {
        const [time, sample] = this.sample(options);
        return this.call(() => this.native.getFaceSets(objectPath, time, sample), objectPath);
    }

    /** AbcMaterial assignment of an object, inherited from its ancestors; null when there is none. */
    getMaterialAssignment(objectPath: string): string | null {
        return this.call(() => this.native.getMaterialAssignment(objectPath), objectPath);
    }

    /** An AbcMaterial object (or an object with a local material), flattened with its parents. */
    getMaterial(materialPath: string): AbcMaterial {
        return this.call(() => this.native.getMaterial(materialPath), materialPath);
    }

    /** Every material object in the archive. */
    getMaterials(): AbcMaterial[] {
        return this.requireObjects()
            .filter((obj) => obj.type === 'material')
            .map((obj) => this.getMaterial(obj.path));
    }

    /** Lists an object's properties without reading their values. */
    getProperties(objectPath: string, options: PropertyListOptions = {}): AbcPropertyInfo[] {
        const { root, recursive, time } = options;
        return this.call(() => this.native.getProperties(objectPath, root, recursive, time), objectPath, root);
    }

    /** Geometry attributes (`.arbGeomParams`) of a mesh, points or curves object. */
    getAttributes(objectPath: string, options: SampleOptions = {}): AbcPropertyInfo[] {
        try {
            return this.getProperties(objectPath, { ...options, root: '.arbGeomParams' });
        } catch (error) {
            if (error instanceof AlembicError && error.code === 'ERR_ABC_PROPERTY_NOT_FOUND') {
                return [];
            }
            throw error;
        }
    }

    /**
     * Reads one property, e.g. `getProperty('/geo/shape', '.arbGeomParams/Cd')`. The shortcuts
     * `.arbGeomParams/...` and `.userProperties/...` are resolved inside the object's schema.
     */
    getProperty(objectPath: string, propertyPath: string, options: PropertyReadOptions = {}): AbcValue {
        const { time, expand } = options;
        return this.call(
            () => this.native.getProperty(objectPath, propertyPath, time, expand),
            objectPath,
            propertyPath,
        );
    }

    /** User properties as a plain object; one-element arrays (as written by Blender) are unwrapped. */
    getUserProperties(objectPath: string, options: SampleOptions = {}): AbcUserProperties {
        return this.call(() => this.native.getUserProperties(objectPath, options.time), objectPath);
    }

    /** Resolves `time`/`frame` and the sample options passed to native readers. */
    private sample(options: SampleOptions): [number | undefined, NativeSampleOptions] {
        let time = options.time;
        if (options.frame !== undefined) {
            if (time !== undefined) {
                throw new AlembicError('ERR_ABC_INVALID_ARGUMENT', 'Pass either `time` or `frame`, not both', {
                    file: this.path,
                });
            }
            const fps = this.getInfo().fps;
            if (!fps) {
                throw new AlembicError(
                    'ERR_ABC_INVALID_ARGUMENT',
                    `'${this.path}' has no uniform frame rate; pass \`time\` (seconds) instead of \`frame\``,
                    { file: this.path },
                );
            }
            time = options.frame / fps;
        }
        const { mode, useVelocities, velocityScale } = options;
        return [time, { mode, useVelocities, velocityScale }];
    }

    private indexObjects(): void {
        this.objects = this.call(() => this.native.getObjects());
        this.byPath = new Map(this.objects.map((obj) => [obj.path, obj]));
    }

    private requireObjects(): AbcObject[] {
        if (!this.objects) {
            throw new AlembicError('ERR_ABC_NOT_LOADED', `Archive '${this.path}' is not loaded; call load() first`, {
                file: this.path,
            });
        }
        return this.objects;
    }

    private call<T>(fn: () => T, objectPath?: string, propertyPath?: string): T {
        try {
            return fn();
        } catch (error) {
            throw wrapNativeError(error, { file: this.path, objectPath, propertyPath });
        }
    }
}
