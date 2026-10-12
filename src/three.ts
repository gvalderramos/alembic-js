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
import { tessellateCurves, widthsPerVertex, type TessellateOptions } from './curves';
import type { AbcCurves, AbcMesh, AbcMeshAttribute, AbcObject, AbcPoints, Matrix4Array, SampleOptions } from './types';

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
    Points: Ctor;
    PointsMaterial: Ctor;
    LineSegments: Ctor;
    LineBasicMaterial: Ctor;
}

/** Attribute names read by default by buildThreeScene(): the usual vertex color names. */
export const DEFAULT_COLOR_ATTRIBUTES = ['Cd', 'Col', 'color', 'displayColor'];

export interface GeometryOptions {
    /** Compute vertex normals when the file has none. Defaults to true. */
    computeNormals?: boolean;
    /** Alembic attribute name -> three.js attribute name, merged over the default mapping. */
    attributeNames?: Record<string, string>;
    /** Color space of color attributes in the file. 'srgb' values are converted to linear. Default 'linear'. */
    colorSpace?: 'linear' | 'srgb';
}

export interface ThreeSceneOptions extends SampleOptions, GeometryOptions {
    /** Material used for every mesh. Defaults to a new MeshStandardMaterial per mesh. */
    material?: any;
    /** Create PerspectiveCameras for camera objects. Defaults to true. */
    includeCameras?: boolean;
    /** Attributes to add to each geometry. Default: DEFAULT_COLOR_ATTRIBUTES (vertex colors). Pass [] to disable. */
    attributes?: string[] | '*';
    /** Material for points objects. Default: a PointsMaterial sized from the widths. */
    pointsMaterial?: any;
    /** Material for curves objects. Default: a LineBasicMaterial. */
    curvesMaterial?: any;
    /** Points evaluated per span of cubic/NURBS curves. Default 8. */
    segmentsPerSpan?: number;
}

export interface PointsOptions {
    material?: any;
    /** Point size when the file has no widths. Default 0.05 (world units with size attenuation). */
    size?: number;
    /** Use per-point widths as sizes (adds a `pointWidth` attribute and patches the material). Default true. */
    sizeFromWidths?: boolean;
}

/** Makes a PointsMaterial scale each point by its `pointWidth` attribute. */
export function usePointWidths(material: any): any {
    material.onBeforeCompile = (shader: { vertexShader: string }) => {
        shader.vertexShader = shader.vertexShader
            .replace('void main() {', 'attribute float pointWidth;\nvoid main() {')
            .replace('gl_PointSize = size;', 'gl_PointSize = size * pointWidth;');
    };
    material.customProgramCacheKey = () => 'alembic-js-point-widths';
    return material;
}

/** Converts points into a THREE.Points (local space). Velocities become a `velocity` attribute, ids go to userData. */
export function toPoints(points: AbcPoints, THREE: ThreeModule, options: PointsOptions = {}): any {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(points.positions, 3));
    if (points.velocities) {
        geometry.setAttribute('velocity', new THREE.BufferAttribute(points.velocities, 3));
    }
    const perPoint = points.widths && points.widthScope === 'vertex' && options.sizeFromWidths !== false;
    if (perPoint) {
        geometry.setAttribute('pointWidth', new THREE.BufferAttribute(points.widths, 1));
    }
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();

    let material = options.material;
    if (!material) {
        const fromWidths = options.sizeFromWidths !== false ? points.widths?.[0] : undefined;
        const size = perPoint ? 1 : (fromWidths ?? options.size ?? 0.05);
        material = new THREE.PointsMaterial({ size, sizeAttenuation: true, color: 0xd0d0d0 });
        if (perPoint) {
            usePointWidths(material);
        }
    }
    const node = new THREE.Points(geometry, material);
    if (points.ids) {
        node.userData.ids = points.ids;
    }
    return node;
}

/** Converts curves into a THREE.LineSegments, evaluating cubic and NURBS curves (local space). */
export function toLineSegments(
    curves: AbcCurves,
    THREE: ThreeModule,
    options: TessellateOptions & { material?: any } = {},
): any {
    const { positions, indices } = tessellateCurves(curves, options);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    const material = options.material ?? new THREE.LineBasicMaterial({ color: 0xd0d0d0 });
    const node = new THREE.LineSegments(geometry, material);
    const widths = widthsPerVertex(curves);
    if (widths) {
        node.userData.controlVertexWidths = widths;
    }
    return node;
}

// Common names of a second UV set. Maya's primary set is "map1", so it is not included.
const SECOND_UV = /^(uv|st)[._]?0*[12]$|^UVMap[._]001$/;

/** three.js attribute name for an Alembic attribute (default mapping, see the README). */
export function threeAttributeName(
    name: string,
    attribute: AbcMeshAttribute,
    overrides: Record<string, string> = {},
): string {
    if (overrides[name]) {
        return overrides[name];
    }
    if (
        DEFAULT_COLOR_ATTRIBUTES.includes(name) ||
        attribute.interpretation === 'rgb' ||
        attribute.interpretation === 'rgba'
    ) {
        return 'color';
    }
    if (attribute.itemSize === 2 && SECOND_UV.test(name)) {
        return 'uv1';
    }
    if (name === 'Pref' || name === 'rest') {
        return 'restPosition';
    }
    return name;
}

function srgbToLinear(c: number): number {
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** Per-vertex data of an attribute; constant attributes are repeated for every vertex. */
function perVertex(attribute: AbcMeshAttribute, vertexCount: number): AbcMeshAttribute['data'] {
    if (!attribute.constant) {
        return attribute.data;
    }
    const Ctor = attribute.data.constructor as new (length: number) => AbcMeshAttribute['data'];
    const out = new Ctor(vertexCount * attribute.itemSize);
    for (let v = 0; v < vertexCount; v++) {
        out.set(attribute.data, v * attribute.itemSize);
    }
    return out;
}

/** Converts extracted mesh data into a three.js BufferGeometry (in the mesh's local space). */
export function toBufferGeometry(mesh: AbcMesh, THREE: ThreeModule, options: GeometryOptions = {}): any {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(mesh.positions, 3));
    if (mesh.normals) {
        geometry.setAttribute('normal', new THREE.BufferAttribute(mesh.normals, 3));
    }
    if (mesh.uvs) {
        geometry.setAttribute('uv', new THREE.BufferAttribute(mesh.uvs, 2));
    }
    geometry.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
    const vertexCount = mesh.positions.length / 3;
    for (const [name, attribute] of Object.entries(mesh.attributes ?? {})) {
        const target = threeAttributeName(name, attribute, options.attributeNames);
        if (geometry.getAttribute(target)) {
            continue; // first match wins, e.g. both Cd and Col present
        }
        let data = perVertex(attribute, vertexCount);
        if (target === 'color' && options.colorSpace === 'srgb' && data instanceof Float32Array) {
            data = data.map((c, i) => (attribute.itemSize === 4 && i % 4 === 3 ? c : srgbToLinear(c)));
        }
        geometry.setAttribute(target, new THREE.BufferAttribute(data, attribute.itemSize));
    }
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
 * their local transform, meshes become Mesh, points become Points, curves become
 * LineSegments, cameras become PerspectiveCamera.
 * Other object types become empty Groups so the hierarchy is preserved.
 */
export function buildThreeScene(file: AbcFile, THREE: ThreeModule, options: ThreeSceneOptions = {}): any {
    const { time, frame, mode, useVelocities, velocityScale } = options;
    const sample = { time, frame, mode, useVelocities, velocityScale };
    const root = new THREE.Group();
    root.name = file.path;
    // Remembered so AbcPlayer reads frames with the same layout options.
    root.userData.alembicSceneOptions = {
        attributes: options.attributes,
        computeNormals: options.computeNormals,
        attributeNames: options.attributeNames,
        colorSpace: options.colorSpace,
        segmentsPerSpan: options.segmentsPerSpan,
    };

    const build = (obj: AbcObject): any => {
        let node: any;
        if (obj.type === 'mesh' || obj.type === 'subd') {
            const attributes = options.attributes ?? DEFAULT_COLOR_ATTRIBUTES;
            const geometry = toBufferGeometry(file.getMesh(obj.path, { ...sample, attributes }), THREE, options);
            const hasColors = Boolean(geometry.getAttribute('color'));
            const material =
                options.material ??
                new THREE.MeshStandardMaterial(hasColors ? { vertexColors: true } : { color: 0xb0b0b0 });
            node = new THREE.Mesh(geometry, material);
        } else if (obj.type === 'points') {
            node = toPoints(file.getPoints(obj.path, sample), THREE, { material: options.pointsMaterial });
        } else if (obj.type === 'curves') {
            node = toLineSegments(file.getCurves(obj.path, sample), THREE, {
                material: options.curvesMaterial,
                segmentsPerSpan: options.segmentsPerSpan,
            });
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
