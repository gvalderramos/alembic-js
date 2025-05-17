# Alembic-JS

**Alembic-JS** is a native Node.js module that provides bindings to read Alembic (`.abc`) files directly from JavaScript/TypeScript applications, with potential integration for 3D libraries like [three.js](https://threejs.org/).

## 🚀 Overview

Alembic is an open-source format used for exchanging 3D scene data between software like Maya, Houdini, and Blender. This project enables you to:

- Load and extract metadata and geometry from `.abc` caches
- Integrate Alembic data directly into Three.js scenes
- Use bindings in modern TypeScript applications

> Powered by [Alembic C++ SDK](https://github.com/alembic/alembic) and [Node-API (N-API)](https://nodejs.org/api/n-api.html)

---

## 📦 Installation

Clone the repository and install dependencies:

```bash
git clone https://github.com/your-username/alembic-js.git
cd alembic-js
yarn install
```

Build the native bindings:

```bash
yarn run build # build the addon files
yarn run start # run the ts files
```

---

## 🧠 Usage Example

### TypeScript

```ts
import { AbcImport, AbcInfo } from './build/bindings';

// Load Alembic file metadata
const info = new AbcInfo();
info.load('/path/to/file.abc');

```

---

## 🧱 API Overview

### `AbcInfo`

| Method         | Description                       |
|----------------|------------------------------------|
| `load(path)`   | Loads general info from `.abc`     |


> **Note**: These are placeholder methods. Real geometry, hierarchy, and animation data loading is under development.

---

## 🛠️ Build Requirements

Make sure you have:

- Node.js ≥ 18
- Yarn ≥ 1.22
- CMake ≥ 3.22
- A C++17-compatible compiler
- Alembic SDK installed (or available via `find_package`)

---

## 🧪 Testing

You can run a TypeScript test using:

```bash
ts-node example.ts
```

---

## 📌 Future Goals

- [ ] Read complete Alembic scene hierarchy
- [ ] Export positions and mesh data for use in Three.js
- [ ] Frame-by-frame animation support
- [ ] High-level TypeScript API for 3D geometry

---

## 🧑‍💻 Author

Gabriel Valderramos  
[LinkedIn](https://www.linkedin.com/in/gabrielvalderramos) • [GitHub](https://github.com/gvalderramos)

---

## 📄 License

MIT