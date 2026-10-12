/**
 * Curve evaluation (spec 0002), independent of three.js so it can be unit tested
 * and used with any renderer. Turns Alembic control vertices into polylines.
 */
import type { AbcCurves } from './types';

export interface TessellateOptions {
    /** Points evaluated per span of a cubic or NURBS curve. Default 8. */
    segmentsPerSpan?: number;
}

export interface TessellatedCurves {
    /** xyz of every evaluated point, curve after curve. */
    positions: Float32Array;
    /** Line segments as index pairs into `positions` (for THREE.LineSegments). */
    indices: Uint32Array;
    /** First point of each curve in `positions` (length curveCount + 1). */
    curveOffsets: Uint32Array;
}

type Vec3 = [number, number, number];
type Basis = (t: number) => [number, number, number, number];

const BEZIER: Basis = (t) => {
    const u = 1 - t;
    return [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t];
};
const BSPLINE: Basis = (t) => {
    const t2 = t * t;
    const t3 = t2 * t;
    return [(1 - t) ** 3 / 6, (3 * t3 - 6 * t2 + 4) / 6, (-3 * t3 + 3 * t2 + 3 * t + 1) / 6, t3 / 6];
};
const CATMULL_ROM: Basis = (t) => {
    const t2 = t * t;
    const t3 = t2 * t;
    return [(-t3 + 2 * t2 - t) / 2, (3 * t3 - 5 * t2 + 2) / 2, (-3 * t3 + 4 * t2 + t) / 2, (t3 - t2) / 2];
};

function combine(basis: Basis, p: Vec3[], t: number): Vec3 {
    const w = basis(t);
    return [0, 1, 2].map((k) => w[0] * p[0][k] + w[1] * p[1][k] + w[2] * p[2][k] + w[3] * p[3][k]) as Vec3;
}

/** Evaluates a cubic curve made of 4-point windows. */
function cubic(cvs: Vec3[], basis: Basis, step: number, periodic: boolean, segments: number): Vec3[] {
    const n = cvs.length;
    const at = (i: number) => cvs[((i % n) + n) % n];
    const spans = periodic ? Math.floor(n / step) : Math.floor((n - 4) / step) + 1;
    if (n < 4 || spans < 1) {
        return cvs; // not enough control vertices: draw the control polygon
    }
    const out: Vec3[] = [];
    for (let s = 0; s < spans; s++) {
        const window = [0, 1, 2, 3].map((k) => at(s * step + k));
        const last = !periodic && s === spans - 1;
        for (let j = 0; j < segments + (last ? 1 : 0); j++) {
            out.push(combine(basis, window, j / segments));
        }
    }
    return out;
}

/** de Boor evaluation of a (rational) B-spline of the given order. */
function nurbs(cvs: Vec3[], weights: number[] | undefined, order: number, knots: number[], segments: number): Vec3[] {
    const n = cvs.length;
    const degree = order - 1;
    const lo = knots[degree];
    const hi = knots[n];
    const spans = Math.max(1, n - degree);
    const total = spans * segments;
    const out: Vec3[] = [];
    for (let j = 0; j <= total; j++) {
        const u = Math.min(lo + ((hi - lo) * j) / total, hi - 1e-9 * (hi - lo || 1));
        let k = degree;
        while (k < n - 1 && u >= knots[k + 1]) k++;
        // Homogeneous control points for this knot span.
        const d = Array.from({ length: order }, (_, r) => {
            const i = k - degree + r;
            const w = weights ? weights[i] : 1;
            return [cvs[i][0] * w, cvs[i][1] * w, cvs[i][2] * w, w];
        });
        for (let r = 1; r <= degree; r++) {
            for (let i = degree; i >= r; i--) {
                const left = knots[k - degree + i];
                const right = knots[k + 1 + i - r];
                const alpha = right === left ? 0 : (u - left) / (right - left);
                d[i] = d[i].map((v, c) => (1 - alpha) * d[i - 1][c] + alpha * v);
            }
        }
        const p = d[degree];
        out.push([p[0] / p[3], p[1] / p[3], p[2] / p[3]]);
    }
    return out;
}

/** Knot vector for a curve: as written (n + order values, or n + order - 2 without end knots), or uniform. */
function knotVector(written: number[] | undefined, n: number, order: number): number[] {
    if (written && written.length === n + order) {
        return written;
    }
    if (written && written.length === n + order - 2 && written.length > 0) {
        return [written[0], ...written, written[written.length - 1]];
    }
    return Array.from({ length: n + order }, (_, i) => i);
}

/** Converts curves into polylines; cubic and NURBS curves are evaluated, linear ones are kept as is. */
export function tessellateCurves(curves: AbcCurves, options: TessellateOptions = {}): TessellatedCurves {
    const segments = Math.max(1, Math.floor(options.segmentsPerSpan ?? 8));
    const positions: number[] = [];
    const indices: number[] = [];
    const offsets: number[] = [0];
    let cv = 0;
    let knotOffset = 0;
    // Knots are concatenated per curve, either n + order values each or n + order - 2 (without end knots).
    const orderOf = (c: number) => curves.orders?.[c] ?? 4;
    const fullKnots = curves.vertexCounts.reduce((sum, n, c) => sum + n + orderOf(c), 0);
    const knotsPerCurveTrimmed = curves.knots !== undefined && curves.knots.length !== fullKnots;

    for (let c = 0; c < curves.vertexCounts.length; c++) {
        const n = curves.vertexCounts[c];
        const cvs: Vec3[] = [];
        for (let i = 0; i < n; i++) {
            const p = (cv + i) * 3;
            cvs.push([curves.positions[p], curves.positions[p + 1], curves.positions[p + 2]]);
        }
        const weights = curves.weights ? Array.from(curves.weights.subarray(cv, cv + n)) : undefined;
        let points: Vec3[];
        let closed = curves.periodic;

        if (curves.curveType === 'variableOrder') {
            const order = orderOf(c);
            const knotCount = knotsPerCurveTrimmed ? n + order - 2 : n + order;
            const written = curves.knots
                ? Array.from(curves.knots.subarray(knotOffset, knotOffset + knotCount))
                : undefined;
            knotOffset += curves.knots ? knotCount : 0;
            if (order <= 2 || n < order) {
                points = cvs;
            } else if (curves.periodic) {
                // Periodic: wrap the first order-1 control vertices, uniform knots.
                const wrapped = [...cvs, ...cvs.slice(0, order - 1)];
                const wrappedWeights = weights ? [...weights, ...weights.slice(0, order - 1)] : undefined;
                points = nurbs(wrapped, wrappedWeights, order, knotVector(undefined, wrapped.length, order), segments);
                points.pop(); // the last point repeats the first
            } else {
                points = nurbs(cvs, weights, order, knotVector(written, n, order), segments);
                closed = false;
            }
        } else if (curves.curveType === 'cubic' && curves.basis === 'bezier') {
            points = cubic(cvs, BEZIER, 3, curves.periodic, segments);
        } else if (curves.curveType === 'cubic' && curves.basis === 'bspline') {
            points = cubic(cvs, BSPLINE, 1, curves.periodic, segments);
        } else if (curves.curveType === 'cubic' && curves.basis === 'catmullrom') {
            points = cubic(cvs, CATMULL_ROM, 1, curves.periodic, segments);
        } else {
            // Linear curves, and bases without an evaluator (hermite, power, none): control polygon.
            points = cvs;
        }

        const start = positions.length / 3;
        for (const p of points) positions.push(p[0], p[1], p[2]);
        for (let i = 0; i + 1 < points.length; i++) indices.push(start + i, start + i + 1);
        if (closed && points.length > 2) indices.push(start + points.length - 1, start);
        offsets.push(positions.length / 3);
        cv += n;
    }
    return {
        positions: new Float32Array(positions),
        indices: new Uint32Array(indices),
        curveOffsets: new Uint32Array(offsets),
    };
}

/**
 * Expands curve widths to one value per control vertex, whatever scope they were written with
 * ('varying' widths are interpolated along each curve).
 */
export function widthsPerVertex(curves: AbcCurves): Float32Array | undefined {
    const { widths, widthScope, vertexCounts } = curves;
    if (!widths) {
        return undefined;
    }
    const total = curves.positions.length / 3;
    const out = new Float32Array(total);
    let cv = 0;
    let varyingOffset = 0;
    for (let c = 0; c < vertexCounts.length; c++) {
        const n = vertexCounts[c];
        if (widthScope === 'constant') {
            out.fill(widths[0], cv, cv + n);
        } else if (widthScope === 'uniform') {
            out.fill(widths[c], cv, cv + n);
        } else if (widthScope === 'varying') {
            // Count the span ends of this curve from the remaining widths.
            const perCurve = Math.round((widths.length - varyingOffset) / (vertexCounts.length - c));
            const local = widths.subarray(varyingOffset, varyingOffset + perCurve);
            for (let i = 0; i < n; i++) {
                const t = n > 1 ? (i / (n - 1)) * (local.length - 1) : 0;
                const a = Math.floor(t);
                const b = Math.min(a + 1, local.length - 1);
                out[cv + i] = local[a] + (local[b] - local[a]) * (t - a);
            }
            varyingOffset += perCurve;
        } else {
            out.set(widths.subarray(cv, cv + n), cv);
        }
        cv += n;
    }
    return out;
}
