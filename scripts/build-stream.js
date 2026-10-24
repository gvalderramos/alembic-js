// Bundles the browser entry point (spec 0008) as an ES module, bin/stream.mjs, so pages can load
// `alembic-js/stream` with an import map or a bundler. The CommonJS build (bin/stream/) comes from tsc.
const esbuild = require('esbuild');
const path = require('path');

const root = path.resolve(__dirname, '..');
esbuild.buildSync({
    entryPoints: [path.join(root, 'src', 'stream', 'index.ts')],
    outfile: path.join(root, 'bin', 'stream.mjs'),
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2020',
    logLevel: 'warning',
});
