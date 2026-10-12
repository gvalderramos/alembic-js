#include "AbcScene.h"
#include "AbcProperties.h"

#include <Alembic/AbcCoreFactory/All.h>
#include <Alembic/AbcGeom/All.h>

#include <algorithm>
#include <cmath>
#include <filesystem>
#include <functional>
#include <limits>
#include <map>

#include <Imath/ImathMatrixAlgo.h>
#include <Imath/ImathQuat.h>

namespace AbcG = Alembic::AbcGeom;
namespace AbcF = Alembic::AbcCoreFactory;

namespace abcjs {

namespace {

constexpr double kPi = 3.14159265358979323846;

Matrix toMatrix(const Imath::M44d& m)
{
    // Imath stores row-major with row vectors (translation in m[3][0..2]).
    // Flattening it gives the column-major layout expected by
    // three.js Matrix4.fromArray / WebGL.
    Matrix out{};
    for (int r = 0; r < 4; ++r) {
        for (int c = 0; c < 4; ++c) {
            out[r * 4 + c] = m[r][c];
        }
    }
    return out;
}

std::string classify(const AbcG::IObject& obj)
{
    const auto& md = obj.getMetaData();
    if (AbcG::IXform::matches(md)) return "xform";
    if (AbcG::IPolyMesh::matches(md)) return "mesh";
    if (AbcG::ISubD::matches(md)) return "subd";
    if (AbcG::ICamera::matches(md)) return "camera";
    if (AbcG::IPoints::matches(md)) return "points";
    if (AbcG::ICurves::matches(md)) return "curves";
    if (AbcG::INuPatch::matches(md)) return "nupatch";
    if (AbcG::ILight::matches(md)) return "light";
    if (AbcG::IFaceSet::matches(md)) return "faceset";
    return "unknown";
}

TimeSamplingInfo describeTimeSampling(const Alembic::AbcCoreAbstract::TimeSamplingPtr& ts, size_t numSamples)
{
    TimeSamplingInfo info;
    if (!ts) return info;
    const auto& type = ts->getTimeSamplingType();
    info.valid = true;
    info.kind = type.isUniform() ? "uniform" : type.isCyclic() ? "cyclic" : "acyclic";
    info.timePerCycle = type.isAcyclic() ? 0.0 : type.getTimePerCycle();
    info.startTime = numSamples > 0 ? ts->getSampleTime(0) : 0.0;
    info.sampleTimes.reserve(numSamples);
    for (size_t i = 0; i < numSamples; ++i)
        info.sampleTimes.push_back(ts->getSampleTime(i));
    return info;
}

template <class S> std::string topologyName(const S& schema)
{
    switch (schema.getTopologyVariance()) {
    case AbcG::kConstantTopology:
        return "constant";
    case AbcG::kHomogeneousTopology:
        return "homogeneous";
    default:
        return "heterogeneous";
    }
}

template <class T> void sampleInfo(const AbcG::IObject& obj, ObjectRecord& rec)
{
    T typed(obj, Alembic::Abc::kWrapExisting);
    auto& schema = typed.getSchema();
    rec.numSamples = schema.getNumSamples();
    rec.animated = !schema.isConstant();
    rec.timeSampling = describeTimeSampling(schema.getTimeSampling(), rec.numSamples);
    if constexpr (std::is_same_v<T, AbcG::IPolyMesh> || std::is_same_v<T, AbcG::ISubD> ||
                  std::is_same_v<T, AbcG::ICurves>) {
        rec.topology = topologyName(schema);
    } else if constexpr (std::is_same_v<T, AbcG::IPoints>) {
        rec.topology = rec.animated ? "heterogeneous" : "constant";
    }
}

void fillSampleInfo(const AbcG::IObject& obj, ObjectRecord& rec)
{
    if (rec.type == "xform")
        sampleInfo<AbcG::IXform>(obj, rec);
    else if (rec.type == "mesh")
        sampleInfo<AbcG::IPolyMesh>(obj, rec);
    else if (rec.type == "subd")
        sampleInfo<AbcG::ISubD>(obj, rec);
    else if (rec.type == "camera")
        sampleInfo<AbcG::ICamera>(obj, rec);
    else if (rec.type == "points")
        sampleInfo<AbcG::IPoints>(obj, rec);
    else if (rec.type == "curves")
        sampleInfo<AbcG::ICurves>(obj, rec);
    else if (rec.type == "nupatch")
        sampleInfo<AbcG::INuPatch>(obj, rec);
}

void visit(const AbcG::IObject& obj, const std::string& parent, ArchiveData& data)
{
    ObjectRecord rec;
    rec.name = obj.getName();
    rec.path = obj.getFullName();
    rec.parent = parent;
    rec.type = classify(obj);
    rec.schema = obj.getMetaData().get("schema");
    fillSampleInfo(obj, rec);
    data.hasAnimation = data.hasAnimation || rec.animated;

    const size_t slot = data.objects.size();
    data.index[rec.path] = slot;
    data.objects.push_back(rec);

    for (size_t i = 0; i < obj.getNumChildren(); ++i) {
        AbcG::IObject child = obj.getChild(i);
        data.objects[slot].children.push_back(child.getFullName());
        visit(child, rec.path, data);
    }
}

// Archive time range and frame rate from the objects' own samples. Archive-level metadata
// (GetArchiveStartAndEndTime) only looks at sample counts and can be inconsistent (spec 0004).
void computeTimeRange(ArchiveData& data)
{
    bool any = false;
    double start = 0.0, end = 0.0;
    std::map<long long, int> rates; // fps * 1000 -> number of animated objects
    for (const auto& rec : data.objects) {
        if (!rec.animated || rec.timeSampling.sampleTimes.empty()) continue;
        const double first = rec.timeSampling.sampleTimes.front();
        const double last = rec.timeSampling.sampleTimes.back();
        start = any ? std::min(start, first) : first;
        end = any ? std::max(end, last) : last;
        any = true;
        if (rec.timeSampling.kind == "uniform" && rec.timeSampling.timePerCycle > 0.0) {
            ++rates[std::llround(1000.0 / rec.timeSampling.timePerCycle)];
        }
    }
    if (!any) {
        // Static archive: a single instant, the earliest sample written.
        for (const auto& rec : data.objects) {
            if (rec.timeSampling.sampleTimes.empty()) continue;
            const double first = rec.timeSampling.sampleTimes.front();
            start = any ? std::min(start, first) : first;
            any = true;
        }
        end = start;
    }
    data.startTime = start;
    data.endTime = end;
    int best = 0;
    for (const auto& [rate, count] : rates) {
        if (count > best) {
            best = count;
            data.fps = rate / 1000.0;
        }
    }
}

} // namespace

// Resolves "/a/b/c" by walking child names from the archive root.
Alembic::Abc::IObject ResolveObject(const ArchiveData& data, const std::string& objectPath)
{
    if (!data.find(objectPath)) {
        throw AbcError(codes::ObjectNotFound, "Object '" + objectPath + "' does not exist in " + data.path);
    }
    AbcG::IObject current = const_cast<Alembic::Abc::IArchive&>(data.archive).getTop();
    size_t start = 1;
    while (start <= objectPath.size()) {
        size_t end = objectPath.find('/', start);
        if (end == std::string::npos) end = objectPath.size();
        if (end > start) {
            current = current.getChild(objectPath.substr(start, end - start));
            if (!current.valid()) {
                throw AbcError(codes::ObjectNotFound, "Object '" + objectPath + "' could not be resolved");
            }
        }
        start = end + 1;
    }
    return current;
}

namespace {

} // namespace

SampleSpan SelectSamples(const Alembic::AbcCoreAbstract::TimeSamplingPtr& ts, size_t numSamples, const SampleSpec& spec)
{
    SampleSpan span;
    if (!ts || numSamples == 0) return span;
    const auto n = static_cast<Alembic::AbcCoreAbstract::index_t>(numSamples);
    if (spec.mode == SampleSpec::Mode::Near) {
        const auto nearest = ts->getNearIndex(spec.time, n);
        span.i0 = span.i1 = nearest.first;
        span.t0 = nearest.second;
        return span;
    }
    const auto floor = ts->getFloorIndex(spec.time, n);
    span.i0 = span.i1 = floor.first;
    span.t0 = floor.second;
    if (spec.mode == SampleSpec::Mode::Interpolate) {
        const auto ceil = ts->getCeilIndex(spec.time, n);
        if (ceil.first != floor.first && ceil.second > floor.second) {
            span.i1 = ceil.first;
            span.alpha = std::clamp((spec.time - floor.second) / (ceil.second - floor.second), 0.0, 1.0);
        }
    }
    return span;
}

namespace {

// Blends two matrices by decomposing them into scale, rotation (slerp) and translation.
Imath::M44d blendMatrices(const Imath::M44d& a, const Imath::M44d& b, double t)
{
    auto decompose = [](Imath::M44d m, Imath::V3d& scale, Imath::Quatd& rotation, Imath::V3d& translation) {
        translation = Imath::V3d(m[3][0], m[3][1], m[3][2]);
        Imath::V3d shear;
        if (!Imath::extractAndRemoveScalingAndShear(m, scale, shear, false)) scale = Imath::V3d(1, 1, 1);
        rotation = Imath::extractQuat(m);
        rotation.normalize();
    };
    Imath::V3d sa, sb, ta, tb;
    Imath::Quatd ra, rb;
    decompose(a, sa, ra, ta);
    decompose(b, sb, rb, tb);
    const Imath::V3d scale = sa * (1.0 - t) + sb * t;
    const Imath::V3d translation = ta * (1.0 - t) + tb * t;
    const Imath::Quatd rotation = Imath::slerpShortestArc(ra, rb, t);
    Imath::M44d out;
    out.setScale(scale);
    out = out * rotation.toMatrix44(); // row vectors: scale, then rotate
    out[3][0] = translation.x;
    out[3][1] = translation.y;
    out[3][2] = translation.z;
    return out;
}

// Local matrix of an xform for a sample spec, with its own time sampling.
Imath::M44d localMatrix(AbcG::IXform& xform, const SampleSpec& spec, bool& inherits)
{
    AbcG::IXformSchema& schema = xform.getSchema();
    const SampleSpan span = SelectSamples(schema.getTimeSampling(), schema.getNumSamples(), spec);
    AbcG::XformSample s0;
    schema.get(s0, Alembic::Abc::ISampleSelector(span.i0));
    inherits = s0.getInheritsXforms();
    if (!span.blends()) return s0.getMatrix();
    AbcG::XformSample s1;
    schema.get(s1, Alembic::Abc::ISampleSelector(span.i1));
    return blendMatrices(s0.getMatrix(), s1.getMatrix(), span.alpha);
}

} // namespace

// World matrix: product of every IXform from the root down to (and including) obj.
Matrix WorldMatrix(Alembic::Abc::IObject obj, const SampleSpec& spec)
{
    std::vector<AbcG::IObject> chain;
    for (AbcG::IObject it = obj; it.valid() && it.getParent().valid(); it = it.getParent()) {
        chain.push_back(it);
    }
    Imath::M44d world; // identity
    for (auto it = chain.rbegin(); it != chain.rend(); ++it) {
        if (!AbcG::IXform::matches(it->getMetaData())) continue;
        AbcG::IXform xform(*it, Alembic::Abc::kWrapExisting);
        bool inherits = true;
        const Imath::M44d local = localMatrix(xform, spec, inherits);
        // Imath uses row vectors: v_world = v_local * local * parentWorld
        world = inherits ? local * world : local;
    }
    return toMatrix(world);
}

namespace {

const ObjectRecord& requireRecord(const ArchiveData& data, const std::string& objectPath)
{
    const ObjectRecord* rec = data.find(objectPath);
    if (!rec) {
        throw AbcError(codes::ObjectNotFound, "Object '" + objectPath + "' does not exist in " + data.path);
    }
    return *rec;
}

// An .arbGeomParams value resolved to the mesh element it is attached to.
struct AttributeSource {
    std::string name;
    PropertyValue value;
    std::string scope; // vertex | facevarying | uniform | constant
};

std::string attributeScope(const AttributeSource& src, size_t numPoints, size_t numCorners, size_t numFaces,
                           const std::string& meshPath)
{
    auto expected = [&](const std::string& scope) -> size_t {
        if (scope == "vertex" || scope == "varying") return numPoints;
        if (scope == "facevarying") return numCorners;
        if (scope == "uniform") return numFaces;
        if (scope == "constant") return 1;
        return std::numeric_limits<size_t>::max();
    };
    const size_t count = src.value.count;
    if (expected(src.value.scope) == count) return src.value.scope == "varying" ? "vertex" : src.value.scope;
    // Missing or inconsistent scope: infer it from the element count.
    for (const char* scope : {"vertex", "facevarying", "uniform", "constant"}) {
        if (expected(scope) == count) return scope;
    }
    throw AbcError(codes::MalformedData, "Attribute '" + src.name + "' on mesh '" + meshPath + "' has " +
                                             std::to_string(count) + " values, which matches no geometry scope (" +
                                             std::to_string(numPoints) + " points, " + std::to_string(numCorners) +
                                             " corners, " + std::to_string(numFaces) + " faces)");
}

std::vector<AttributeSource> readAttributeSources(const Alembic::Abc::ICompoundProperty& arb,
                                                  const MeshOptions& options, const Alembic::Abc::ISampleSelector& sel,
                                                  const std::string& meshPath)
{
    std::vector<AttributeSource> sources;
    if (!arb.valid() || (!options.allAttributes && options.attributes.empty())) return sources;
    const std::vector<std::string> names = options.allAttributes ? ChildNames(arb) : options.attributes;
    for (const std::string& name : names) {
        const auto* header = arb.getPropertyHeader(name);
        if (!header) continue; // requested names that this mesh doesn't have are ignored
        const bool plainCompound =
            header->isCompound() && !Alembic::Abc::ICompoundProperty(arb, name).getPropertyHeader(".vals");
        if (plainCompound || header->isScalar()) {
            if (options.allAttributes) continue;
            throw AbcError(codes::UnsupportedType,
                           "Attribute '" + name + "' on mesh '" + meshPath + "' is not an array geometry parameter");
        }
        PropertyValue value = ReadValue(arb, name, sel, true);
        if (value.isString() || value.pod == "unknown") {
            if (options.allAttributes) continue;
            throw AbcError(codes::UnsupportedType, "Attribute '" + name + "' on mesh '" + meshPath + "' has type '" +
                                                       value.pod + "'; read it with getProperty() instead");
        }
        sources.push_back({name, std::move(value), ""});
    }
    return sources;
}

[[noreturn]] void tooWide(const std::string& name, const std::string& meshPath, const std::string& value)
{
    throw AbcError(codes::UnsupportedType, "Attribute '" + name + "' on mesh '" + meshPath + "' holds " + value +
                                               ", which doesn't fit in 32 bits; read it with getProperty() instead");
}

MeshAttribute layoutAttribute(const AttributeSource& src, const std::vector<size_t>& elementOf, bool constant,
                              const std::string& meshPath)
{
    const PropertyValue& v = src.value;
    MeshAttribute out;
    out.name = src.name;
    out.pod = v.pod;
    out.scope = src.scope;
    out.interpretation = v.interpretation;
    out.itemSize = v.extent;
    out.constant = constant;
    out.count = constant ? 1 : elementOf.size();

    if (v.pod == "float16" || v.pod == "float32" || v.pod == "float64") {
        out.kind = "float32";
    } else if (v.pod == "bool" || v.pod == "uint8") {
        out.kind = "uint8";
    } else if (v.pod == "uint16" || v.pod == "uint32" || v.pod == "uint64") {
        out.kind = "uint32";
    } else {
        out.kind = "int32";
    }

    for (size_t e = 0; e < out.count; ++e) {
        const size_t element = constant ? 0 : elementOf[e];
        for (size_t c = 0; c < out.itemSize; ++c) {
            const size_t i = element * v.extent + c;
            if (out.kind == "float32") {
                out.f32.push_back(static_cast<float>(v.numberAt(i)));
            } else if (out.kind == "uint8") {
                out.u8.push_back(static_cast<uint8_t>(v.numberAt(i)));
            } else if (out.kind == "uint32") {
                const uint64_t value = v.pod == "uint64" ? v.uint64At(i) : static_cast<uint64_t>(v.numberAt(i));
                if (value > std::numeric_limits<uint32_t>::max()) tooWide(src.name, meshPath, std::to_string(value));
                out.u32.push_back(static_cast<uint32_t>(value));
            } else {
                const int64_t value = v.pod == "int64" ? v.int64At(i) : static_cast<int64_t>(v.numberAt(i));
                if (value < std::numeric_limits<int32_t>::min() || value > std::numeric_limits<int32_t>::max()) {
                    tooWide(src.name, meshPath, std::to_string(value));
                }
                out.i32.push_back(static_cast<int32_t>(value));
            }
        }
    }
    return out;
}

std::string digestOf(const Alembic::Abc::IInt32ArrayProperty& prop, const Alembic::Abc::ISampleSelector& sel)
{
    Alembic::AbcCoreAbstract::ArraySampleKey key;
    return prop.valid() && prop.getKey(key, sel) ? key.digest.str() : std::string();
}

std::string cacheKey(const std::string& path, const MeshOptions& options)
{
    std::string key = path + (options.forceCorners ? "|corners|" : "|auto|") + (options.allAttributes ? "*" : "");
    for (const auto& name : options.attributes)
        key += name + ",";
    return key;
}

template <class SchemaT>
MeshData readMeshSchema(SchemaT& schema, const ObjectRecord& rec, const SampleSpec& spec,
                        const AbcG::IN3fGeomParam* normalsParam, const MeshOptions& options, const ArchiveData& data,
                        bool withTopology)
{
    const SampleSpan span = SelectSamples(schema.getTimeSampling(), schema.getNumSamples(), spec);
    const Alembic::Abc::ISampleSelector sel(static_cast<Alembic::AbcCoreAbstract::index_t>(span.i0));
    typename SchemaT::Sample sample;
    schema.get(sample, sel);

    auto P = sample.getPositions();
    auto faceIndices = sample.getFaceIndices();
    auto faceCounts = sample.getFaceCounts();
    if (!P || !faceIndices || !faceCounts) {
        throw AbcError(codes::MalformedData, "Mesh '" + rec.path + "' is missing positions or topology");
    }

    const size_t numPoints = P->size();
    const size_t numCorners = faceIndices->size();
    const int32_t* fi = faceIndices->get();
    const int32_t* fc = faceCounts->get();

    // Topology fingerprint: per-frame reads reuse the layout of the last full read (spec 0004).
    const std::string indicesDigest = digestOf(schema.getFaceIndicesProperty(), sel);
    const std::string countsDigest = digestOf(schema.getFaceCountsProperty(), sel);
    const std::string key = cacheKey(rec.path, options);
    bool topologyKnown = false;
    {
        std::lock_guard<std::mutex> lock(data.cacheMutex);
        auto it = data.topologyCache.find(key);
        if (it != data.topologyCache.end()) {
            topologyKnown =
                it->second.faceIndicesDigest == indicesDigest && it->second.faceCountsDigest == countsDigest;
            if (!withTopology && !topologyKnown) {
                throw AbcError(codes::TopologyChanged, "The topology of '" + rec.path + "' at time " +
                                                           std::to_string(spec.time) +
                                                           " differs from the last read; call getMesh() again");
            }
        }
    }

    // Positions, interpolated or moved with velocities when requested (spec 0004).
    std::vector<Imath::V3f> points(P->get(), P->get() + numPoints);
    bool interpolated = false;
    if (span.blends()) {
        const Alembic::Abc::ISampleSelector sel1(static_cast<Alembic::AbcCoreAbstract::index_t>(span.i1));
        const bool sameTopology =
            rec.topology != "heterogeneous" || (digestOf(schema.getFaceIndicesProperty(), sel1) == indicesDigest &&
                                                digestOf(schema.getFaceCountsProperty(), sel1) == countsDigest);
        Alembic::Abc::P3fArraySamplePtr P1;
        schema.getPositionsProperty().get(P1, sel1);
        if (sameTopology && P1 && P1->size() == numPoints) {
            const float a = static_cast<float>(span.alpha);
            for (size_t i = 0; i < numPoints; ++i)
                points[i] = points[i] * (1.0f - a) + (*P1)[i] * a;
            interpolated = true;
        }
    }
    if (!interpolated && spec.useVelocities) {
        auto velocities = sample.getVelocities();
        if (velocities && velocities->size() == numPoints) {
            const float dt = static_cast<float>((spec.time - span.t0) * spec.velocityScale);
            for (size_t i = 0; i < numPoints; ++i)
                points[i] += (*velocities)[i] * dt;
        }
    }

    // Optional attributes, expanded so that index buffers are already applied.
    std::vector<Imath::V3f> N;
    bool hasNormals = false;
    bool nFaceVarying = false;
    if (normalsParam && normalsParam->valid() && normalsParam->getNumSamples() > 0) {
        auto ns = normalsParam->getExpandedValue(sel);
        if (ns.getVals()) {
            N.assign(ns.getVals()->get(), ns.getVals()->get() + ns.getVals()->size());
            hasNormals = true;
            nFaceVarying = ns.getScope() == AbcG::kFacevaryingScope;
            if (interpolated) {
                const Alembic::Abc::ISampleSelector sel1(static_cast<Alembic::AbcCoreAbstract::index_t>(span.i1));
                auto n1 = normalsParam->getExpandedValue(sel1).getVals();
                if (n1 && n1->size() == N.size()) {
                    const float a = static_cast<float>(span.alpha);
                    for (size_t i = 0; i < N.size(); ++i) {
                        N[i] = N[i] * (1.0f - a) + (*n1)[i] * a;
                        const float len = N[i].length();
                        if (len > 0.0f) N[i] /= len;
                    }
                }
            }
        }
    }
    AbcG::V2fArraySamplePtr UV;
    bool uvFaceVarying = false;
    auto uvParam = schema.getUVsParam();
    if (uvParam.valid()) {
        auto us = uvParam.getExpandedValue(sel);
        UV = us.getVals();
        uvFaceVarying = us.getScope() == AbcG::kFacevaryingScope;
    }

    auto attrMatches = [&](size_t size, bool faceVarying) {
        return faceVarying ? size == numCorners : size == numPoints;
    };
    if (hasNormals && !attrMatches(N.size(), nFaceVarying)) hasNormals = false;
    if (UV && !attrMatches(UV->size(), uvFaceVarying)) UV.reset();

    // Arbitrary attributes, resolved to the element (point, corner, face) they belong to.
    std::vector<AttributeSource> sources = readAttributeSources(schema.getArbGeomParams(), options, sel, rec.path);
    bool attributesNeedCorners = false;
    for (auto& src : sources) {
        src.scope = attributeScope(src, numPoints, numCorners, faceCounts->size(), rec.path);
        attributesNeedCorners = attributesNeedCorners || src.scope == "facevarying" || src.scope == "uniform";
    }

    // Face-varying (and per-face) data needs one vertex per face corner.
    const bool perCorner =
        (hasNormals && nFaceVarying) || (UV && uvFaceVarying) || attributesNeedCorners || options.forceCorners;

    MeshData mesh;
    mesh.name = rec.name;
    mesh.path = rec.path;
    mesh.type = rec.type;
    mesh.layout = perCorner ? "corners" : "points";
    mesh.faceCount = faceCounts->size();
    mesh.sampleTime = span.t0;
    mesh.interpolated = interpolated;

    // Validate indices once per topology; per-frame reads of a known topology skip it.
    if (!topologyKnown) {
        for (size_t c = 0; c < numCorners; ++c) {
            if (fi[c] < 0 || static_cast<size_t>(fi[c]) >= numPoints) {
                throw AbcError(codes::MalformedData, "Mesh '" + rec.path + "' references point " +
                                                         std::to_string(fi[c]) + " but only has " +
                                                         std::to_string(numPoints) + " points");
            }
        }
    }

    const size_t numVerts = perCorner ? numCorners : numPoints;
    mesh.positions.resize(numVerts * 3);
    if (hasNormals) mesh.normals.resize(numVerts * 3);
    if (UV) mesh.uvs.resize(numVerts * 2);

    for (size_t v = 0; v < numVerts; ++v) {
        const size_t p = perCorner ? static_cast<size_t>(fi[v]) : v;
        const auto& pos = points[p];
        mesh.positions[v * 3 + 0] = pos.x;
        mesh.positions[v * 3 + 1] = pos.y;
        mesh.positions[v * 3 + 2] = pos.z;
        if (hasNormals) {
            const auto& n = N[nFaceVarying ? v : p];
            mesh.normals[v * 3 + 0] = n.x;
            mesh.normals[v * 3 + 1] = n.y;
            mesh.normals[v * 3 + 2] = n.z;
        }
        if (UV) {
            const auto& uv = (*UV)[uvFaceVarying ? v : p];
            mesh.uvs[v * 2 + 0] = uv.x;
            mesh.uvs[v * 2 + 1] = uv.y;
        }
    }

    // Fan-triangulate. Alembic winds polygons clockwise; three.js/WebGL expect
    // counter-clockwise, so each triangle is emitted reversed. Per-frame reads skip this.
    size_t offset = 0;
    for (size_t f = 0; withTopology && f < faceCounts->size(); ++f) {
        const int32_t count = fc[f];
        if (count < 0 || offset + static_cast<size_t>(count) > numCorners) {
            throw AbcError(codes::MalformedData, "Mesh '" + rec.path + "' has inconsistent face counts");
        }
        auto corner = [&](size_t k) -> uint32_t {
            return static_cast<uint32_t>(perCorner ? offset + k : static_cast<size_t>(fi[offset + k]));
        };
        for (int32_t k = 1; k + 1 < count; ++k) {
            mesh.indices.push_back(corner(0));
            mesh.indices.push_back(corner(k + 1));
            mesh.indices.push_back(corner(k));
        }
        offset += count;
    }

    if (!sources.empty()) {
        // Element index of every output vertex, for each scope.
        const size_t numVerts = mesh.positions.size() / 3;
        std::vector<size_t> pointOf(numVerts), cornerOf(numVerts), faceOf;
        for (size_t v = 0; v < numVerts; ++v) {
            pointOf[v] = perCorner ? static_cast<size_t>(fi[v]) : v;
            cornerOf[v] = v;
        }
        if (perCorner) {
            faceOf.reserve(numCorners);
            for (size_t f = 0; f < faceCounts->size(); ++f)
                faceOf.insert(faceOf.end(), static_cast<size_t>(fc[f]), f);
        }
        for (const auto& src : sources) {
            const std::vector<size_t>& elementOf = src.scope == "facevarying" ? cornerOf
                                                   : src.scope == "uniform"   ? faceOf
                                                                              : pointOf;
            try {
                mesh.attributes.push_back(layoutAttribute(src, elementOf, src.scope == "constant", rec.path));
            } catch (const AbcError& e) {
                // With '*', attributes that can't be laid out (e.g. 64-bit values above 2^32) are skipped.
                if (!options.allAttributes || e.code() != codes::UnsupportedType) throw;
            }
        }
    }

    {
        std::lock_guard<std::mutex> lock(data.cacheMutex);
        data.topologyCache[key] = {indicesDigest, countsDigest, mesh.layout, numVerts};
    }
    return mesh;
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

} // namespace

const ObjectRecord* ArchiveData::find(const std::string& objectPath) const
{
    auto it = index.find(objectPath);
    return it == index.end() ? nullptr : &objects[it->second];
}

std::shared_ptr<ArchiveData> OpenArchive(const std::string& path)
{
    if (path.empty()) {
        throw AbcError(codes::InvalidArgument, "Alembic file path must be a non-empty string");
    }
    std::error_code ec;
    const auto fsPath = std::filesystem::u8path(path);
    if (!std::filesystem::exists(fsPath, ec)) {
        throw AbcError(codes::FileNotFound, "Alembic file not found: " + path);
    }
    if (!std::filesystem::is_regular_file(fsPath, ec)) {
        throw AbcError(codes::InvalidArgument, "Alembic path is not a regular file: " + path);
    }

    auto data = std::make_shared<ArchiveData>();
    data->path = path;

    try {
        AbcF::IFactory factory;
        factory.setPolicy(Alembic::Abc::ErrorHandler::kThrowPolicy);
        AbcF::IFactory::CoreType coreType = AbcF::IFactory::kUnknown;
        data->archive = factory.getArchive(path, coreType);
        if (!data->archive.valid()) {
            throw AbcError(codes::InvalidArchive, "File is not a valid Alembic archive: " + path);
        }
        switch (coreType) {
        case AbcF::IFactory::kOgawa:
            data->coreType = "ogawa";
            break;
        case AbcF::IFactory::kHDF5:
            data->coreType = "hdf5";
            break;
        case AbcF::IFactory::kLayer:
            data->coreType = "layer";
            break;
        default:
            data->coreType = "unknown";
            break;
        }
    } catch (const AbcError&) {
        throw;
    } catch (const std::exception& e) {
        throw AbcError(codes::InvalidArchive, "File is not a valid Alembic archive: " + path + " (" + e.what() + ")");
    }

    guarded("archive metadata", [&] {
        Alembic::Abc::GetArchiveInfo(data->archive, data->appName, data->libraryVersionString, data->libraryVersion,
                                     data->whenWritten, data->userDescription);
        data->archiveVersion = data->archive.getArchiveVersion();

        AbcG::IObject top = data->archive.getTop();
        for (size_t i = 0; i < top.getNumChildren(); ++i) {
            visit(top.getChild(i), "", *data);
        }
        computeTimeRange(*data);
        return 0;
    });
    return data;
}

namespace {

MeshData readMesh(const ArchiveData& data, const std::string& objectPath, const SampleSpec& spec,
                  const MeshOptions& options, bool withTopology)
{
    const ObjectRecord& rec = requireRecord(data, objectPath);
    if (rec.type != "mesh" && rec.type != "subd") {
        const std::string hint = rec.type == "points"   ? " (use getPoints())"
                                 : rec.type == "curves" ? " (use getCurves())"
                                                        : "";
        throw AbcError(codes::UnsupportedType, "Object '" + objectPath + "' is of type '" + rec.type +
                                                   "'; only 'mesh' and 'subd' provide geometry" + hint);
    }
    return guarded("mesh '" + objectPath + "'", [&] {
        AbcG::IObject obj = ResolveObject(data, objectPath);
        MeshData mesh;
        if (rec.type == "mesh") {
            AbcG::IPolyMesh polyMesh(obj, Alembic::Abc::kWrapExisting);
            auto& schema = polyMesh.getSchema();
            auto normals = schema.getNormalsParam();
            mesh = readMeshSchema(schema, rec, spec, &normals, options, data, withTopology);
        } else {
            AbcG::ISubD subd(obj, Alembic::Abc::kWrapExisting);
            mesh = readMeshSchema(subd.getSchema(), rec, spec, nullptr, options, data, withTopology);
        }
        mesh.transform = WorldMatrix(obj, spec);
        return mesh;
    });
}

double lerp(double a, double b, double t)
{
    return a + (b - a) * t;
}

} // namespace

MeshData ReadMesh(const ArchiveData& data, const std::string& objectPath, const SampleSpec& spec,
                  const MeshOptions& options)
{
    return readMesh(data, objectPath, spec, options, true);
}

MeshData ReadMeshFrame(const ArchiveData& data, const std::string& objectPath, const SampleSpec& spec,
                       const MeshOptions& options)
{
    return readMesh(data, objectPath, spec, options, false);
}

TransformData ReadTransform(const ArchiveData& data, const std::string& objectPath, const SampleSpec& spec)
{
    const ObjectRecord& rec = requireRecord(data, objectPath);
    return guarded("transform of '" + objectPath + "'", [&] {
        AbcG::IObject obj = ResolveObject(data, objectPath);
        TransformData out;
        out.path = objectPath;
        out.local = toMatrix(Imath::M44d());
        if (rec.type == "xform") {
            AbcG::IXform xform(obj, Alembic::Abc::kWrapExisting);
            bool inherits = true;
            out.local = toMatrix(localMatrix(xform, spec, inherits));
            out.inheritsTransform = inherits;
            out.animated = !xform.getSchema().isConstant();
        }
        out.world = WorldMatrix(obj, spec);
        return out;
    });
}

CameraData ReadCamera(const ArchiveData& data, const std::string& objectPath, const SampleSpec& spec)
{
    const ObjectRecord& rec = requireRecord(data, objectPath);
    if (rec.type != "camera") {
        throw AbcError(codes::UnsupportedType,
                       "Object '" + objectPath + "' is of type '" + rec.type + "', not 'camera'");
    }
    return guarded("camera '" + objectPath + "'", [&] {
        AbcG::IObject obj = ResolveObject(data, objectPath);
        AbcG::ICamera camera(obj, Alembic::Abc::kWrapExisting);
        AbcG::ICameraSchema& schema = camera.getSchema();
        const SampleSpan span = SelectSamples(schema.getTimeSampling(), schema.getNumSamples(), spec);
        AbcG::CameraSample sample;
        schema.get(sample, Alembic::Abc::ISampleSelector(static_cast<Alembic::AbcCoreAbstract::index_t>(span.i0)));

        CameraData out;
        out.name = rec.name;
        out.path = rec.path;
        out.focalLength = sample.getFocalLength();
        out.horizontalAperture = sample.getHorizontalAperture();
        out.verticalAperture = sample.getVerticalAperture();
        out.nearClip = sample.getNearClippingPlane();
        out.farClip = sample.getFarClippingPlane();
        if (span.blends()) {
            AbcG::CameraSample next;
            schema.get(next, Alembic::Abc::ISampleSelector(static_cast<Alembic::AbcCoreAbstract::index_t>(span.i1)));
            out.focalLength = lerp(out.focalLength, next.getFocalLength(), span.alpha);
            out.horizontalAperture = lerp(out.horizontalAperture, next.getHorizontalAperture(), span.alpha);
            out.verticalAperture = lerp(out.verticalAperture, next.getVerticalAperture(), span.alpha);
            out.nearClip = lerp(out.nearClip, next.getNearClippingPlane(), span.alpha);
            out.farClip = lerp(out.farClip, next.getFarClippingPlane(), span.alpha);
        }
        // Apertures are in cm, focal length in mm.
        if (out.focalLength > 0.0) {
            out.fov = 2.0 * std::atan((out.verticalAperture * 10.0) / (2.0 * out.focalLength)) * 180.0 / kPi;
        }
        if (out.verticalAperture > 0.0) {
            out.aspect = out.horizontalAperture / out.verticalAperture;
        }
        out.transform = WorldMatrix(obj, spec);
        return out;
    });
}

} // namespace abcjs
