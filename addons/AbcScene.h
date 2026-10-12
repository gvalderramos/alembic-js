#pragma once

#ifndef ABCSCENE_H
#define ABCSCENE_H

// Pure C++ layer that reads Alembic archives into plain structs.
// It has no N-API dependency so it can safely run on worker threads.

#include <Alembic/Abc/All.h>

#include <array>
#include <cstdint>
#include <memory>
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
} // namespace codes

class AbcError : public std::runtime_error {
public:
    AbcError(std::string code, const std::string& message) : std::runtime_error(message), m_code(std::move(code)) {}
    const std::string& code() const { return m_code; }

private:
    std::string m_code;
};

using Matrix = std::array<double, 16>;

struct ObjectRecord {
    std::string name;
    std::string path;
    std::string parent; // empty for top-level objects
    std::vector<std::string> children;
    std::string type;   // xform | mesh | subd | camera | points | curves | nupatch | light | faceset | unknown
    std::string schema; // raw Alembic schema name, e.g. "AbcGeom_PolyMesh_v1"
    size_t numSamples = 0;
    bool animated = false;
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
    bool hasAnimation = false;
    std::vector<ObjectRecord> objects; // depth-first order, root excluded
    std::unordered_map<std::string, size_t> index;

    const ObjectRecord* find(const std::string& objectPath) const;
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

// Accumulated world matrix of an object at a sample.
Matrix WorldMatrix(Alembic::Abc::IObject obj, const Alembic::Abc::ISampleSelector& sel);

// Readers. All throw AbcError. `time` is in seconds.
MeshData ReadMesh(const ArchiveData& data, const std::string& objectPath, double time,
                  const MeshOptions& options = MeshOptions());
TransformData ReadTransform(const ArchiveData& data, const std::string& objectPath, double time);
CameraData ReadCamera(const ArchiveData& data, const std::string& objectPath, double time);
PointsData ReadPoints(const ArchiveData& data, const std::string& objectPath, double time);
CurvesData ReadCurves(const ArchiveData& data, const std::string& objectPath, double time);

} // namespace abcjs

#endif // ABCSCENE_H
