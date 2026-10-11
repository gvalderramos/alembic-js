// Runs the fixture generator built by `yarn fixtures` (tools/generate_fixtures.cpp).
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const exe = process.platform === 'win32' ? 'generate_fixtures.exe' : 'generate_fixtures';
const candidates = [path.join(root, 'build-tools', 'Release', exe), path.join(root, 'build-tools', exe)];
const tool = candidates.find((candidate) => fs.existsSync(candidate));
if (!tool) {
    console.error(`generate_fixtures was not found in ${candidates.join(' or ')}`);
    process.exit(1);
}
execFileSync(tool, [path.join(root, 'test', 'fixtures')], { stdio: 'inherit' });
