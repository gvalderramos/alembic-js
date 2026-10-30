/**
 * Applies decoded frames (spec 0008) to a three.js scene, in the browser or in Node. three is not
 * imported: new geometries are created with the constructors of the objects already in the scene,
 * so they belong to the caller's three instance.
 */
import type { DecodedFrame, DeformRecord, MeshRecord } from './format';

/** Geometry each mesh had before a 'mesh' record replaced it; 'deform' records apply to it. */
const referenceGeometry = new WeakMap<object, any>();
/** triangleToFace and vertexToPoint of each object before a 'mesh' record replaced its geometry. */
const referenceMaps = new WeakMap<object, { triangleToFace: unknown; vertexToPoint: unknown }>();
const nodesByRoot = new WeakMap<object, Map<string, any>>();

function indexNodes(root: any): Map<string, any> {
    const nodes = new Map<string, any>();
    root.traverse((node: any) => {
        const path = node.userData?.alembic?.path;
        if (typeof path === 'string' && !nodes.has(path)) {
            nodes.set(path, node);
        }
    });
    nodesByRoot.set(root, nodes);
    return nodes;
}

/**
 * Meshes drawn for an Alembic object: the object itself, or the per-material primitives that
 * GLTFLoader puts under a Group for a mesh with several materials.
 */
function drawables(node: any): any[] {
    if (node.isMesh) {
        return [node];
    }
    return node.children.filter((child: any) => child.isMesh && child.userData?.alembic === undefined);
}

function updateBounds(geometry: any): void {
    if (geometry.boundingBox) {
        geometry.computeBoundingBox();
    }
    geometry.computeBoundingSphere();
}

function restoreReference(mesh: any): void {
    const reference = referenceGeometry.get(mesh);
    if (reference && mesh.geometry !== reference) {
        mesh.geometry.dispose?.();
        mesh.geometry = reference;
    }
}

function restoreMap(alembic: any, key: string, value: unknown): void {
    if (value === undefined) {
        delete alembic[key];
    } else {
        alembic[key] = value;
    }
}

function applyDeform(node: any, record: DeformRecord): void {
    const updated = new Set<unknown>();
    for (const mesh of drawables(node)) {
        restoreReference(mesh);
        const geometry = mesh.geometry;
        const position = geometry.getAttribute('position');
        if (!position || position.array.length !== record.positions.length) {
            continue; // not the vertex layout the encoder used
        }
        if (!updated.has(position)) {
            position.array.set(record.positions);
            position.needsUpdate = true;
            updated.add(position);
        }
        const normal = geometry.getAttribute('normal');
        if (normal && record.normals && normal.array.length === record.normals.length) {
            if (!updated.has(normal)) {
                normal.array.set(record.normals);
                normal.needsUpdate = true;
                updated.add(normal);
            }
        } else if (normal) {
            geometry.computeVertexNormals();
        }
        updateBounds(geometry);
    }
    const reference = referenceMaps.get(node);
    if (reference) {
        restoreMap(node.userData.alembic, 'triangleToFace', reference.triangleToFace);
        restoreMap(node.userData.alembic, 'vertexToPoint', reference.vertexToPoint);
    }
}

function applyMesh(node: any, record: MeshRecord): void {
    const meshes = drawables(node);
    const groups = record.groups ?? [{ start: 0, count: record.indices.length / 3, materialIndex: 0 }];
    let position: any;
    let normal: any;
    meshes.forEach((mesh, k) => {
        if (!referenceGeometry.has(mesh)) {
            referenceGeometry.set(mesh, mesh.geometry);
        }
        const reference = referenceGeometry.get(mesh);
        const Attribute = reference.getAttribute('position').constructor;
        position ??= new Attribute(record.positions, 3);
        if (record.normals) {
            normal ??= new Attribute(record.normals, 3);
        }
        const geometry = new reference.constructor();
        geometry.setAttribute('position', position);
        if (normal) {
            geometry.setAttribute('normal', normal);
        }
        if (meshes.length === 1) {
            geometry.setIndex(new Attribute(record.indices, 1));
            for (const group of groups) {
                geometry.addGroup(group.start * 3, group.count * 3, group.materialIndex);
            }
        } else {
            // One primitive per material slot (GLTFLoader): primitive k draws group k.
            const group = groups.length === meshes.length ? groups[k] : undefined;
            const indices = group
                ? record.indices.subarray(group.start * 3, (group.start + group.count) * 3)
                : k === 0
                  ? record.indices
                  : new Uint32Array(0);
            geometry.setIndex(new Attribute(indices, 1));
        }
        if (!record.normals && reference.getAttribute('normal')) {
            geometry.computeVertexNormals();
        }
        geometry.computeBoundingBox();
        geometry.computeBoundingSphere();
        if (mesh.geometry !== reference) {
            mesh.geometry.dispose?.();
        }
        mesh.geometry = geometry;
    });
    const alembic = node.userData.alembic;
    if (!referenceMaps.has(node)) {
        referenceMaps.set(node, { triangleToFace: alembic.triangleToFace, vertexToPoint: alembic.vertexToPoint });
    }
    if (record.triangleToFace) {
        alembic.triangleToFace = record.triangleToFace;
    } else {
        delete alembic.triangleToFace;
    }
    // 'mesh' records don't carry vertexToPoint: the scene's map doesn't fit the new vertices.
    delete alembic.vertexToPoint;
}

/**
 * Updates the objects of a scene built by buildThreeScene() (or loaded from its GLB export) with a
 * decoded frame. Objects are found by `userData.alembic.path`; records for paths that are not in
 * the scene are ignored. Mesh attributes are updated in place; a 'mesh' record (changed topology)
 * swaps in a new geometry, and the next 'deform' record restores the original one.
 */
export function applyFrame(root: any, frame: DecodedFrame): void {
    let nodes = nodesByRoot.get(root) ?? indexNodes(root);
    let reindexed = false;
    for (const [path, record] of frame.objects) {
        let node = nodes.get(path);
        if (!node && !reindexed) {
            nodes = indexNodes(root); // objects may have been added since the last frame
            reindexed = true;
            node = nodes.get(path);
        }
        if (!node) {
            continue;
        }
        switch (record.kind) {
            case 'transform':
                node.matrix.fromArray(record.matrix).decompose(node.position, node.quaternion, node.scale);
                node.matrixWorldNeedsUpdate = true;
                break;
            case 'deform':
                applyDeform(node, record);
                break;
            case 'mesh':
                applyMesh(node, record);
                break;
            case 'camera':
                if (node.isPerspectiveCamera) {
                    node.fov = record.fov;
                    node.near = record.near;
                    node.far = record.far;
                    node.updateProjectionMatrix();
                }
                break;
        }
    }
}

/**
 * Source polygon of every triangle of an object's mesh, when the scene was built with
 * `triangleToFace: true` (or the last 'mesh' record carried it). After a GLB round trip the value
 * in userData is a plain array; this returns it as a Uint32Array either way.
 */
export function getTriangleToFace(node: any): Uint32Array | undefined {
    const value = node?.userData?.alembic?.triangleToFace;
    if (value instanceof Uint32Array) {
        return value;
    }
    return Array.isArray(value) ? Uint32Array.from(value) : undefined;
}

/**
 * Source point of every vertex of an object's mesh, when the scene was built with
 * `vertexToPoint: true` (spec 0009). Expands per-point data (one value per point of the file) to
 * the geometry's vertex layout: `vertexData[v] = pointData[vertexToPoint[v]]`. Returns undefined
 * while a 'mesh' record (changed topology) is applied. Plain arrays from a GLB round trip are
 * returned as a Uint32Array.
 */
export function getVertexToPoint(node: any): Uint32Array | undefined {
    const value = node?.userData?.alembic?.vertexToPoint;
    if (value instanceof Uint32Array) {
        return value;
    }
    return Array.isArray(value) ? Uint32Array.from(value) : undefined;
}
