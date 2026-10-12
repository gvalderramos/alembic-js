// Prints what alembic-js reads from an Alembic file and the three.js scene built from it.
//   node src/inspect.ts [file.abc]
import { AlembicError } from 'alembic-js';
import type * as THREE from 'three';

import { loadScene, resolveAbcPath } from './scene.ts';

const abcPath = resolveAbcPath(process.argv[2]);

try {
    const { file, root, box } = loadScene(abcPath);
    const info = file.getInfo();

    console.log(`File:        ${info.path}`);
    console.log(`Written by:  ${info.appName} (${info.libraryVersionString})`);
    console.log(`Written on:  ${info.whenWritten}`);
    console.log(
        `Objects:     ${info.objectCount}, animated: ${info.hasAnimation}, time ${info.startTime}s - ${info.endTime}s`,
    );

    console.log('\nHierarchy:');
    file.traverse((obj, depth) => {
        const extra = obj.numSamples > 1 ? ` [${obj.numSamples} samples${obj.animated ? ', animated' : ''}]` : '';
        console.log(`${'  '.repeat(depth + 1)}${obj.name} (${obj.type})${extra}`);
    });

    console.log('\nGeometry:');
    for (const mesh of file.getMeshes()) {
        const vertices = mesh.positions.length / 3;
        const triangles = mesh.indices.length / 3;
        const attrs = [mesh.normals && 'normals', mesh.uvs && 'uvs'].filter(Boolean).join(', ') || 'positions only';
        console.log(
            `  ${mesh.path}: ${mesh.faceCount} faces -> ${triangles} triangles, ${vertices} vertices (${attrs})`,
        );
    }

    for (const points of file.getAllPoints()) {
        const extra = [
            points.ids && 'ids',
            points.velocities && 'velocities',
            points.widths && `widths (${points.widthScope})`,
        ];
        console.log(
            `  ${points.path}: ${points.count} points (${extra.filter(Boolean).join(', ') || 'positions only'})`,
        );
    }
    for (const curves of file.getAllCurves()) {
        const kind = curves.curveType === 'linear' ? 'linear' : `${curves.curveType} ${curves.basis}`;
        const vertices = curves.positions.length / 3;
        console.log(
            `  ${curves.path}: ${curves.curveCount} ${kind} curves, ${vertices} control vertices${curves.periodic ? ', periodic' : ''}`,
        );
    }

    let meshCount = 0;
    let triangleCount = 0;
    root.traverse((node) => {
        const mesh = node as THREE.Mesh;
        if (mesh.isMesh) {
            meshCount++;
            triangleCount += (mesh.geometry.index?.count ?? 0) / 3;
        }
    });
    const fmt = (v: THREE.Vector3) =>
        v
            .toArray()
            .map((n) => n.toFixed(3))
            .join(', ');
    console.log('\nthree.js scene:');
    console.log(`  ${meshCount} THREE.Mesh, ${triangleCount} triangles`);
    console.log(`  bounding box min (${fmt(box.min)}) max (${fmt(box.max)})`);

    file.close();
} catch (error) {
    if (error instanceof AlembicError) {
        console.error(`${error.code}: ${error.message}`);
        process.exit(1);
    }
    throw error;
}
