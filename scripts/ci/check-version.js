// Release guard (spec 0005): fails before any tag is created when the version is already on npm.
//   node scripts/ci/check-version.js <version>
const { execFileSync } = require('child_process');

const version = process.argv[2];
let published = false;
try {
    execFileSync('npm', ['view', `alembic-js@${version}`, 'version'], {
        stdio: 'pipe',
        shell: process.platform === 'win32',
    });
    published = true;
} catch {
    // E404: not published yet (or the package doesn't exist yet)
}
if (published) {
    console.error(`alembic-js@${version} is already published; refusing to tag it again.`);
    process.exit(1);
}
console.log(`alembic-js@${version} is not published yet.`);
