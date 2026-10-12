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
AbcG::OPolyMesh writeCube(Abc::OObject parent, const std::string& name)
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
    return mesh;
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

// Attributes and user properties (spec 0006).
// /cube (xform) user properties: assetId, version, scale, enabled, tags, frameLabel (3 samples)
// /cube/cubeShape (24 corners, 8 points, 6 faces) .arbGeomParams:
//   Cd          C3f      facevarying, indexed (6 values, one color per face)
//   pointWeight float32  vertex  (8)      faceId  int32   uniform (6)
//   uv2         V2f      facevarying (24) tint    C4f     constant (1)
//   bigId       uint64   vertex  (8, one value above 2^32)
//   half        float16  vertex  (8)      flags   bool    vertex  (8)
//   label       string   constant (1)
// /plainShape: mesh without attributes or user properties
void attributes(const std::filesystem::path& dir)
{
    Abc::OArchive archive = createArchive(dir / "attributes.abc");
    const Alembic::AbcCoreAbstract::TimeSampling ts(1.0 / 24.0, 1.0 / 24.0);
    const uint32_t tsIndex = archive.addTimeSampling(ts);

    AbcG::OXform cube = writeXform(archive.getTop(), "cube", {0, 0, 0});
    Abc::OCompoundProperty user = cube.getSchema().getUserProperties();
    Abc::OStringProperty(user, "assetId").set("crate-042");
    Abc::OInt32Property(user, "version").set(7);
    Abc::ODoubleProperty(user, "scale").set(2.5);
    Abc::OBoolProperty(user, "enabled").set(true);
    const std::vector<std::string> tags = {"prop", "wood"};
    Abc::OStringArrayProperty(user, "tags").set(Abc::StringArraySample(tags));
    Abc::OStringProperty frameLabel(user, "frameLabel", tsIndex);
    for (const char* label : {"start", "middle", "end"})
        frameLabel.set(label);

    AbcG::OPolyMesh shape = writeCube(cube, "cubeShape");
    Abc::OCompoundProperty arb = shape.getSchema().getArbGeomParams();

    const std::vector<Imath::C3f> faceColors = {{1, 0, 0}, {0, 1, 0}, {0, 0, 1}, {1, 1, 0}, {0, 1, 1}, {1, 0, 1}};
    std::vector<uint32_t> colorIndices;
    for (uint32_t f = 0; f < 6; ++f)
        colorIndices.insert(colorIndices.end(), 4, f);
    AbcG::OC3fGeomParam cd(arb, "Cd", true, AbcG::kFacevaryingScope, 1);
    cd.set(AbcG::OC3fGeomParam::Sample(AbcG::C3fArraySample(faceColors), Abc::UInt32ArraySample(colorIndices),
                                       AbcG::kFacevaryingScope));

    std::vector<float> weights;
    for (int p = 0; p < 8; ++p)
        weights.push_back(p * 0.125f);
    AbcG::OFloatGeomParam pointWeight(arb, "pointWeight", false, AbcG::kVertexScope, 1);
    pointWeight.set(AbcG::OFloatGeomParam::Sample(Abc::FloatArraySample(weights), AbcG::kVertexScope));

    const std::vector<int32_t> faceIds = {10, 11, 12, 13, 14, 15};
    AbcG::OInt32GeomParam faceId(arb, "faceId", false, AbcG::kUniformScope, 1);
    faceId.set(AbcG::OInt32GeomParam::Sample(Abc::Int32ArraySample(faceIds), AbcG::kUniformScope));

    std::vector<Imath::V2f> uv2;
    for (int c = 0; c < 24; ++c)
        uv2.push_back(Imath::V2f(c * 0.5f, 1.0f));
    AbcG::OV2fGeomParam uvSet(arb, "uv2", false, AbcG::kFacevaryingScope, 1);
    uvSet.set(AbcG::OV2fGeomParam::Sample(AbcG::V2fArraySample(uv2), AbcG::kFacevaryingScope));

    const std::vector<Imath::C4f> tint = {{0.25f, 0.5f, 0.75f, 1.0f}};
    AbcG::OC4fGeomParam tintParam(arb, "tint", false, AbcG::kConstantScope, 1);
    tintParam.set(AbcG::OC4fGeomParam::Sample(AbcG::C4fArraySample(tint), AbcG::kConstantScope));

    std::vector<uint64_t> ids;
    for (uint64_t p = 0; p < 8; ++p)
        ids.push_back(p == 7 ? 5000000000ull : 100 + p);
    AbcG::OUInt64GeomParam bigId(arb, "bigId", false, AbcG::kVertexScope, 1);
    bigId.set(AbcG::OUInt64GeomParam::Sample(Abc::UInt64ArraySample(ids), AbcG::kVertexScope));

    std::vector<Alembic::Util::float16_t> halves;
    for (int p = 0; p < 8; ++p)
        halves.push_back(Alembic::Util::float16_t(p * 0.5f));
    AbcG::OHalfGeomParam half(arb, "half", false, AbcG::kVertexScope, 1);
    half.set(AbcG::OHalfGeomParam::Sample(Abc::HalfArraySample(halves), AbcG::kVertexScope));

    std::vector<Alembic::Util::bool_t> flags;
    for (int p = 0; p < 8; ++p)
        flags.push_back(p % 2 == 0);
    AbcG::OBoolGeomParam flagParam(arb, "flags", false, AbcG::kVertexScope, 1);
    flagParam.set(AbcG::OBoolGeomParam::Sample(Abc::BoolArraySample(flags), AbcG::kVertexScope));

    const std::vector<std::string> label = {"crate"};
    AbcG::OStringGeomParam labelParam(arb, "label", false, AbcG::kConstantScope, 1);
    labelParam.set(AbcG::OStringGeomParam::Sample(Abc::StringArraySample(label), AbcG::kConstantScope));

    writeCube(archive.getTop(), "plainShape");
}

int main(int argc, char** argv)
{
    const std::filesystem::path dir = argc > 1 ? argv[1] : "test/fixtures";
    try {
        std::filesystem::create_directories(dir);
        simpleMesh(dir);
        transformedMesh(dir);
        nestedHierarchy(dir);
        unsupportedTypes(dir);
        attributes(dir);
    } catch (const std::exception& e) {
        std::cerr << "Failed to write fixtures: " << e.what() << std::endl;
        return 1;
    }
    std::cout << "Fixtures written to " << std::filesystem::absolute(dir).string() << std::endl;
    return 0;
}
