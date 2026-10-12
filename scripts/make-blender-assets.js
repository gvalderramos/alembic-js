// Regenerates resource/blender/ with tools/blender/make_test_assets.py.
//   yarn assets:blender [--large]
// Uses $BLENDER, or `blender` on PATH.
const { spawnSync } = require('child_process');
const path = require('path');

const root = path.resolve(__dirname, '..');
const blender = process.env.BLENDER || 'blender';
const args = [
    '-b',
    '--factory-startup',
    '-noaudio',
    '--python',
    path.join(root, 'tools', 'blender', 'make_test_assets.py'),
    '--',
    path.join(root, 'resource', 'blender'),
    ...process.argv.slice(2),
];
const result = spawnSync(blender, args, { stdio: 'inherit' });
if (result.error) {
    console.error(`Could not run Blender (${blender}): ${result.error.message}. Set BLENDER=/path/to/blender.`);
    process.exit(1);
}
process.exit(result.status ?? 1);
