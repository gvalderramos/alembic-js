// Points and curves readers (spec 0002).
#include "AbcScene.h"

#include <Alembic/AbcGeom/All.h>

namespace AbcG = Alembic::AbcGeom;

namespace abcjs {

namespace {

const ObjectRecord& requireType(const ArchiveData& data, const std::string& objectPath, const std::string& type)
{
    const ObjectRecord* rec = data.find(objectPath);
    if (!rec) {
        throw AbcError(codes::ObjectNotFound, "Object '" + objectPath + "' does not exist in " + data.path);
    }
    if (rec->type != type) {
        throw AbcError(codes::UnsupportedType,
                       "Object '" + objectPath + "' is of type '" + rec->type + "', not '" + type + "'");
    }
    return *rec;
}

template <class Fn> auto guarded(const std::string& what, Fn&& fn) -> decltype(fn())
{
    try {
        return fn();
    } catch (const AbcError&) {
        throw;
    } catch (const std::exception& e) {
        throw AbcError(codes::ReadFailed, "Failed to read " + what + ": " + e.what());
    }
}

template <class SamplePtr> void appendVec3(const SamplePtr& sample, std::vector<float>& out)
{
    if (!sample) return;
    out.reserve(sample->size() * 3);
    for (size_t i = 0; i < sample->size(); ++i) {
        const auto& v = (*sample)[i];
        out.push_back(v.x);
        out.push_back(v.y);
        out.push_back(v.z);
    }
}

std::string scopeName(AbcG::GeometryScope scope)
{
    switch (scope) {
    case AbcG::kConstantScope:
        return "constant";
    case AbcG::kUniformScope:
        return "uniform";
    case AbcG::kVaryingScope:
        return "varying";
    case AbcG::kVertexScope:
        return "vertex";
    case AbcG::kFacevaryingScope:
        return "facevarying";
    default:
        return "";
    }
}

std::string basisName(AbcG::BasisType basis)
{
    switch (basis) {
    case AbcG::kBezierBasis:
        return "bezier";
    case AbcG::kBsplineBasis:
        return "bspline";
    case AbcG::kCatmullromBasis:
        return "catmullrom";
    case AbcG::kHermiteBasis:
        return "hermite";
    case AbcG::kPowerBasis:
        return "power";
    default:
        return "none";
    }
}

std::string curveTypeName(AbcG::CurveType type)
{
    switch (type) {
    case AbcG::kLinear:
        return "linear";
    case AbcG::kVariableOrder:
        return "variableOrder";
    default:
        return "cubic";
    }
}

// Number of span end points ("varying" values) of a curve with n control vertices.
size_t varyingCount(const std::string& type, const std::string& basis, bool periodic, size_t n, size_t order)
{
    if (type == "linear") return n;
    size_t spans = 0;
    if (type == "cubic" && basis == "bezier") {
        spans = periodic ? n / 3 : (n >= 4 ? (n - 1) / 3 : 0);
    } else {
        const size_t degree = type == "cubic" ? 3 : (order > 0 ? order - 1 : 3);
        spans = periodic ? n : (n > degree ? n - degree : 0);
    }
    return periodic ? spans : spans + 1;
}

// Widths scope as written when it matches the count; otherwise inferred from the count.
// Some exporters (e.g. Blender) label per-vertex widths as 'constant'.
std::string widthScope(const CurvesData& c, size_t numWidths, AbcG::GeometryScope declared)
{
    size_t vertices = 0, varying = 0;
    for (size_t i = 0; i < c.vertexCounts.size(); ++i) {
        const size_t n = static_cast<size_t>(c.vertexCounts[i]);
        const size_t order = i < c.orders.size() ? c.orders[i] : 0;
        vertices += n;
        varying += varyingCount(c.curveType, c.basis, c.periodic, n, order);
    }
    const size_t curves = c.vertexCounts.size();
    auto matches = [&](const std::string& scope) {
        if (scope == "constant") return numWidths == 1;
        if (scope == "uniform") return numWidths == curves;
        if (scope == "varying") return numWidths == varying;
        if (scope == "vertex") return numWidths == vertices;
        return false;
    };
    const std::string written = scopeName(declared);
    if (matches(written)) return written;
    for (const char* scope : {"vertex", "varying", "uniform", "constant"}) {
        if (matches(scope)) return scope;
    }
    return written.empty() ? "unknown" : written;
}

[[noreturn]] void malformed(const std::string& what, const std::string& path, size_t got, size_t expected)
{
    throw AbcError(codes::MalformedData, "'" + path + "' has " + std::to_string(got) + " " + what + " but " +
                                             std::to_string(expected) + " were expected");
}

} // namespace

PointsData ReadPoints(const ArchiveData& data, const std::string& objectPath, double time)
{
    const ObjectRecord& rec = requireType(data, objectPath, "points");
    return guarded("points '" + objectPath + "'", [&] {
        Alembic::Abc::IObject obj = ResolveObject(data, objectPath);
        Alembic::Abc::ISampleSelector sel(time);
        AbcG::IPoints points(obj, Alembic::Abc::kWrapExisting);
        AbcG::IPointsSchema& schema = points.getSchema();
        AbcG::IPointsSchema::Sample sample;
        schema.get(sample, sel);

        PointsData out;
        out.name = rec.name;
        out.path = rec.path;
        appendVec3(sample.getPositions(), out.positions);
        const size_t count = out.positions.size() / 3;

        if (auto ids = sample.getIds(); ids && ids->size() > 0) {
            if (ids->size() != count) malformed("ids", objectPath, ids->size(), count);
            out.ids.assign(ids->get(), ids->get() + ids->size());
            out.hasIds = true;
        }
        if (auto velocities = sample.getVelocities(); velocities && velocities->size() > 0) {
            if (velocities->size() != count) malformed("velocities", objectPath, velocities->size(), count);
            appendVec3(velocities, out.velocities);
        }
        AbcG::IFloatGeomParam widths = schema.getWidthsParam();
        if (widths.valid() && widths.getNumSamples() > 0) {
            AbcG::IFloatGeomParam::Sample ws = widths.getExpandedValue(sel);
            if (ws.getVals() && ws.getVals()->size() > 0) {
                const size_t n = ws.getVals()->size();
                out.widths.assign(ws.getVals()->get(), ws.getVals()->get() + n);
                if (n == count) {
                    out.widthScope = "vertex";
                } else if (n == 1) {
                    out.widthScope = "constant";
                } else {
                    malformed("widths", objectPath, n, count);
                }
            }
        }
        out.transform = WorldMatrix(obj, sel);
        return out;
    });
}

CurvesData ReadCurves(const ArchiveData& data, const std::string& objectPath, double time)
{
    const ObjectRecord& rec = requireType(data, objectPath, "curves");
    return guarded("curves '" + objectPath + "'", [&] {
        Alembic::Abc::IObject obj = ResolveObject(data, objectPath);
        Alembic::Abc::ISampleSelector sel(time);
        AbcG::ICurves curves(obj, Alembic::Abc::kWrapExisting);
        AbcG::ICurvesSchema& schema = curves.getSchema();
        AbcG::ICurvesSchema::Sample sample;
        schema.get(sample, sel);

        CurvesData out;
        out.name = rec.name;
        out.path = rec.path;
        appendVec3(sample.getPositions(), out.positions);
        const size_t numVertices = out.positions.size() / 3;

        if (auto counts = sample.getCurvesNumVertices()) {
            out.vertexCounts.assign(counts->get(), counts->get() + counts->size());
        }
        size_t total = 0;
        for (int32_t c : out.vertexCounts) {
            if (c < 0) malformed("vertices in a curve", objectPath, 0, 1);
            total += static_cast<size_t>(c);
        }
        if (total != numVertices) malformed("positions", objectPath, numVertices, total);

        out.curveType = curveTypeName(sample.getType());
        out.periodic = sample.getWrap() == AbcG::kPeriodic;
        out.basis = basisName(sample.getBasis());
        if (auto orders = sample.getOrders(); orders && orders->size() > 0) {
            out.orders.assign(orders->get(), orders->get() + orders->size());
        }
        if (auto knots = sample.getKnots(); knots && knots->size() > 0) {
            out.knots.assign(knots->get(), knots->get() + knots->size());
        }
        if (auto weights = sample.getPositionWeights(); weights && weights->size() > 0) {
            if (weights->size() != numVertices) malformed("position weights", objectPath, weights->size(), numVertices);
            out.weights.assign(weights->get(), weights->get() + weights->size());
        }
        if (auto velocities = sample.getVelocities(); velocities && velocities->size() > 0) {
            appendVec3(velocities, out.velocities);
        }

        AbcG::IFloatGeomParam widths = schema.getWidthsParam();
        if (widths.valid() && widths.getNumSamples() > 0) {
            AbcG::IFloatGeomParam::Sample ws = widths.getExpandedValue(sel);
            if (ws.getVals() && ws.getVals()->size() > 0) {
                const size_t n = ws.getVals()->size();
                out.widths.assign(ws.getVals()->get(), ws.getVals()->get() + n);
                out.widthScope = widthScope(out, n, ws.getScope());
            }
        }
        AbcG::IV2fGeomParam uvs = schema.getUVsParam();
        if (uvs.valid() && uvs.getNumSamples() > 0) {
            auto us = uvs.getExpandedValue(sel);
            if (us.getVals()) {
                for (size_t i = 0; i < us.getVals()->size(); ++i) {
                    out.uvs.push_back((*us.getVals())[i].x);
                    out.uvs.push_back((*us.getVals())[i].y);
                }
            }
        }
        AbcG::IN3fGeomParam normals = schema.getNormalsParam();
        if (normals.valid() && normals.getNumSamples() > 0) {
            appendVec3(normals.getExpandedValue(sel).getVals(), out.normals);
        }
        out.transform = WorldMatrix(obj, sel);
        return out;
    });
}

} // namespace abcjs
