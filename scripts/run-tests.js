// Runs the compiled tests with node:test. Node 20 does not accept glob patterns, so list the files here.
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const dir = path.resolve(__dirname, '..', 'bin-test', 'test');
const files = fs
    .readdirSync(dir)
    .filter((file) => file.endsWith('.test.js'))
    .map((file) => path.join(dir, file));
const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exit(result.status ?? 1);
