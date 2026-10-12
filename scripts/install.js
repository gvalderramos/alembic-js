// npm "install" hook (spec 0005). Does nothing when a prebuilt binary matches this platform.
// Otherwise, with ALEMBIC_JS_BUILD_FROM_SOURCE=1 (or `npm install --build-from-source`), builds the
// addon with cmake-js. That needs CMake, a C++17 compiler and the Alembic SDK on CMAKE_PREFIX_PATH
// (scripts/ci/build-alembic.sh builds one).
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
if (fs.existsSync(path.join(root, 'src'))) {
    process.exit(0); // a git checkout: `yarn build` builds the addon
}

const { currentTarget, findAddon, prebuildName } = require('../bin/native');
const target = currentTarget();
try {
    findAddon(target, path.join(root, 'bin'));
    process.exit(0);
} catch {
    // no prebuilt binary for this platform
}

const wanted = process.env.ALEMBIC_JS_BUILD_FROM_SOURCE === '1' || process.env.npm_config_build_from_source === 'true';
if (!wanted) {
    console.warn(
        `alembic-js: no prebuilt binary for ${prebuildName(target)}. Reinstall with ` +
            'ALEMBIC_JS_BUILD_FROM_SOURCE=1 to build it (needs CMake, a C++17 compiler and the Alembic SDK).',
    );
    process.exit(0);
}

const run = (command) => execSync(command, { cwd: root, stdio: 'inherit' });
console.log(`alembic-js: building the native addon for ${prebuildName(target)} from source...`);
run('npm install --no-save --no-package-lock --ignore-scripts cmake-js@^7 node-addon-api@^8');
const prefix = process.env.ALEMBIC_SDK || process.env.CMAKE_PREFIX_PATH;
run(`npx cmake-js compile${prefix ? ` --CDCMAKE_PREFIX_PATH="${prefix}"` : ''}`);
