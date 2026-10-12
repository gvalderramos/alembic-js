/**
 * Optional three.js bridge. alembic-js does not depend on three: pass your own
 * `three` module in, so the objects created belong to the same three instance
 * as the rest of your app.
 *
 * ```ts
 * import * as THREE from 'three';
 * import { AbcFile, buildThreeScene } from 'alembic-js';
 * scene.add(buildThreeScene(AbcFile.open('scene.abc'), THREE));
 * ```
 */
import type { AbcFile } from './AbcFile';
import type { AbcMesh, AbcObject, Matrix4Array, SampleOptions } from './types';

type Ctor = new (...args: any[]) => any;

/** The subset of the three.js namespace used by this bridge. */
export interface ThreeModule {
    BufferGeometry: Ctor;
    BufferAttribute: Ctor;
    Group: Ctor;
    Mesh: Ctor;
    MeshStandardMaterial: Ctor;
    PerspectiveCamera: Ctor;
    Matrix4: Ctor;
}

export interface ThreeSceneOptions extends SampleOptions {
    /** Material used for every mesh. Defaults to a new MeshStandardMaterial per mesh. */
    material?: any;
    /** Compute vertex normals when the file has none. Defaults to true. */
    computeNormals?: boolean;
    /** Create PerspectiveCameras for camera objects. Defaults to true. */
    includeCameras?: boolean;
}

/** Converts extracted mesh data into a three.js BufferGeometry (in the mesh's local space). */
export function toBufferGeometry(mesh: AbcMesh, THREE: ThreeModule, options: { computeNormals?: boolean } = {}): any {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(mesh.positions, 3));
    if (mesh.normals) {
        geometry.setAttribute('normal', new THREE.BufferAttribute(mesh.normals, 3));
    }
    if (mesh.uvs) {
        geometry.setAttribute('uv', new THREE.BufferAttribute(mesh.uvs, 2));
    }
    geometry.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
    if (!mesh.normals && options.computeNormals !== false) {
        geometry.computeVertexNormals();
    }
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    return geometry;
}

function applyMatrix(object: any, matrix: Matrix4Array, THREE: ThreeModule): void {
    const m = new THREE.Matrix4().fromArray(matrix);
    m.decompose(object.position, object.quaternion, object.scale);
}

/**
 * Rebuilds the Alembic hierarchy as three.js objects: xforms become Groups with
 * their local transform, meshes become Mesh, cameras become PerspectiveCamera.
 * Other object types become empty Groups so the hierarchy is preserved.
 */
export function buildThreeScene(file: AbcFile, THREE: ThreeModule, options: ThreeSceneOptions = {}): any {
    const sample = { time: options.time };
    const root = new THREE.Group();
    root.name = file.path;

    const build = (obj: AbcObject): any => {
        let node: any;
        if (obj.type === 'mesh' || obj.type === 'subd') {
            const geometry = toBufferGeometry(file.getMesh(obj.path, sample), THREE, options);
            const material = options.material ?? new THREE.MeshStandardMaterial({ color: 0xb0b0b0 });
            node = new THREE.Mesh(geometry, material);
        } else if (obj.type === 'camera' && options.includeCameras !== false) {
            const cam = file.getCamera(obj.path, sample);
            node = new THREE.PerspectiveCamera(cam.fov, cam.aspect, cam.near, cam.far);
        } else {
            node = new THREE.Group();
            if (obj.type === 'xform') {
                applyMatrix(node, file.getTransform(obj.path, sample).local, THREE);
            }
        }
        node.name = obj.name;
        node.userData.alembic = { path: obj.path, type: obj.type, schema: obj.schema };
        for (const child of file.getChildren(obj.path)) {
            node.add(build(child));
        }
        return node;
    };

    for (const top of file.getChildren()) {
        root.add(build(top));
    }
    return root;
}
