// Writes the small Alembic archives used by the unit tests (test/fixtures/).
//
//   yarn fixtures            # builds this tool and regenerates the fixtures
//
// The expected values asserted in test/*.test.ts come from this file, so keep
// both in sync when changing anything here.

#include <Alembic/AbcCoreOgawa/All.h>
#include <Alembic/AbcGeom/All.h>
#include <Alembic/AbcMaterial/All.h>

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

// Points and curves (spec 0002).
// /particles     4 points, ids 10..13, velocity (1,0,0) units/s, widths 0.1..0.4, 2 frames at 24 fps
// /linearCurves  2 linear curves (3 and 4 vertices), per-curve widths
// /linearLoop    1 periodic linear curve (unit square)
// /bezierCurve   1 cubic Bezier (4 CVs), constant width 0.5
// /bsplineCurve  1 cubic B-spline (5 CVs), per-vertex widths and UVs
// /nurbsArc      rational quadratic quarter circle (order 3, knots 0 0 0 1 1 1, weights 1 sqrt(2)/2 1)
// /badCurves     vertex counts that don't add up to the positions
void pointsAndCurves(const std::filesystem::path& dir)
{
    Abc::OArchive archive = createArchive(dir / "points_and_curves.abc");
    Abc::OObject top = archive.getTop();
    const Alembic::AbcCoreAbstract::TimeSampling ts(1.0 / 24.0, 1.0 / 24.0);
    const uint32_t tsIndex = archive.addTimeSampling(ts);

    AbcG::OPoints particles(top, "particles", tsIndex);
    const std::vector<uint64_t> ids = {10, 11, 12, 13};
    const std::vector<Imath::V3f> velocities(4, Imath::V3f(1, 0, 0));
    const std::vector<float> widths = {0.1f, 0.2f, 0.3f, 0.4f};
    for (int frame = 0; frame < 2; ++frame) {
        std::vector<Imath::V3f> P;
        for (int i = 0; i < 4; ++i)
            P.push_back(Imath::V3f(i + frame / 24.0f, 0, 0));
        AbcG::OPointsSchema::Sample sample(
            AbcG::P3fArraySample(P), Abc::UInt64ArraySample(ids), Abc::V3fArraySample(velocities),
            AbcG::OFloatGeomParam::Sample(Abc::FloatArraySample(widths), AbcG::kVertexScope));
        particles.getSchema().set(sample);
    }

    auto writeCurves = [&](const std::string& name, const std::vector<Imath::V3f>& P,
                           const std::vector<int32_t>& counts, AbcG::CurveType type, AbcG::CurvePeriodicity wrap,
                           AbcG::BasisType basis, const AbcG::OFloatGeomParam::Sample& widths,
                           const AbcG::OV2fGeomParam::Sample& uvs = AbcG::OV2fGeomParam::Sample(),
                           const std::vector<float>& weights = {}, const std::vector<uint8_t>& orders = {},
                           const std::vector<float>& knots = {}) {
        AbcG::OCurves curves(top, name);
        AbcG::OCurvesSchema::Sample sample(AbcG::P3fArraySample(P), Abc::Int32ArraySample(counts), type, wrap, widths,
                                           uvs, AbcG::ON3fGeomParam::Sample(), basis, Abc::FloatArraySample(weights),
                                           Abc::UcharArraySample(orders), Abc::FloatArraySample(knots));
        curves.getSchema().set(sample);
    };

    const std::vector<float> perCurve = {0.1f, 0.2f};
    writeCurves("linearCurves", {{0, 0, 0}, {1, 0, 0}, {2, 0, 0}, {0, 1, 0}, {1, 1, 0}, {2, 1, 0}, {3, 1, 0}}, {3, 4},
                AbcG::kLinear, AbcG::kNonPeriodic, AbcG::kNoBasis,
                AbcG::OFloatGeomParam::Sample(Abc::FloatArraySample(perCurve), AbcG::kUniformScope));

    writeCurves("linearLoop", {{0, 0, 0}, {1, 0, 0}, {1, 1, 0}, {0, 1, 0}}, {4}, AbcG::kLinear, AbcG::kPeriodic,
                AbcG::kNoBasis, AbcG::OFloatGeomParam::Sample());

    const std::vector<float> constantWidth = {0.5f};
    writeCurves("bezierCurve", {{0, 0, 0}, {0, 1, 0}, {1, 1, 0}, {1, 0, 0}}, {4}, AbcG::kCubic, AbcG::kNonPeriodic,
                AbcG::kBezierBasis,
                AbcG::OFloatGeomParam::Sample(Abc::FloatArraySample(constantWidth), AbcG::kConstantScope));

    const std::vector<float> vertexWidths = {0.1f, 0.2f, 0.3f, 0.4f, 0.5f};
    std::vector<Imath::V2f> curveUvs;
    for (int i = 0; i < 5; ++i)
        curveUvs.push_back(Imath::V2f(i / 4.0f, 0));
    writeCurves("bsplineCurve", {{0, 0, 0}, {1, 2, 0}, {2, 0, 0}, {3, 2, 0}, {4, 0, 0}}, {5}, AbcG::kCubic,
                AbcG::kNonPeriodic, AbcG::kBsplineBasis,
                AbcG::OFloatGeomParam::Sample(Abc::FloatArraySample(vertexWidths), AbcG::kVertexScope),
                AbcG::OV2fGeomParam::Sample(AbcG::V2fArraySample(curveUvs), AbcG::kVertexScope));

    writeCurves("nurbsArc", {{1, 0, 0}, {1, 1, 0}, {0, 1, 0}}, {3}, AbcG::kVariableOrder, AbcG::kNonPeriodic,
                AbcG::kBsplineBasis, AbcG::OFloatGeomParam::Sample(), AbcG::OV2fGeomParam::Sample(),
                {1.0f, 0.70710678f, 1.0f}, {3}, {0, 0, 0, 1, 1, 1});

    writeCurves("badCurves", {{0, 0, 0}, {1, 0, 0}, {2, 0, 0}}, {5}, AbcG::kLinear, AbcG::kNonPeriodic, AbcG::kNoBasis,
                AbcG::OFloatGeomParam::Sample());
}

// Animation (spec 0004). Frames are at 24 fps starting at 1/24 s unless noted.
// /spin                 xform: rotate 0, 90, 180 degrees about Y and translate x = 0, 1, 2 (3 frames)
// /wave/waveShape       4x4 grid, constant topology; point i has y = (frame - 1) * (i % 4) * 0.1 (3 frames)
// /sim/simShape         changing topology: frame f has f quads in a row; velocity (0, 1, 0) per point (3 frames)
// /particles            ids {0, 1} on frame 1, {0, 1, 2} on frame 2; x = id, y = frame - 1; velocity (0, 24, 0)
// /acyclic              xform at acyclic times 0, 0.1, 0.35 with x = 0, 1, 2
// /thirty               xform at 30 fps (2 samples from 1/30 s) with x = 0, 10
void animation(const std::filesystem::path& dir)
{
    namespace AbcA = Alembic::AbcCoreAbstract;
    Abc::OArchive archive = createArchive(dir / "animation.abc");
    Abc::OObject top = archive.getTop();
    const uint32_t fps24 = archive.addTimeSampling(AbcA::TimeSampling(1.0 / 24.0, 1.0 / 24.0));
    const uint32_t fps30 = archive.addTimeSampling(AbcA::TimeSampling(1.0 / 30.0, 1.0 / 30.0));
    const std::vector<double> acyclicTimes = {0.0, 0.1, 0.35};
    const uint32_t acyclic = archive.addTimeSampling(
        AbcA::TimeSampling(AbcA::TimeSamplingType(AbcA::TimeSamplingType::kAcyclic), acyclicTimes));

    AbcG::OXform spin(top, "spin", fps24);
    for (int f = 0; f < 3; ++f) {
        AbcG::XformSample sample;
        sample.setTranslation(Imath::V3d(f, 0, 0));
        sample.setRotation(Imath::V3d(0, 1, 0), 90.0 * f);
        spin.getSchema().set(sample);
    }

    AbcG::OXform wave = writeXform(top, "wave", {0, 0, 0});
    AbcG::OPolyMesh waveShape(wave, "waveShape", fps24);
    std::vector<int32_t> gridIndices, gridCounts;
    for (int j = 0; j < 3; ++j) {
        for (int i = 0; i < 3; ++i) {
            const int a = j * 4 + i;
            gridIndices.insert(gridIndices.end(), {a, a + 4, a + 5, a + 1}); // clockwise from +Y
            gridCounts.push_back(4);
        }
    }
    for (int f = 0; f < 3; ++f) {
        std::vector<Imath::V3f> P;
        for (int i = 0; i < 16; ++i)
            P.push_back(Imath::V3f(i % 4, f * (i % 4) * 0.1f, i / 4));
        waveShape.getSchema().set(AbcG::OPolyMeshSchema::Sample(
            AbcG::P3fArraySample(P), Abc::Int32ArraySample(gridIndices), Abc::Int32ArraySample(gridCounts)));
    }

    AbcG::OXform sim = writeXform(top, "sim", {0, 0, 0});
    AbcG::OPolyMesh simShape(sim, "simShape", fps24);
    for (int f = 1; f <= 3; ++f) {
        std::vector<Imath::V3f> P;
        for (int i = 0; i <= f; ++i) {
            P.push_back(Imath::V3f(i, 0, 0));
            P.push_back(Imath::V3f(i, 0, 1));
        }
        std::vector<int32_t> indices, counts;
        for (int q = 0; q < f; ++q) {
            indices.insert(indices.end(), {2 * q, 2 * q + 1, 2 * q + 3, 2 * q + 2});
            counts.push_back(4);
        }
        const std::vector<Imath::V3f> velocities(P.size(), Imath::V3f(0, 1, 0));
        AbcG::OPolyMeshSchema::Sample sample{AbcG::P3fArraySample(P), Abc::Int32ArraySample(indices),
                                             Abc::Int32ArraySample(counts)};
        sample.setVelocities(Abc::V3fArraySample(velocities));
        simShape.getSchema().set(sample);
    }

    AbcG::OPoints particles(top, "particles", fps24);
    for (int f = 1; f <= 2; ++f) {
        std::vector<uint64_t> ids;
        std::vector<Imath::V3f> P, velocities;
        for (int id = 0; id <= f; ++id) {
            ids.push_back(id);
            P.push_back(Imath::V3f(id, f - 1, 0));
            velocities.push_back(Imath::V3f(0, 24, 0));
        }
        particles.getSchema().set(AbcG::OPointsSchema::Sample(AbcG::P3fArraySample(P), Abc::UInt64ArraySample(ids),
                                                              Abc::V3fArraySample(velocities)));
    }

    AbcG::OXform acyclicXform(top, "acyclic", acyclic);
    AbcG::OXform thirty(top, "thirty", fps30);
    for (int i = 0; i < 3; ++i) {
        AbcG::XformSample sample;
        sample.setTranslation(Imath::V3d(i, 0, 0));
        acyclicXform.getSchema().set(sample);
    }
    for (int i = 0; i < 2; ++i) {
        AbcG::XformSample sample;
        sample.setTranslation(Imath::V3d(i * 10, 0, 0));
        thirty.getSchema().set(sample);
    }
}

// Face sets and materials (spec 0003).
// /cube/cubeShape     face-varying cube; face sets sides {0,1,2,3}, bottom {4}, top {5} (exclusive)
//                     assigned /materials/red; face set "top" assigned /materials/red/blue
// /overlap/quadShape  2x1 quads; non-exclusive face sets a {0} and b {0, 1}
// /assigned           xform assigned /materials/red/blue; /assigned/childShape inherits it
// /materials/red      target "*", surface "standard_surface", base_color (1,0,0), roughness 0.5
// /materials/red/blue child material: inherits red (AbcMaterial inheritance is by nesting),
//                     overrides base_color (0,0,1)
// /bad/quadShape      face set referencing face 5 of a 1-face mesh
void faceSetsAndMaterials(const std::filesystem::path& dir)
{
    namespace AbcM = Alembic::AbcMaterial;
    Abc::OArchive archive = createArchive(dir / "face_sets.abc");
    Abc::OObject top = archive.getTop();

    auto faceSet = [](AbcG::OPolyMesh& mesh, const std::string& name, const std::vector<int32_t>& faces,
                      bool exclusive) -> AbcG::OFaceSet& {
        AbcG::OFaceSet& set = mesh.getSchema().createFaceSet(name);
        set.getSchema().set(AbcG::OFaceSetSchema::Sample(Abc::Int32ArraySample(faces)));
        set.getSchema().setFaceExclusivity(exclusive ? AbcG::kFaceSetExclusive : AbcG::kFaceSetNonExclusive);
        return set;
    };

    Abc::OObject materials(top, "materials");
    AbcM::OMaterial red(materials, "red");
    red.getSchema().setShader("*", "surface", "standard_surface");
    Abc::OCompoundProperty redParams = red.getSchema().getShaderParameters("*", "surface");
    Abc::OC3fProperty(redParams, "base_color").set(Imath::C3f(1, 0, 0));
    Abc::OFloatProperty(redParams, "roughness").set(0.5f);
    AbcM::OMaterial blue(red, "blue");
    blue.getSchema().setShader("*", "surface", "standard_surface");
    Abc::OCompoundProperty blueParams = blue.getSchema().getShaderParameters("*", "surface");
    Abc::OC3fProperty(blueParams, "base_color").set(Imath::C3f(0, 0, 1));

    AbcG::OXform cube = writeXform(top, "cube", {0, 0, 0});
    AbcG::OPolyMesh cubeShape = writeCube(cube, "cubeShape");
    faceSet(cubeShape, "sides", {0, 1, 2, 3}, true);
    faceSet(cubeShape, "bottom", {4}, true);
    AbcG::OFaceSet& topSet = faceSet(cubeShape, "top", {5}, true);
    AbcM::addMaterialAssignment(cubeShape, "/materials/red");
    AbcM::addMaterialAssignment(topSet, "/materials/red/blue");

    AbcG::OXform overlap = writeXform(top, "overlap", {3, 0, 0});
    AbcG::OPolyMesh quads(overlap, "quadShape");
    const std::vector<Imath::V3f> P = {{0, 0, 0}, {0, 0, 1}, {1, 0, 1}, {1, 0, 0}, {2, 0, 1}, {2, 0, 0}};
    const std::vector<int32_t> indices = {0, 3, 2, 1, 3, 5, 4, 2};
    const std::vector<int32_t> counts = {4, 4};
    quads.getSchema().set(AbcG::OPolyMeshSchema::Sample{AbcG::P3fArraySample(P), Abc::Int32ArraySample(indices),
                                                        Abc::Int32ArraySample(counts)});
    faceSet(quads, "a", {0}, false);
    faceSet(quads, "b", {0, 1}, false);

    AbcG::OXform assigned = writeXform(top, "assigned", {0, 3, 0});
    AbcM::addMaterialAssignment(assigned, "/materials/red/blue");
    writeQuad(assigned, "childShape");

    AbcG::OXform bad = writeXform(top, "bad", {0, -3, 0});
    AbcG::OPolyMesh badShape(bad, "quadShape");
    const std::vector<Imath::V3f> quad = {{0, 0, 0}, {0, 0, 1}, {1, 0, 1}, {1, 0, 0}};
    const std::vector<int32_t> quadIndices = {0, 3, 2, 1};
    const std::vector<int32_t> quadCounts = {4};
    badShape.getSchema().set(AbcG::OPolyMeshSchema::Sample{
        AbcG::P3fArraySample(quad), Abc::Int32ArraySample(quadIndices), Abc::Int32ArraySample(quadCounts)});
    faceSet(badShape, "broken", {5}, true);
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
        pointsAndCurves(dir);
        animation(dir);
        faceSetsAndMaterials(dir);
    } catch (const std::exception& e) {
        std::cerr << "Failed to write fixtures: " << e.what() << std::endl;
        return 1;
    }
    std::cout << "Fixtures written to " << std::filesystem::absolute(dir).string() << std::endl;
    return 0;
}
