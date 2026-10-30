import * as fs from 'fs';
import * as path from 'path';

import { AlembicError } from './errors';
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
    AbcTopology,
    AbcTopologyChange,
    AbcTransform,
    AbcUserProperties,
    AbcValue,
} from './types';

export interface NativeSampleOptions {
    mode?: 'near' | 'floor' | 'interpolate';
    useVelocities?: boolean;
    velocityScale?: number;
}

export interface NativeMeshOptions extends NativeSampleOptions {
    attributes?: string[] | '*';
    layout?: string;
    groupByFaceSet?: boolean;
    triangleToFace?: boolean;
    vertexToPoint?: boolean;
}

export interface NativeTopologyOptions extends NativeSampleOptions {
    faces?: boolean;
}

/** Shape of the C++ `AbcArchive` class (addons/AbcArchive.cpp). */
export interface NativeArchive {
    open(): void;
    openAsync(): Promise<void>;
    isOpen(): boolean;
    close(): void;
    getInfo(): AbcFileInfo;
    getObjects(): AbcObject[];
    getMesh(objectPath: string, time?: number, options?: NativeMeshOptions): AbcMesh;
    getMeshFrame(objectPath: string, time?: number, options?: NativeMeshOptions): AbcMeshFrame;
    getMeshAsync(objectPath: string, time?: number, options?: NativeMeshOptions): Promise<AbcMesh>;
    getMeshFrameAsync(objectPath: string, time?: number, options?: NativeMeshOptions): Promise<AbcMeshFrame>;
    getTopology(objectPath: string, time?: number, options?: NativeTopologyOptions): AbcTopology;
    getTopologyAsync(objectPath: string, time?: number, options?: NativeTopologyOptions): Promise<AbcTopology>;
    getTopologyChanges(objectPath: string): Promise<AbcTopologyChange[]>;
    /** Internal counters for tests. */
    getDebugStats(): { topologyHashReads: number };
    getPoints(objectPath: string, time?: number, options?: NativeSampleOptions): AbcPoints;
    getCurves(objectPath: string, time?: number, options?: NativeSampleOptions): AbcCurves;
    getFaceSets(objectPath: string, time?: number, options?: NativeSampleOptions): AbcFaceSet[];
    getMaterialAssignment(objectPath: string): string | null;
    getMaterial(objectPath: string): AbcMaterial;
    getProperties(objectPath: string, root?: string, recursive?: boolean, time?: number): AbcPropertyInfo[];
    getProperty(objectPath: string, propertyPath: string, time?: number, expand?: boolean): AbcValue;
    getUserProperties(objectPath: string, time?: number): AbcUserProperties;
    getTransform(objectPath: string, time?: number, options?: NativeSampleOptions): AbcTransform;
    getCamera(objectPath: string, time?: number, options?: NativeSampleOptions): AbcCamera;
}

interface NativeModule {
    AbcArchive: new (filePath: string) => NativeArchive;
}

export type Libc = 'glibc' | 'musl' | undefined;

export interface Target {
    platform: string;
    arch: string;
    /** Linux only. */
    libc?: Libc;
}

/** Detects the C library on Linux: Alpine and other musl distros need the `-musl` prebuilds. */
export function detectLibc(
    report: { header?: { glibcVersionRuntime?: string } } | null = (process.report?.getReport() as {
        header?: { glibcVersionRuntime?: string };
    }) ?? null,
    lddContents: () => string | undefined = () => {
        try {
            return fs.readFileSync('/usr/bin/ldd', 'utf8');
        } catch {
            return undefined;
        }
    },
): Libc {
    if (report?.header?.glibcVersionRuntime) {
        return 'glibc';
    }
    // Same fallback as detect-libc: musl's ldd mentions musl.
    const ldd = lddContents();
    if (ldd !== undefined) {
        return ldd.includes('musl') ? 'musl' : 'glibc';
    }
    return report ? 'musl' : undefined;
}

/** Name of the prebuild directory for a target, e.g. "linux-x64", "linux-arm64-musl", "win32-x64". */
export function prebuildName(target: Target): string {
    const base = `${target.platform}-${target.arch}`;
    return target.platform === 'linux' && target.libc === 'musl' ? `${base}-musl` : base;
}

/** Files to try, relative to the package root. A local `yarn build` wins over prebuilt binaries. */
export function addonCandidates(target: Target): string[] {
    return [path.join('build', 'alembic-js.node'), path.join('prebuilds', prebuildName(target), 'alembic-js.node')];
}

/** Package root: the closest ancestor of `from` that contains package.json. */
function packageRoot(from: string): string {
    for (let dir = from; ; dir = path.dirname(dir)) {
        if (fs.existsSync(path.join(dir, 'package.json'))) {
            return dir;
        }
        if (path.dirname(dir) === dir) {
            return from;
        }
    }
}

/** Locates the addon for `target`, walking up from `from`; throws an actionable error when none exists. */
export function findAddon(target: Target, from: string = __dirname, env: NodeJS.ProcessEnv = process.env): string {
    const override = env.ALEMBIC_JS_NATIVE;
    if (override) {
        return override;
    }
    const files = addonCandidates(target);
    for (let dir = from; ; dir = path.dirname(dir)) {
        for (const file of files) {
            const candidate = path.join(dir, file);
            if (fs.existsSync(candidate)) {
                return candidate;
            }
        }
        if (path.dirname(dir) === dir) {
            break;
        }
    }
    const root = packageRoot(from);
    let available: string[] = [];
    try {
        available = fs.readdirSync(path.join(root, 'prebuilds')).sort();
    } catch {
        // no prebuilds directory (e.g. a git checkout)
    }
    throw new AlembicError(
        'ERR_ABC_NATIVE_MODULE',
        `No alembic-js native addon for ${prebuildName(target)} (Node-API ${process.versions.napi}). ` +
            (available.length > 0 ? `Prebuilt binaries exist for: ${available.join(', ')}. ` : '') +
            'Build it from source: set ALEMBIC_JS_BUILD_FROM_SOURCE=1 and reinstall, or run "yarn build" in a ' +
            'checkout (needs CMake, a C++17 compiler and the Alembic SDK). ' +
            'See https://github.com/gvalderramos/alembic-js#build-from-source',
    );
}

export function currentTarget(): Target {
    return {
        platform: process.platform,
        arch: process.arch,
        libc: process.platform === 'linux' ? detectLibc() : undefined,
    };
}

let cached: NativeModule | undefined;

export function loadNative(): NativeModule {
    if (!cached) {
        const addonPath = findAddon(currentTarget());
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
