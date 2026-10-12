#pragma once

#ifndef ABCMATERIALS_H
#define ABCMATERIALS_H

// Face sets and materials (spec 0003). Pure C++, no N-API.

#include "AbcProperties.h"
#include "AbcScene.h"

#include <string>
#include <utility>
#include <vector>

namespace abcjs {

struct FaceSetData {
    std::string name;
    std::string path;
    std::vector<int32_t> faces; // polygon indices into the mesh
    bool exclusive = false;
    std::string materialPath; // resolved assignment: face set, then mesh, then ancestors ("" if none)
};

struct MaterialShader {
    std::string target;     // e.g. "arnold", "prman", "*"
    std::string shaderType; // e.g. "surface", "displacement"
    std::string shaderName; // e.g. "standard_surface"
    std::vector<std::pair<std::string, PropertyValue>> parameters;
};

struct MaterialNetworkNode {
    std::string name;
    std::string target;
    std::string nodeType;
    std::vector<std::pair<std::string, std::string>> connections; // input -> "node.output"
};

struct MaterialData {
    std::string name;
    std::string path;
    std::vector<std::string> targets;
    std::vector<MaterialShader> shaders; // flattened with inherited (parent) materials
    std::vector<MaterialNetworkNode> network;
};

// Face sets of a mesh/subd object, validated against `faceCount`.
std::vector<FaceSetData> FaceSetsOf(const Alembic::Abc::IObject& mesh, double time, size_t faceCount);

// Material assignment of an object, inherited from its ancestors ("" when there is none).
std::string MaterialAssignmentOf(const Alembic::Abc::IObject& obj);

std::vector<FaceSetData> ReadFaceSets(const ArchiveData& data, const std::string& meshPath, const SampleSpec& spec);
std::string ReadMaterialAssignment(const ArchiveData& data, const std::string& objectPath);
MaterialData ReadMaterial(const ArchiveData& data, const std::string& materialPath);

} // namespace abcjs

#endif // ABCMATERIALS_H
