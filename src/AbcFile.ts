import * as path from 'path';

import { AlembicError, wrapNativeError } from './errors';
import { loadNative, type NativeArchive } from './native';
import type { AbcCamera, AbcFileInfo, AbcMesh, AbcObject, AbcTransform, SampleOptions } from './types';

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
        return this.call(() => this.native.getInfo());
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
            throw new AlembicError('ERR_ABC_OBJECT_NOT_FOUND', `Object '${parentPath}' does not exist in ${this.path}`,
                { file: this.path, objectPath: parentPath });
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
    getMesh(objectPath: string, options: SampleOptions = {}): AbcMesh {
        return this.call(() => this.native.getMesh(objectPath, options.time), objectPath);
    }

    /** Geometry of every mesh/subd object in the archive. */
    getMeshes(options: SampleOptions = {}): AbcMesh[] {
        return this.requireObjects()
            .filter((obj) => obj.type === 'mesh' || obj.type === 'subd')
            .map((obj) => this.getMesh(obj.path, options));
    }

    /** Local and world matrices of any object (local is identity for non-xform objects). */
    getTransform(objectPath: string, options: SampleOptions = {}): AbcTransform {
        return this.call(() => this.native.getTransform(objectPath, options.time), objectPath);
    }

    getCamera(objectPath: string, options: SampleOptions = {}): AbcCamera {
        return this.call(() => this.native.getCamera(objectPath, options.time), objectPath);
    }

    private indexObjects(): void {
        this.objects = this.call(() => this.native.getObjects());
        this.byPath = new Map(this.objects.map((obj) => [obj.path, obj]));
    }

    private requireObjects(): AbcObject[] {
        if (!this.objects) {
            throw new AlembicError('ERR_ABC_NOT_LOADED', `Archive '${this.path}' is not loaded; call load() first`,
                { file: this.path });
        }
        return this.objects;
    }

    private call<T>(fn: () => T, objectPath?: string): T {
        try {
            return fn();
        } catch (error) {
            throw wrapNativeError(error, { file: this.path, objectPath });
        }
    }
}
