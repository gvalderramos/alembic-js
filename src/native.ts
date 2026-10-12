import * as fs from 'fs';
import * as path from 'path';

import { AlembicError } from './errors';
import type {
    AbcCamera,
    AbcCurves,
    AbcFileInfo,
    AbcMesh,
    AbcObject,
    AbcPoints,
    AbcPropertyInfo,
    AbcTransform,
    AbcUserProperties,
    AbcValue,
} from './types';

/** Shape of the C++ `AbcArchive` class (addons/AbcArchive.cpp). */
export interface NativeArchive {
    open(): void;
    openAsync(): Promise<void>;
    isOpen(): boolean;
    close(): void;
    getInfo(): AbcFileInfo;
    getObjects(): AbcObject[];
    getMesh(objectPath: string, time?: number, options?: { attributes?: string[] | '*'; layout?: string }): AbcMesh;
    getPoints(objectPath: string, time?: number): AbcPoints;
    getCurves(objectPath: string, time?: number): AbcCurves;
    getProperties(objectPath: string, root?: string, recursive?: boolean, time?: number): AbcPropertyInfo[];
    getProperty(objectPath: string, propertyPath: string, time?: number, expand?: boolean): AbcValue;
    getUserProperties(objectPath: string, time?: number): AbcUserProperties;
    getTransform(objectPath: string, time?: number): AbcTransform;
    getCamera(objectPath: string, time?: number): AbcCamera;
}

interface NativeModule {
    AbcArchive: new (filePath: string) => NativeArchive;
}

// A local `yarn build` wins over the prebuilt binary shipped in release packages.
const ADDON_FILES = [
    path.join('build', 'alembic-js.node'),
    path.join('prebuilds', `${process.platform}-${process.arch}`, 'alembic-js.node'),
];

function findAddon(): string {
    const override = process.env.ALEMBIC_JS_NATIVE;
    if (override) {
        return override;
    }
    // Walk up from the compiled file (bin/ or bin-test/src/) to the package root.
    for (let dir = __dirname; ; dir = path.dirname(dir)) {
        for (const file of ADDON_FILES) {
            const candidate = path.join(dir, file);
            if (fs.existsSync(candidate)) {
                return candidate;
            }
        }
        if (path.dirname(dir) === dir) {
            break;
        }
    }
    throw new AlembicError(
        'ERR_ABC_NATIVE_MODULE',
        `No native addon for ${process.platform}-${process.arch} (looked for ${ADDON_FILES.join(', ')}). ` +
            'Run "yarn build" in the alembic-js package.',
    );
}

let cached: NativeModule | undefined;

export function loadNative(): NativeModule {
    if (!cached) {
        const addonPath = findAddon();
        try {
            // eslint-disable-next-line @typescript-eslint/no-require-imports -- loading a native addon by absolute path
            cached = require(addonPath) as NativeModule;
        } catch (error) {
            throw new AlembicError(
                'ERR_ABC_NATIVE_MODULE',
                `Failed to load the native addon at ${addonPath}: ${(error as Error).message}`,
                { cause: error },
            );
        }
    }
    return cached;
}
