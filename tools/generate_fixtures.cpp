// Writes the small Alembic archives used by the unit tests (test/fixtures/).
//
//   yarn fixtures            # builds this tool and regenerates the fixtures
//
// The expected values asserted in test/*.test.ts come from this file, so keep
// both in sync when changing anything here.

#include <Alembic/AbcCoreOgawa/All.h>
#include <Alembic/AbcGeom/All.h>

#include <filesystem>
#include <iostream>
#include <string>
#include <vector>

namespace Abc = Alembic::Abc;
namespace AbcG = Alembic::AbcGeom;

namespace {

Abc::OArchive createArchive(const std::filesystem::path& file)
{
    return Abc::CreateArchiveWithInfo(Alembic::AbcCoreOgawa::WriteArchive(), file.string(),
                                      "alembic-js fixture generator", "alembic-js unit test fixture",
                                      Abc::ErrorHandler::kThrowPolicy);
}

// Unit quad in the XZ plane facing +Y: clockwise when seen from +Y, which is
// Alembic's front-face convention.
void writeQuad(Abc::OObject parent, const std::string& name)
{
    const std::vector<Imath::V3f> P = {{0, 0, 0}, {0, 0, 1}, {1, 0, 1}, {1, 0, 0}};
    const std::vector<int32_t> indices = {0, 3, 2, 1};
    const std::vector<int32_t> counts = {4};
    AbcG::OPolyMesh mesh(parent, name);
    AbcG::OPolyMeshSchema::Sample sample{AbcG::P3fArraySample(P), Abc::Int32ArraySample(indices),
                                         Abc::Int32ArraySample(counts)};
    mesh.getSchema().set(sample);
}

// Unit cube with face-varying normals and UVs: 8 points, 6 quads, 24 corners.
void writeCube(Abc::OObject parent, const std::string& name)
{
    const std::vector<Imath::V3f> P = {
        {-0.5f, -0.5f, -0.5f}, {0.5f, -0.5f, -0.5f}, {0.5f, 0.5f, -0.5f}, {-0.5f, 0.5f, -0.5f},
        {-0.5f, -0.5f, 0.5f},  {0.5f, -0.5f, 0.5f},  {0.5f, 0.5f, 0.5f},  {-0.5f, 0.5f, 0.5f},
    };
    // Clockwise when viewed from outside.
    const std::vector<int32_t> indices = {
        0, 1, 2, 3, // -Z
        7, 6, 5, 4, // +Z
        3, 7, 4, 0, // -X
        5, 6, 2, 1, // +X
        4, 5, 1, 0, // -Y
        2, 6, 7, 3, // +Y
    };
    const std::vector<int32_t> counts = {4, 4, 4, 4, 4, 4};
    const Imath::V3f faceNormals[6] = {{0, 0, -1}, {0, 0, 1}, {-1, 0, 0}, {1, 0, 0}, {0, -1, 0}, {0, 1, 0}};
    std::vector<Imath::V3f> normals;
    std::vector<Imath::V2f> uvs;
    for (int f = 0; f < 6; ++f) {
        for (int c = 0; c < 4; ++c)
            normals.push_back(faceNormals[f]);
        uvs.insert(uvs.end(), {{0, 0}, {0, 1}, {1, 1}, {1, 0}});
    }

    AbcG::OPolyMesh mesh(parent, name);
    AbcG::ON3fGeomParam::Sample nSample{AbcG::N3fArraySample(normals), AbcG::kFacevaryingScope};
    AbcG::OV2fGeomParam::Sample uvSample{AbcG::V2fArraySample(uvs), AbcG::kFacevaryingScope};
    AbcG::OPolyMeshSchema::Sample sample{AbcG::P3fArraySample(P), Abc::Int32ArraySample(indices),
                                         Abc::Int32ArraySample(counts), uvSample, nSample};
    mesh.getSchema().set(sample);
}

AbcG::OXform writeXform(Abc::OObject parent, const std::string& name, const Imath::V3d& translate,
                        const Imath::V3d& scale = {1, 1, 1}, bool inherits = true)
{
    AbcG::OXform xform(parent, name);
    AbcG::XformSample sample;
    sample.setTranslation(translate);
    sample.setScale(scale);
    sample.setInheritsXforms(inherits);
    xform.getSchema().set(sample);
    return xform;
}

// /plane : polymesh directly under the root, no normals or UVs.
void simpleMesh(const std::filesystem::path& dir)
{
    Abc::OArchive archive = createArchive(dir / "simple_mesh.abc");
    writeQuad(archive.getTop(), "plane");
}

// /cube (translate 1,2,3 scale 2) / cubeShape : face-varying normals + UVs.
void transformedMesh(const std::filesystem::path& dir)
{
    Abc::OArchive archive = createArchive(dir / "transformed_mesh.abc");
    AbcG::OXform cube = writeXform(archive.getTop(), "cube", {1, 2, 3}, {2, 2, 2});
    writeCube(cube, "cubeShape");
}

// /root (translate 0,1,0)
//   /root/child_a (animated: translate x = 0, 1, 2 over 3 frames at 24fps)
//     /root/child_a/grandchild (translate 0,0,1)
//       /root/child_a/grandchild/quadShape
//   /root/child_b (translate 5,0,0, does not inherit parent transforms)
void nestedHierarchy(const std::filesystem::path& dir)
{
    Abc::OArchive archive = createArchive(dir / "nested_hierarchy.abc");
    const Alembic::AbcCoreAbstract::TimeSampling ts(1.0 / 24.0, 1.0 / 24.0);
    const uint32_t tsIndex = archive.addTimeSampling(ts);

    AbcG::OXform root = writeXform(archive.getTop(), "root", {0, 1, 0});

    AbcG::OXform childA(root, "child_a", tsIndex);
    for (int frame = 0; frame < 3; ++frame) {
        AbcG::XformSample sample;
        sample.setTranslation(Imath::V3d(frame, 0, 0));
        childA.getSchema().set(sample);
    }

    AbcG::OXform grandchild = writeXform(childA, "grandchild", {0, 0, 1});
    writeQuad(grandchild, "quadShape");

    writeXform(root, "child_b", {5, 0, 0}, {1, 1, 1}, false);
}

// Object types that have no geometry reader: points, curves, camera, plain object.
void unsupportedTypes(const std::filesystem::path& dir)
{
    Abc::OArchive archive = createArchive(dir / "unsupported_types.abc");
    Abc::OObject top = archive.getTop();

    const std::vector<Imath::V3f> P = {{0, 0, 0}, {1, 1, 1}, {2, 2, 2}};
    const std::vector<uint64_t> ids = {0, 1, 2};
    AbcG::OPoints points(top, "particles");
    points.getSchema().set(AbcG::OPointsSchema::Sample(AbcG::P3fArraySample(P), Abc::UInt64ArraySample(ids)));

    const std::vector<int32_t> nVerts = {3};
    AbcG::OCurves curves(top, "curve");
    curves.getSchema().set(AbcG::OCurvesSchema::Sample(AbcG::P3fArraySample(P), Abc::Int32ArraySample(nVerts)));

    AbcG::OCamera camera(top, "camera");
    AbcG::CameraSample camSample;
    camSample.setFocalLength(50.0);
    camSample.setVerticalAperture(2.4);
    camSample.setHorizontalAperture(3.6);
    camSample.setNearClippingPlane(0.5);
    camSample.setFarClippingPlane(500.0);
    camera.getSchema().set(camSample);

    Abc::OObject plain(top, "group");
}

} // namespace

int main(int argc, char** argv)
{
    const std::filesystem::path dir = argc > 1 ? argv[1] : "test/fixtures";
    try {
        std::filesystem::create_directories(dir);
        simpleMesh(dir);
        transformedMesh(dir);
        nestedHierarchy(dir);
        unsupportedTypes(dir);
    } catch (const std::exception& e) {
        std::cerr << "Failed to write fixtures: " << e.what() << std::endl;
        return 1;
    }
    std::cout << "Fixtures written to " << std::filesystem::absolute(dir).string() << std::endl;
    return 0;
}
