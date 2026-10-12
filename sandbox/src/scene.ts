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

export interface LoadedScene {
    file: AbcFile;
    root: THREE.Group;
    box: THREE.Box3;
}

export function loadScene(abcPath: string, time = 0): LoadedScene {
    const file = AbcFile.open(abcPath);
    const brass = new THREE.MeshStandardMaterial({ color: 0xc8a165, metalness: 0.6, roughness: 0.35 });
    // Default materials show vertex colors (Cd/Col) when the file has them; use brass for the rest.
    const root = buildThreeScene(file, THREE, { time }) as THREE.Group;
    root.traverse((node) => {
        const mesh = node as THREE.Mesh;
        if (mesh.isMesh && !mesh.geometry.getAttribute('color')) mesh.material = brass;
    });
    root.name = path.basename(abcPath);
    root.updateMatrixWorld(true);
    const box = new THREE.Box3();
    root.traverse((node) => {
        if ((node as THREE.Mesh).isMesh) box.expandByObject(node);
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

export async function toGlb(root: THREE.Object3D): Promise<Buffer> {
    // Cameras from the .abc are kept in the hierarchy but not exported; the viewer frames the model itself.
    const result = await new GLTFExporter().parseAsync(root, { binary: true, onlyVisible: false });
    return Buffer.from(result as ArrayBuffer);
}
