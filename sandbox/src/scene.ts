// Shared helpers: open an .abc with alembic-js, turn it into a three.js scene,
// and serialize it to GLB so a browser can display it.
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { AbcFile, buildThreeScene } from 'alembic-js';
import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_ABC = path.resolve(here, '..', '..', 'resource', 'Ancient_Kettle.abc');

export function resolveAbcPath(arg: string | undefined): string {
    return arg ? path.resolve(arg) : DEFAULT_ABC;
}

/** `[file.abc] [--triangle-to-face]`: the .abc path, the shared flag, and the other arguments. */
export function parseArgs(args: string[]): { abcPath: string; triangleToFace: boolean; rest: string[] } {
    const rest = args.filter((arg) => arg !== '--triangle-to-face');
    return { abcPath: resolveAbcPath(rest[0]), triangleToFace: rest.length !== args.length, rest: rest.slice(1) };
}

export interface LoadedScene {
    file: AbcFile;
    root: THREE.Group;
    box: THREE.Box3;
}

export interface LoadOptions {
    /** Time the scene is built at; streamed frames are relative to it (encodeFrames' referenceTime). Default 0. */
    time?: number;
    /** Keep each mesh's triangleToFace in userData.alembic, and so in the GLB. Default false. */
    triangleToFace?: boolean;
}

export function loadScene(abcPath: string, { time = 0, triangleToFace = false }: LoadOptions = {}): LoadedScene {
    const file = AbcFile.open(abcPath);
    const brass = new THREE.MeshStandardMaterial({ color: 0xc8a165, metalness: 0.6, roughness: 0.35 });
    // Face sets get one material each: the AbcMaterial's base color when assigned, else a palette color.
    const palette = [0xe07a5f, 0x81b29a, 0xf2cc8f, 0x3d85c6, 0xb07cc6, 0x6cc4c4];
    let slotIndex = 0;
    const root = buildThreeScene(file, THREE, {
        time,
        triangleToFace,
        onError: (error, object) => console.warn(`Skipping ${object.path}: ${(error as Error).message}`),
        createMaterial: ({ material }) => {
            const params = material?.parameters['*.surface'] ?? Object.values(material?.parameters ?? {})[0];
            const base = (params?.base_color ?? params?.diffuse_color ?? params?.color) as number[] | undefined;
            const color = base
                ? new THREE.Color(base[0], base[1], base[2])
                : new THREE.Color(palette[slotIndex++ % palette.length]);
            return new THREE.MeshStandardMaterial({ color, roughness: 0.6 });
        },
    }) as THREE.Group;
    // Default materials show vertex colors (Cd/Col) when the file has them; use brass for the rest.
    root.traverse((node) => {
        const mesh = node as THREE.Mesh;
        if (mesh.isMesh && !Array.isArray(mesh.material) && !mesh.geometry.getAttribute('color')) mesh.material = brass;
    });
    root.name = path.basename(abcPath);
    root.updateMatrixWorld(true);
    const box = new THREE.Box3();
    root.traverse((node) => {
        const drawable = node as THREE.Mesh & THREE.Points & THREE.LineSegments;
        if (drawable.isMesh || drawable.isPoints || drawable.isLineSegments) box.expandByObject(node);
    });
    return { file, root, box };
}

// GLTFExporter reads Blobs through the browser-only FileReader API.
class NodeFileReader {
    result: ArrayBuffer | string | null = null;
    onloadend: (() => void) | null = null;

    readAsArrayBuffer(blob: Blob): void {
        blob.arrayBuffer().then((buffer) => {
            this.result = buffer;
            this.onloadend?.();
        });
    }

    readAsDataURL(blob: Blob): void {
        blob.arrayBuffer().then((buffer) => {
            this.result = `data:${blob.type || 'application/octet-stream'};base64,${Buffer.from(buffer).toString('base64')}`;
            this.onloadend?.();
        });
    }
}
(globalThis as Record<string, unknown>).FileReader ??= NodeFileReader;

// GLTFExporter writes userData as glTF extras, so userData.alembic.path (and triangleToFace, when
// requested) reaches the browser, where applyFrame() finds objects by path.
export async function toGlb(root: THREE.Object3D): Promise<Buffer> {
    // Cameras from the .abc are kept in the hierarchy but not exported; the viewer frames the model itself.
    const result = await new GLTFExporter().parseAsync(root, { binary: true, onlyVisible: false });
    return Buffer.from(result as ArrayBuffer);
}
