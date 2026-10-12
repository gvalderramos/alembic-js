// Spec 0003: face sets, triangle groups and materials.
import * as assert from 'assert/strict';
import * as path from 'path';
import { after, before, describe, it } from 'node:test';
import * as THREE from 'three';

import { AbcFile, buildThreeScene, toBufferGeometry } from '../src';
import { assertAbcError, fixture, kettlePath, repoRoot } from './helpers';

const blender = (name: string) => path.join(repoRoot, 'resource', 'blender', name);

describe('face sets', () => {
    let file: AbcFile;
    before(() => {
        file = AbcFile.open(fixture('face_sets'));
    });
    after(() => file.close());

    it('lists face sets with faces, exclusivity and materials', () => {
        const sets = file.getFaceSets('/cube/cubeShape');
        assert.deepEqual(
            sets.map((s) => [s.name, s.path, Array.from(s.faces), s.exclusive, s.materialPath]),
            [
                ['sides', '/cube/cubeShape/sides', [0, 1, 2, 3], true, '/materials/red'],
                ['bottom', '/cube/cubeShape/bottom', [4], true, '/materials/red'],
                ['top', '/cube/cubeShape/top', [5], true, '/materials/red/blue'],
            ],
        );
        assert.equal(file.getObject('/cube/cubeShape/top')!.type, 'faceset');
        assert.deepEqual(
            file.getFaceSets('/overlap/quadShape').map((s) => s.exclusive),
            [false, false],
        );
    });

    it('returns no face sets for meshes without them', () => {
        assert.deepEqual(file.getFaceSets('/assigned/childShape'), []);
    });

    it('rejects other types and malformed face sets', () => {
        assertAbcError(() => file.getFaceSets('/cube'), 'ERR_ABC_UNSUPPORTED_TYPE');
        assertAbcError(() => file.getFaceSets('/bad/quadShape'), 'ERR_ABC_MALFORMED_DATA', /face 5/);
        assertAbcError(() => file.getMesh('/bad/quadShape'), 'ERR_ABC_MALFORMED_DATA');
    });
});

describe('triangle groups', () => {
    let file: AbcFile;
    before(() => {
        file = AbcFile.open(fixture('face_sets'));
    });
    after(() => file.close());

    it('reports groups when face sets are contiguous, keeping the triangle order', () => {
        const plain = AbcFile.open(fixture('transformed_mesh')).getMesh('/cube/cubeShape');
        const mesh = file.getMesh('/cube/cubeShape');
        assert.deepEqual(Array.from(mesh.indices), Array.from(plain.indices));
        assert.deepEqual(mesh.groups, [
            { start: 0, count: 8, faceSet: 'sides', materialIndex: 0 },
            { start: 8, count: 2, faceSet: 'bottom', materialIndex: 1 },
            { start: 10, count: 2, faceSet: 'top', materialIndex: 2 },
        ]);
        assert.deepEqual(
            mesh.materialSlots!.map((slot) => slot.materialPath),
            ['/materials/red', '/materials/red', '/materials/red/blue'],
        );
    });

    it('reorders interleaved face sets with groupByFaceSet (Blender materials)', () => {
        const blenderFile = AbcFile.open(blender('materials_subd.abc'));
        assert.equal(
            blenderFile.getMesh('/Box/BoxShape').groups,
            undefined,
            'interleaved: no groups without reordering',
        );
        const mesh = blenderFile.getMesh('/Box/BoxShape', { groupByFaceSet: true, triangleToFace: true });
        assert.deepEqual(
            mesh.groups!.map((g) => [g.faceSet, g.start, g.count]),
            [
                ['Blue', 0, 4],
                ['Green', 4, 4],
                ['Red', 8, 4],
            ],
        );
        // Every triangle of a group comes from a face of that set.
        const sets = Object.fromEntries(
            blenderFile.getFaceSets('/Box/BoxShape').map((s) => [s.name, Array.from(s.faces)]),
        );
        for (const group of mesh.groups!) {
            for (let t = group.start; t < group.start + group.count; t++) {
                assert.ok(sets[group.faceSet!].includes(mesh.triangleToFace![t]));
            }
        }
        // The vertex layout is unchanged; only the triangle order differs.
        assert.equal(mesh.positions.length, blenderFile.getMesh('/Box/BoxShape').positions.length);
        blenderFile.close();
    });

    it('puts faces in no face set in a final default group', () => {
        const mesh = file.getMesh('/overlap/quadShape', { groupByFaceSet: true });
        assert.equal(mesh.faceSetsOverlap, true);
        // Face 0 is in both sets: the first set ('a') wins; face 1 belongs to 'b'.
        assert.deepEqual(
            mesh.groups!.map((g) => [g.faceSet, g.count]),
            [
                ['a', 2],
                ['b', 2],
            ],
        );
    });

    it('maps every triangle to its polygon', () => {
        const mesh = file.getMesh('/cube/cubeShape', { triangleToFace: true });
        assert.deepEqual(Array.from(mesh.triangleToFace!), [0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5]);
    });

    it('leaves meshes without face sets untouched', () => {
        const kettle = AbcFile.open(kettlePath);
        const mesh = kettle.getMesh('/Lid/Circle_001', { groupByFaceSet: true });
        assert.equal(mesh.groups, undefined);
        assert.equal(mesh.materialSlots, undefined);
        kettle.close();
    });
});

describe('materials', () => {
    let file: AbcFile;
    before(() => {
        file = AbcFile.open(fixture('face_sets'));
    });
    after(() => file.close());

    it('classifies material objects', () => {
        assert.equal(file.getObject('/materials/red')!.type, 'material');
        assert.deepEqual(
            file.getMaterials().map((m) => m.path),
            ['/materials/red', '/materials/red/blue'],
        );
    });

    it('reads shaders and parameters, flattened with parent materials', () => {
        const red = file.getMaterial('/materials/red');
        assert.deepEqual(red.targets, ['*']);
        assert.deepEqual(red.shaders, [{ target: '*', shaderType: 'surface', shaderName: 'standard_surface' }]);
        assert.deepEqual(red.parameters['*.surface'], { base_color: [1, 0, 0], roughness: 0.5 });

        const blue = file.getMaterial('/materials/red/blue');
        assert.deepEqual(blue.parameters['*.surface'], { base_color: [0, 0, 1], roughness: 0.5 });
    });

    it('resolves direct, face-set and inherited assignments', () => {
        assert.equal(file.getMaterialAssignment('/cube/cubeShape'), '/materials/red');
        assert.equal(file.getMaterialAssignment('/cube/cubeShape/top'), '/materials/red/blue');
        assert.equal(file.getMaterialAssignment('/assigned/childShape'), '/materials/red/blue');
        assert.equal(file.getMaterialAssignment('/overlap/quadShape'), null);
        assertAbcError(() => file.getMaterialAssignment('/missing'), 'ERR_ABC_OBJECT_NOT_FOUND');
    });

    it('rejects objects without a material', () => {
        assertAbcError(() => file.getMaterial('/cube/cubeShape'), 'ERR_ABC_UNSUPPORTED_TYPE');
    });
});

describe('three.js multi-material meshes', () => {
    it('adds geometry groups', () => {
        const file = AbcFile.open(fixture('face_sets'));
        const geometry = toBufferGeometry(file.getMesh('/cube/cubeShape'), THREE) as THREE.BufferGeometry;
        assert.deepEqual(
            geometry.groups.map((g) => [g.start, g.count, g.materialIndex]),
            [
                [0, 24, 0],
                [24, 6, 1],
                [30, 6, 2],
            ],
        );
        file.close();
    });

    it('creates one material per slot, with the assigned AbcMaterial', () => {
        const file = AbcFile.open(fixture('face_sets'));
        const calls: { name: string; material?: string; base?: unknown }[] = [];
        const errors: string[] = [];
        const root = buildThreeScene(file, THREE, {
            onError: (_error, object) => errors.push(object.path),
            createMaterial: ({ name, material }) => {
                calls.push({ name, material: material?.path, base: material?.parameters['*.surface']?.base_color });
                const [r, g, b] = (material?.parameters['*.surface']?.base_color as number[]) ?? [1, 1, 1];
                return new THREE.MeshStandardMaterial({ color: new THREE.Color(r, g, b) });
            },
        }) as THREE.Group;
        const cube = root.getObjectByName('cubeShape') as THREE.Mesh;
        assert.ok(Array.isArray(cube.material));
        assert.equal((cube.material as THREE.Material[]).length, 3);
        assert.deepEqual(
            calls.filter((c) => ['sides', 'bottom', 'top'].includes(c.name)).map((c) => [c.name, c.material, c.base]),
            [
                ['sides', '/materials/red', [1, 0, 0]],
                ['bottom', '/materials/red', [1, 0, 0]],
                ['top', '/materials/red/blue', [0, 0, 1]],
            ],
        );
        assert.equal(cube.userData.alembicMaterialSlots.length, 3);
        // The malformed mesh is reported and replaced by an empty group; the rest of the scene is built.
        assert.deepEqual(errors, ['/bad/quadShape']);
        assert.equal((root.getObjectByName('quadShape') as THREE.Object3D).type, 'Mesh');
        assertAbcError(() => buildThreeScene(file, THREE), 'ERR_ABC_MALFORMED_DATA');
        file.close();
    });

    it('defaults to a material per slot, and to one material when given', () => {
        const file = AbcFile.open(blender('materials_subd.abc'));
        const root = buildThreeScene(file, THREE) as THREE.Group;
        const box = root.getObjectByName('BoxShape') as THREE.Mesh;
        assert.equal((box.material as THREE.Material[]).length, 3);
        assert.equal(box.geometry.groups.length, 3);

        const single = new THREE.MeshBasicMaterial();
        const flat = buildThreeScene(file, THREE, { material: single }) as THREE.Group;
        assert.equal((flat.getObjectByName('BoxShape') as THREE.Mesh).material, single);
        file.close();
    });
});
