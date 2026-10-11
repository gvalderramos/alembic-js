// Converts an Alembic file to GLB through three.js.
//   node src/export-glb.ts [file.abc] [out.glb]
import * as fs from 'node:fs';
import * as path from 'node:path';

import { loadScene, resolveAbcPath, toGlb } from './scene.ts';

const abcPath = resolveAbcPath(process.argv[2]);
const outPath = path.resolve(process.argv[3] ?? path.join('out', `${path.parse(abcPath).name}.glb`));

const { file, root } = loadScene(abcPath);
const glb = await toGlb(root);
file.close();

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, glb);
console.log(`Wrote ${outPath} (${(glb.length / 1024 / 1024).toFixed(2)} MB)`);
