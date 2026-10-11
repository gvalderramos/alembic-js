import * as fs from 'fs';
import * as path from 'path';

import { AlembicError } from './errors';
import type { AbcCamera, AbcFileInfo, AbcMesh, AbcObject, AbcTransform } from './types';

/** Shape of the C++ `AbcArchive` class (addons/AbcArchive.cpp). */
export interface NativeArchive {
    open(): void;
    openAsync(): Promise<void>;
    isOpen(): boolean;
    close(): void;
    getInfo(): AbcFileInfo;
    getObjects(): AbcObject[];
    getMesh(objectPath: string, time?: number): AbcMesh;
    getTransform(objectPath: string, time?: number): AbcTransform;
    getCamera(objectPath: string, time?: number): AbcCamera;
}

interface NativeModule {
    AbcArchive: new (filePath: string) => NativeArchive;
}

const ADDON_FILE = path.join('build', 'alembic-js.node');

function findAddon(): string {
    const override = process.env.ALEMBIC_JS_NATIVE;
    if (override) {
        return override;
    }
    // Walk up from the compiled file (bin/ or bin-test/src/) to the package root.
    for (let dir = __dirname; ; dir = path.dirname(dir)) {
        const candidate = path.join(dir, ADDON_FILE);
        if (fs.existsSync(candidate)) {
            return candidate;
        }
        if (path.dirname(dir) === dir) {
            break;
        }
    }
    throw new AlembicError('ERR_ABC_NATIVE_MODULE',
        `Could not find the native addon (${ADDON_FILE}). Run "yarn build" in the alembic-js package.`);
}

let cached: NativeModule | undefined;

export function loadNative(): NativeModule {
    if (!cached) {
        const addonPath = findAddon();
        try {
            cached = require(addonPath) as NativeModule;
        } catch (error) {
            throw new AlembicError('ERR_ABC_NATIVE_MODULE',
                `Failed to load the native addon at ${addonPath}: ${(error as Error).message}`, { cause: error });
        }
    }
    return cached;
}
