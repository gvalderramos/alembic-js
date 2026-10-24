// Serves a three.js viewer for an Alembic file.
//   node src/server.ts [file.abc] [--triangle-to-face]      then open http://localhost:3000
// alembic-js runs in Node (it is a native addon); the browser receives the
// three.js scene as GLB plus the Alembic metadata as JSON, and animated frames
// in the binary frame format (spec 0008) from /frames?from=&step=&count=.
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import * as zlib from 'node:zlib';

import { encodeFrames } from 'alembic-js';

import { loadScene, parseArgs, toGlb } from './scene.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(here, '..', 'public');
const threeDir = path.resolve(here, '..', 'node_modules', 'three');
// Browser build of alembic-js/stream (bin/stream.mjs), loaded by the page through its import map.
const streamModule = fileURLToPath(import.meta.resolve('alembic-js/stream'));
const port = Number(process.env.PORT ?? 3000);
const { abcPath, triangleToFace } = parseArgs(process.argv.slice(2));
const gzip = promisify(zlib.gzip);

console.log(`Loading ${abcPath} ...`);
const started = performance.now();
const { file, root, box } = loadScene(abcPath, { triangleToFace });
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
// The file stays open to serve animation frames.
console.log(
    `Converted to GLB in ${(performance.now() - started).toFixed(0)} ms (${(glb.length / 1024 / 1024).toFixed(2)} MB)`,
);

const types: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
};

// Frames at `from + i * step` for i < count, as one binary packet (spec 0008).
async function frames(url: URL): Promise<Buffer | null> {
    const from = Number(url.searchParams.get('from'));
    const step = Number(url.searchParams.get('step'));
    const count = Number(url.searchParams.get('count'));
    if (!sceneInfo.info.hasAnimation || ![from, step].every(Number.isFinite) || !Number.isInteger(count)) return null;
    if (count < 1 || count > 240) return null;
    const times = Array.from({ length: count }, (_, i) => from + i * step);
    return Buffer.from(await encodeFrames(file, times, { mode: 'interpolate', triangleToFace }));
}

function sendFile(res: http.ServerResponse, baseDir: string, relative: string): void {
    const target = path.resolve(baseDir, '.' + path.posix.normalize('/' + relative));
    if (!target.startsWith(baseDir + path.sep) || !fs.existsSync(target) || !fs.statSync(target).isFile()) {
        res.writeHead(404).end('Not found');
        return;
    }
    res.writeHead(200, { 'Content-Type': types[path.extname(target)] ?? 'application/octet-stream' });
    fs.createReadStream(target).pipe(res);
}

async function sendFrames(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    let body = await frames(url);
    if (!body) {
        res.writeHead(400).end('Expected an animated file and ?from=<seconds>&step=<seconds>&count=<1-240>');
        return;
    }
    // Compression is left to HTTP (spec 0008).
    const headers: http.OutgoingHttpHeaders = { 'Content-Type': 'application/octet-stream' };
    if (/\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''))) {
        body = await gzip(body, { level: 1 });
        headers['Content-Encoding'] = 'gzip';
    }
    res.writeHead(200, { ...headers, 'Content-Length': body.length }).end(body);
}

http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/scene.glb') {
        res.writeHead(200, { 'Content-Type': 'model/gltf-binary', 'Content-Length': glb.length }).end(glb);
    } else if (url.pathname === '/scene.json') {
        // BigInt values (64-bit user properties) aren't JSON-serializable.
        const json = JSON.stringify(sceneInfo, (_key, value) => (typeof value === 'bigint' ? value.toString() : value));
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(json);
    } else if (url.pathname === '/frames') {
        sendFrames(req, res, url).catch((error: Error) => {
            console.error(error);
            if (!res.headersSent) res.writeHead(500);
            res.end(error.message);
        });
    } else if (url.pathname === '/alembic-js/stream.mjs') {
        sendFile(res, path.dirname(streamModule), path.basename(streamModule));
    } else if (url.pathname.startsWith('/three/')) {
        sendFile(res, threeDir, url.pathname.slice('/three/'.length));
    } else {
        sendFile(res, publicDir, url.pathname === '/' ? 'index.html' : url.pathname);
    }
}).listen(port, () => {
    console.log(`Viewer running at http://localhost:${port}`);
});
