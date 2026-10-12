// Serves a three.js viewer for an Alembic file.
//   node src/server.ts [file.abc]      then open http://localhost:3000
// alembic-js runs in Node (it is a native addon); the browser receives the
// three.js scene as GLB plus the Alembic metadata as JSON.
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadScene, resolveAbcPath, toGlb } from './scene.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(here, '..', 'public');
const threeDir = path.resolve(here, '..', 'node_modules', 'three');
const port = Number(process.env.PORT ?? 3000);
const abcPath = resolveAbcPath(process.argv[2]);

console.log(`Loading ${abcPath} ...`);
const started = performance.now();
const { file, root, box } = loadScene(abcPath);
const glb = await toGlb(root);
const sceneInfo = {
    info: file.getInfo(),
    objects: file.getObjects().map((obj) => ({
        ...obj,
        userProperties: file.getUserProperties(obj.path),
        attributes: file
            .getAttributes(obj.path)
            .map((attr) => `${attr.name} (${attr.pod}[${attr.extent}], ${attr.scope})`),
    })),
    bounds: { min: box.min.toArray(), max: box.max.toArray() },
};
file.close();
console.log(
    `Converted to GLB in ${(performance.now() - started).toFixed(0)} ms (${(glb.length / 1024 / 1024).toFixed(2)} MB)`,
);

const types: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
};

function sendFile(res: http.ServerResponse, baseDir: string, relative: string): void {
    const target = path.resolve(baseDir, '.' + path.posix.normalize('/' + relative));
    if (!target.startsWith(baseDir + path.sep) || !fs.existsSync(target) || !fs.statSync(target).isFile()) {
        res.writeHead(404).end('Not found');
        return;
    }
    res.writeHead(200, { 'Content-Type': types[path.extname(target)] ?? 'application/octet-stream' });
    fs.createReadStream(target).pipe(res);
}

http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/scene.glb') {
        res.writeHead(200, { 'Content-Type': 'model/gltf-binary', 'Content-Length': glb.length }).end(glb);
    } else if (url.pathname === '/scene.json') {
        // BigInt values (64-bit user properties) aren't JSON-serializable.
        const json = JSON.stringify(sceneInfo, (_key, value) => (typeof value === 'bigint' ? value.toString() : value));
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(json);
    } else if (url.pathname.startsWith('/three/')) {
        sendFile(res, threeDir, url.pathname.slice('/three/'.length));
    } else {
        sendFile(res, publicDir, url.pathname === '/' ? 'index.html' : url.pathname);
    }
}).listen(port, () => {
    console.log(`Viewer running at http://localhost:${port}`);
});
