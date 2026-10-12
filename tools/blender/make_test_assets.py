"""Builds the Blender-made test assets in resource/blender/.

Run headless (Blender 5.2+):

    blender -b --factory-startup --python tools/blender/make_test_assets.py -- resource/blender [--large]

Every scene is built from an empty file, so the output only depends on this
script and the Blender version. See resource/README.md for what each file
covers and which specs use it.
"""

import math
import os
import sys

import bpy

FPS = 30


def reset_scene(frames, fps=FPS):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.render.fps = fps
    scene.frame_start = 1
    scene.frame_end = frames
    return scene


def export(path, scene, **options):
    settings = dict(
        filepath=path,
        start=scene.frame_start,
        end=scene.frame_end,
        init_scene_frame_range=False,
        export_custom_properties=True,
        evaluation_mode="RENDER",
    )
    settings.update(options)
    bpy.ops.wm.alembic_export(**settings)
    print(f"[assets] wrote {path} ({os.path.getsize(path)} bytes)")


def link(obj):
    bpy.context.scene.collection.objects.link(obj)
    return obj


def material(name, rgba):
    mat = bpy.data.materials.new(name)
    mat.diffuse_color = rgba
    return mat


def grid_mesh(name, nx, ny, size=2.0):
    """Quad grid in the XY plane with UVs."""
    verts = [
        (size * (i / (nx - 1) - 0.5), size * (j / (ny - 1) - 0.5), 0.0)
        for j in range(ny)
        for i in range(nx)
    ]
    faces = [
        (j * nx + i, j * nx + i + 1, (j + 1) * nx + i + 1, (j + 1) * nx + i)
        for j in range(ny - 1)
        for i in range(nx - 1)
    ]
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(verts, [], faces)
    uv = mesh.uv_layers.new(name="UVMap")
    for loop in mesh.loops:
        x, y, _ = verts[loop.vertex_index]
        uv.data[loop.index].uv = (x / size + 0.5, y / size + 0.5)
    mesh.update()
    return mesh


def cloth_deform(out_dir):
    """Deforming mesh with constant topology: UVs, a second UV set, corner and
    point colors, custom properties, 30 fps."""
    scene = reset_scene(frames=30)
    mesh = grid_mesh("ClothShape", 24, 24)
    mesh.uv_layers.new(name="UVMap.001")  # second UV set (copy of the first)

    corner = mesh.color_attributes.new("Col", "BYTE_COLOR", "CORNER")
    for poly in mesh.polygons:
        shade = (poly.index % 7) / 6.0
        for li in poly.loop_indices:
            corner.data[li].color = (shade, 0.2, 1.0 - shade, 1.0)
    point = mesh.color_attributes.new("Heat", "FLOAT_COLOR", "POINT")
    for v in mesh.vertices:
        r = min(1.0, math.hypot(v.co.x, v.co.y))
        point.data[v.index].color = (r, 1.0 - r, 0.0, 1.0)

    obj = link(bpy.data.objects.new("Cloth", mesh))
    obj["assetId"] = "cloth-001"
    obj["version"] = 3
    obj["stiffness"] = 0.75
    obj["approved"] = True
    obj["tags"] = ["fabric", "test"]

    wave = obj.modifiers.new("Wave", "WAVE")
    wave.height = 0.25
    wave.width = 0.6
    wave.speed = 0.08
    wave.time_offset = 1

    export(os.path.join(out_dir, "cloth_deform.abc"), scene, vcolors=True, uvs=True, normals=True)


def materials_and_subd(out_dir):
    """Mesh with three materials (face sets) and custom properties, plus a
    subdivision-surface cage with edge creases."""
    scene = reset_scene(frames=1)
    bpy.ops.mesh.primitive_cube_add(size=2.0, location=(-2.0, 0.0, 0.0))
    cube = bpy.context.active_object
    cube.name = "Box"
    cube.data.name = "BoxShape"
    mats = [material("Red", (0.8, 0.1, 0.1, 1)), material("Green", (0.1, 0.8, 0.1, 1)), material("Blue", (0.1, 0.1, 0.8, 1))]
    for mat in mats:
        cube.data.materials.append(mat)
    for poly in cube.data.polygons:
        poly.material_index = poly.index % 3
    cube["shot"] = "sq010_sh020"
    cube["frameRange"] = [1001, 1100]
    cube.data["lod"] = 2

    bpy.ops.mesh.primitive_cube_add(size=2.0, location=(2.0, 0.0, 0.0))
    cage = bpy.context.active_object
    cage.name = "SubdCage"
    cage.data.name = "SubdCageShape"
    crease = cage.data.attributes.get("crease_edge") or cage.data.attributes.new("crease_edge", "FLOAT", "EDGE")
    for i in range(len(cage.data.edges)):
        crease.data[i].value = 1.0 if i < 4 else 0.0
    cage.modifiers.new("Subdivision", "SUBSURF")

    export(os.path.join(out_dir, "materials_subd.abc"), scene, face_sets=True, subdiv_schema=True)


def camera_and_rigid(out_dir):
    """Animated camera and rigid objects in a hierarchy at 30 fps, plus a
    collection instanced several times."""
    scene = reset_scene(frames=60)

    cam_data = bpy.data.cameras.new("ShotCam")
    cam_data.lens = 35.0
    cam_data.clip_start = 0.1
    cam_data.clip_end = 200.0
    cam = link(bpy.data.objects.new("ShotCam", cam_data))
    for frame, x in ((1, -6.0), (60, 6.0)):
        cam.location = (x, -10.0, 3.0)
        cam.rotation_euler = (math.radians(80), 0.0, math.radians(x * 2.0))
        cam.keyframe_insert("location", frame=frame)
        cam.keyframe_insert("rotation_euler", frame=frame)
    cam_data.lens = 35.0
    cam_data.keyframe_insert("lens", frame=1)
    cam_data.lens = 50.0
    cam_data.keyframe_insert("lens", frame=60)

    pivot = link(bpy.data.objects.new("Pivot", None))
    pivot.rotation_euler = (0.0, 0.0, 0.0)
    pivot.keyframe_insert("rotation_euler", frame=1)
    pivot.rotation_euler = (0.0, 0.0, math.radians(180))
    pivot.keyframe_insert("rotation_euler", frame=60)

    bpy.ops.mesh.primitive_uv_sphere_add(radius=0.5, location=(3.0, 0.0, 0.0))
    moon = bpy.context.active_object
    moon.name = "Moon"
    moon.parent = pivot
    moon.scale = (1.0, 1.0, 1.0)
    moon.keyframe_insert("scale", frame=1)
    moon.scale = (2.0, 2.0, 2.0)
    moon.keyframe_insert("scale", frame=60)

    # Instancing: one collection referenced by three empties.
    props = bpy.data.collections.new("Props")
    bpy.ops.mesh.primitive_cone_add(radius1=0.4, depth=1.0)
    cone = bpy.context.active_object
    cone.name = "Cone"
    for coll in list(cone.users_collection):
        coll.objects.unlink(cone)
    props.objects.link(cone)
    for i in range(3):
        inst = link(bpy.data.objects.new(f"PropInstance{i}", None))
        inst.instance_type = "COLLECTION"
        inst.instance_collection = props
        inst.location = (-3.0 + 3.0 * i, 4.0, 0.0)

    export(os.path.join(out_dir, "camera_rigid_instances.abc"), scene, use_instancing=True)


def curves_and_hair(out_dir):
    """Legacy curve objects (poly, Bezier, NURBS) and new hair curves."""
    scene = reset_scene(frames=1)

    # One spline type per object: Blender writes an empty curve when they're mixed.
    def curve_object(name, kind, count, place, cyclic=False, order=4):
        data = bpy.data.curves.new(name, "CURVE")
        data.dimensions = "3D"
        spline = data.splines.new(kind)
        points = spline.bezier_points if kind == "BEZIER" else spline.points
        points.add(count - 1)
        for i, p in enumerate(points):
            co = place(i)
            if kind == "BEZIER":
                p.co = co
                p.handle_left_type = p.handle_right_type = "AUTO"
            else:
                p.co = (*co, 1.0)
        if kind == "NURBS":
            spline.order_u = order
        spline.use_cyclic_u = cyclic
        return link(bpy.data.objects.new(name, data))

    curve_object("PolyLine", "POLY", 4, lambda i: (i * 0.5, 0.0, math.sin(i) * 0.5))
    curve_object("Bezier", "BEZIER", 3, lambda i: (i * 1.0, 1.0, (i % 2) * 0.5))
    curve_object("NurbsLoop", "NURBS", 6, lambda i: (math.cos(i), 2.0 + math.sin(i), 0.0), cyclic=True)

    hair = bpy.data.hair_curves.new("Fur")
    strands, points_per_strand = 64, 6
    hair.add_curves([points_per_strand] * strands)
    positions = hair.attributes["position"].data
    for s in range(strands):
        angle = 2 * math.pi * s / strands
        for k in range(points_per_strand):
            t = k / (points_per_strand - 1)
            positions[s * points_per_strand + k].vector = (
                math.cos(angle) * (1 + 0.1 * t),
                math.sin(angle) * (1 + 0.1 * t),
                t * 0.8,
            )
    radius = hair.attributes.get("radius") or hair.attributes.new("radius", "FLOAT", "POINT")
    for i in range(strands * points_per_strand):
        radius.data[i].value = 0.01 * (1 - (i % points_per_strand) / points_per_strand)
    link(bpy.data.objects.new("Fur", hair))

    export(os.path.join(out_dir, "curves_hair.abc"), scene, export_hair=True, curves_as_mesh=False)


def _geometry_nodes_group(name):
    group = bpy.data.node_groups.new(name, "GeometryNodeTree")
    group.interface.new_socket(name="Geometry", in_out="INPUT", socket_type="NodeSocketGeometry")
    group.interface.new_socket(name="Geometry", in_out="OUTPUT", socket_type="NodeSocketGeometry")
    return group


def changing_topology(out_dir):
    """Mesh whose vertex/face count changes every frame, with a `velocity`
    point attribute (the attribute Blender exports as Alembic velocities)."""
    scene = reset_scene(frames=24)
    group = _geometry_nodes_group("GrowingGrid")
    nodes, links = group.nodes, group.links
    out = nodes.new("NodeGroupOutput")
    time = nodes.new("GeometryNodeInputSceneTime")
    add = nodes.new("ShaderNodeMath")
    add.operation = "ADD"
    add.inputs[1].default_value = 2.0
    grid = nodes.new("GeometryNodeMeshGrid")
    grid.inputs["Size X"].default_value = 2.0
    grid.inputs["Size Y"].default_value = 2.0
    grid.inputs["Vertices Y"].default_value = 4
    links.new(time.outputs["Frame"], add.inputs[0])
    links.new(add.outputs[0], grid.inputs["Vertices X"])

    position = nodes.new("GeometryNodeInputPosition")
    velocity = nodes.new("ShaderNodeVectorMath")
    velocity.operation = "SCALE"
    velocity.inputs["Scale"].default_value = 0.5
    links.new(position.outputs[0], velocity.inputs[0])
    store = nodes.new("GeometryNodeStoreNamedAttribute")
    store.data_type = "FLOAT_VECTOR"
    store.domain = "POINT"
    store.inputs["Name"].default_value = "velocity"
    links.new(grid.outputs["Mesh"], store.inputs["Geometry"])
    links.new(velocity.outputs[0], store.inputs["Value"])
    links.new(store.outputs["Geometry"], out.inputs[0])

    obj = link(bpy.data.objects.new("Growing", bpy.data.meshes.new("GrowingShape")))
    mod = obj.modifiers.new("GrowingGrid", "NODES")
    mod.node_group = group

    export(os.path.join(out_dir, "changing_topology.abc"), scene)


def particles(out_dir):
    """Particle system: particles are born over time and die, exported as points."""
    scene = reset_scene(frames=40)
    bpy.ops.mesh.primitive_plane_add(size=2.0)
    emitter = bpy.context.active_object
    emitter.name = "Emitter"
    mod = emitter.modifiers.new("Spray", "PARTICLE_SYSTEM")
    settings = mod.particle_system.settings
    settings.count = 200
    settings.frame_start = 1
    settings.frame_end = 20
    settings.lifetime = 15
    settings.normal_factor = 2.0
    settings.render_type = "NONE"
    settings.effector_weights.gravity = 0.5
    emitter.show_instancer_for_render = True

    # Log how many particles are alive per frame, so resource/README.md can document it.
    alive = []
    for frame in range(scene.frame_start, scene.frame_end + 1):
        scene.frame_set(frame)
        system = emitter.evaluated_get(bpy.context.evaluated_depsgraph_get()).particle_systems[0]
        alive.append(sum(1 for p in system.particles if p.alive_state == "ALIVE"))
    print(f"[assets] particles alive per frame: {alive}")
    scene.frame_set(scene.frame_start)

    export(os.path.join(out_dir, "particles.abc"), scene, export_particles=True)


def large_mesh(out_dir):
    """~2M-face mesh for benchmarks. Not committed (see resource/README.md)."""
    scene = reset_scene(frames=1)
    mesh = grid_mesh("DenseShape", 1415, 1415, size=10.0)
    link(bpy.data.objects.new("Dense", mesh))
    export(os.path.join(out_dir, "large_mesh.abc"), scene, uvs=True, normals=False)


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    out_dir = os.path.abspath(argv[0] if argv and not argv[0].startswith("--") else "resource/blender")
    os.makedirs(out_dir, exist_ok=True)
    print(f"[assets] Blender {bpy.app.version_string} -> {out_dir}")

    builders = [cloth_deform, materials_and_subd, camera_and_rigid, curves_and_hair, changing_topology, particles]
    if "--large" in argv:
        builders.append(large_mesh)
    failed = []
    for build in builders:
        try:
            build(out_dir)
        except Exception as error:  # keep going so one API change doesn't block the rest
            failed.append(build.__name__)
            print(f"[assets] FAILED {build.__name__}: {type(error).__name__}: {error}")
    if failed:
        print(f"[assets] {len(failed)} scene(s) failed: {', '.join(failed)}")
        sys.exit(1)


main()
