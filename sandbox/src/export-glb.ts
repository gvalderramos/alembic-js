// Converts an Alembic file to GLB through three.js.
//   node src/export-glb.ts [file.abc] [out.glb] [--triangle-to-face]
import * as fs from 'node:fs';
import * as path from 'node:path';

import { loadScene, parseArgs, toGlb } from './scene.ts';

const { abcPath, triangleToFace, rest } = parseArgs(process.argv.slice(2));
const outPath = path.resolve(rest[0] ?? path.join('out', `${path.parse(abcPath).name}.glb`));

const { file, root } = loadScene(abcPath, { triangleToFace });
const glb = await toGlb(root);
file.close();

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, glb);
console.log(`Wrote ${outPath} (${(glb.length / 1024 / 1024).toFixed(2)} MB)`);
