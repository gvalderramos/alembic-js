// Spec 0004: time sampling, interpolation, velocities, per-frame reads, async reads, three.js playback.
import * as assert from 'assert/strict';
import * as path from 'path';
import { after, before, describe, it } from 'node:test';
import * as THREE from 'three';

import { AbcFile, AbcPlayer, buildThreeScene, createTransformClip } from '../src';
import { assertAbcError, assertAbcErrorAsync, assertClose, fixture, kettlePath, repoRoot } from './helpers';

const F = (frame: number) => frame / 24;
const blender = (name: string) => path.join(repoRoot, 'resource', 'blender', name);

describe('time sampling', () => {
    let file: AbcFile;
    before(() => {
        file = AbcFile.open(fixture('animation'));
    });
    after(() => file.close());

    it('describes each object', () => {
        const spin = file.getObject('/spin')!.timeSampling!;
        assert.equal(spin.kind, 'uniform');
        assert.ok(Math.abs(spin.fps! - 24) < 1e-9);
        assertClose(spin.sampleTimes, [F(1), F(2), F(3)], 1e-9);

        const acyclic = file.getTimeSampling('/acyclic')!;
        assert.equal(acyclic.kind, 'acyclic');
        assert.equal(acyclic.fps, undefined);
        assertClose(acyclic.sampleTimes, [0, 0.1, 0.35], 1e-9);

        assert.ok(Math.abs(file.getTimeSampling('/thirty')!.fps! - 30) < 1e-9);
        assertAbcError(() => file.getTimeSampling('/missing'), 'ERR_ABC_OBJECT_NOT_FOUND');
    });

    it('reports topology variance', () => {
        assert.equal(file.getObject('/wave/waveShape')!.topology, 'homogeneous');
        assert.equal(file.getObject('/sim/simShape')!.topology, 'heterogeneous');
        assert.equal(file.getObject('/particles')!.topology, 'heterogeneous');
        assert.equal(file.getObject('/spin')!.topology, undefined);
    });

    it('computes the archive time range and frame rate from the objects', () => {
        const info = file.getInfo();
        assert.equal(info.fps, 24, 'most common rate among animated objects');
        assertClose([info.startTime, info.endTime], [0, 0.35], 1e-9);
        assertClose([info.frameRange!.start, info.frameRange!.end], [0, 0.35 * 24], 1e-9);
    });

    it('is consistent for static and real-world files', () => {
        const kettle = AbcFile.open(kettlePath);
        const info = kettle.getInfo();
        assert.equal(info.hasAnimation, false);
        assert.equal(info.startTime, info.endTime);
        assert.equal(info.fps, undefined);
        kettle.close();

        const camera = AbcFile.open(blender('camera_rigid_instances.abc'));
        const camInfo = camera.getInfo();
        assert.ok(Math.abs(camInfo.fps! - 30) < 1e-6);
        assertClose([camInfo.startTime, camInfo.endTime], [1 / 30, 2], 1e-9);
        camera.close();
    });
});

describe('sampling modes', () => {
    let file: AbcFile;
    before(() => {
        file = AbcFile.open(fixture('animation'));
    });
    after(() => file.close());

    const translationX = (m: number[]) => m[12];

    it("keeps 'near' as the default", () => {
        assert.equal(translationX(file.getTransform('/spin', { time: F(1.4) }).local), 0);
        assert.equal(translationX(file.getTransform('/spin', { time: F(1.6) }).local), 1);
    });

    it("uses the previous sample with 'floor'", () => {
        assert.equal(translationX(file.getTransform('/spin', { time: F(1.9), mode: 'floor' }).local), 0);
    });

    it('accepts frames instead of seconds', () => {
        assert.equal(translationX(file.getTransform('/spin', { frame: 3 }).local), 2);
        assertAbcError(() => file.getTransform('/spin', { frame: 1, time: 0 }), 'ERR_ABC_INVALID_ARGUMENT');
        const noFps = AbcFile.open(fixture('simple_mesh'));
        assertAbcError(() => noFps.getMesh('/plane', { frame: 1 }), 'ERR_ABC_INVALID_ARGUMENT', /frame rate/);
        noFps.close();
    });

    it('slerps rotations instead of skewing matrices', () => {
        const m = file.getTransform('/spin', { time: F(1.5), mode: 'interpolate' }).local;
        const c = Math.cos(Math.PI / 4);
        // Rotation by 45 degrees about Y (row-vector matrix), translation x = 0.5, no scale change.
        assertClose(m, [c, 0, -c, 0, 0, 1, 0, 0, c, 0, c, 0, 0.5, 0, 0, 1], 1e-6);
    });

    it('interpolates with acyclic sample times', () => {
        const m = file.getTransform('/acyclic', { time: 0.225, mode: 'interpolate' }).local;
        assert.ok(Math.abs(translationX(m) - 1.5) < 1e-9, `x = ${translationX(m)}`);
    });

    it('interpolates world matrices and cameras', () => {
        const mid = file.getTransform('/spin', { time: F(2.5), mode: 'interpolate' });
        assert.ok(Math.abs(translationX(mid.world) - 1.5) < 1e-9);

        const cam = AbcFile.open(blender('camera_rigid_instances.abc'));
        const focal = cam.getCamera('/ShotCam/ShotCam', { time: 30.5 / 30, mode: 'interpolate' }).focalLength;
        assert.ok(focal > 35 && focal < 50, `focal length ${focal}`);
        cam.close();
    });

    it('interpolates positions of meshes with constant topology', () => {
        const mesh = file.getMesh('/wave/waveShape', { time: F(1.5), mode: 'interpolate' });
        assert.equal(mesh.interpolated, true);
        assertClose([mesh.sampleTime], [F(1)], 1e-9);
        // Point i has y = (frame - 1) * (i % 4) * 0.1, so halfway between frames 1 and 2 it is 0.05 * (i % 4).
        for (let i = 0; i < 16; i++) {
            assert.ok(Math.abs(mesh.positions[i * 3 + 1] - 0.05 * (i % 4)) < 1e-6);
        }
        assert.equal(file.getMesh('/wave/waveShape', { time: F(1.5) }).interpolated, false);
    });

    it('falls back to the floor sample when the topology changes', () => {
        const mesh = file.getMesh('/sim/simShape', { time: F(1.5), mode: 'interpolate' });
        assert.equal(mesh.interpolated, false);
        assert.equal(mesh.faceCount, 1);
    });

    it('moves positions with velocities', () => {
        const dt = F(1.5) - F(1);
        const mesh = file.getMesh('/sim/simShape', { time: F(1.5), mode: 'floor', useVelocities: true });
        for (let v = 0; v < mesh.positions.length / 3; v++) {
            assert.ok(Math.abs(mesh.positions[v * 3 + 1] - dt) < 1e-6);
        }
        const scaled = file.getMesh('/sim/simShape', {
            time: F(1.5),
            mode: 'floor',
            useVelocities: true,
            velocityScale: 2,
        });
        assert.ok(Math.abs(scaled.positions[1] - 2 * dt) < 1e-6);
    });

    it('interpolates points by id and moves new points with velocities', () => {
        const points = file.getPoints('/particles', { time: F(1.5), mode: 'interpolate', useVelocities: true });
        // Frame 1 has ids 0 and 1 (y = 0); both exist on frame 2 (y = 1), so they are blended to y = 0.5.
        assert.equal(points.count, 2);
        assertClose([points.positions[1], points.positions[4]], [0.5, 0.5], 1e-6);
        // At frame 2 the newborn id 2 has no next sample: velocities (24 units/s) move it.
        const later = file.getPoints('/particles', { time: F(2.5), mode: 'interpolate', useVelocities: true });
        assert.equal(later.count, 3);
        assert.ok(Math.abs(later.positions[2 * 3 + 1] - (1 + 24 * F(0.5))) < 1e-5);
    });

    it('validates sample options', () => {
        assertAbcError(
            () => file.getTransform('/spin', { mode: 'linear' as unknown as 'near' }),
            'ERR_ABC_INVALID_ARGUMENT',
        );
        assertAbcError(
            () => file.getMesh('/wave/waveShape', { velocityScale: Number.NaN }),
            'ERR_ABC_INVALID_ARGUMENT',
        );
    });
});

describe('per-frame mesh reads', () => {
    it('returns positions in the getMesh layout without topology', () => {
        const file = AbcFile.open(fixture('animation'));
        const mesh = file.getMesh('/wave/waveShape', { time: F(1) });
        const frame = file.getMeshFrame('/wave/waveShape', { time: F(3) });
        assert.equal(frame.positions.length, mesh.positions.length);
        assert.equal(frame.layout, mesh.layout);
        assert.equal((frame as unknown as { indices?: unknown }).indices, undefined);
        assertClose(frame.positions, file.getMesh('/wave/waveShape', { time: F(3) }).positions);
        file.close();
    });

    it('reports topology changes', () => {
        const file = AbcFile.open(fixture('animation'));
        file.getMesh('/sim/simShape', { time: F(1) });
        assertAbcError(() => file.getMeshFrame('/sim/simShape', { time: F(2) }), 'ERR_ABC_TOPOLOGY_CHANGED');
        // After a new full read, frames of that topology work again.
        file.getMesh('/sim/simShape', { time: F(2) });
        assert.equal(file.getMeshFrame('/sim/simShape', { time: F(2) }).positions.length, 6 * 3);
        file.close();
    });

    it('keeps the layout of the options used, including attributes', () => {
        const file = AbcFile.open(blender('cloth_deform.abc'));
        const mesh = file.getMesh('/Cloth/ClothShape', { frame: 1, attributes: ['Col'] });
        const frame = file.getMeshFrame('/Cloth/ClothShape', { frame: 10, attributes: ['Col'] });
        assert.equal(frame.positions.length, mesh.positions.length);
        assert.ok(frame.attributes!.Col);
        assert.notDeepEqual(Array.from(frame.positions.slice(0, 30)), Array.from(mesh.positions.slice(0, 30)));
        file.close();
    });

    it('reads meshes and frames asynchronously', async () => {
        const file = AbcFile.open(fixture('animation'));
        const sync = file.getMesh('/wave/waveShape', { time: F(2) });
        const async = await file.getMeshAsync('/wave/waveShape', { time: F(2) });
        assertClose(async.positions, sync.positions);
        assert.deepEqual(Array.from(async.indices), Array.from(sync.indices));
        const frame = await file.getMeshFrameAsync('/wave/waveShape', { time: F(3), mode: 'interpolate' });
        assert.equal(frame.positions.length, sync.positions.length);
        await assertAbcErrorAsync(file.getMeshAsync('/spin'), 'ERR_ABC_UNSUPPORTED_TYPE');
        file.close();
    });

    it('survives close() while asynchronous reads are pending', async () => {
        const file = AbcFile.open(kettlePath);
        const pending = Array.from({ length: 8 }, (_, i) => file.getMeshAsync('/Kettle/Circle', { time: i / 24 }));
        file.close();
        const results = await Promise.allSettled(pending);
        assert.ok(results.every((r) => r.status === 'fulfilled'));
        assert.equal(
            (results[0] as PromiseFulfilledResult<{ positions: Float32Array }>).value.positions.length,
            103984 * 3,
        );
    });
});

describe('three.js playback', () => {
    it('updates transforms and mesh positions in place', () => {
        const file = AbcFile.open(fixture('animation'));
        const root = buildThreeScene(file, THREE, { time: F(1) }) as THREE.Group;
        const player = new AbcPlayer(file, root, THREE, { mode: 'interpolate' });
        assert.ok(player.animatedPaths.includes('/wave/waveShape'));
        assert.ok(Math.abs(player.duration - 0.35) < 1e-9);

        const wave = root.getObjectByName('waveShape') as THREE.Mesh;
        const position = wave.geometry.getAttribute('position');
        player.setTime(F(2));
        assert.equal(wave.geometry.getAttribute('position'), position, 'same attribute instance');
        assert.ok(Math.abs(position.getY(3) - 0.3) < 1e-6);

        const spin = root.getObjectByName('spin')!;
        player.setTime(F(1.5));
        assert.ok(Math.abs(spin.position.x - 0.5) < 1e-6);
        file.close();
    });

    it('rebuilds geometry when the topology changes', () => {
        const file = AbcFile.open(fixture('animation'));
        const root = buildThreeScene(file, THREE, { time: F(1) }) as THREE.Group;
        const player = new AbcPlayer(file, root, THREE);
        const sim = root.getObjectByName('simShape') as THREE.Mesh;
        assert.equal(sim.geometry.getAttribute('position').count, 4);
        player.setTime(F(3));
        assert.equal(sim.geometry.getAttribute('position').count, 8);
        const particles = root.getObjectByName('particles') as THREE.Points;
        assert.equal(particles.geometry.getAttribute('position').count, 3);
        file.close();
    });

    it('advances, loops and pauses', () => {
        const file = AbcFile.open(fixture('animation'));
        const root = buildThreeScene(file, THREE) as THREE.Group;
        const player = new AbcPlayer(file, root, THREE);
        player.update(0.1);
        assert.ok(Math.abs(player.time - 0.1) < 1e-9);
        player.update(0.3); // 0.4 wraps to 0.05
        assert.ok(Math.abs(player.time - 0.05) < 1e-9);
        player.pause();
        player.update(0.1);
        assert.ok(Math.abs(player.time - 0.05) < 1e-9);

        const once = new AbcPlayer(file, root, THREE, { loop: false });
        once.update(1);
        assert.equal(once.time, 0.35);
        assert.equal(once.playing, false);
        file.close();
    });

    it('bakes transforms into an AnimationClip', () => {
        const file = AbcFile.open(fixture('animation'));
        const root = buildThreeScene(file, THREE) as THREE.Group;
        const clip = createTransformClip(file, root, THREE) as THREE.AnimationClip;
        // spin, acyclic and thirty are animated xforms: 3 tracks each.
        assert.equal(clip.tracks.length, 9);
        const mixer = new THREE.AnimationMixer(root);
        mixer.clipAction(clip).play();
        mixer.setTime(F(3));
        const spin = root.getObjectByName('spin')!;
        assert.ok(Math.abs(spin.position.x - 2) < 1e-6);
        const expected = new THREE.Matrix4().fromArray(file.getTransform('/spin', { time: F(3) }).local);
        spin.updateMatrix();
        assert.ok(
            spin.matrix.equals(expected) ||
                spin.matrix.elements.every((v, i) => Math.abs(v - expected.elements[i]) < 1e-6),
        );

        const resampled = createTransformClip(file, root, THREE, { fps: 24 }) as THREE.AnimationClip;
        assert.equal(resampled.tracks[0].times.length, Math.floor(0.35 * 24 + 1e-6) + 1);
        file.close();
    });
});
