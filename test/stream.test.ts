// Spec 0008: binary frame format, encodeFrames(), decodeFrames()/applyFrame() and the browser entry point.
import * as assert from 'assert/strict';
import * as path from 'path';
import { after, before, describe, it } from 'node:test';
import * as esbuild from 'esbuild';
import * as THREE from 'three';

import {
    AbcFile,
    AbcPlayer,
    applyFrame,
    buildThreeScene,
    decodeFrames,
    encodeFrames,
    FrameFormatError,
    getTriangleToFace,
    writeFrames,
    type DecodedFrame,
    type FrameRecord,
} from '../src';
import { assertAbcErrorAsync, assertClose, repoRoot } from './helpers';

const blender = (name: string) => path.join(repoRoot, 'resource', 'blender', name);

/** Every Alembic object of a scene, by path. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- meshes, cameras and groups
type Node = any;

function nodesByPath(root: THREE.Object3D): Map<string, Node> {
    const nodes = new Map<string, Node>();
    root.traverse((node) => {
        if (node.userData.alembic?.path) nodes.set(node.userData.alembic.path, node);
    });
    return nodes;
}

/** Like assertClose(), but builds the message only on failure (fast for large arrays). */
function assertNear(actual: ArrayLike<number>, expected: ArrayLike<number>, epsilon: number, label: string): void {
    assert.equal(actual.length, expected.length, `${label}: length`);
    for (let i = 0; i < expected.length; i++) {
        if (!(Math.abs(actual[i] - expected[i]) <= epsilon)) {
            assert.fail(`${label}[${i}]: expected ${expected[i]}, got ${actual[i]}`);
        }
    }
}

/** Positions, normals, indices and transforms of the animated objects, to compare two scenes. */
function assertSameState(actual: THREE.Object3D, expected: THREE.Object3D, paths: string[], label: string): void {
    const a = nodesByPath(actual);
    const e = nodesByPath(expected);
    for (const objectPath of paths) {
        const got = a.get(objectPath);
        const want = e.get(objectPath);
        if (want.isMesh) {
            const g = got.geometry as THREE.BufferGeometry;
            const w = want.geometry as THREE.BufferGeometry;
            const where = `${label}: ${objectPath}`;
            assertNear(g.getAttribute('position').array, w.getAttribute('position').array, 1e-5, `${where} positions`);
            assertNear(g.index!.array, w.index!.array, 0, `${where} indices`);
            const normal = w.getAttribute('normal');
            if (normal) assertNear(g.getAttribute('normal').array, normal.array, 1e-4, `${where} normals`);
        } else if (want.isPerspectiveCamera) {
            assertClose([got.fov, got.near, got.far], [want.fov, want.near, want.far], 1e-3);
        } else {
            assertClose(got.position.toArray(), want.position.toArray(), 1e-5);
            assertClose(got.quaternion.toArray(), want.quaternion.toArray(), 1e-5);
            assertClose(got.scale.toArray(), want.scale.toArray(), 1e-5);
        }
    }
}

describe('frame format', () => {
    const frames: DecodedFrame[] = [
        {
            time: 1 / 24,
            objects: new Map<string, FrameRecord>([
                ['/a', { kind: 'transform', matrix: Float32Array.from({ length: 16 }, (_, i) => i) }],
                ['/a/odd', { kind: 'deform', positions: new Float32Array([1, 2, 3, 4, 5, 6]) }],
                [
                    '/a/odd/ünï',
                    {
                        kind: 'deform',
                        positions: new Float32Array([0.5, 0.25, 0.125]),
                        normals: new Float32Array([0, 1, 0]),
                    },
                ],
                ['/cam', { kind: 'camera', fov: 39.6, near: 0.1, far: 1000 }],
            ]),
        },
        {
            time: 2 / 24,
            objects: new Map<string, FrameRecord>([
                [
                    '/m',
                    {
                        kind: 'mesh',
                        positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0]),
                        normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
                        indices: new Uint32Array([0, 1, 2, 2, 1, 3]),
                        triangleToFace: new Uint32Array([0, 0]),
                        groups: [
                            { start: 0, count: 1, materialIndex: 0 },
                            { start: 1, count: 1, materialIndex: 1 },
                        ],
                    },
                ],
                ['/m2', { kind: 'mesh', positions: new Float32Array(9), indices: new Uint32Array([0, 1, 2]) }],
            ]),
        },
    ];

    it('round-trips every record kind', () => {
        const buffer = writeFrames(frames);
        const decoded = decodeFrames(buffer);
        assert.equal(decoded.length, 2);
        assert.equal(decoded[0].time, 1 / 24);
        assert.equal(decoded[1].time, 2 / 24);
        assert.deepEqual([...decoded[0].objects.keys()], ['/a', '/a/odd', '/a/odd/ünï', '/cam']);
        for (let f = 0; f < frames.length; f++) {
            for (const [objectPath, record] of frames[f].objects) {
                const got = decoded[f].objects.get(objectPath)!;
                assert.equal(got.kind, record.kind);
                if (record.kind === 'camera') {
                    assert.equal(got.kind, 'camera');
                    assertClose([got.fov, got.near, got.far], [record.fov, record.near, record.far], 1e-4);
                } else {
                    for (const [key, value] of Object.entries(record)) {
                        if (key !== 'kind') assert.deepEqual((got as never)[key], value, `${objectPath}.${key}`);
                    }
                    for (const key of Object.keys(got)) {
                        assert.ok(key in record, `${objectPath}: unexpected ${key}`);
                    }
                }
            }
        }
    });

    it('decodes arrays as views into the buffer', () => {
        const buffer = writeFrames(frames);
        const decoded = decodeFrames(buffer);
        for (const frame of decoded) {
            for (const record of frame.objects.values()) {
                for (const value of Object.values(record)) {
                    if (ArrayBuffer.isView(value)) {
                        assert.equal(value.buffer, buffer, 'no copy');
                        assert.equal(value.byteOffset % 4, 0, 'aligned');
                    }
                }
            }
        }
    });

    it('accepts unaligned views, such as a Node Buffer', () => {
        const buffer = new Uint8Array(writeFrames(frames));
        const copy = Buffer.alloc(buffer.length + 1);
        copy.set(buffer, 1);
        const decoded = decodeFrames(copy.subarray(1));
        assert.deepEqual(
            (decoded[0].objects.get('/a/odd') as { positions: Float32Array }).positions,
            new Float32Array([1, 2, 3, 4, 5, 6]),
        );
    });

    it('writes the documented header and skips unknown record kinds', () => {
        const buffer = writeFrames([{ time: 0.5, objects: new Map([['/x', frames[0].objects.get('/cam')!]]) }]);
        const view = new DataView(buffer);
        assert.equal(Buffer.from(buffer, 0, 4).toString('latin1'), 'ABCF');
        assert.equal(view.getUint16(4, true), 1);
        assert.equal(view.getUint16(6, true), 1);
        assert.equal(view.getFloat64(8, true), 0.5);
        assert.equal(view.getUint32(16, true), 1);
        assert.equal(view.getUint16(20, true), 2); // '/x'
        const kindOffset = 24;
        assert.equal(view.getUint8(kindOffset), 4); // camera
        assert.equal(view.getUint32(kindOffset + 1, true), 12);
        assert.equal(buffer.byteLength, 32 + 12, 'payload padded to byte 32');
        view.setUint8(kindOffset, 200);
        assert.equal(decodeFrames(buffer)[0].objects.size, 0);
    });

    it('rejects buffers that are not in the format', () => {
        assert.throws(() => decodeFrames(new ArrayBuffer(4)), FrameFormatError);
        assert.throws(() => decodeFrames(new TextEncoder().encode('ABCX\x01\x00\x00\x00')), /magic/);
        const buffer = writeFrames(frames);
        const future = buffer.slice(0);
        new DataView(future).setUint16(4, 2, true);
        assert.throws(() => decodeFrames(future), /version 2/);
        assert.throws(() => decodeFrames(buffer.slice(0, buffer.byteLength - 4)), /Truncated|shorter/);
        assert.throws(
            () =>
                writeFrames([
                    {
                        time: 0,
                        objects: new Map([['/bad', { kind: 'deform', positions: new Float32Array(4) }]]),
                    },
                ]),
            FrameFormatError,
        );
    });
});

describe('encodeFrames', () => {
    let file: AbcFile;
    let playerFile: AbcFile;
    before(() => {
        file = AbcFile.open(blender('changing_topology.abc'));
        playerFile = AbcFile.open(blender('changing_topology.abc'));
    });
    after(() => {
        file.close();
        playerFile.close();
    });

    it('matches AbcPlayer on a mesh whose topology changes every frame', async () => {
        const meshPath = '/Growing/Mesh';
        const info = file.getInfo();
        const times = Array.from({ length: 6 }, (_, i) => info.startTime + (i * 4) / 30);
        const frames = decodeFrames(await encodeFrames(file, times, { triangleToFace: true }));
        assert.deepEqual(
            frames.map((frame) => frame.time),
            times,
        );
        assert.deepEqual([...frames[0].objects.keys()], [meshPath], 'animated paths by default');
        assert.equal(frames[0].objects.get(meshPath)!.kind, 'deform', 'same topology as the scene');
        const later = frames[3].objects.get(meshPath)!;
        assert.equal(later.kind, 'mesh');
        assert.equal(later.triangleToFace!.length * 3, later.indices.length);

        const expected = buildThreeScene(playerFile, THREE);
        const player = new AbcPlayer(playerFile, expected, THREE);
        const actual = buildThreeScene(file, THREE);
        const original = nodesByPath(actual).get(meshPath).geometry;
        for (const frame of [...frames, ...frames.slice().reverse()]) {
            player.setTime(frame.time);
            applyFrame(actual, frame);
            assertSameState(actual, expected, [meshPath], `t=${frame.time}`);
        }
        assert.equal(nodesByPath(actual).get(meshPath).geometry, original, 'deform restores the scene geometry');
    });

    it('matches AbcPlayer on deforming meshes, transforms and cameras', async () => {
        for (const name of ['cloth_deform.abc', 'camera_rigid_instances.abc']) {
            const source = AbcFile.open(blender(name));
            const reference = AbcFile.open(blender(name));
            const info = source.getInfo();
            const times = [info.startTime, info.startTime + 0.25, (info.startTime + info.endTime) / 2 + 0.01];
            const expected = buildThreeScene(reference, THREE);
            const player = new AbcPlayer(reference, expected, THREE, { mode: 'interpolate' });
            const actual = buildThreeScene(source, THREE);
            const frames = decodeFrames(await encodeFrames(source, times, { mode: 'interpolate' }));
            assert.deepEqual(new Set(frames[0].objects.keys()), new Set(player.animatedPaths), name);
            for (const frame of frames) {
                for (const record of frame.objects.values()) assert.notEqual(record.kind, 'mesh', name);
                player.setTime(frame.time);
                applyFrame(actual, frame);
                assertSameState(actual, expected, player.animatedPaths, `${name} t=${frame.time}`);
            }
            source.close();
            reference.close();
        }
    });

    it('honours paths and normals', async () => {
        const cloth = AbcFile.open(blender('cloth_deform.abc'));
        const [frame] = decodeFrames(
            await encodeFrames(cloth, [0.5], { paths: ['/Cloth/ClothShape', '/Cloth'], normals: false }),
        );
        assert.deepEqual([...frame.objects.keys()], ['/Cloth/ClothShape', '/Cloth']);
        const record = frame.objects.get('/Cloth/ClothShape')!;
        assert.equal(record.kind, 'deform');
        assert.equal(record.normals, undefined);
        assert.equal(frame.objects.get('/Cloth')!.kind, 'transform');

        await assertAbcErrorAsync(encodeFrames(cloth, [0], { paths: ['/missing'] }), 'ERR_ABC_OBJECT_NOT_FOUND');
        await assertAbcErrorAsync(encodeFrames(cloth, [Number.NaN]), 'ERR_ABC_INVALID_ARGUMENT');
        cloth.close();
        const particles = AbcFile.open(blender('particles.abc'));
        const points = particles.getObjects().find((object) => object.type === 'points')!;
        await assertAbcErrorAsync(encodeFrames(particles, [0], { paths: [points.path] }), 'ERR_ABC_INVALID_ARGUMENT');
        particles.close();
    });

    it('keeps triangleToFace on the scene for the GLB export', () => {
        const scene = buildThreeScene(file, THREE, { triangleToFace: true });
        const node = nodesByPath(scene).get('/Growing/Mesh');
        assert.ok(Array.isArray(node.userData.alembic.triangleToFace), 'plain array survives JSON (GLTFExporter)');
        assert.equal(node.userData.alembic.path, '/Growing/Mesh');
        const triangleToFace = getTriangleToFace(JSON.parse(JSON.stringify({ userData: node.userData })));
        assert.ok(triangleToFace instanceof Uint32Array);
        assert.equal(triangleToFace.length * 3, node.geometry.index.count);
    });
});

describe('applyFrame', () => {
    it('updates the per-material primitives GLTFLoader creates', () => {
        // GLTFLoader turns a mesh with two materials into a Group with one Mesh per material.
        const position = new THREE.BufferAttribute(new Float32Array(12), 3);
        const primitive = (index: number[]) => {
            const geometry = new THREE.BufferGeometry();
            geometry.setAttribute('position', position);
            geometry.setIndex(index);
            return new THREE.Mesh(geometry);
        };
        const group = new THREE.Group();
        group.userData.alembic = { path: '/m' };
        group.add(primitive([0, 1, 2]), primitive([2, 1, 3]));
        const root = new THREE.Group().add(group);

        const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0]);
        applyFrame(root, { time: 0, objects: new Map([['/m', { kind: 'deform', positions }]]) });
        assert.deepEqual(Array.from(position.array), Array.from(positions));

        const indices = new Uint32Array([0, 1, 2, 2, 1, 3, 0, 2, 3]);
        const groups = [
            { start: 0, count: 2, materialIndex: 0 },
            { start: 2, count: 1, materialIndex: 1 },
        ];
        applyFrame(root, { time: 1, objects: new Map([['/m', { kind: 'mesh', positions, indices, groups }]]) });
        const [first, second] = group.children as THREE.Mesh[];
        assert.deepEqual(Array.from(first.geometry.index!.array), [0, 1, 2, 2, 1, 3]);
        assert.deepEqual(Array.from(second.geometry.index!.array), [0, 2, 3]);
        assert.equal(first.geometry.getAttribute('position'), second.geometry.getAttribute('position'));

        applyFrame(root, { time: 2, objects: new Map([['/m', { kind: 'deform', positions }]]) });
        assert.equal(first.geometry.getAttribute('position'), position, 'the original geometry is back');
        assert.deepEqual(Array.from(second.geometry.index!.array), [2, 1, 3]);
    });

    it('ignores objects that are not in the scene', () => {
        const root = new THREE.Group();
        applyFrame(root, {
            time: 0,
            objects: new Map([['/nope', { kind: 'transform', matrix: new Float32Array(16) }]]),
        });
    });
});

describe('payload size', () => {
    it('is under 40% of the sandbox JSON frame for a deforming 100k-vertex mesh', () => {
        // A 317 x 317 grid: 100,489 vertices, 199,712 triangles, with normals.
        const side = 317;
        const positions = new Float32Array(side * side * 3).map((_, i) => Math.sin(i));
        const normals = new Float32Array(side * side * 3).map((_, i) => Math.cos(i));
        const indices = new Uint32Array((side - 1) * (side - 1) * 6);
        let k = 0;
        for (let y = 0; y < side - 1; y++) {
            for (let x = 0; x < side - 1; x++) {
                const a = y * side + x;
                indices.set([a, a + 1, a + side, a + side, a + 1, a + side + 1], k);
                k += 6;
            }
        }
        const objectPath = '/Grid/GridShape';
        const binary = writeFrames([
            { time: 1, objects: new Map([[objectPath, { kind: 'deform', positions, normals }]]) },
        ]).byteLength;
        // What the sandbox's base64 JSON /frame route sent for the same mesh (before spec 0008).
        const base64 = (a: Float32Array | Uint32Array) =>
            Buffer.from(a.buffer, a.byteOffset, a.byteLength).toString('base64');
        const json = JSON.stringify({
            time: 1,
            objects: {
                [objectPath]: { positions: base64(positions), normals: base64(normals), indices: base64(indices) },
            },
        }).length;
        assert.ok(
            binary < json * 0.4,
            `${binary} bytes vs ${json} bytes of JSON (${((binary / json) * 100).toFixed(1)}%)`,
        );
    });
});

describe('alembic-js/stream', () => {
    it('bundles for the browser without Node built-ins or the native addon', async () => {
        const result = await esbuild.build({
            stdin: {
                contents: "export { applyFrame, decodeFrames } from './src/stream';",
                resolveDir: repoRoot,
                loader: 'ts',
            },
            bundle: true,
            platform: 'browser',
            format: 'esm',
            write: false,
            metafile: true,
            logLevel: 'silent',
        });
        const inputs = Object.keys(result.metafile.inputs).filter((input) => input !== '<stdin>');
        assert.ok(inputs.length > 0);
        for (const input of inputs) {
            assert.match(input.replace(/\\/g, '/'), /^src\/stream\//, `${input} is bundled`);
        }
        assert.doesNotMatch(result.outputFiles[0].text, /require\(|\.node\b|process\./);
    });

    it('is exported from package.json', () => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const pkg = require(path.join(repoRoot, 'package.json'));
        assert.deepEqual(Object.keys(pkg.exports['./stream']), ['types', 'import', 'default']);
        assert.equal(pkg.exports['./stream'].default, './bin/stream/index.js');
        assert.equal(pkg.exports['.'].default, './' + pkg.main);
    });
});
