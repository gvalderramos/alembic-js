import * as assert from 'assert/strict';
import { after, before, describe, it } from 'node:test';

import { AbcFile } from '../src';
import { assertAbcError, assertClose, fixture, translation, triangleNormal } from './helpers';

const IDENTITY = translation(0, 0, 0);

describe('simple mesh', () => {
    let file: AbcFile;
    before(() => { file = AbcFile.open(fixture('simple_mesh')); });
    after(() => file.close());

    it('extracts positions and triangulated indices', () => {
        const mesh = file.getMesh('/plane');
        assert.equal(mesh.name, 'plane');
        assert.equal(mesh.path, '/plane');
        assert.equal(mesh.type, 'mesh');
        assert.ok(mesh.positions instanceof Float32Array);
        assert.ok(mesh.indices instanceof Uint32Array);
        assertClose(mesh.positions, [0, 0, 0, 0, 0, 1, 1, 0, 1, 1, 0, 0]);
        assert.equal(mesh.faceCount, 1);
        assert.equal(mesh.indices.length, 6); // one quad -> two triangles
        assert.equal(mesh.normals, undefined);
        assert.equal(mesh.uvs, undefined);
        assertClose(mesh.transform, IDENTITY);
    });

    it('converts clockwise Alembic polygons to counter-clockwise triangles', () => {
        const mesh = file.getMesh('/plane');
        for (let t = 0; t < mesh.indices.length / 3; t++) {
            const n = triangleNormal(mesh.positions, mesh.indices, t);
            assert.ok(n[1] > 0, `triangle ${t} should face +Y, got ${n}`);
        }
    });

    it('returns every mesh with getMeshes()', () => {
        assert.deepEqual(file.getMeshes().map((mesh) => mesh.path), ['/plane']);
    });
});

describe('transformed mesh', () => {
    let file: AbcFile;
    before(() => { file = AbcFile.open(fixture('transformed_mesh')); });
    after(() => file.close());

    it('splits vertices for face-varying normals and UVs', () => {
        const mesh = file.getMesh('/cube/cubeShape');
        assert.equal(mesh.faceCount, 6);
        assert.equal(mesh.positions.length, 24 * 3);
        assert.equal(mesh.normals!.length, 24 * 3);
        assert.equal(mesh.uvs!.length, 24 * 2);
        assert.equal(mesh.indices.length, 12 * 3);
        for (const index of mesh.indices) {
            assert.ok(index < 24);
        }
    });

    it('keeps triangles consistent with their normals', () => {
        const mesh = file.getMesh('/cube/cubeShape');
        for (let t = 0; t < mesh.indices.length / 3; t++) {
            const geometric = triangleNormal(mesh.positions, mesh.indices, t);
            const i = mesh.indices[t * 3] * 3;
            const stored = [mesh.normals![i], mesh.normals![i + 1], mesh.normals![i + 2]];
            const dot = geometric[0] * stored[0] + geometric[1] * stored[1] + geometric[2] * stored[2];
            assert.ok(dot > 0, `triangle ${t} winding disagrees with its normal ${stored}`);
        }
    });

    it('exposes the mesh world transform', () => {
        assertClose(file.getMesh('/cube/cubeShape').transform, translation(1, 2, 3, 2));
    });

    it('exposes local and world transforms of xforms', () => {
        const xform = file.getTransform('/cube');
        assertClose(xform.local, translation(1, 2, 3, 2));
        assertClose(xform.world, translation(1, 2, 3, 2));
        assert.equal(xform.inheritsTransform, true);
        assert.equal(xform.animated, false);

        const shape = file.getTransform('/cube/cubeShape');
        assertClose(shape.local, IDENTITY);
        assertClose(shape.world, translation(1, 2, 3, 2));
    });
});

describe('nested and animated transforms', () => {
    let file: AbcFile;
    before(() => { file = AbcFile.open(fixture('nested_hierarchy')); });
    after(() => file.close());

    it('accumulates parent transforms', () => {
        assertClose(file.getTransform('/root').world, translation(0, 1, 0));
        assertClose(file.getTransform('/root/child_a/grandchild').world, translation(0, 1, 1));
        assertClose(file.getMesh('/root/child_a/grandchild/quadShape').transform, translation(0, 1, 1));
    });

    it('samples animated transforms over time', () => {
        const frame = (n: number) => ({ time: n / 24 });
        assertClose(file.getTransform('/root/child_a', frame(1)).local, translation(0, 0, 0));
        assertClose(file.getTransform('/root/child_a', frame(2)).local, translation(1, 0, 0));
        assertClose(file.getTransform('/root/child_a', frame(3)).local, translation(2, 0, 0));
        assertClose(file.getMesh('/root/child_a/grandchild/quadShape', frame(3)).transform, translation(2, 1, 1));
        assert.equal(file.getTransform('/root/child_a').animated, true);
    });

    it('clamps times outside the sampled range', () => {
        assertClose(file.getTransform('/root/child_a', { time: -10 }).local, translation(0, 0, 0));
        assertClose(file.getTransform('/root/child_a', { time: 10 }).local, translation(2, 0, 0));
    });

    it('honours inheritsTransform = false', () => {
        const childB = file.getTransform('/root/child_b');
        assert.equal(childB.inheritsTransform, false);
        assertClose(childB.world, translation(5, 0, 0));
    });

    it('rejects invalid times', () => {
        assertAbcError(() => file.getTransform('/root', { time: Number.NaN }), 'ERR_ABC_INVALID_ARGUMENT');
        assertAbcError(() => file.getTransform('/root', { time: '1' as unknown as number }), 'ERR_ABC_INVALID_ARGUMENT');
    });
});

describe('unsupported objects and lookup errors', () => {
    let file: AbcFile;
    before(() => { file = AbcFile.open(fixture('unsupported_types')); });
    after(() => file.close());

    for (const objectPath of ['/particles', '/curve', '/camera', '/group']) {
        it(`refuses to extract geometry from ${objectPath}`, () => {
            const error = assertAbcError(() => file.getMesh(objectPath), 'ERR_ABC_UNSUPPORTED_TYPE', /only 'mesh' and 'subd'/);
            assert.equal(error.objectPath, objectPath);
        });
    }

    it('has no meshes', () => {
        assert.deepEqual(file.getMeshes(), []);
    });

    it('reports unknown object paths', () => {
        const error = assertAbcError(() => file.getMesh('/missing'), 'ERR_ABC_OBJECT_NOT_FOUND');
        assert.equal(error.objectPath, '/missing');
        assertAbcError(() => file.getTransform('/missing'), 'ERR_ABC_OBJECT_NOT_FOUND');
        assertAbcError(() => file.getCamera('/missing'), 'ERR_ABC_OBJECT_NOT_FOUND');
    });

    it('validates object path arguments', () => {
        assertAbcError(() => file.getMesh(undefined as unknown as string), 'ERR_ABC_INVALID_ARGUMENT');
        assertAbcError(() => file.getTransform(7 as unknown as string), 'ERR_ABC_INVALID_ARGUMENT');
    });

    it('reads cameras', () => {
        const camera = file.getCamera('/camera');
        assert.equal(camera.name, 'camera');
        assert.equal(camera.focalLength, 50);
        assert.equal(camera.near, 0.5);
        assert.equal(camera.far, 500);
        assert.ok(Math.abs(camera.aspect - 1.5) < 1e-9);
        const expectedFov = 2 * Math.atan(24 / (2 * 50)) * 180 / Math.PI;
        assert.ok(Math.abs(camera.fov - expectedFov) < 1e-9, `fov ${camera.fov}`);
        assertClose(camera.transform, IDENTITY);
        assertAbcError(() => file.getCamera('/particles'), 'ERR_ABC_UNSUPPORTED_TYPE');
    });
});
