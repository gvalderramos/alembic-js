// Spec 0009: data for comparing caches (vertexToPoint, attribute records, encoder velocities).
import * as assert from 'assert/strict';
import * as path from 'path';
import { after, before, describe, it } from 'node:test';
import * as THREE from 'three';

import { AbcFile, applyFrame, buildThreeScene, getVertexToPoint, type AbcArrayValue } from '../src';
import { fixture, repoRoot } from './helpers';

const blender = (name: string) => path.join(repoRoot, 'resource', 'blender', name);

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- three.js nodes
function nodeAt(root: THREE.Object3D, objectPath: string): any {
    let found: THREE.Object3D | undefined;
    root.traverse((node) => {
        if (node.userData.alembic?.path === objectPath) found = node;
    });
    assert.ok(found, objectPath);
    return found;
}

/** positions[v] must equal points[vertexToPoint[v]] for every vertex. */
function assertExpands(positions: Float32Array, points: ArrayLike<number>, vertexToPoint: Uint32Array): void {
    assert.equal(vertexToPoint.length * 3, positions.length);
    for (let v = 0; v < vertexToPoint.length; v++) {
        const p = vertexToPoint[v];
        for (let c = 0; c < 3; c++) {
            if (positions[v * 3 + c] !== points[p * 3 + c]) {
                assert.fail(`vertex ${v} (point ${p}) component ${c}: ${positions[v * 3 + c]} != ${points[p * 3 + c]}`);
            }
        }
    }
}

describe('vertexToPoint', () => {
    let file: AbcFile;
    before(() => {
        file = AbcFile.open(fixture('animation'));
    });
    after(() => file.close());

    it('is only returned when asked', () => {
        assert.equal(file.getMesh('/wave/waveShape').vertexToPoint, undefined);
    });

    it("is the identity for layout 'points'", () => {
        const mesh = file.getMesh('/wave/waveShape', { vertexToPoint: true });
        assert.equal(mesh.layout, 'points');
        assert.ok(mesh.vertexToPoint instanceof Uint32Array);
        assert.deepEqual(
            Array.from(mesh.vertexToPoint),
            Array.from({ length: 16 }, (_, i) => i),
        );
    });

    it("maps every corner to its point for layout 'corners'", () => {
        const points = file.getMesh('/wave/waveShape', { time: 3 / 24 });
        const corners = file.getMesh('/wave/waveShape', { time: 3 / 24, layout: 'corners', vertexToPoint: true });
        assert.equal(corners.layout, 'corners');
        assert.equal(corners.vertexToPoint!.length, 36);
        assertExpands(corners.positions, points.positions, corners.vertexToPoint!);
        // Same as the raw face indices.
        const topology = file.getTopology('/wave/waveShape', { faces: true });
        assert.deepEqual(Array.from(corners.vertexToPoint!), Array.from(topology.faceIndices!));
    });

    it('holds for face-varying meshes and face set reordering', () => {
        const faceSets = AbcFile.open(fixture('face_sets'));
        const P = faceSets.getProperty('/cube/cubeShape', '.geom/P') as AbcArrayValue;
        for (const groupByFaceSet of [false, true]) {
            const mesh = faceSets.getMesh('/cube/cubeShape', { vertexToPoint: true, groupByFaceSet });
            assert.equal(mesh.layout, 'corners');
            assertExpands(mesh.positions, P.data as Float32Array, mesh.vertexToPoint!);
        }
        faceSets.close();

        const subd = AbcFile.open(blender('materials_subd.abc'));
        for (const obj of subd.getObjects().filter((o) => o.type === 'mesh' || o.type === 'subd')) {
            const mesh = subd.getMesh(obj.path, { vertexToPoint: true, layout: 'corners' });
            const raw = subd.getProperty(obj.path, '.geom/P') as AbcArrayValue;
            assertExpands(mesh.positions, raw.data as Float32Array, mesh.vertexToPoint!);
        }
        subd.close();
    });

    it('is stored on the scene, survives a JSON round trip and is cleared by mesh records', () => {
        const scene = buildThreeScene(file, THREE, { vertexToPoint: true, attributes: [] });
        const node = nodeAt(scene, '/wave/waveShape');
        assert.ok(Array.isArray(node.userData.alembic.vertexToPoint), 'plain array, kept by GLTFExporter');
        assert.equal(node.userData.alembic.path, '/wave/waveShape');
        const restored = getVertexToPoint(JSON.parse(JSON.stringify({ userData: node.userData })));
        assert.ok(restored instanceof Uint32Array);
        assert.equal(restored.length, node.geometry.getAttribute('position').count);
        assert.equal(getVertexToPoint(nodeAt(buildThreeScene(file, THREE), '/wave/waveShape')), undefined);

        // A 'mesh' record (other topology) drops the map; the next 'deform' record brings it back.
        const positions = new Float32Array(9);
        const mesh = { kind: 'mesh' as const, positions, indices: new Uint32Array([0, 1, 2]) };
        applyFrame(scene, { time: 0, objects: new Map([['/wave/waveShape', mesh]]) });
        assert.equal(getVertexToPoint(node), undefined);
        const deform = { kind: 'deform' as const, positions: new Float32Array(16 * 3) };
        applyFrame(scene, { time: 1, objects: new Map([['/wave/waveShape', deform]]) });
        assert.deepEqual(Array.from(getVertexToPoint(node)!), Array.from(restored));
    });
});
