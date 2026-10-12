// Face sets and materials (spec 0003).
#include "AbcMaterials.h"

#include <Alembic/AbcGeom/All.h>
#include <Alembic/AbcMaterial/All.h>

namespace AbcG = Alembic::AbcGeom;
namespace AbcM = Alembic::AbcMaterial;

namespace abcjs {

namespace {

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

const ObjectRecord& requireRecord(const ArchiveData& data, const std::string& objectPath)
{
    const ObjectRecord* rec = data.find(objectPath);
    if (!rec) {
        throw AbcError(codes::ObjectNotFound, "Object '" + objectPath + "' does not exist in " + data.path);
    }
    return *rec;
}

// Number of polygons of a mesh/subd at a time, read from its face counts.
size_t faceCountAt(const Alembic::Abc::IObject& mesh, const ObjectRecord& rec, double time)
{
    Alembic::Abc::IInt32ArrayProperty counts;
    if (rec.type == "mesh") {
        AbcG::IPolyMesh polyMesh(mesh, Alembic::Abc::kWrapExisting);
        counts = polyMesh.getSchema().getFaceCountsProperty();
    } else {
        AbcG::ISubD subd(mesh, Alembic::Abc::kWrapExisting);
        counts = subd.getSchema().getFaceCountsProperty();
    }
    if (!counts.valid() || counts.getNumSamples() == 0) return 0;
    Alembic::Util::Dimensions dims;
    counts.getDimensions(dims, Alembic::Abc::ISampleSelector(time));
    return dims.numPoints();
}

} // namespace

std::string MaterialAssignmentOf(const Alembic::Abc::IObject& obj)
{
    for (Alembic::Abc::IObject it = obj; it.valid(); it = it.getParent()) {
        std::string path;
        if (AbcM::getMaterialAssignmentPath(it, path)) return path;
        AbcM::IMaterialSchema local;
        if (AbcM::hasMaterial(it, local)) return it.getFullName(); // material defined on the object itself
        if (!it.getParent().valid()) break;
    }
    return "";
}

std::vector<FaceSetData> FaceSetsOf(const Alembic::Abc::IObject& mesh, double time, size_t faceCount)
{
    std::vector<FaceSetData> sets;
    const std::string meshMaterial = MaterialAssignmentOf(mesh);
    for (size_t i = 0; i < mesh.getNumChildren(); ++i) {
        Alembic::Abc::IObject child = mesh.getChild(i);
        if (!AbcG::IFaceSet::matches(child.getMetaData())) continue;
        AbcG::IFaceSet faceSet(child, Alembic::Abc::kWrapExisting);
        AbcG::IFaceSetSchema& schema = faceSet.getSchema();
        FaceSetData out;
        out.name = child.getName();
        out.path = child.getFullName();
        out.exclusive = schema.getFaceExclusivity() == AbcG::kFaceSetExclusive;
        if (schema.getNumSamples() > 0) {
            AbcG::IFaceSetSchema::Sample sample;
            schema.get(sample, Alembic::Abc::ISampleSelector(time));
            if (auto faces = sample.getFaces()) out.faces.assign(faces->get(), faces->get() + faces->size());
        }
        for (int32_t face : out.faces) {
            if (face < 0 || static_cast<size_t>(face) >= faceCount) {
                throw AbcError(codes::MalformedData, "Face set '" + out.path + "' references face " +
                                                         std::to_string(face) + " but the mesh has " +
                                                         std::to_string(faceCount) + " faces");
            }
        }
        std::string own;
        out.materialPath = AbcM::getMaterialAssignmentPath(child, own) ? own : meshMaterial;
        sets.push_back(std::move(out));
    }
    return sets;
}

std::vector<FaceSetData> ReadFaceSets(const ArchiveData& data, const std::string& meshPath, const SampleSpec& spec)
{
    const ObjectRecord& rec = requireRecord(data, meshPath);
    if (rec.type != "mesh" && rec.type != "subd") {
        throw AbcError(codes::UnsupportedType, "Object '" + meshPath + "' is of type '" + rec.type +
                                                   "'; only 'mesh' and 'subd' have face sets");
    }
    return guarded("face sets of '" + meshPath + "'", [&] {
        Alembic::Abc::IObject mesh = ResolveObject(data, meshPath);
        return FaceSetsOf(mesh, spec.time, faceCountAt(mesh, rec, spec.time));
    });
}

std::string ReadMaterialAssignment(const ArchiveData& data, const std::string& objectPath)
{
    requireRecord(data, objectPath);
    return guarded("material assignment of '" + objectPath + "'",
                   [&] { return MaterialAssignmentOf(ResolveObject(data, objectPath)); });
}

MaterialData ReadMaterial(const ArchiveData& data, const std::string& materialPath)
{
    const ObjectRecord& rec = requireRecord(data, materialPath);
    Alembic::Abc::IObject obj =
        guarded("material '" + materialPath + "'", [&] { return ResolveObject(data, materialPath); });
    AbcM::IMaterialSchema localSchema;
    const bool isMaterial = rec.type == "material";
    if (!isMaterial && !AbcM::hasMaterial(obj, localSchema)) {
        throw AbcError(codes::UnsupportedType,
                       "Object '" + materialPath + "' is of type '" + rec.type + "' and has no material");
    }
    return guarded("material '" + materialPath + "'", [&] {
        AbcM::MaterialFlatten flat = isMaterial
                                         ? AbcM::MaterialFlatten(AbcM::IMaterial(obj, Alembic::Abc::kWrapExisting))
                                         : AbcM::MaterialFlatten(localSchema);
        MaterialData out;
        out.name = rec.name;
        out.path = rec.path;
        flat.getTargetNames(out.targets);
        const Alembic::Abc::ISampleSelector sel(0.0);
        for (const std::string& target : out.targets) {
            std::vector<std::string> shaderTypes;
            flat.getShaderTypesForTarget(target, shaderTypes);
            for (const std::string& shaderType : shaderTypes) {
                MaterialShader shader;
                shader.target = target;
                shader.shaderType = shaderType;
                flat.getShader(target, shaderType, shader.shaderName);
                AbcM::MaterialFlatten::ParameterEntryVector entries;
                flat.getShaderParameters(target, shaderType, entries);
                for (const auto& entry : entries) {
                    try {
                        shader.parameters.emplace_back(entry.name,
                                                       ReadValue(entry.parent, entry.header->getName(), sel, true));
                    } catch (const AbcError&) {
                        // Parameters with exotic types (e.g. plain compounds) are skipped.
                    }
                }
                out.shaders.push_back(std::move(shader));
            }
        }
        for (size_t i = 0; i < flat.getNumNetworkNodes(); ++i) {
            AbcM::MaterialFlatten::NetworkNode node = flat.getNetworkNode(i);
            if (!node.valid()) continue;
            MaterialNetworkNode out_node;
            out_node.name = node.getName();
            node.getTarget(out_node.target);
            node.getNodeType(out_node.nodeType);
            AbcM::MaterialFlatten::NetworkNode::ConnectionVector connections;
            node.getConnections(connections);
            for (const auto& c : connections) {
                out_node.connections.emplace_back(c.inputName, c.connectedNodeName + "." + c.connectedOutputName);
            }
            out.network.push_back(std::move(out_node));
        }
        return out;
    });
}

} // namespace abcjs
