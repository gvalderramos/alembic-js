// Spec 0009: data for comparing caches (vertexToPoint, attribute records, encoder velocities).
import * as assert from 'assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { after, before, describe, it } from 'node:test';
import * as THREE from 'three';

import {
    AbcFile,
    applyFrame,
    buildThreeScene,
    decodeFrames,
    encodeFrames,
    FrameFormatError,
    getVertexToPoint,
    writeFrames,
    type AbcArrayValue,
    type AttributeRecord,
    type DecodedFrame,
    type MeshRecord,
} from '../src';
import { RECORD_KINDS } from '../src/stream';
import * as legacy from './legacy/format-v1';
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

/** Packet with a deform record, a kind-5 attribute record and a transform record after it. */
const ATTRIBUTE_PACKET = path.join(repoRoot, 'test', 'fixtures', 'attribute_record.bin');

function attributePacketFrames(): DecodedFrame[] {
    return [
        {
            time: 0.5,
            objects: new Map([
                ['/a', { kind: 'deform', positions: new Float32Array([0, 1, 2, 3, 4, 5]) }],
                ['/b', { kind: 'attribute', name: 'distance', itemSize: 1, data: new Float32Array([0.25, 0.5]) }],
                [
                    '/c',
                    { kind: 'transform', matrix: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 7, 8, 9, 1]) },
                ],
            ]),
        },
    ];
}

/** A one-mesh scene with `vertexCount` vertices, as buildThreeScene() would make it. */
function meshScene(vertexCount: number): { root: THREE.Group; mesh: THREE.Mesh } {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(vertexCount * 3), 3));
    const mesh = new THREE.Mesh(geometry);
    mesh.userData.alembic = { path: '/m' };
    return { root: new THREE.Group().add(mesh) as THREE.Group, mesh };
}

const attribute = (data: number[], itemSize = 1, name = 'distance'): AttributeRecord => ({
    kind: 'attribute',
    name,
    itemSize,
    data: new Float32Array(data),
});

describe('attribute records', () => {
    it('round-trips through writeFrames()/decodeFrames()', () => {
        const frames = [
            { time: 0, objects: new Map([['/m', attribute([1, 2, 3, 4, 5, 6], 3, 'Cd \u00e9')]]) },
            { time: 1, objects: new Map([['/m', attribute([], 1, '')]]) },
        ];
        const decoded = decodeFrames(writeFrames(frames));
        const first = decoded[0].objects.get('/m') as AttributeRecord;
        assert.equal(first.kind, 'attribute');
        assert.equal(first.name, 'Cd \u00e9');
        assert.equal(first.itemSize, 3);
        assert.deepEqual(Array.from(first.data), [1, 2, 3, 4, 5, 6]);
        assert.equal(first.data.byteOffset % 4, 0, 'data is an aligned view');
        assert.deepEqual(decoded[1].objects.get('/m'), {
            kind: 'attribute',
            name: '',
            itemSize: 1,
            data: new Float32Array(0),
        });
        assert.equal(RECORD_KINDS.attribute, 5);
    });

    it('matches the checked-in packet byte for byte', () => {
        const expected = fs.readFileSync(ATTRIBUTE_PACKET);
        assert.deepEqual(Buffer.from(writeFrames(attributePacketFrames())), expected);
        const [frame] = decodeFrames(expected);
        assert.deepEqual(frame.objects.get('/b'), attributePacketFrames()[0].objects.get('/b'));
    });

    it('is skipped by a version-1 decoder from before spec 0009', () => {
        const [frame] = legacy.decodeFrames(fs.readFileSync(ATTRIBUTE_PACKET));
        assert.deepEqual([...frame.objects.keys()], ['/a', '/c']);
        assert.deepEqual(
            Array.from((frame.objects.get('/c') as legacy.TransformRecord).matrix.subarray(12, 15)),
            [7, 8, 9],
        );
    });

    it('rejects data that is not a whole number of items', () => {
        const bad = (record: AttributeRecord) => () => writeFrames([{ time: 0, objects: new Map([['/m', record]]) }]);
        assert.throws(bad(attribute([1, 2, 3, 4], 3)), FrameFormatError);
        assert.throws(bad(attribute([1], 0)), FrameFormatError);
        assert.throws(bad(attribute([1], 1.5)), FrameFormatError);
    });

    it('sets the attribute and then updates the same BufferAttribute in place', () => {
        const { root, mesh } = meshScene(3);
        applyFrame(root, { time: 0, objects: new Map([['/m', attribute([1, 2, 3])]]) });
        const created = mesh.geometry.getAttribute('distance') as THREE.BufferAttribute;
        assert.ok(created instanceof THREE.BufferAttribute);
        assert.equal(created.itemSize, 1);
        assert.deepEqual(Array.from(created.array), [1, 2, 3]);

        const record = attribute([4, 5, 6]);
        const version = created.version;
        applyFrame(root, { time: 1, objects: new Map([['/m', record]]) });
        assert.equal(mesh.geometry.getAttribute('distance'), created, 'same BufferAttribute');
        assert.deepEqual(Array.from(created.array), [4, 5, 6]);
        assert.ok(created.version > version, 'needsUpdate was set');
        assert.notEqual(created.array.buffer, record.data.buffer, 'the packet is copied, never written to');

        // Another item size replaces the attribute.
        applyFrame(root, { time: 2, objects: new Map([['/m', attribute([1, 0, 0, 0, 1, 0, 0, 0, 1], 3)]]) });
        const replaced = mesh.geometry.getAttribute('distance') as THREE.BufferAttribute;
        assert.notEqual(replaced, created);
        assert.equal(replaced.itemSize, 3);
    });

    it('is skipped when the vertex count no longer matches, e.g. after a mesh record', () => {
        const { root, mesh } = meshScene(3);
        applyFrame(root, { time: 0, objects: new Map([['/m', attribute([1, 2, 3])]]) });
        const positions = new Float32Array(4 * 3);
        const indices = new Uint32Array([0, 1, 2, 0, 2, 3]);
        applyFrame(root, { time: 1, objects: new Map([['/m', { kind: 'mesh', positions, indices }]]) });
        applyFrame(root, { time: 1, objects: new Map([['/m', attribute([7, 8, 9])]]) });
        assert.equal(mesh.geometry.getAttribute('distance'), undefined, 'not applied to the 4-vertex geometry');
        // Attributes for the new topology apply; order with the position packet doesn't matter.
        applyFrame(root, { time: 1, objects: new Map([['/m', attribute([1, 2, 3, 4])]]) });
        assert.equal(mesh.geometry.getAttribute('distance').count, 4);
    });

    it('colors the right vertices: per-point distance expanded with vertexToPoint', () => {
        // Two versions of /wave/waveShape: frame 1 and frame 3. Distances are computed per point from
        // 'points' layout reads, expanded with vertexToPoint and applied to a corners-layout scene.
        const file = AbcFile.open(fixture('animation'));
        const a = file.getMesh('/wave/waveShape', { time: 1 / 24 });
        const b = file.getMesh('/wave/waveShape', { time: 3 / 24 });
        const perPoint = new Float32Array(a.positions.length / 3);
        for (let p = 0; p < perPoint.length; p++) {
            perPoint[p] = Math.hypot(...[0, 1, 2].map((c) => b.positions[p * 3 + c] - a.positions[p * 3 + c]));
        }
        const scene = buildThreeScene(file, THREE, { vertexToPoint: true, attributes: [] });
        const node = nodeAt(scene, '/wave/waveShape');
        const sceneCorners = file.getMesh('/wave/waveShape', { layout: 'corners', vertexToPoint: true });
        const vertexToPoint = getVertexToPoint(node)!;
        const perVertex = Float32Array.from(vertexToPoint, (p) => perPoint[p]);
        applyFrame(scene, { time: 0, objects: new Map([['/wave/waveShape', attribute(Array.from(perVertex))]]) });
        const applied = node.geometry.getAttribute('distance');
        assert.equal(applied.count, node.geometry.getAttribute('position').count);
        // Point i moves by 2 * 0.1 * (i % 4) in y between frames 1 and 3.
        const positions = node.geometry.getAttribute('position').array as Float32Array;
        for (let v = 0; v < applied.count; v++) {
            const x = positions[v * 3];
            assert.ok(Math.abs(applied.array[v] - 0.2 * x) < 1e-6, `vertex ${v} at x=${x}: ${applied.array[v]}`);
        }
        // The same per-point data expands to a corners layout too.
        const corners = Float32Array.from(sceneCorners.vertexToPoint!, (p) => perPoint[p]);
        for (let v = 0; v < corners.length; v++) {
            assert.ok(Math.abs(corners[v] - 0.2 * sceneCorners.positions[v * 3]) < 1e-6);
        }
        file.close();
    });

    it("colors the right vertices of a scene whose default layout is 'corners'", () => {
        // The face-varying cube is built with one vertex per corner. Send each point's index as the
        // per-point value; every vertex must get the index of the point at its position.
        const file = AbcFile.open(fixture('face_sets'));
        const P = (file.getProperty('/cube/cubeShape', '.geom/P') as AbcArrayValue).data as Float32Array;
        const scene = buildThreeScene(file, THREE, { vertexToPoint: true, onError: () => {} });
        const node = nodeAt(scene, '/cube/cubeShape');
        const vertexToPoint = getVertexToPoint(node)!;
        assert.ok(vertexToPoint.length > P.length / 3, 'corners layout has more vertices than points');
        const perPoint = Array.from({ length: P.length / 3 }, (_, p) => p);
        const perVertex = Array.from(vertexToPoint, (p) => perPoint[p]);
        applyFrame(scene, { time: 0, objects: new Map([['/cube/cubeShape', attribute(perVertex)]]) });
        const applied = node.geometry.getAttribute('distance');
        assert.equal(applied.count, node.geometry.getAttribute('position').count);
        const positions = node.geometry.getAttribute('position').array as Float32Array;
        for (let v = 0; v < applied.count; v++) {
            const p = applied.array[v];
            assert.deepEqual(
                Array.from(positions.subarray(v * 3, v * 3 + 3)),
                Array.from(P.subarray(p * 3, p * 3 + 3)),
            );
        }
        file.close();
    });
});

describe('encodeFrames velocities', () => {
    const F = (frame: number) => frame / 24;
    const sim = '/sim/simShape';

    async function simRecord(time: number, options: Parameters<typeof encodeFrames>[2] = {}): Promise<MeshRecord> {
        const file = AbcFile.open(fixture('animation'));
        try {
            const [frame] = decodeFrames(await encodeFrames(file, [time], { paths: [sim], ...options }));
            const record = frame.objects.get(sim)!;
            assert.equal(record.kind, 'mesh', 'the topology differs from the reference (time 0)');
            return record as MeshRecord;
        } finally {
            file.close();
        }
    }

    it('moves a changing mesh with its velocities between samples', async () => {
        // /sim at frame 2 + 0.25: 6 points at y = 0 with velocity (0, 1, 0) units per second.
        const dt = F(0.25);
        const floor = await simRecord(F(2) + dt, { mode: 'interpolate' });
        const moved = await simRecord(F(2) + dt, { mode: 'interpolate', useVelocities: true });
        assert.equal(floor.positions.length, 6 * 3);
        assert.equal(moved.positions.length, floor.positions.length);
        assert.deepEqual(Array.from(moved.indices), Array.from(floor.indices));
        for (let v = 0; v < floor.positions.length / 3; v++) {
            assert.equal(floor.positions[v * 3 + 1], 0, 'without velocities: the floor sample');
            assert.ok(Math.abs(moved.positions[v * 3 + 1] - dt) < 1e-6, `y = v * dt at vertex ${v}`);
            assert.equal(moved.positions[v * 3], floor.positions[v * 3]);
            assert.equal(moved.positions[v * 3 + 2], floor.positions[v * 3 + 2]);
        }
    });

    it('applies velocityScale', async () => {
        const dt = F(0.5);
        const record = await simRecord(F(2) + dt, { mode: 'floor', useVelocities: true, velocityScale: 24 });
        assert.ok(Math.abs(record.positions[1] - dt * 24) < 1e-5);
    });
});
