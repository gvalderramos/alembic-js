// Topology identity of meshes and subds (spec 0009): counts and a hash of the raw face arrays,
// read without triangulating and cached by the Alembic array digests.
#include "AbcScene.h"

#include <Alembic/AbcGeom/All.h>

#include <cstdio>

namespace AbcG = Alembic::AbcGeom;
namespace AbcA = Alembic::AbcCoreAbstract;

namespace abcjs {

std::string TopologyHash(const int32_t* faceCounts, size_t numFaces, const int32_t* faceIndices, size_t numCorners)
{
    uint64_t hash = 0xcbf29ce484222325ULL;
    auto feed = [&hash](const int32_t* values, size_t count) {
        for (size_t i = 0; i < count; ++i) {
            const uint32_t value = static_cast<uint32_t>(values[i]); // negative values: their bit pattern
            for (int shift = 0; shift < 32; shift += 8) {
                hash ^= (value >> shift) & 0xffu; // little-endian byte order
                hash *= 0x100000001b3ULL;
            }
        }
    };
    feed(faceCounts, numFaces);
    feed(faceIndices, numCorners);
    char out[17];
    std::snprintf(out, sizeof(out), "%016llx", static_cast<unsigned long long>(hash));
    return out;
}

namespace {

std::string keyOf(const Alembic::Abc::IInt32ArrayProperty& prop, const Alembic::Abc::ISampleSelector& sel)
{
    AbcA::ArraySampleKey key;
    return prop.valid() && prop.getKey(key, sel) ? key.digest.str() : std::string();
}

size_t pointCountOf(const Alembic::Abc::IP3fArrayProperty& prop, const Alembic::Abc::ISampleSelector& sel)
{
    if (!prop.valid()) return 0;
    AbcA::Dimensions dims;
    prop.getDimensions(dims, sel); // reads the sample's size, not its data
    return dims.numPoints();
}

const ObjectRecord& requireMeshRecord(const ArchiveData& data, const std::string& objectPath)
{
    const ObjectRecord* rec = data.find(objectPath);
    if (!rec) {
        throw AbcError(codes::ObjectNotFound, "Object '" + objectPath + "' does not exist in " + data.path);
    }
    if (rec->type != "mesh" && rec->type != "subd") {
        throw AbcError(codes::InvalidArgument, "Object '" + objectPath + "' is of type '" + rec->type +
                                                   "'; topology is only available for 'mesh' and 'subd' objects");
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

// Reads one sample's topology. The hash comes from the digest cache when the same face arrays were
// hashed before; the arrays are only read on a cache miss or when `withFaces` asks for them.
template <class SchemaT>
TopologyData readSampleTopology(const ArchiveData& data, const ObjectRecord& rec, SchemaT& schema, int64_t index,
                                bool withFaces)
{
    const Alembic::Abc::ISampleSelector sel(static_cast<AbcA::index_t>(index));
    TopologyData out;
    out.path = rec.path;
    out.sampleIndex = index;
    out.sampleTime = schema.getTimeSampling()->getSampleTime(static_cast<AbcA::index_t>(index));
    out.pointCount = pointCountOf(schema.getPositionsProperty(), sel);
    out.withFaces = withFaces;

    const auto countsProp = schema.getFaceCountsProperty();
    const auto indicesProp = schema.getFaceIndicesProperty();
    const std::string countsKey = keyOf(countsProp, sel);
    const std::string indicesKey = keyOf(indicesProp, sel);
    const bool cacheable = !countsKey.empty() && !indicesKey.empty();
    const std::string cacheKey = rec.path + "|" + countsKey + "|" + indicesKey;
    if (cacheable && !withFaces) {
        std::lock_guard<std::mutex> lock(data.cacheMutex);
        auto it = data.topologyHashCache.find(cacheKey);
        if (it != data.topologyHashCache.end()) {
            out.hash = it->second.hash;
            out.faceCount = it->second.faceCount;
            out.cornerCount = it->second.cornerCount;
            return out;
        }
    }

    Alembic::Abc::Int32ArraySamplePtr counts, indices;
    countsProp.get(counts, sel);
    indicesProp.get(indices, sel);
    ++data.topologyHashReads;
    const int32_t* fc = counts ? counts->get() : nullptr;
    const int32_t* fi = indices ? indices->get() : nullptr;
    out.faceCount = counts ? counts->size() : 0;
    out.cornerCount = indices ? indices->size() : 0;
    out.hash = TopologyHash(fc, out.faceCount, fi, out.cornerCount);
    if (withFaces) {
        out.faceCounts.assign(fc, fc + out.faceCount);
        out.faceIndices.assign(fi, fi + out.cornerCount);
    }
    if (cacheable) {
        std::lock_guard<std::mutex> lock(data.cacheMutex);
        data.topologyHashCache[cacheKey] = {out.hash, out.faceCount, out.cornerCount};
    }
    return out;
}

template <class SchemaT>
TopologyData topologyAt(const ArchiveData& data, const ObjectRecord& rec, SchemaT& schema, const SampleSpec& spec,
                        bool withFaces)
{
    if (schema.getNumSamples() == 0) {
        throw AbcError(codes::MalformedData, "Mesh '" + rec.path + "' has no samples");
    }
    SampleSpec floor = spec;
    if (floor.mode == SampleSpec::Mode::Interpolate) floor.mode = SampleSpec::Mode::Floor; // never interpolated
    const SampleSpan span = SelectSamples(schema.getTimeSampling(), schema.getNumSamples(), floor);
    return readSampleTopology(data, rec, schema, span.i0, withFaces);
}

template <class SchemaT>
std::vector<TopologyData> topologyChanges(const ArchiveData& data, const ObjectRecord& rec, SchemaT& schema)
{
    std::vector<TopologyData> changes;
    const int64_t numSamples = static_cast<int64_t>(schema.getNumSamples());
    if (numSamples == 0) return changes;
    changes.push_back(readSampleTopology(data, rec, schema, 0, false));
    if (schema.getTopologyVariance() != AbcG::kHeterogeneousTopology) return changes; // fixed by definition

    // Walk the digests and the point counts (both read without the arrays' data); hash only when the
    // face arrays change.
    const auto countsProp = schema.getFaceCountsProperty();
    const auto indicesProp = schema.getFaceIndicesProperty();
    const auto positionsProp = schema.getPositionsProperty();
    auto keysAt = [&](int64_t i) {
        const Alembic::Abc::ISampleSelector sel(static_cast<AbcA::index_t>(i));
        return keyOf(countsProp, sel) + "|" + keyOf(indicesProp, sel);
    };
    std::string previousKeys = keysAt(0);
    for (int64_t i = 1; i < numSamples; ++i) {
        const std::string keys = keysAt(i);
        const TopologyData& previous = changes.back();
        const bool knownKeys = keys.size() > 1 && keys == previousKeys; // "|" alone: no digests (e.g. HDF5)
        previousKeys = keys;
        if (knownKeys) {
            const size_t points =
                pointCountOf(positionsProp, Alembic::Abc::ISampleSelector(static_cast<AbcA::index_t>(i)));
            if (points == previous.pointCount) continue;
        }
        TopologyData current = readSampleTopology(data, rec, schema, i, false);
        if (current.hash != previous.hash || current.pointCount != previous.pointCount) {
            changes.push_back(std::move(current));
        }
    }
    return changes;
}

template <class Fn> auto withSchema(const ArchiveData& data, const ObjectRecord& rec, Fn&& fn)
{
    AbcG::IObject obj = ResolveObject(data, rec.path);
    if (rec.type == "mesh") {
        AbcG::IPolyMesh mesh(obj, Alembic::Abc::kWrapExisting);
        return fn(mesh.getSchema());
    }
    AbcG::ISubD subd(obj, Alembic::Abc::kWrapExisting);
    return fn(subd.getSchema());
}

} // namespace

TopologyData ReadTopology(const ArchiveData& data, const std::string& objectPath, const SampleSpec& spec,
                          bool withFaces)
{
    const ObjectRecord& rec = requireMeshRecord(data, objectPath);
    return guarded("topology of '" + objectPath + "'", [&] {
        return withSchema(data, rec, [&](auto& schema) { return topologyAt(data, rec, schema, spec, withFaces); });
    });
}

std::vector<TopologyData> ReadTopologyChanges(const ArchiveData& data, const std::string& objectPath)
{
    const ObjectRecord& rec = requireMeshRecord(data, objectPath);
    return guarded("topology changes of '" + objectPath + "'", [&] {
        return withSchema(data, rec, [&](auto& schema) { return topologyChanges(data, rec, schema); });
    });
}

} // namespace abcjs
