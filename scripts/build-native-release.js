// Builds the addon against the static Release SDK in .deps/alembic-sdk (see `yarn build:sdk`),
// like CI does for prebuilt binaries.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const prefix = path.resolve(__dirname, '..', '.deps', 'alembic-sdk');
if (!fs.existsSync(prefix)) {
    console.error(`No SDK in ${prefix}; run "yarn build:sdk" first.`);
    process.exit(1);
}
execFileSync('npx', ['cmake-js', 'compile', `--CDCMAKE_PREFIX_PATH=${prefix}`], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
});
