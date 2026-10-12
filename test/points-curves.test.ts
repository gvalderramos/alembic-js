// Spec 0002: points and curves.
import * as assert from 'assert/strict';
import * as path from 'path';
import { after, before, describe, it } from 'node:test';
import * as THREE from 'three';

import {
    AbcFile,
    buildThreeScene,
    tessellateCurves,
    toLineSegments,
    toPoints,
    usePointWidths,
    widthsPerVertex,
    type AbcCurves,
} from '../src';
import { assertAbcError, assertClose, fixture, repoRoot, translation } from './helpers';

const blender = (name: string) => path.join(repoRoot, 'resource', 'blender', name);

describe('points', () => {
    let file: AbcFile;
    before(() => {
        file = AbcFile.open(fixture('points_and_curves'));
    });
    after(() => file.close());

    it('reads positions, ids, velocities and widths', () => {
        const points = file.getPoints('/particles', { time: 1 / 24 });
        assert.equal(points.type, 'points');
        assert.equal(points.count, 4);
        assertClose(points.positions, [0, 0, 0, 1, 0, 0, 2, 0, 0, 3, 0, 0]);
        assert.ok(points.ids instanceof BigUint64Array);
        assert.deepEqual(Array.from(points.ids!), [10n, 11n, 12n, 13n]);
        assertClose(points.velocities!, [1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0]);
        assertClose(points.widths!, [0.1, 0.2, 0.3, 0.4]);
        assert.equal(points.widthScope, 'vertex');
        assertClose(points.transform, translation(0, 0, 0));
    });

    it('samples over time', () => {
        const second = file.getPoints('/particles', { time: 2 / 24 });
        assertClose(second.positions.slice(0, 3), [1 / 24, 0, 0], 1e-6);
    });

    it('lists every points object', () => {
        assert.deepEqual(
            file.getAllPoints().map((p) => p.path),
            ['/particles'],
        );
    });

    it('reads empty point clouds and particles that are born and die (Blender)', () => {
        const particles = AbcFile.open(blender('particles.abc'));
        const count = (frame: number) => particles.getPoints('/Emitter/Spray', { time: frame / 30 }).count;
        assert.equal(count(1), 1);
        assert.ok(count(15) > count(5), 'particles are being born');
        assert.ok(count(30) < count(20), 'particles are dying');
        const empty = particles.getPoints('/Emitter/Spray', { time: 36 / 30 });
        assert.equal(empty.count, 0);
        assert.equal(empty.positions.length, 0);
        assert.equal(empty.ids, undefined);
        particles.close();
    });

    it('rejects other object types', () => {
        assertAbcError(() => file.getPoints('/bezierCurve'), 'ERR_ABC_UNSUPPORTED_TYPE');
        assertAbcError(() => file.getMesh('/particles'), 'ERR_ABC_UNSUPPORTED_TYPE', /use getPoints\(\)/);
        assertAbcError(() => file.getPoints('/missing'), 'ERR_ABC_OBJECT_NOT_FOUND');
    });
});

describe('curves', () => {
    let file: AbcFile;
    before(() => {
        file = AbcFile.open(fixture('points_and_curves'));
    });
    after(() => file.close());

    it('reads linear curves with per-curve widths', () => {
        const curves = file.getCurves('/linearCurves');
        assert.equal(curves.type, 'curves');
        assert.deepEqual(Array.from(curves.vertexCounts), [3, 4]);
        assert.equal(curves.curveCount, 2);
        assert.equal(curves.curveType, 'linear');
        assert.equal(curves.periodic, false);
        assert.equal(curves.widthScope, 'uniform');
        assertClose(curves.widths!, [0.1, 0.2]);
        assert.equal(curves.uvs, undefined);
        assert.equal(curves.knots, undefined);
    });

    it('reads cubic curves, bases and optional attributes', () => {
        const bezier = file.getCurves('/bezierCurve');
        assert.deepEqual([bezier.curveType, bezier.basis, bezier.widthScope], ['cubic', 'bezier', 'constant']);
        const bspline = file.getCurves('/bsplineCurve');
        assert.deepEqual([bspline.basis, bspline.widthScope], ['bspline', 'vertex']);
        assert.equal(bspline.uvs!.length, 10);
        assert.equal(file.getCurves('/linearLoop').periodic, true);
    });

    it('reads NURBS data', () => {
        const arc = file.getCurves('/nurbsArc');
        assert.equal(arc.curveType, 'variableOrder');
        assert.deepEqual(Array.from(arc.orders!), [3]);
        assertClose(arc.knots!, [0, 0, 0, 1, 1, 1]);
        assertClose(arc.weights!, [1, Math.SQRT1_2, 1]);
    });

    it('rejects malformed vertex counts', () => {
        assertAbcError(() => file.getCurves('/badCurves'), 'ERR_ABC_MALFORMED_DATA', /3 positions but 5/);
        assertAbcError(() => file.getCurves('/particles'), 'ERR_ABC_UNSUPPORTED_TYPE');
        assertAbcError(() => file.getMesh('/bezierCurve'), 'ERR_ABC_UNSUPPORTED_TYPE', /use getCurves\(\)/);
    });

    it('handles Blender curves, including mislabeled and per-span widths', () => {
        const curves = AbcFile.open(blender('curves_hair.abc'));
        // Blender labels per-vertex widths as 'constant'; the scope is inferred from the count.
        assert.equal(curves.getCurves('/PolyLine/PolyLine').widthScope, 'vertex');
        const fur = curves.getCurves('/Fur/Fur');
        assert.equal(fur.curveCount, 64);
        assert.equal(fur.widthScope, 'vertex');
        // Bezier handles are exported as control vertices: 3 points become 7 CVs with 3 widths (one per span end).
        const bezier = curves.getCurves('/Bezier/Bezier');
        assert.equal(bezier.positions.length / 3, 7);
        assert.equal(bezier.widthScope, 'varying');
        const nurbs = curves.getCurves('/NurbsLoop/NurbsLoop');
        assert.deepEqual([nurbs.curveType, nurbs.periodic, nurbs.orders![0]], ['variableOrder', true, 4]);
        assert.equal(curves.getAllCurves().length, 4);
        curves.close();
    });
});

describe('curve evaluation', () => {
    const curve = (overrides: Partial<AbcCurves>): AbcCurves => ({
        name: 'c',
        path: '/c',
        type: 'curves',
        positions: new Float32Array(),
        vertexCounts: new Int32Array(),
        curveCount: 1,
        curveType: 'linear',
        periodic: false,
        basis: 'none',
        transform: translation(0, 0, 0),
        ...overrides,
    });
    const point = (t: { positions: Float32Array }, i: number) => Array.from(t.positions.slice(i * 3, i * 3 + 3));

    it('keeps linear curves and stops segments at curve boundaries', () => {
        const file = AbcFile.open(fixture('points_and_curves'));
        const t = tessellateCurves(file.getCurves('/linearCurves'));
        assert.equal(t.positions.length / 3, 7);
        assert.deepEqual(Array.from(t.indices), [0, 1, 1, 2, 3, 4, 4, 5, 5, 6]);
        assert.deepEqual(Array.from(t.curveOffsets), [0, 3, 7]);
        file.close();
    });

    it('closes periodic linear curves', () => {
        const loop = curve({
            positions: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0]),
            vertexCounts: new Int32Array([3]),
            periodic: true,
        });
        assert.deepEqual(Array.from(tessellateCurves(loop).indices), [0, 1, 1, 2, 2, 0]);
    });

    it('evaluates Bezier curves through their end points', () => {
        const file = AbcFile.open(fixture('points_and_curves'));
        const t = tessellateCurves(file.getCurves('/bezierCurve'), { segmentsPerSpan: 4 });
        assert.equal(t.positions.length / 3, 5);
        assertClose(point(t, 0), [0, 0, 0]);
        assertClose(point(t, 2), [0.5, 0.75, 0]); // B(0.5) of (0,0) (0,1) (1,1) (1,0)
        assertClose(point(t, 4), [1, 0, 0]);
        file.close();
    });

    it('evaluates uniform B-splines and Catmull-Rom splines', () => {
        const cvs = new Float32Array([0, 0, 0, 1, 2, 0, 2, 0, 0, 3, 2, 0, 4, 0, 0]);
        const bspline = tessellateCurves(
            curve({ positions: cvs, vertexCounts: new Int32Array([5]), curveType: 'cubic', basis: 'bspline' }),
            { segmentsPerSpan: 2 },
        );
        // Two spans, 2 segments each, plus the end point. Span start = (P0 + 4 P1 + P2) / 6.
        assert.equal(bspline.positions.length / 3, 5);
        assertClose(point(bspline, 0), [1, 8 / 6, 0], 1e-6);

        const catmull = tessellateCurves(
            curve({ positions: cvs, vertexCounts: new Int32Array([5]), curveType: 'cubic', basis: 'catmullrom' }),
            { segmentsPerSpan: 2 },
        );
        // Catmull-Rom passes through the inner control vertices.
        assertClose(point(catmull, 0), [1, 2, 0]);
        assertClose(point(catmull, 2), [2, 0, 0]);
        assertClose(point(catmull, 4), [3, 2, 0]);
    });

    it('evaluates rational NURBS exactly (quarter circle)', () => {
        const file = AbcFile.open(fixture('points_and_curves'));
        const t = tessellateCurves(file.getCurves('/nurbsArc'), { segmentsPerSpan: 8 });
        assert.equal(t.positions.length / 3, 9);
        for (let i = 0; i < 9; i++) {
            const [x, y] = point(t, i);
            assert.ok(Math.abs(Math.hypot(x, y) - 1) < 1e-6, `point ${i} is off the unit circle`);
        }
        assertClose(point(t, 0), [1, 0, 0]);
        assertClose(point(t, 8), [0, 1, 0], 1e-6);
        file.close();
    });

    it('accepts knot vectors without end knots', () => {
        const arc = curve({
            positions: new Float32Array([1, 0, 0, 1, 1, 0, 0, 1, 0]),
            vertexCounts: new Int32Array([3]),
            curveType: 'variableOrder',
            basis: 'bspline',
            orders: new Uint8Array([3]),
            knots: new Float32Array([0, 0, 1, 1]),
            weights: new Float32Array([1, Math.SQRT1_2, 1]),
        });
        const t = tessellateCurves(arc, { segmentsPerSpan: 4 });
        const [x, y] = point(t, 2);
        assertClose([x, y], [Math.SQRT1_2, Math.SQRT1_2], 1e-6);
    });

    it('draws the control polygon for bases without an evaluator', () => {
        const hermite = curve({
            positions: new Float32Array([0, 0, 0, 1, 0, 0, 2, 0, 0, 3, 0, 0]),
            vertexCounts: new Int32Array([4]),
            curveType: 'cubic',
            basis: 'hermite',
        });
        assert.equal(tessellateCurves(hermite).positions.length / 3, 4);
    });

    it('expands widths to one per control vertex', () => {
        const file = AbcFile.open(fixture('points_and_curves'));
        assertClose(widthsPerVertex(file.getCurves('/linearCurves'))!, [0.1, 0.1, 0.1, 0.2, 0.2, 0.2, 0.2]);
        assertClose(widthsPerVertex(file.getCurves('/bezierCurve'))!, [0.5, 0.5, 0.5, 0.5]);
        assert.equal(widthsPerVertex(file.getCurves('/linearLoop')), undefined);
        file.close();

        const curves = AbcFile.open(blender('curves_hair.abc'));
        const bezier = curves.getCurves('/Bezier/Bezier');
        const widths = widthsPerVertex(bezier)!;
        assert.equal(widths.length, 7);
        assertClose([widths[0], widths[6]], [bezier.widths![0], bezier.widths![2]]);
        curves.close();
    });
});

describe('three.js points and curves', () => {
    it('creates Points with per-point sizes and velocities', () => {
        const file = AbcFile.open(fixture('points_and_curves'));
        const points = toPoints(file.getPoints('/particles'), THREE) as THREE.Points;
        assert.equal(points.type, 'Points');
        assert.equal(points.geometry.getAttribute('position').count, 4);
        assert.equal(points.geometry.getAttribute('pointWidth').count, 4);
        assert.equal(points.geometry.getAttribute('velocity').itemSize, 3);
        assert.deepEqual(Array.from(points.userData.ids as BigUint64Array), [10n, 11n, 12n, 13n]);
        assert.equal(typeof (points.material as THREE.PointsMaterial).onBeforeCompile, 'function');

        const fixed = toPoints(file.getPoints('/particles'), THREE, { sizeFromWidths: false }) as THREE.Points;
        assert.equal(fixed.geometry.getAttribute('pointWidth'), undefined);
        assert.equal((fixed.material as THREE.PointsMaterial).size, 0.05);
        file.close();
    });

    it('patches the points shader to use per-point widths', () => {
        const material = usePointWidths(new THREE.PointsMaterial());
        const shader = { vertexShader: THREE.ShaderLib.points.vertexShader };
        material.onBeforeCompile(shader);
        assert.match(shader.vertexShader, /attribute float pointWidth;/);
        assert.match(shader.vertexShader, /gl_PointSize = size \* pointWidth;/);
    });

    it('creates LineSegments from evaluated curves', () => {
        const file = AbcFile.open(fixture('points_and_curves'));
        const lines = toLineSegments(file.getCurves('/bezierCurve'), THREE, {
            segmentsPerSpan: 4,
        }) as THREE.LineSegments;
        assert.equal(lines.type, 'LineSegments');
        assert.equal(lines.geometry.getAttribute('position').count, 5);
        assert.equal(lines.geometry.getIndex()!.count, 8);
        assert.equal((lines.userData.controlVertexWidths as Float32Array).length, 4);
        file.close();
    });

    it('builds points and curves into the scene', () => {
        const file = AbcFile.open(blender('curves_hair.abc'));
        const root = buildThreeScene(file, THREE, { segmentsPerSpan: 4 }) as THREE.Group;
        const lines: THREE.LineSegments[] = [];
        root.traverse((node) => {
            if ((node as THREE.LineSegments).isLineSegments) lines.push(node as THREE.LineSegments);
        });
        assert.equal(lines.length, 4);
        assert.ok(!new THREE.Box3().setFromObject(root).isEmpty());
        file.close();
    });
});
