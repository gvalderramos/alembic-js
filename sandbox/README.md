# alembic-js sandbox

A small Node project that installs `alembic-js` from the parent folder and opens `resource/Ancient_Kettle.abc` with three.js.

```bash
# in the repository root
yarn install && yarn build

# in sandbox/
yarn install
yarn inspect                 # print metadata, hierarchy, mesh stats and the three.js bounding box
yarn export                  # write out/Ancient_Kettle.glb
yarn start                   # viewer at http://localhost:3000
```

Each script takes an optional path to another `.abc` file, for example `yarn start path/to/file.abc`.

## How it works

- `src/scene.ts` opens the archive with `AbcFile` and builds a `THREE.Group` with `buildThreeScene()`.
- `src/server.ts` runs that in Node, exports the scene to GLB with `GLTFExporter`, and serves `public/index.html`. The page loads the GLB with `GLTFLoader`.
- For animated files the page shows a timeline. The server encodes frames with `encodeFrames()` and serves them in the binary frame format from `/frames?from=&step=&count=`, gzipped (spec 0008). The page loads `alembic-js/stream` through its import map, keeps the next 48 frames loaded in chunks of 12, and applies each frame to the GLB scene with `applyFrame()`. Playback waits while a frame is still loading instead of skipping it.
- `--triangle-to-face` (for `yarn start` and `yarn export`) keeps each mesh's `triangleToFace` in the GLB, under `userData.alembic`.

## Why the viewer uses GLB

alembic-js returns real three.js objects, so GLB isn't needed to *use* the data. It's needed here because two processes are involved:

- alembic-js is a native addon, so it only runs in **Node**.
- three.js renders with WebGL, which runs in the **browser**.

The `THREE.Mesh` objects built in Node live in the server's memory, and the browser can't reach them. They have to be serialized and sent over HTTP. GLB is a convenient format for this: three.js can write it (`GLTFExporter`) and read it (`GLTFLoader`), and it keeps the hierarchy, transforms and materials.

Using GLB has some costs:
- `GLTFExporter` uses the browser-only `FileReader`, so `src/scene.ts` adds a small Node shim.
- The browser shows `GLTFLoader`'s output rather than alembic-js's three.js bridge.

You don't need GLB when Node and three.js run in the same process:

| Setup | How to get the scene |
|---|---|
| Node scripts (like `yarn inspect` and the unit tests) | Use `buildThreeScene()` / `toBufferGeometry()` directly |
| Electron renderer with Node integration | `scene.add(buildThreeScene(file, THREE))` |
| Headless rendering (`headless-gl`, Puppeteer) | Same as above, in the rendering process |
| Browser + Node server | Serialize the scene: GLB (this sandbox), or send `positions`/`normals`/`uvs`/`indices` as binary buffers and build a `BufferGeometry` in the page |

The dependency is `"alembic-js": "link:.."`, so a rebuilt library is picked up right away. On Windows, stop `yarn start` before you rebuild the library, because a running server keeps `alembic-js.node` locked.
