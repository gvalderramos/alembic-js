// Release step (spec 0005): writes the release version into the tarball that CI already verified,
// so the published files are byte-identical apart from package.json.
//   node scripts/ci/stamp-tarball.js <verified.tgz> <version> <out-dir>
const { execFileSync } = require('child_process');
const { createHash } = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const [input, version, outDir] = process.argv.slice(2);
if (!input || !/^\d+\.\d+\.\d+/.test(version ?? '') || !outDir) {
    console.error('usage: stamp-tarball.js <verified.tgz> <version> <out-dir>');
    process.exit(1);
}
// tar only sees relative paths: GNU tar reads "C:\..." as a remote host on Windows.
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'alembic-js-stamp-'));
fs.copyFileSync(path.resolve(input), path.join(work, 'input.tgz'));
execFileSync('tar', ['-xzf', 'input.tgz'], { cwd: work });
const pkgPath = path.join(work, 'package', 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
pkg.version = version;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');

fs.mkdirSync(outDir, { recursive: true });
const out = path.resolve(outDir, `alembic-js-${version}.tgz`);
execFileSync('tar', ['-czf', 'output.tgz', 'package'], { cwd: work });
fs.copyFileSync(path.join(work, 'output.tgz'), out);

// Checksums of the tarball and of every prebuilt binary, attached to the GitHub release.
const sha = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const lines = [`${sha(out)}  ${path.basename(out)}`];
const prebuilds = path.join(work, 'package', 'prebuilds');
for (const target of fs.existsSync(prebuilds) ? fs.readdirSync(prebuilds).sort() : []) {
    lines.push(`${sha(path.join(prebuilds, target, 'alembic-js.node'))}  prebuilds/${target}/alembic-js.node`);
}
fs.writeFileSync(path.resolve(outDir, 'SHA256SUMS'), lines.join('\n') + '\n');
console.log(`Wrote ${out}\n${lines.join('\n')}`);
