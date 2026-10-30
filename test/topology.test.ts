// Spec 0009: topology info, the 'fnv1a64-faces-v1' hash and topology changes.
import * as assert from 'assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { after, before, describe, it } from 'node:test';

import { AbcFile, topologyHash, TOPOLOGY_HASH_ALGORITHM } from '../src';
import * as stream from '../src/stream';
import { assertAbcError, assertAbcErrorAsync, fixture, kettlePath, repoRoot } from './helpers';

const F = (frame: number) => frame / 24;

/** Shared with nitpick-health-core spec 0004: both implementations must produce these values. */
const VECTORS: [number[], number[], string][] = [
    [[], [], 'cbf29ce484222325'],
    [[3], [0, 1, 2], 'b623a479d2984da5'],
    [[4], [0, 1, 2, 3], '0e8a69ddf947c4f1'],
    [[3, 3], [0, 1, 2, 0, 2, 3], '18e3a471ae049257'],
    [[3, 3], [0, 2, 1, 0, 3, 2], '516fb1c0a2254197'],
];

/** Every .abc in the repository's test assets. */
function testAssets(): string[] {
    const dirs = [
        path.join(repoRoot, 'test', 'fixtures'),
        path.join(repoRoot, 'resource'),
        path.join(repoRoot, 'resource', 'blender'),
    ];
    return dirs.flatMap((dir) =>
        fs
            .readdirSync(dir)
            .filter((name) => name.endsWith('.abc'))
            .map((name) => path.join(dir, name)),
    );
}

describe('topologyHash', () => {
    it('matches the shared test vectors', () => {
        for (const [counts, indices, hash] of VECTORS) {
            assert.equal(topologyHash(counts, indices), hash, `${JSON.stringify(counts)} / ${JSON.stringify(indices)}`);
            assert.equal(topologyHash(Int32Array.from(counts), Uint32Array.from(indices)), hash);
        }
        assert.equal(TOPOLOGY_HASH_ALGORITHM, 'fnv1a64-faces-v1');
    });

    it('hashes negative indices as their uint32 bit pattern', () => {
        assert.equal(topologyHash([1], [-1]), topologyHash([1], [0xffffffff]));
        assert.notEqual(topologyHash([1], [-1]), topologyHash([1], [1]));
    });

    it('hashes counts before indices', () => {
        assert.notEqual(topologyHash([3, 3], [0, 1, 2, 0, 2, 3]), topologyHash([6], [0, 1, 2, 0, 2, 3]));
    });

    it('is exported from alembic-js/stream', () => {
        assert.equal(stream.topologyHash, topologyHash);
    });
});

describe('getTopology', () => {
    let file: AbcFile;
    before(() => {
        file = AbcFile.open(fixture('animation'));
    });
    after(() => file.close());

    it('reads counts and the hash of a mesh', () => {
        const wave = file.getTopology('/wave/waveShape', { faces: true });
        assert.equal(wave.path, '/wave/waveShape');
        assert.equal(wave.pointCount, 16);
        assert.equal(wave.faceCount, 9);
        assert.equal(wave.cornerCount, 36);
        assert.equal(wave.hashAlgorithm, 'fnv1a64-faces-v1');
        assert.match(wave.hash, /^[0-9a-f]{16}$/);
        assert.ok(wave.faceCounts instanceof Int32Array);
        assert.ok(wave.faceIndices instanceof Int32Array);
        assert.deepEqual(Array.from(wave.faceCounts), Array(9).fill(4));
        // Raw file order: the generator writes a, a+4, a+5, a+1 (no rewinding).
        assert.deepEqual(Array.from(wave.faceIndices.subarray(0, 4)), [0, 4, 5, 1]);
        assert.equal(wave.hash, topologyHash(wave.faceCounts, wave.faceIndices));
    });

    it('omits the face arrays unless asked', () => {
        const wave = file.getTopology('/wave/waveShape');
        assert.equal(wave.faceCounts, undefined);
        assert.equal(wave.faceIndices, undefined);
    });

    it('has one hash at every sample of a homogeneous mesh', () => {
        const hashes = [1, 2, 3].map((f) => file.getTopology('/wave/waveShape', { time: F(f) }));
        assert.deepEqual(
            hashes.map((t) => t.sampleIndex),
            [0, 1, 2],
        );
        assert.equal(new Set(hashes.map((t) => t.hash)).size, 1);
    });

    it('differs per sample when the topology changes', () => {
        const sim = [1, 2, 3].map((f) => file.getTopology('/sim/simShape', { time: F(f), faces: true }));
        assert.deepEqual(
            sim.map((t) => [t.pointCount, t.faceCount, t.cornerCount]),
            [
                [4, 1, 4],
                [6, 2, 8],
                [8, 3, 12],
            ],
        );
        assert.equal(new Set(sim.map((t) => t.hash)).size, 3);
        for (const t of sim) {
            assert.equal(t.hash, topologyHash(t.faceCounts!, t.faceIndices!));
        }
    });

    it("reads 'interpolate' as 'floor' and honours frame", () => {
        const t = file.getTopology('/sim/simShape', { time: F(2.9), mode: 'interpolate' });
        assert.equal(t.sampleIndex, 1);
        assert.ok(Math.abs(t.sampleTime - F(2)) < 1e-9);
        assert.equal(file.getTopology('/sim/simShape', { frame: 3 }).sampleIndex, 2);
        assert.equal(file.getTopology('/sim/simShape', { time: F(2.9) }).sampleIndex, 2); // 'near'
    });

    it('matches a hand-computed hash for a one-quad mesh', () => {
        const quad = file.getTopology('/sim/simShape', { time: F(1), faces: true });
        assert.deepEqual(Array.from(quad.faceCounts!), [4]);
        assert.deepEqual(Array.from(quad.faceIndices!), [0, 1, 3, 2]);
        // FNV-1a 64 over 04 00 00 00 | 00 00 00 00 01 00 00 00 03 00 00 00 02 00 00 00.
        assert.equal(quad.hash, '8d8a84deae015281');
    });

    it('rejects objects that are not meshes or subds', () => {
        assertAbcError(() => file.getTopology('/spin'), 'ERR_ABC_INVALID_ARGUMENT', /topology/);
        assertAbcError(() => file.getTopology('/particles'), 'ERR_ABC_INVALID_ARGUMENT');
        assertAbcError(() => file.getTopology('/missing'), 'ERR_ABC_OBJECT_NOT_FOUND');
    });

    it('reads asynchronously', async () => {
        const sync = file.getTopology('/sim/simShape', { time: F(3), faces: true });
        const async = await file.getTopologyAsync('/sim/simShape', { time: F(3), faces: true });
        assert.deepEqual(async, sync);
        await assertAbcErrorAsync(file.getTopologyAsync('/spin'), 'ERR_ABC_INVALID_ARGUMENT');
    });

    it('equals topologyHash() of the raw arrays for every mesh in the test assets', () => {
        let meshes = 0;
        for (const asset of testAssets()) {
            const abc = AbcFile.open(asset);
            try {
                for (const obj of abc.getObjects()) {
                    if (obj.type !== 'mesh' && obj.type !== 'subd') continue;
                    for (const index of new Set([0, obj.numSamples - 1])) {
                        const time = obj.timeSampling?.sampleTimes[index] ?? 0;
                        const t = abc.getTopology(obj.path, { time, mode: 'floor', faces: true });
                        assert.equal(t.hash, topologyHash(t.faceCounts!, t.faceIndices!), `${asset} ${obj.path}`);
                        assert.equal(t.faceCount, t.faceCounts!.length);
                        assert.equal(t.cornerCount, t.faceIndices!.length);
                        // The cached hash (no face arrays) is the same.
                        assert.equal(abc.getTopology(obj.path, { time, mode: 'floor' }).hash, t.hash);
                        meshes++;
                    }
                }
            } finally {
                abc.close();
            }
        }
        assert.ok(meshes > 10, `only ${meshes} meshes checked`);
    });
});

describe('getTopologyChanges', () => {
    it('has one entry for a constant or homogeneous mesh', async () => {
        const file = AbcFile.open(fixture('animation'));
        const changes = await file.getTopologyChanges('/wave/waveShape');
        assert.equal(changes.length, 1);
        assert.equal(changes[0].sampleIndex, 0);
        assert.equal(changes[0].hash, file.getTopology('/wave/waveShape').hash);
        file.close();
    });

    it('lists every changing sample of /sim', async () => {
        const file = AbcFile.open(fixture('animation'));
        const changes = await file.getTopologyChanges('/sim/simShape');
        assert.deepEqual(
            changes.map((c) => [c.sampleIndex, c.pointCount, c.faceCount]),
            [
                [0, 4, 1],
                [1, 6, 2],
                [2, 8, 3],
            ],
        );
        await assertAbcErrorAsync(file.getTopologyChanges('/spin'), 'ERR_ABC_INVALID_ARGUMENT');
        await assertAbcErrorAsync(file.getTopologyChanges('/missing'), 'ERR_ABC_OBJECT_NOT_FOUND');
        file.close();
    });

    it('equals getTopology() at every sample with repeats dropped', async () => {
        for (const asset of testAssets()) {
            const abc = AbcFile.open(asset);
            try {
                for (const obj of abc.getObjects()) {
                    if (obj.type !== 'mesh' && obj.type !== 'subd') continue;
                    const expected: { sampleIndex: number; pointCount: number; faceCount: number; hash: string }[] = [];
                    const times = obj.timeSampling?.sampleTimes ?? [0];
                    for (let i = 0; i < Math.max(1, obj.numSamples); i++) {
                        const t = abc.getTopology(obj.path, { time: times[i], mode: 'floor' });
                        const last = expected[expected.length - 1];
                        if (!last || last.hash !== t.hash || last.pointCount !== t.pointCount) {
                            expected.push({
                                sampleIndex: t.sampleIndex,
                                pointCount: t.pointCount,
                                faceCount: t.faceCount,
                                hash: t.hash,
                            });
                        }
                    }
                    const changes = await abc.getTopologyChanges(obj.path);
                    assert.deepEqual(
                        changes.map(({ sampleIndex, pointCount, faceCount, hash }) => ({
                            sampleIndex,
                            pointCount,
                            faceCount,
                            hash,
                        })),
                        expected,
                        `${asset} ${obj.path}`,
                    );
                }
            } finally {
                abc.close();
            }
        }
    });

    it('reads the face arrays of a constant mesh once', async () => {
        const kettle = AbcFile.open(kettlePath);
        const body = kettle.getObject('/Kettle/Circle')!;
        assert.ok(body.numSamples >= 250, `${body.numSamples} samples`);
        assert.notEqual(body.topology, 'heterogeneous');
        const stats = () =>
            (
                kettle as unknown as { native: { getDebugStats(): { topologyHashReads: number } } }
            ).native.getDebugStats();
        const before = stats().topologyHashReads;
        const changes = await kettle.getTopologyChanges('/Kettle/Circle');
        assert.equal(changes.length, 1);
        assert.equal(stats().topologyHashReads - before, 1);
        // Later reads of any sample hit the digest cache.
        kettle.getTopology('/Kettle/Circle', { time: body.timeSampling!.sampleTimes[100] });
        assert.equal(stats().topologyHashReads - before, 1);
        kettle.close();
    });
});
