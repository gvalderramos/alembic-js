import * as assert from 'assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { AlembicError, type AbcErrorCode } from '../src';

// Tests run from bin-test/test, so walk back to the repository root.
export const repoRoot = path.resolve(__dirname, '..', '..');

/** Fixtures written by tools/generate_fixtures.cpp (`yarn fixtures`). */
export function fixture(name: 'simple_mesh' | 'transformed_mesh' | 'nested_hierarchy' | 'unsupported_types'): string {
    return path.join(repoRoot, 'test', 'fixtures', `${name}.abc`);
}

export const kettlePath = path.join(repoRoot, 'resource', 'Ancient_Kettle.abc');

/** Writes `contents` to a fresh temp file and returns its path. */
export function tempFile(name: string, contents: string | Buffer): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alembic-js-'));
    const file = path.join(dir, name);
    fs.writeFileSync(file, contents);
    return file;
}

export function assertAbcError(fn: () => unknown, code: AbcErrorCode, message?: RegExp): AlembicError {
    let caught: unknown;
    try {
        fn();
    } catch (error) {
        caught = error;
    }
    assert.ok(caught instanceof AlembicError, `expected AlembicError ${code}, got ${String(caught)}`);
    assert.equal(caught.code, code, caught.message);
    if (message) {
        assert.match(caught.message, message);
    }
    return caught;
}

export async function assertAbcErrorAsync(promise: Promise<unknown>, code: AbcErrorCode): Promise<AlembicError> {
    try {
        await promise;
    } catch (error) {
        assert.ok(error instanceof AlembicError, `expected AlembicError ${code}, got ${String(error)}`);
        assert.equal(error.code, code, error.message);
        return error;
    }
    assert.fail(`expected promise to reject with ${code}`);
}

export function assertClose(actual: ArrayLike<number>, expected: ArrayLike<number>, epsilon = 1e-6): void {
    assert.equal(actual.length, expected.length, 'length mismatch');
    for (let i = 0; i < expected.length; i++) {
        assert.ok(Math.abs(actual[i] - expected[i]) <= epsilon,
            `index ${i}: expected ${expected[i]}, got ${actual[i]} (${Array.from(actual).join(', ')})`);
    }
}

export function translation(x: number, y: number, z: number, scale = 1): number[] {
    return [scale, 0, 0, 0, 0, scale, 0, 0, 0, 0, scale, 0, x, y, z, 1];
}

/** Geometric (right-handed, counter-clockwise) normal of triangle `t`. */
export function triangleNormal(positions: Float32Array, indices: Uint32Array, t: number): [number, number, number] {
    const p = (k: number) => {
        const i = indices[t * 3 + k] * 3;
        return [positions[i], positions[i + 1], positions[i + 2]];
    };
    const [a, b, c] = [p(0), p(1), p(2)];
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    return [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
}
