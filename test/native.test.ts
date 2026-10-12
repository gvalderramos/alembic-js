// Spec 0005: selecting the right native addon for the platform, architecture and libc.
import * as assert from 'assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it } from 'node:test';

import { AlembicError } from '../src';
import { addonCandidates, detectLibc, findAddon, prebuildName } from '../src/native';

function fakePackage(prebuilds: string[], withBuild = false): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'alembic-js-pkg-'));
    fs.writeFileSync(path.join(root, 'package.json'), '{}');
    for (const name of prebuilds) {
        fs.mkdirSync(path.join(root, 'prebuilds', name), { recursive: true });
        fs.writeFileSync(path.join(root, 'prebuilds', name, 'alembic-js.node'), '');
    }
    if (withBuild) {
        fs.mkdirSync(path.join(root, 'build'));
        fs.writeFileSync(path.join(root, 'build', 'alembic-js.node'), '');
    }
    fs.mkdirSync(path.join(root, 'bin'));
    return root;
}

describe('native addon selection', () => {
    it('names prebuild directories by platform, arch and libc', () => {
        assert.equal(prebuildName({ platform: 'linux', arch: 'x64', libc: 'glibc' }), 'linux-x64');
        assert.equal(prebuildName({ platform: 'linux', arch: 'arm64', libc: 'musl' }), 'linux-arm64-musl');
        assert.equal(prebuildName({ platform: 'darwin', arch: 'x64' }), 'darwin-x64');
        assert.equal(prebuildName({ platform: 'win32', arch: 'arm64' }), 'win32-arm64');
    });

    it('prefers a local build over prebuilt binaries', () => {
        assert.deepEqual(addonCandidates({ platform: 'linux', arch: 'x64', libc: 'musl' }), [
            path.join('build', 'alembic-js.node'),
            path.join('prebuilds', 'linux-x64-musl', 'alembic-js.node'),
        ]);
        const root = fakePackage(['linux-x64'], true);
        assert.equal(
            findAddon({ platform: 'linux', arch: 'x64', libc: 'glibc' }, path.join(root, 'bin'), {}),
            path.join(root, 'build', 'alembic-js.node'),
        );
    });

    it('picks the musl or glibc prebuild', () => {
        const root = fakePackage(['linux-x64', 'linux-x64-musl']);
        const from = path.join(root, 'bin');
        assert.equal(
            findAddon({ platform: 'linux', arch: 'x64', libc: 'musl' }, from, {}),
            path.join(root, 'prebuilds', 'linux-x64-musl', 'alembic-js.node'),
        );
        assert.equal(
            findAddon({ platform: 'linux', arch: 'x64', libc: 'glibc' }, from, {}),
            path.join(root, 'prebuilds', 'linux-x64', 'alembic-js.node'),
        );
    });

    it('honours ALEMBIC_JS_NATIVE', () => {
        assert.equal(
            findAddon({ platform: 'linux', arch: 'x64' }, os.tmpdir(), { ALEMBIC_JS_NATIVE: '/custom.node' }),
            '/custom.node',
        );
    });

    it('explains what is available when nothing matches', () => {
        const root = fakePackage(['darwin-arm64', 'linux-x64']);
        let error: unknown;
        try {
            findAddon({ platform: 'freebsd', arch: 'x64' }, path.join(root, 'bin'), {});
        } catch (e) {
            error = e;
        }
        assert.ok(error instanceof AlembicError);
        assert.equal(error.code, 'ERR_ABC_NATIVE_MODULE');
        assert.match(error.message, /No alembic-js native addon for freebsd-x64/);
        assert.match(error.message, /Prebuilt binaries exist for: darwin-arm64, linux-x64/);
        assert.match(error.message, /ALEMBIC_JS_BUILD_FROM_SOURCE=1/);
        assert.match(error.message, /Node-API \d+/);
    });

    it('detects glibc and musl', () => {
        assert.equal(
            detectLibc({ header: { glibcVersionRuntime: '2.28' } }, () => undefined),
            'glibc',
        );
        assert.equal(
            detectLibc({ header: {} }, () => 'musl libc (x86_64)'),
            'musl',
        );
        assert.equal(
            detectLibc({ header: {} }, () => '#!/bin/bash\n# GNU C Library ldd'),
            'glibc',
        );
        assert.equal(
            detectLibc({ header: {} }, () => undefined),
            'musl',
        );
        assert.equal(
            detectLibc(null, () => undefined),
            undefined,
        );
    });
});
