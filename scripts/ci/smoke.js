// Smoke test of an installed alembic-js package (spec 0005), run in the directory where the
// package tarball was installed:   node scripts/ci/smoke.js <repo-root>
const assert = require('assert/strict');
const { createRequire } = require('module');
const path = require('path');

const root = path.resolve(process.argv[2] ?? path.join(__dirname, '..', '..'));
// Resolve from the install directory: inside the repository, 'alembic-js' would resolve to the
// repository itself (package self-reference through `exports`).
const installed = createRequire(path.join(process.cwd(), 'smoke.js'));
const { AbcFile } = installed('alembic-js');

const kettle = AbcFile.open(path.join(root, 'resource', 'Ancient_Kettle.abc'));
assert.equal(kettle.getInfo().objectCount, 8);
assert.equal(kettle.getMesh('/Kettle/Circle').positions.length, 103984 * 3);
kettle.close();

const mesh = AbcFile.open(path.join(root, 'test', 'fixtures', 'transformed_mesh.abc'));
const cube = mesh.getMesh('/cube/cubeShape');
assert.equal(cube.indices.length, 36);
assert.equal(cube.transform[12], 1);
mesh.close();

// Browser entry point (spec 0008), through the package's `exports`.
const { decodeFrames, writeFrames } = installed('alembic-js/stream');
const frame = { time: 0, objects: new Map([['/a', { kind: 'camera', fov: 40, near: 0.5, far: 100 }]]) };
assert.equal(decodeFrames(writeFrames([frame]))[0].objects.get('/a').fov, 40);

const runtime = process.versions.electron ? `Electron ${process.versions.electron}` : `Node ${process.version}`;
console.log(`smoke ok: ${process.platform}-${process.arch} (${runtime}, Node-API ${process.versions.napi})`);
