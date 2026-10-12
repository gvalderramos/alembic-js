#pragma once

#ifndef ABCPROPERTIES_H
#define ABCPROPERTIES_H

// Generic property access (spec 0006): list the property tree of an object and
// decode any scalar/array property into plain C++ storage. Pure C++, no N-API.

#include "AbcScene.h"

#include <Alembic/Abc/All.h>

#include <cstdint>
#include <string>
#include <utility>
#include <vector>

namespace abcjs {

struct PropertyInfo {
    std::string name;
    std::string path; // relative to the object's top compound, e.g. ".geom/.arbGeomParams/Cd"
    std::string kind; // scalar | array | compound
    std::string pod;  // empty for plain compounds
    size_t extent = 0;
    std::string interpretation;
    std::string scope; // geometry scope when the property carries one
    bool indexed = false;
    size_t numSamples = 0;
    bool animated = false;
    int64_t count = -1; // array elements at the sampled time (-1 when not applicable)
    std::vector<std::pair<std::string, std::string>> metadata;
    std::vector<PropertyInfo> children;
};

// Decoded property sample. Numeric data keeps its stored element type, except
// float16 (widened to float32) and bool (stored as uint8).
struct PropertyValue {
    std::string pod;
    size_t extent = 1;
    size_t count = 0;     // number of elements (each has `extent` components)
    bool isArray = false; // array or indexed property (false for scalars)
    std::string scope;
    std::string interpretation;
    std::vector<uint8_t> bytes; // numeric payload, count * extent components
    std::vector<std::string> strings;
    std::vector<uint32_t> indices; // only when an indexed property is read with expand = false
    bool hasIndices = false;

    bool isString() const { return pod == "string" || pod == "wstring"; }
    // Component `i` (0 <= i < count * extent) as a double; numeric pods only.
    double numberAt(size_t i) const;
    int64_t int64At(size_t i) const;
    uint64_t uint64At(size_t i) const;
};

struct UserProperty {
    std::string name;
    bool isCompound = false;
    PropertyValue value;
    std::vector<UserProperty> children;
};

// Bytes per stored component after decoding (float16 -> 4, bool -> 1).
size_t DecodedComponentSize(const std::string& pod);

// Lists the properties of `objectPath`, starting at `root` ("" = top compound).
std::vector<PropertyInfo> ListProperties(const ArchiveData& data, const std::string& objectPath,
                                         const std::string& root, bool recursive, double time);

// Reads the property at `propertyPath` (relative to the object's top compound;
// ".arbGeomParams/..." and ".userProperties/..." are resolved inside the schema).
PropertyValue ReadProperty(const ArchiveData& data, const std::string& objectPath, const std::string& propertyPath,
                           double time, bool expand);

// Reads every user property of the object (schema `.userProperties`).
std::vector<UserProperty> ReadUserProperties(const ArchiveData& data, const std::string& objectPath, double time);

// Helpers shared with the mesh reader.
PropertyValue ReadValue(const Alembic::Abc::ICompoundProperty& parent, const std::string& name,
                        const Alembic::Abc::ISampleSelector& sel, bool expand);
std::vector<std::string> ChildNames(const Alembic::Abc::ICompoundProperty& parent);

} // namespace abcjs

#endif // ABCPROPERTIES_H
