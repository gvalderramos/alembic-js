// Spec 0006: property tree, typed values, user properties and mesh attributes.
import * as assert from 'assert/strict';
import * as path from 'path';
import { after, before, describe, it } from 'node:test';
import * as THREE from 'three';

import { AbcFile, buildThreeScene, toBufferGeometry, type AbcArrayValue } from '../src';
import { assertAbcError, assertClose, fixture, kettlePath, repoRoot } from './helpers';

const CUBE = '/cube/cubeShape';

describe('property listing', () => {
    let file: AbcFile;
    before(() => {
        file = AbcFile.open(fixture('attributes'));
    });
    after(() => file.close());

    it('lists the top compound of an object', () => {
        const props = file.getProperties(CUBE);
        assert.deepEqual(
            props.map((p) => [p.name, p.kind]),
            [['.geom', 'compound']],
        );
        assert.equal(props[0].metadata.schema, 'AbcGeom_PolyMesh_v1');
    });

    it('lists geometry attributes with type, scope and count, without reading values', () => {
        const attrs = Object.fromEntries(file.getAttributes(CUBE).map((p) => [p.name, p]));
        assert.deepEqual(Object.keys(attrs).sort(), [
            'Cd',
            'bigId',
            'faceId',
            'flags',
            'half',
            'label',
            'pointWeight',
            'tint',
            'uv2',
        ]);
        assert.equal(attrs.Cd.path, '.geom/.arbGeomParams/Cd');
        assert.equal(attrs.Cd.kind, 'compound');
        assert.equal(attrs.Cd.indexed, true);
        assert.equal(attrs.Cd.pod, 'float32');
        assert.equal(attrs.Cd.extent, 3);
        assert.equal(attrs.Cd.interpretation, 'rgb');
        assert.equal(attrs.Cd.scope, 'facevarying');
        assert.equal(attrs.Cd.count, 24);
        assert.deepEqual(
            [attrs.pointWeight.kind, attrs.pointWeight.scope, attrs.pointWeight.count],
            ['array', 'vertex', 8],
        );
        assert.deepEqual([attrs.faceId.pod, attrs.faceId.scope, attrs.faceId.count], ['int32', 'uniform', 6]);
        assert.deepEqual(
            [attrs.bigId.pod, attrs.half.pod, attrs.flags.pod, attrs.label.pod],
            ['uint64', 'float16', 'bool', 'string'],
        );
        assert.equal(attrs.tint.scope, 'constant');
        assert.equal(attrs.pointWeight.numSamples, 1);
        assert.equal(attrs.pointWeight.animated, false);
    });

    it('lists recursively, including .vals and .indices of indexed attributes', () => {
        const [geom] = file.getProperties(CUBE, { recursive: true });
        const arb = geom.children!.find((p) => p.name === '.arbGeomParams')!;
        const cd = arb.children!.find((p) => p.name === 'Cd')!;
        assert.deepEqual(cd.children!.map((p) => p.name).sort(), ['.indices', '.vals']);
        const vals = cd.children!.find((p) => p.name === '.vals')!;
        assert.equal(vals.count, 6);
    });

    it('returns no attributes for objects without .arbGeomParams', () => {
        assert.deepEqual(file.getAttributes('/cube'), []);
    });

    it('reports unknown roots', () => {
        assertAbcError(() => file.getProperties(CUBE, { root: '.nope' }), 'ERR_ABC_PROPERTY_NOT_FOUND');
    });
});

describe('reading values', () => {
    let file: AbcFile;
    before(() => {
        file = AbcFile.open(fixture('attributes'));
    });
    after(() => file.close());

    const read = (name: string, expand?: boolean) =>
        file.getProperty(CUBE, `.arbGeomParams/${name}`, { expand }) as AbcArrayValue;

    it('expands indexed attributes by default', () => {
        const cd = read('Cd');
        assert.equal(cd.pod, 'float32');
        assert.equal(cd.extent, 3);
        assert.equal(cd.count, 24);
        assert.equal(cd.scope, 'facevarying');
        assert.equal(cd.interpretation, 'rgb');
        assert.ok(cd.data instanceof Float32Array);
        assertClose(cd.data.slice(0, 3) as Float32Array, [1, 0, 0]); // face 0
        assertClose(cd.data.slice(4 * 3, 4 * 3 + 3) as Float32Array, [0, 1, 0]); // face 1
        assert.equal(cd.indices, undefined);
    });

    it('returns values and indices separately with expand: false', () => {
        const cd = read('Cd', false);
        assert.equal(cd.count, 6);
        assert.equal(cd.data.length, 18);
        assert.deepEqual(Array.from(cd.indices!.slice(0, 8)), [0, 0, 0, 0, 1, 1, 1, 1]);
    });

    it('decodes every data type', () => {
        assert.ok(read('pointWeight').data instanceof Float32Array);
        assertClose(read('pointWeight').data as Float32Array, [0, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875]);
        assert.deepEqual(Array.from(read('faceId').data as Int32Array), [10, 11, 12, 13, 14, 15]);

        const bigId = read('bigId').data;
        assert.ok(bigId instanceof BigUint64Array);
        assert.equal(bigId[0], 100n);
        assert.equal(bigId[7], 5000000000n);

        const half = read('half');
        assert.equal(half.pod, 'float16');
        assert.ok(half.data instanceof Float32Array, 'float16 is widened to float32');
        assertClose(half.data as Float32Array, [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5]);

        const flags = read('flags');
        assert.ok(flags.data instanceof Uint8Array);
        assert.deepEqual(Array.from(flags.data as Uint8Array), [1, 0, 1, 0, 1, 0, 1, 0]);

        assert.deepEqual(read('label').data, ['crate']);
        assertClose(read('tint').data as Float32Array, [0.25, 0.5, 0.75, 1]);
    });

    it('reads schema properties by their full path', () => {
        const positions = file.getProperty(CUBE, '.geom/P') as AbcArrayValue;
        assert.equal(positions.count, 8);
        assert.equal(positions.interpretation, 'point');
    });

    it('reports unknown properties and compounds', () => {
        const error = assertAbcError(() => file.getProperty(CUBE, '.arbGeomParams/nope'), 'ERR_ABC_PROPERTY_NOT_FOUND');
        assert.equal(error.objectPath, CUBE);
        assert.equal(error.propertyPath, '.arbGeomParams/nope');
        assertAbcError(() => file.getProperty(CUBE, '.geom'), 'ERR_ABC_INVALID_ARGUMENT');
        assertAbcError(() => file.getProperty('/nope', '.geom/P'), 'ERR_ABC_OBJECT_NOT_FOUND');
    });
});

describe('user properties', () => {
    it('returns user properties with JS types', () => {
        const file = AbcFile.open(fixture('attributes'));
        assert.deepEqual(file.getUserProperties('/cube'), {
            assetId: 'crate-042',
            version: 7,
            scale: 2.5,
            enabled: true,
            tags: ['prop', 'wood'],
            frameLabel: 'start',
        });
        assert.deepEqual(file.getUserProperties('/plainShape'), {});
        file.close();
    });

    it('samples animated user properties over time', () => {
        const file = AbcFile.open(fixture('attributes'));
        const label = (frame: number) => file.getUserProperties('/cube', { time: frame / 24 }).frameLabel;
        assert.deepEqual([label(1), label(2), label(3)], ['start', 'middle', 'end']);
        file.close();
    });

    it('reads the kettle and unwraps Blender array properties', () => {
        const kettle = AbcFile.open(kettlePath);
        assert.deepEqual(kettle.getUserProperties('/Kettle/Circle'), { meshtype: false });
        assert.deepEqual(kettle.getAttributes('/Kettle/Circle'), []);
        kettle.close();

        const cloth = AbcFile.open(path.join(repoRoot, 'resource', 'blender', 'cloth_deform.abc'));
        assert.deepEqual(cloth.getUserProperties('/Cloth'), {
            assetId: 'cloth-001',
            version: 3,
            stiffness: 0.75,
            approved: true,
            tags: ['fabric', 'test'],
        });
        cloth.close();
    });
});

describe('mesh attributes', () => {
    let file: AbcFile;
    before(() => {
        file = AbcFile.open(fixture('attributes'));
    });
    after(() => file.close());

    it('adds no attributes and keeps the layout unless asked', () => {
        const mesh = file.getMesh(CUBE);
        assert.equal(mesh.attributes, undefined);
        assert.equal(mesh.layout, 'corners'); // the cube's normals and UVs are face-varying
        const plain = file.getMesh('/plainShape', { attributes: '*' });
        assert.equal(plain.attributes, undefined);
    });

    it('lays out every scope per vertex', () => {
        const mesh = file.getMesh(CUBE, { attributes: ['Cd', 'pointWeight', 'faceId', 'uv2', 'tint', 'missing'] });
        const vertices = mesh.positions.length / 3;
        assert.equal(vertices, 24);
        const attrs = mesh.attributes!;
        assert.deepEqual(Object.keys(attrs).sort(), ['Cd', 'faceId', 'pointWeight', 'tint', 'uv2']);

        // Corner c belongs to face floor(c / 4) in the cube fixture.
        for (let c = 0; c < vertices; c++) {
            const face = Math.floor(c / 4);
            assert.equal((attrs.faceId.data as Int32Array)[c], 10 + face);
        }
        assert.equal(attrs.Cd.count, 24);
        assert.equal(attrs.Cd.sourceScope, 'facevarying');
        assertClose(attrs.Cd.data.slice(5 * 4 * 3, 5 * 4 * 3 + 3) as Float32Array, [1, 0, 1]);
        assert.equal(attrs.uv2.itemSize, 2);
        assertClose(attrs.uv2.data.slice(2, 4) as Float32Array, [0.5, 1]);

        // Vertex-scope values follow the point of each corner.
        const cubeIndices = [0, 1, 2, 3, 7, 6, 5, 4, 3, 7, 4, 0, 5, 6, 2, 1, 4, 5, 1, 0, 2, 6, 7, 3];
        for (let c = 0; c < vertices; c++) {
            assert.equal((attrs.pointWeight.data as Float32Array)[c], cubeIndices[c] * 0.125);
        }

        assert.equal(attrs.tint.constant, true);
        assert.equal(attrs.tint.count, 1);
        assertClose(attrs.tint.data as Float32Array, [0.25, 0.5, 0.75, 1]);
    });

    it('keeps the points layout for vertex attributes when nothing needs corners', () => {
        const quad = AbcFile.open(fixture('simple_mesh'));
        const mesh = quad.getMesh('/plane');
        assert.equal(mesh.layout, 'points');
        assert.equal(quad.getMesh('/plane', { layout: 'corners' }).layout, 'corners');
        assert.equal(quad.getMesh('/plane', { layout: 'corners' }).positions.length / 3, 4);
        quad.close();
    });

    it('converts types for the GPU and rejects values that do not fit', () => {
        const mesh = file.getMesh(CUBE, { attributes: ['half', 'flags'] });
        assert.ok(mesh.attributes!.half.data instanceof Float32Array);
        assert.ok(mesh.attributes!.flags.data instanceof Uint8Array);
        assertAbcError(() => file.getMesh(CUBE, { attributes: ['bigId'] }), 'ERR_ABC_UNSUPPORTED_TYPE', /32 bits/);
        assertAbcError(() => file.getMesh(CUBE, { attributes: ['label'] }), 'ERR_ABC_UNSUPPORTED_TYPE', /getProperty/);
    });

    it("skips attributes that can't be laid out when '*' is requested", () => {
        const names = Object.keys(file.getMesh(CUBE, { attributes: '*' }).attributes ?? {});
        assert.ok(!names.includes('label'));
        assert.ok(names.includes('Cd') && names.includes('pointWeight'));
    });

    it('validates options', () => {
        assertAbcError(() => file.getMesh(CUBE, { layout: 'grid' as unknown as 'points' }), 'ERR_ABC_INVALID_ARGUMENT');
        assertAbcError(
            () => file.getMesh(CUBE, { attributes: [1] as unknown as string[] }),
            'ERR_ABC_INVALID_ARGUMENT',
        );
    });
});

describe('three.js attribute mapping', () => {
    it('maps Cd to color, uv2 to uv1 and keeps custom names', () => {
        const file = AbcFile.open(fixture('attributes'));
        const mesh = file.getMesh(CUBE, { attributes: ['Cd', 'uv2', 'pointWeight', 'tint'] });
        const geometry = toBufferGeometry(mesh, THREE) as THREE.BufferGeometry;
        assert.equal(geometry.getAttribute('color').itemSize, 3);
        assert.equal(geometry.getAttribute('uv1').itemSize, 2);
        assert.equal(geometry.getAttribute('pointWeight').count, 24);
        // tint is 'rgba' too, but the first color attribute (Cd) wins the 'color' slot.
        assert.equal(geometry.getAttribute('tint'), undefined);

        const renamed = toBufferGeometry(mesh, THREE, { attributeNames: { pointWeight: 'weight', tint: 'tint' } });
        assert.ok(renamed.getAttribute('weight'));
        // Constant attributes are repeated per vertex.
        assert.equal(renamed.getAttribute('tint').count, 24);
        file.close();
    });

    it('converts sRGB colors to linear when asked', () => {
        const file = AbcFile.open(fixture('attributes'));
        const mesh = file.getMesh(CUBE, { attributes: ['tint'] });
        const linear = toBufferGeometry(mesh, THREE, { attributeNames: { tint: 'color' }, colorSpace: 'srgb' });
        const color = linear.getAttribute('color') as THREE.BufferAttribute;
        assert.ok(Math.abs(color.getX(0) - Math.pow((0.25 + 0.055) / 1.055, 2.4)) < 1e-6);
        assert.equal(color.getW(0), 1, 'alpha is not converted');
        file.close();
    });

    it('enables vertex colors by default in buildThreeScene', () => {
        const file = AbcFile.open(fixture('attributes'));
        const root = buildThreeScene(file, THREE) as THREE.Group;
        const cube = root.getObjectByName('cubeShape') as THREE.Mesh;
        assert.ok(cube.geometry.getAttribute('color'));
        assert.equal((cube.material as THREE.MeshStandardMaterial).vertexColors, true);
        assert.equal(cube.geometry.getAttribute('pointWeight'), undefined, 'only colors by default');

        const plain = root.getObjectByName('plainShape') as THREE.Mesh;
        assert.equal((plain.material as THREE.MeshStandardMaterial).vertexColors, false);

        const none = buildThreeScene(file, THREE, { attributes: [] }) as THREE.Group;
        assert.equal((none.getObjectByName('cubeShape') as THREE.Mesh).geometry.getAttribute('color'), undefined);
        file.close();
    });

    it('shows Blender vertex colors (Col) from a real export', () => {
        const file = AbcFile.open(path.join(repoRoot, 'resource', 'blender', 'cloth_deform.abc'));
        const root = buildThreeScene(file, THREE) as THREE.Group;
        const cloth = root.getObjectByName('ClothShape') as THREE.Mesh;
        assert.equal(cloth.geometry.getAttribute('color').itemSize, 4);
        file.close();
    });
});
