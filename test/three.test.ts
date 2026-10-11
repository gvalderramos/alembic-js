// Integration: extracted Alembic data must be usable by three.js in Node.
import * as assert from 'assert/strict';
import { after, before, describe, it } from 'node:test';
import * as THREE from 'three';

import { AbcFile, buildThreeScene, toBufferGeometry } from '../src';
import { fixture, kettlePath } from './helpers';

describe('three.js bridge', () => {
    it('converts a mesh into a BufferGeometry', () => {
        const file = AbcFile.open(fixture('transformed_mesh'));
        const geometry = toBufferGeometry(file.getMesh('/cube/cubeShape'), THREE) as THREE.BufferGeometry;
        assert.equal(geometry.getAttribute('position').count, 24);
        assert.equal(geometry.getAttribute('normal').count, 24);
        assert.equal(geometry.getAttribute('uv').count, 24);
        assert.equal(geometry.getIndex()!.count, 36);
        assert.deepEqual(geometry.boundingBox!.min.toArray(), [-0.5, -0.5, -0.5]);
        assert.deepEqual(geometry.boundingBox!.max.toArray(), [0.5, 0.5, 0.5]);
        file.close();
    });

    it('computes normals when the file has none', () => {
        const file = AbcFile.open(fixture('simple_mesh'));
        const geometry = toBufferGeometry(file.getMesh('/plane'), THREE) as THREE.BufferGeometry;
        const normal = new THREE.Vector3().fromBufferAttribute(geometry.getAttribute('normal') as THREE.BufferAttribute, 0);
        assert.deepEqual(normal.toArray(), [0, 1, 0]);
        const bare = toBufferGeometry(file.getMesh('/plane'), THREE, { computeNormals: false }) as THREE.BufferGeometry;
        assert.equal(bare.getAttribute('normal'), undefined);
        file.close();
    });

    it('rebuilds the hierarchy with matching world transforms', () => {
        const file = AbcFile.open(fixture('nested_hierarchy'));
        const time = 3 / 24;
        const root = buildThreeScene(file, THREE, { time }) as THREE.Group;
        root.updateMatrixWorld(true);

        const names: string[] = [];
        root.traverse((node) => names.push(node.name));
        assert.deepEqual(names.slice(1), ['root', 'child_a', 'grandchild', 'quadShape', 'child_b']);

        const quad = root.getObjectByName('quadShape') as THREE.Mesh;
        assert.ok(quad.isMesh);
        assert.equal(quad.userData.alembic.path, '/root/child_a/grandchild/quadShape');
        const expected = new THREE.Matrix4().fromArray(file.getMesh(quad.userData.alembic.path, { time }).transform);
        assert.ok(quad.matrixWorld.equals(expected), `got ${quad.matrixWorld.toArray()}`);
        file.close();
    });

    it('creates cameras and placeholder groups for other types', () => {
        const file = AbcFile.open(fixture('unsupported_types'));
        const root = buildThreeScene(file, THREE) as THREE.Group;
        const camera = root.getObjectByName('camera') as THREE.PerspectiveCamera;
        assert.ok(camera.isPerspectiveCamera);
        assert.equal(camera.near, 0.5);
        assert.equal(camera.far, 500);
        assert.equal((root.getObjectByName('particles') as THREE.Group).type, 'Group');
        const noCameras = buildThreeScene(file, THREE, { includeCameras: false }) as THREE.Group;
        assert.equal((noCameras.getObjectByName('camera') as THREE.Object3D).type, 'Group');
        file.close();
    });

    it('loads the Ancient Kettle sample into a three.js scene', () => {
        const file = AbcFile.open(kettlePath);
        const material = new THREE.MeshStandardMaterial();
        const root = buildThreeScene(file, THREE, { material }) as THREE.Group;
        const meshes: THREE.Mesh[] = [];
        root.traverse((node) => { if ((node as THREE.Mesh).isMesh) meshes.push(node as THREE.Mesh); });
        assert.deepEqual(meshes.map((mesh) => mesh.name).sort(), ['Circle', 'Circle_001', 'Circle_002']);
        assert.ok(meshes.every((mesh) => mesh.material === material));

        const box = new THREE.Box3().setFromObject(root);
        assert.ok(!box.isEmpty());
        const size = box.getSize(new THREE.Vector3());
        assert.ok(size.x > 0 && size.y > 0 && size.z > 0, `size ${size.toArray()}`);
        file.close();
    });
});

describe('Ancient Kettle sample', () => {
    let file: AbcFile;
    before(() => { file = AbcFile.open(kettlePath); });
    after(() => file.close());

    it('reads Blender metadata', () => {
        const info = file.getInfo();
        assert.equal(info.appName, 'Blender');
        assert.equal(info.objectCount, 8);
        assert.match(info.libraryVersionString, /^Alembic 1\.7\.12/);
    });

    it('reads the hierarchy', () => {
        assert.deepEqual(file.getChildren().map((obj) => obj.name), ['Camera', 'Handle', 'Lid', 'Kettle']);
        assert.deepEqual(file.getObject('/Kettle')!.children, ['/Kettle/Circle']);
        assert.equal(file.getObject('/Camera/Camera')!.type, 'camera');
    });

    it('extracts the kettle body', () => {
        const mesh = file.getMesh('/Kettle/Circle');
        assert.equal(mesh.positions.length, 103984 * 3);
        assert.equal(mesh.faceCount, 103984);
        assert.equal(mesh.indices.length % 3, 0);
        const vertexCount = mesh.positions.length / 3;
        assert.ok(mesh.indices.every((index) => index < vertexCount));
    });
});
