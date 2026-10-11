import * as assert from 'assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { describe, it } from 'node:test';

import { AbcFile, AlembicError, isAlembicError } from '../src';
import { assertAbcError, assertAbcErrorAsync, fixture, tempFile } from './helpers';

describe('file loading', () => {
    it('loads a valid archive synchronously', () => {
        const file = new AbcFile(fixture('simple_mesh'));
        assert.equal(file.isLoaded, false);
        file.load();
        assert.equal(file.isLoaded, true);
        file.close();
    });

    it('loads a valid archive asynchronously', async () => {
        const file = await AbcFile.openAsync(fixture('nested_hierarchy'));
        assert.equal(file.isLoaded, true);
        assert.equal(file.getInfo().objectCount, 5);
        file.close();
    });

    it('resolves the path to an absolute path', () => {
        const relative = path.relative(process.cwd(), fixture('simple_mesh'));
        const file = AbcFile.open(relative);
        assert.equal(file.path, fixture('simple_mesh'));
        assert.equal(file.getInfo().path, fixture('simple_mesh'));
        file.close();
    });

    it('can be closed and loaded again', () => {
        const file = AbcFile.open(fixture('simple_mesh'));
        file.close();
        assert.equal(file.isLoaded, false);
        assertAbcError(() => file.getObjects(), 'ERR_ABC_NOT_LOADED');
        file.load();
        assert.equal(file.getObjects().length, 1);
        file.close();
    });

    it('allows several archives to be open at once', () => {
        const a = AbcFile.open(fixture('simple_mesh'));
        const b = AbcFile.open(fixture('transformed_mesh'));
        assert.equal(a.getObjects().length, 1);
        assert.equal(b.getObjects().length, 2);
        a.close();
        b.close();
    });
});

describe('input validation', () => {
    it('rejects empty and non-string paths', () => {
        assertAbcError(() => new AbcFile(''), 'ERR_ABC_INVALID_ARGUMENT');
        assertAbcError(() => new AbcFile('   '), 'ERR_ABC_INVALID_ARGUMENT');
        assertAbcError(() => new AbcFile(42 as unknown as string), 'ERR_ABC_INVALID_ARGUMENT');
        assertAbcError(() => new AbcFile(undefined as unknown as string), 'ERR_ABC_INVALID_ARGUMENT');
    });

    it('reports missing files', () => {
        const missing = path.join(__dirname, 'does-not-exist.abc');
        const error = assertAbcError(() => AbcFile.open(missing), 'ERR_ABC_FILE_NOT_FOUND', /not found/);
        assert.equal(error.file, missing);
        assert.ok(isAlembicError(error));
        assert.ok(error instanceof Error);
        assert.equal(error.name, 'AlembicError');
    });

    it('reports missing files asynchronously', async () => {
        await assertAbcErrorAsync(AbcFile.openAsync(path.join(__dirname, 'nope.abc')), 'ERR_ABC_FILE_NOT_FOUND');
    });

    it('rejects directories', () => {
        assertAbcError(() => AbcFile.open(__dirname), 'ERR_ABC_INVALID_ARGUMENT', /not a regular file/);
    });

    it('reports files that are not Alembic archives', () => {
        const bogus = tempFile('bogus.abc', 'this is not an alembic archive');
        assertAbcError(() => AbcFile.open(bogus), 'ERR_ABC_INVALID_ARCHIVE', /not a valid Alembic archive/);
    });

    it('reports empty files', async () => {
        const empty = tempFile('empty.abc', '');
        assertAbcError(() => AbcFile.open(empty), 'ERR_ABC_INVALID_ARCHIVE');
        await assertAbcErrorAsync(AbcFile.openAsync(empty), 'ERR_ABC_INVALID_ARCHIVE');
    });

    it('reports truncated archives', () => {
        const bytes = fs.readFileSync(fixture('nested_hierarchy'));
        const truncated = tempFile('truncated.abc', bytes.subarray(0, Math.floor(bytes.length / 2)));
        let error: unknown;
        try {
            const file = AbcFile.open(truncated);
            // Ogawa may open a truncated file and only fail when data is read.
            file.getMeshes();
            file.close();
        } catch (e) {
            error = e;
        }
        assert.ok(error instanceof AlembicError, 'expected an AlembicError for a truncated archive');
        assert.ok(['ERR_ABC_INVALID_ARCHIVE', 'ERR_ABC_READ_FAILED', 'ERR_ABC_MALFORMED_DATA'].includes(error.code),
            `unexpected code ${error.code}`);
    });

    it('requires load() before reading', () => {
        const file = new AbcFile(fixture('simple_mesh'));
        assertAbcError(() => file.getInfo(), 'ERR_ABC_NOT_LOADED');
        assertAbcError(() => file.getObjects(), 'ERR_ABC_NOT_LOADED');
        assertAbcError(() => file.getObject('/plane'), 'ERR_ABC_NOT_LOADED');
        assertAbcError(() => file.getMesh('/plane'), 'ERR_ABC_NOT_LOADED');
        assertAbcError(() => file.getTransform('/plane'), 'ERR_ABC_NOT_LOADED');
    });
});

describe('metadata', () => {
    it('exposes archive information', () => {
        const file = AbcFile.open(fixture('simple_mesh'));
        const info = file.getInfo();
        assert.equal(info.path, fixture('simple_mesh'));
        assert.equal(info.coreType, 'ogawa');
        assert.equal(info.appName, 'alembic-js fixture generator');
        assert.equal(info.userDescription, 'alembic-js unit test fixture');
        assert.ok(info.libraryVersion >= 10700, `libraryVersion ${info.libraryVersion}`);
        assert.match(info.libraryVersionString, /^Alembic \d+\.\d+\.\d+/);
        assert.ok(info.whenWritten.length > 0);
        assert.equal(info.objectCount, 1);
        assert.equal(info.hasAnimation, false);
        file.close();
    });

    it('detects animation and the archive time range', () => {
        const file = AbcFile.open(fixture('nested_hierarchy'));
        const info = file.getInfo();
        assert.equal(info.hasAnimation, true);
        assert.ok(Math.abs(info.startTime - 1 / 24) < 1e-9, `startTime ${info.startTime}`);
        assert.ok(Math.abs(info.endTime - 3 / 24) < 1e-9, `endTime ${info.endTime}`);
        file.close();
    });
});
