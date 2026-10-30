#pragma once

#ifndef ABCSCENE_H
#define ABCSCENE_H

// Pure C++ layer that reads Alembic archives into plain structs.
// It has no N-API dependency so it can safely run on worker threads.

#include <Alembic/Abc/All.h>

#include <array>
#include <atomic>
#include <cstdint>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <vector>

namespace abcjs {

// Error codes shared with the JavaScript layer (see src/errors.ts).
namespace codes {
constexpr const char* InvalidArgument = "ERR_ABC_INVALID_ARGUMENT";
constexpr const char* FileNotFound = "ERR_ABC_FILE_NOT_FOUND";
constexpr const char* InvalidArchive = "ERR_ABC_INVALID_ARCHIVE";
constexpr const char* NotLoaded = "ERR_ABC_NOT_LOADED";
constexpr const char* ObjectNotFound = "ERR_ABC_OBJECT_NOT_FOUND";
constexpr const char* UnsupportedType = "ERR_ABC_UNSUPPORTED_TYPE";
constexpr const char* MalformedData = "ERR_ABC_MALFORMED_DATA";
constexpr const char* ReadFailed = "ERR_ABC_READ_FAILED";
constexpr const char* PropertyNotFound = "ERR_ABC_PROPERTY_NOT_FOUND";
constexpr const char* TopologyChanged = "ERR_ABC_TOPOLOGY_CHANGED";
} // namespace codes

class AbcError : public std::runtime_error {
public:
    AbcError(std::string code, const std::string& message) : std::runtime_error(message), m_code(std::move(code)) {}
    const std::string& code() const { return m_code; }

private:
    std::string m_code;
};

using Matrix = std::array<double, 16>;

// Time sampling of an object's schema (spec 0004).
struct TimeSamplingInfo {
    bool valid = false;
    std::string kind; // uniform | cyclic | acyclic
    double startTime = 0.0;
    double timePerCycle = 0.0; // seconds per sample for uniform sampling
    std::vector<double> sampleTimes;
};

// Which sample(s) a read uses (spec 0004).
struct SampleSpec {
    enum class Mode { Near, Floor, Interpolate };
    double time = 0.0;
    Mode mode = Mode::Near;
    bool useVelocities = false; // move positions from the chosen sample to `time` with velocities
    double velocityScale = 1.0; // multiplier for velocities (e.g. 1/fps for per-frame velocities)

    static SampleSpec at(double t)
    {
        SampleSpec spec;
        spec.time = t;
        return spec;
    }
};

// Sample indices resolved for a schema: blend i0 -> i1 by alpha; t0 is the time of i0.
struct SampleSpan {
    int64_t i0 = 0;
    int64_t i1 = 0;
    double alpha = 0.0;
    double t0 = 0.0;
    bool blends() const { return i1 != i0 && alpha > 0.0; }
};

SampleSpan SelectSamples(const Alembic::AbcCoreAbstract::TimeSamplingPtr& ts, size_t numSamples,
                         const SampleSpec& spec);

struct ObjectRecord {
    std::string name;
    std::string path;
    std::string parent; // empty for top-level objects
    std::vector<std::string> children;
    std::string type;   // xform | mesh | subd | camera | points | curves | nupatch | light | faceset | unknown
    std::string schema; // raw Alembic schema name, e.g. "AbcGeom_PolyMesh_v1"
    size_t numSamples = 0;
    bool animated = false;
    TimeSamplingInfo timeSampling;
    std::string topology; // constant | homogeneous | heterogeneous (geometry only)
};

// Topology fingerprint of a mesh layout, reused by per-frame reads (spec 0004).
struct MeshTopologyCache {
    std::string faceIndicesDigest;
    std::string faceCountsDigest;
    std::string layout;
    size_t vertexCount = 0;
};

// Topology identity of one mesh sample (spec 0009), cached by Alembic array digests.
struct TopologyHashEntry {
    std::string hash; // fnv1a64-faces-v1, 16 lowercase hex digits
    size_t faceCount = 0;
    size_t cornerCount = 0;
};

struct ArchiveData {
    Alembic::Abc::IArchive archive;
    std::string path;
    std::string coreType;
    std::string appName;
    std::string libraryVersionString;
    uint32_t libraryVersion = 0;
    int32_t archiveVersion = 0;
    std::string whenWritten;
    std::string userDescription;
    double startTime = 0.0;
    double endTime = 0.0;
    double fps = 0.0; // most common uniform rate among animated objects (0 if unknown)
    bool hasAnimation = false;
    std::vector<ObjectRecord> objects; // depth-first order, root excluded
    std::unordered_map<std::string, size_t> index;

    const ObjectRecord* find(const std::string& objectPath) const;

    // Mesh topology fingerprints, keyed by "path|layout options". Guarded for async reads.
    mutable std::mutex cacheMutex;
    mutable std::unordered_map<std::string, MeshTopologyCache> topologyCache;
    // Topology hashes (spec 0009), keyed by "path|faceCounts digest|faceIndices digest".
    mutable std::unordered_map<std::string, TopologyHashEntry> topologyHashCache;
    // Debug stats: how many times face arrays were read to compute a topology hash.
    mutable std::atomic<uint64_t> topologyHashReads{0};
};

// A geometry attribute (.arbGeomParams) laid out like the mesh positions (spec 0006).
struct MeshAttribute {
    std::string name;
    std::string pod;   // stored type, e.g. "float32", "int32", "uint64"
    std::string kind;  // output storage: float32 | int32 | uint32 | uint8
    std::string scope; // source geometry scope
    std::string interpretation;
    size_t itemSize = 1;
    size_t count = 0;      // output elements: one per vertex, or 1 for constant attributes
    bool constant = false; // compacted constant attribute
    std::vector<float> f32;
    std::vector<int32_t> i32;
    std::vector<uint32_t> u32;
    std::vector<uint8_t> u8;
};

struct MeshOptions {
    std::vector<std::string> attributes; // names in .arbGeomParams; missing names are ignored
    bool allAttributes = false;          // '*': every numeric attribute
    bool forceCorners = false;           // layout: 'corners'
    bool groupByFaceSet = false;         // reorder triangles so each face set is one range (spec 0003)
    bool triangleToFace = false;         // return the source polygon of every triangle
    bool vertexToPoint = false;          // return the source point of every vertex (spec 0009)
};

// A range of triangles drawn with one material slot (spec 0003).
struct MeshGroup {
    size_t start = 0; // in triangles
    size_t count = 0;
    std::string faceSet; // empty for faces in no face set
    size_t materialIndex = 0;
};

struct MaterialSlot {
    std::string name;
    std::string faceSet;
    std::string materialPath;
};

struct MeshData {
    std::string name;
    std::string path;
    std::string type;
    std::string layout = "points"; // points | corners (one vertex per face corner)
    std::vector<float> positions;
    std::vector<float> normals;
    std::vector<float> uvs;
    std::vector<uint32_t> indices;
    size_t faceCount = 0;
    Matrix transform{}; // world matrix of the mesh
    std::vector<MeshAttribute> attributes;
    double sampleTime = 0.0; // time of the (first) sample used
    bool interpolated = false;
    // Face sets (spec 0003): present when the mesh has face sets and they form contiguous ranges,
    // or always with groupByFaceSet.
    std::vector<MeshGroup> groups;
    std::vector<MaterialSlot> materialSlots;
    bool faceSetsOverlap = false;
    std::vector<uint32_t> triangleToFace;
    std::vector<uint32_t> vertexToPoint;
};

// Topology of a mesh/subd sample (spec 0009). Face arrays are only filled when requested.
struct TopologyData {
    std::string path;
    int64_t sampleIndex = 0;
    double sampleTime = 0.0;
    size_t pointCount = 0;
    size_t faceCount = 0;
    size_t cornerCount = 0;
    std::string hash;
    bool withFaces = false;
    std::vector<int32_t> faceCounts;
    std::vector<int32_t> faceIndices;
};

// Points / particles (spec 0002).
struct PointsData {
    std::string name;
    std::string path;
    std::vector<float> positions;
    std::vector<uint64_t> ids;
    std::vector<float> velocities;
    std::vector<float> widths;
    std::string widthScope; // vertex | constant (empty when there are no widths)
    bool hasIds = false;
    Matrix transform{};
};

// Curves (spec 0002). Optional arrays are empty when the file doesn't write them.
struct CurvesData {
    std::string name;
    std::string path;
    std::vector<float> positions;
    std::vector<int32_t> vertexCounts;
    std::string curveType; // linear | cubic | variableOrder
    bool periodic = false;
    std::string basis; // none | bezier | bspline | catmullrom | hermite | power
    std::vector<uint8_t> orders;
    std::vector<float> knots;
    std::vector<float> weights;
    std::vector<float> widths;
    std::string widthScope; // constant | uniform | varying | vertex (as written, or inferred from the count)
    std::vector<float> uvs;
    std::vector<float> normals;
    std::vector<float> velocities;
    Matrix transform{};
};

struct TransformData {
    std::string path;
    Matrix local{};
    Matrix world{};
    bool inheritsTransform = true;
    bool animated = false;
};

struct CameraData {
    std::string name;
    std::string path;
    double focalLength = 0.0;        // mm
    double horizontalAperture = 0.0; // cm
    double verticalAperture = 0.0;   // cm
    double nearClip = 0.0;
    double farClip = 0.0;
    double fov = 0.0; // vertical field of view, degrees
    double aspect = 1.0;
    Matrix transform{};
};

// Opens and indexes an archive. Throws AbcError.
std::shared_ptr<ArchiveData> OpenArchive(const std::string& path);

// Resolves an object path such as "/a/b" to its IObject. Throws AbcError.
Alembic::Abc::IObject ResolveObject(const ArchiveData& data, const std::string& objectPath);

// Accumulated world matrix of an object (each xform sampled with its own time sampling).
Matrix WorldMatrix(Alembic::Abc::IObject obj, const SampleSpec& spec);

// Readers. All throw AbcError. Times are in seconds.
MeshData ReadMesh(const ArchiveData& data, const std::string& objectPath, const SampleSpec& spec,
                  const MeshOptions& options = MeshOptions());
// Same vertex layout as ReadMesh but without topology (indices). Throws TopologyChanged when the
// topology differs from the last ReadMesh/ReadMeshFrame of this object with the same options.
MeshData ReadMeshFrame(const ArchiveData& data, const std::string& objectPath, const SampleSpec& spec,
                       const MeshOptions& options = MeshOptions());
// Topology at a time ('interpolate' is read as 'floor'), without triangulating (spec 0009).
// Throws InvalidArgument for objects that are not meshes or subds.
TopologyData ReadTopology(const ArchiveData& data, const std::string& objectPath, const SampleSpec& spec,
                          bool withFaces);
// The first sample, and every sample whose topology (hash or point count) differs from the previous.
std::vector<TopologyData> ReadTopologyChanges(const ArchiveData& data, const std::string& objectPath);
// FNV-1a 64 over face counts then face indices as uint32 little-endian (spec 0009).
std::string TopologyHash(const int32_t* faceCounts, size_t numFaces, const int32_t* faceIndices, size_t numCorners);
TransformData ReadTransform(const ArchiveData& data, const std::string& objectPath, const SampleSpec& spec);
CameraData ReadCamera(const ArchiveData& data, const std::string& objectPath, const SampleSpec& spec);
PointsData ReadPoints(const ArchiveData& data, const std::string& objectPath, const SampleSpec& spec);
CurvesData ReadCurves(const ArchiveData& data, const std::string& objectPath, const SampleSpec& spec);

} // namespace abcjs

#endif // ABCSCENE_H
