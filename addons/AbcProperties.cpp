#include "AbcProperties.h"

#include <Alembic/AbcGeom/All.h>

#include <cstring>

namespace Abc = Alembic::Abc;
namespace AbcA = Alembic::AbcCoreAbstract;
namespace AbcG = Alembic::AbcGeom;
namespace Util = Alembic::Util;

namespace abcjs {

namespace {

std::string podName(Util::PlainOldDataType pod)
{
    switch (pod) {
    case Util::kBooleanPOD:
        return "bool";
    case Util::kUint8POD:
        return "uint8";
    case Util::kInt8POD:
        return "int8";
    case Util::kUint16POD:
        return "uint16";
    case Util::kInt16POD:
        return "int16";
    case Util::kUint32POD:
        return "uint32";
    case Util::kInt32POD:
        return "int32";
    case Util::kUint64POD:
        return "uint64";
    case Util::kInt64POD:
        return "int64";
    case Util::kFloat16POD:
        return "float16";
    case Util::kFloat32POD:
        return "float32";
    case Util::kFloat64POD:
        return "float64";
    case Util::kStringPOD:
        return "string";
    case Util::kWstringPOD:
        return "wstring";
    default:
        return "unknown";
    }
}

std::string scopeName(const AbcA::MetaData& md)
{
    if (md.get("geoScope").empty()) return "";
    switch (AbcG::GetGeometryScope(md)) {
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
        return "unknown";
    }
}

std::string toUtf8(const std::wstring& in)
{
    std::string out;
    for (size_t i = 0; i < in.size(); ++i) {
        uint32_t cp = static_cast<uint32_t>(in[i]);
        // wchar_t is UTF-16 on Windows: combine surrogate pairs.
        if (sizeof(wchar_t) == 2 && cp >= 0xD800 && cp <= 0xDBFF && i + 1 < in.size()) {
            const uint32_t low = static_cast<uint32_t>(in[i + 1]);
            if (low >= 0xDC00 && low <= 0xDFFF) {
                cp = 0x10000 + ((cp - 0xD800) << 10) + (low - 0xDC00);
                ++i;
            }
        }
        if (cp < 0x80) {
            out += static_cast<char>(cp);
        } else if (cp < 0x800) {
            out += static_cast<char>(0xC0 | (cp >> 6));
            out += static_cast<char>(0x80 | (cp & 0x3F));
        } else if (cp < 0x10000) {
            out += static_cast<char>(0xE0 | (cp >> 12));
            out += static_cast<char>(0x80 | ((cp >> 6) & 0x3F));
            out += static_cast<char>(0x80 | (cp & 0x3F));
        } else {
            out += static_cast<char>(0xF0 | (cp >> 18));
            out += static_cast<char>(0x80 | ((cp >> 12) & 0x3F));
            out += static_cast<char>(0x80 | ((cp >> 6) & 0x3F));
            out += static_cast<char>(0x80 | (cp & 0x3F));
        }
    }
    return out;
}

// Appends `components` raw values of `pod` to `out`, widening float16 and bool.
void decodeNumeric(Util::PlainOldDataType pod, const void* raw, size_t components, PropertyValue& out)
{
    if (pod == Util::kFloat16POD) {
        const auto* src = static_cast<const Util::float16_t*>(raw);
        const size_t start = out.bytes.size();
        out.bytes.resize(start + components * sizeof(float));
        auto* dst = reinterpret_cast<float*>(out.bytes.data() + start);
        for (size_t i = 0; i < components; ++i)
            dst[i] = static_cast<float>(src[i]);
    } else if (pod == Util::kBooleanPOD) {
        const auto* src = static_cast<const Util::bool_t*>(raw);
        for (size_t i = 0; i < components; ++i)
            out.bytes.push_back(src[i] ? 1 : 0);
    } else {
        const size_t n = components * Util::PODNumBytes(pod);
        const auto* src = static_cast<const uint8_t*>(raw);
        out.bytes.insert(out.bytes.end(), src, src + n);
    }
}

void decodeStrings(Util::PlainOldDataType pod, const void* raw, size_t components, PropertyValue& out)
{
    if (pod == Util::kStringPOD) {
        const auto* src = static_cast<const std::string*>(raw);
        out.strings.insert(out.strings.end(), src, src + components);
    } else {
        const auto* src = static_cast<const std::wstring*>(raw);
        for (size_t i = 0; i < components; ++i)
            out.strings.push_back(toUtf8(src[i]));
    }
}

void decode(Util::PlainOldDataType pod, const void* raw, size_t components, PropertyValue& out)
{
    if (pod == Util::kStringPOD || pod == Util::kWstringPOD) {
        decodeStrings(pod, raw, components, out);
    } else if (pod == Util::kUnknownPOD || pod == Util::kNumPlainOldDataTypes) {
        throw AbcError(codes::UnsupportedType, "Property has an unknown data type");
    } else {
        decodeNumeric(pod, raw, components, out);
    }
}

bool isIndexedCompound(const Abc::ICompoundProperty& compound)
{
    return compound.getPropertyHeader(".vals") != nullptr && compound.getPropertyHeader(".indices") != nullptr;
}

PropertyValue readArray(const Abc::ICompoundProperty& parent, const std::string& name, const Abc::ISampleSelector& sel)
{
    Abc::IArrayProperty prop(parent, name);
    AbcA::ArraySamplePtr sample;
    prop.get(sample, sel);
    const AbcA::DataType& dt = sample->getDataType();

    PropertyValue out;
    out.pod = podName(dt.getPod());
    out.extent = dt.getExtent();
    out.count = sample->size();
    out.isArray = true;
    out.scope = scopeName(prop.getMetaData());
    out.interpretation = prop.getMetaData().get("interpretation");
    decode(dt.getPod(), sample->getData(), out.count * out.extent, out);
    return out;
}

PropertyValue readScalar(const Abc::ICompoundProperty& parent, const std::string& name, const Abc::ISampleSelector& sel)
{
    Abc::IScalarProperty prop(parent, name);
    const AbcA::DataType& dt = prop.getDataType();
    const size_t extent = dt.getExtent();

    PropertyValue out;
    out.pod = podName(dt.getPod());
    out.extent = extent;
    out.count = 1;
    out.interpretation = prop.getMetaData().get("interpretation");
    if (dt.getPod() == Util::kStringPOD) {
        std::vector<std::string> buf(extent);
        prop.get(buf.data(), sel);
        decode(dt.getPod(), buf.data(), extent, out);
    } else if (dt.getPod() == Util::kWstringPOD) {
        std::vector<std::wstring> buf(extent);
        prop.get(buf.data(), sel);
        decode(dt.getPod(), buf.data(), extent, out);
    } else {
        std::vector<uint8_t> buf(Util::PODNumBytes(dt.getPod()) * extent);
        prop.get(buf.data(), sel);
        decode(dt.getPod(), buf.data(), extent, out);
    }
    return out;
}

// Returns the schema compound (".geom", ".xform", ...) of an object, if any.
Abc::ICompoundProperty schemaCompound(const Abc::ICompoundProperty& top)
{
    for (size_t i = 0; i < top.getNumProperties(); ++i) {
        const auto& header = top.getPropertyHeader(i);
        if (header.isCompound() && !header.getMetaData().get("schema").empty()) {
            return Abc::ICompoundProperty(top, header.getName());
        }
    }
    return Abc::ICompoundProperty();
}

std::vector<std::string> splitPath(const std::string& path)
{
    std::vector<std::string> parts;
    size_t start = 0;
    while (start <= path.size()) {
        size_t end = path.find('/', start);
        if (end == std::string::npos) end = path.size();
        if (end > start) parts.push_back(path.substr(start, end - start));
        start = end + 1;
    }
    return parts;
}

[[noreturn]] void notFound(const std::string& objectPath, const std::string& propertyPath)
{
    throw AbcError(codes::PropertyNotFound,
                   "Property '" + propertyPath + "' does not exist on object '" + objectPath + "'");
}

// Walks `parts` (all compounds) starting at `from`; returns an invalid compound when a segment is missing.
Abc::ICompoundProperty walk(Abc::ICompoundProperty from, const std::vector<std::string>& parts, size_t count)
{
    for (size_t i = 0; i < count; ++i) {
        const AbcA::PropertyHeader* header = from.getPropertyHeader(parts[i]);
        if (!header || !header->isCompound()) return Abc::ICompoundProperty();
        from = Abc::ICompoundProperty(from, parts[i]);
    }
    return from;
}

// Resolves the compound that contains the last segment of `propertyPath`, with
// ".arbGeomParams" / ".userProperties" shortcuts resolved inside the schema compound.
Abc::ICompoundProperty resolveParent(const Abc::ICompoundProperty& top, const std::vector<std::string>& parts)
{
    Abc::ICompoundProperty parent = walk(top, parts, parts.size() - 1);
    const bool lastExists = parent.valid() && parent.getPropertyHeader(parts.back()) != nullptr;
    if (lastExists) return parent;
    if (!parts.empty() && (parts[0] == ".arbGeomParams" || parts[0] == ".userProperties")) {
        Abc::ICompoundProperty schema = schemaCompound(top);
        if (schema.valid()) {
            Abc::ICompoundProperty viaSchema = walk(schema, parts, parts.size() - 1);
            if (viaSchema.valid() && viaSchema.getPropertyHeader(parts.back()) != nullptr) return viaSchema;
        }
    }
    return Abc::ICompoundProperty();
}

Abc::ICompoundProperty resolveCompound(const Abc::ICompoundProperty& top, const std::string& objectPath,
                                       const std::string& path)
{
    if (path.empty() || path == "/") return top;
    const std::vector<std::string> parts = splitPath(path);
    Abc::ICompoundProperty parent = resolveParent(top, parts);
    if (!parent.valid()) notFound(objectPath, path);
    const AbcA::PropertyHeader* header = parent.getPropertyHeader(parts.back());
    if (!header->isCompound()) {
        throw AbcError(codes::InvalidArgument, "Property '" + path + "' is not a compound");
    }
    return Abc::ICompoundProperty(parent, parts.back());
}

void fillSampling(const Abc::ICompoundProperty& parent, const AbcA::PropertyHeader& header,
                  const Abc::ISampleSelector& sel, PropertyInfo& info)
{
    if (header.isScalar()) {
        Abc::IScalarProperty prop(parent, header.getName());
        info.numSamples = prop.getNumSamples();
        info.animated = !prop.isConstant();
    } else if (header.isArray()) {
        Abc::IArrayProperty prop(parent, header.getName());
        info.numSamples = prop.getNumSamples();
        info.animated = !prop.isConstant();
        if (info.numSamples > 0) {
            Util::Dimensions dims;
            prop.getDimensions(dims, sel);
            info.count = static_cast<int64_t>(dims.numPoints());
        }
    }
}

std::vector<PropertyInfo> list(const Abc::ICompoundProperty& compound, const std::string& prefix, bool recursive,
                               const Abc::ISampleSelector& sel)
{
    std::vector<PropertyInfo> out;
    for (size_t i = 0; i < compound.getNumProperties(); ++i) {
        const AbcA::PropertyHeader& header = compound.getPropertyHeader(i);
        PropertyInfo info;
        info.name = header.getName();
        info.path = prefix.empty() ? info.name : prefix + "/" + info.name;
        info.kind = header.isScalar() ? "scalar" : header.isArray() ? "array" : "compound";
        const AbcA::MetaData& md = header.getMetaData();
        for (auto it = md.begin(); it != md.end(); ++it)
            info.metadata.emplace_back(it->first, it->second);
        info.interpretation = md.get("interpretation");
        info.scope = scopeName(md);

        if (header.isCompound()) {
            Abc::ICompoundProperty child(compound, info.name);
            if (isIndexedCompound(child)) {
                const AbcA::PropertyHeader& vals = *child.getPropertyHeader(".vals");
                info.indexed = true;
                info.pod = podName(vals.getDataType().getPod());
                info.extent = vals.getDataType().getExtent();
                if (info.interpretation.empty()) info.interpretation = vals.getMetaData().get("interpretation");
                if (info.scope.empty()) info.scope = scopeName(vals.getMetaData());
                PropertyInfo valsInfo;
                fillSampling(child, vals, sel, valsInfo);
                info.numSamples = valsInfo.numSamples;
                info.animated = valsInfo.animated;
                PropertyInfo indicesInfo;
                fillSampling(child, *child.getPropertyHeader(".indices"), sel, indicesInfo);
                info.count = indicesInfo.count;
                info.animated = info.animated || indicesInfo.animated;
            }
            if (recursive) info.children = list(child, info.path, true, sel);
        } else {
            info.pod = podName(header.getDataType().getPod());
            info.extent = header.getDataType().getExtent();
            fillSampling(compound, header, sel, info);
        }
        out.push_back(std::move(info));
    }
    return out;
}

Abc::ICompoundProperty objectTop(const ArchiveData& data, const std::string& objectPath)
{
    if (!data.find(objectPath)) {
        throw AbcError(codes::ObjectNotFound, "Object '" + objectPath + "' does not exist in " + data.path);
    }
    return ResolveObject(data, objectPath).getProperties();
}

template <class Fn> auto guardedRead(const std::string& what, Fn&& fn) -> decltype(fn())
{
    try {
        return fn();
    } catch (const AbcError&) {
        throw;
    } catch (const std::exception& e) {
        throw AbcError(codes::ReadFailed, "Failed to read " + what + ": " + e.what());
    }
}

std::vector<UserProperty> readUserCompound(const Abc::ICompoundProperty& compound, const Abc::ISampleSelector& sel)
{
    std::vector<UserProperty> out;
    for (const std::string& name : ChildNames(compound)) {
        UserProperty prop;
        prop.name = name;
        const AbcA::PropertyHeader* header = compound.getPropertyHeader(name);
        if (header->isCompound() && !isIndexedCompound(Abc::ICompoundProperty(compound, name))) {
            prop.isCompound = true;
            prop.children = readUserCompound(Abc::ICompoundProperty(compound, name), sel);
        } else {
            prop.value = ReadValue(compound, name, sel, true);
        }
        out.push_back(std::move(prop));
    }
    return out;
}

} // namespace

size_t DecodedComponentSize(const std::string& pod)
{
    if (pod == "bool" || pod == "uint8" || pod == "int8") return 1;
    if (pod == "uint16" || pod == "int16") return 2;
    if (pod == "uint32" || pod == "int32" || pod == "float32" || pod == "float16") return 4;
    if (pod == "uint64" || pod == "int64" || pod == "float64") return 8;
    return 0;
}

double PropertyValue::numberAt(size_t i) const
{
    const uint8_t* p = bytes.data() + i * DecodedComponentSize(pod);
    auto read = [p](auto value) {
        std::memcpy(&value, p, sizeof(value));
        return static_cast<double>(value);
    };
    if (pod == "bool" || pod == "uint8") return read(uint8_t{});
    if (pod == "int8") return read(int8_t{});
    if (pod == "uint16") return read(uint16_t{});
    if (pod == "int16") return read(int16_t{});
    if (pod == "uint32") return read(uint32_t{});
    if (pod == "int32") return read(int32_t{});
    if (pod == "uint64") return read(uint64_t{});
    if (pod == "int64") return read(int64_t{});
    if (pod == "float16" || pod == "float32") return read(float{});
    if (pod == "float64") return read(double{});
    throw AbcError(codes::UnsupportedType, "Property of type '" + pod + "' is not numeric");
}

int64_t PropertyValue::int64At(size_t i) const
{
    int64_t value = 0;
    std::memcpy(&value, bytes.data() + i * 8, 8);
    return value;
}

uint64_t PropertyValue::uint64At(size_t i) const
{
    uint64_t value = 0;
    std::memcpy(&value, bytes.data() + i * 8, 8);
    return value;
}

std::vector<std::string> ChildNames(const Abc::ICompoundProperty& parent)
{
    std::vector<std::string> names;
    if (!parent.valid()) return names;
    for (size_t i = 0; i < parent.getNumProperties(); ++i)
        names.push_back(parent.getPropertyHeader(i).getName());
    return names;
}

PropertyValue ReadValue(const Abc::ICompoundProperty& parent, const std::string& name, const Abc::ISampleSelector& sel,
                        bool expand)
{
    const AbcA::PropertyHeader* header = parent.getPropertyHeader(name);
    if (!header) {
        throw AbcError(codes::PropertyNotFound, "Property '" + name + "' does not exist");
    }
    if (header->isScalar()) return readScalar(parent, name, sel);
    if (header->isArray()) return readArray(parent, name, sel);

    Abc::ICompoundProperty compound(parent, name);
    if (!isIndexedCompound(compound)) {
        throw AbcError(codes::InvalidArgument,
                       "Property '" + name + "' is a compound; list it with getProperties() instead");
    }
    PropertyValue vals = readArray(compound, ".vals", sel);
    if (vals.scope.empty()) vals.scope = scopeName(header->getMetaData());
    if (vals.interpretation.empty()) vals.interpretation = header->getMetaData().get("interpretation");

    Abc::IUInt32ArrayProperty indicesProp(compound, ".indices");
    Abc::UInt32ArraySamplePtr indices;
    indicesProp.get(indices, sel);
    const size_t numIndices = indices ? indices->size() : 0;
    for (size_t i = 0; i < numIndices; ++i) {
        if ((*indices)[i] >= vals.count) {
            throw AbcError(codes::MalformedData, "Indexed property '" + name + "' has index " +
                                                     std::to_string((*indices)[i]) + " but only " +
                                                     std::to_string(vals.count) + " values");
        }
    }
    if (!expand) {
        vals.indices.assign(indices->get(), indices->get() + numIndices);
        vals.hasIndices = true;
        return vals;
    }

    PropertyValue out = vals;
    out.count = numIndices;
    out.bytes.clear();
    out.strings.clear();
    if (vals.isString()) {
        for (size_t i = 0; i < numIndices; ++i) {
            const size_t src = (*indices)[i] * vals.extent;
            out.strings.insert(out.strings.end(), vals.strings.begin() + src, vals.strings.begin() + src + vals.extent);
        }
    } else {
        const size_t element = DecodedComponentSize(vals.pod) * vals.extent;
        out.bytes.resize(numIndices * element);
        for (size_t i = 0; i < numIndices; ++i) {
            std::memcpy(out.bytes.data() + i * element, vals.bytes.data() + (*indices)[i] * element, element);
        }
    }
    return out;
}

std::vector<PropertyInfo> ListProperties(const ArchiveData& data, const std::string& objectPath,
                                         const std::string& root, bool recursive, double time)
{
    return guardedRead("properties of '" + objectPath + "'", [&] {
        Abc::ICompoundProperty top = objectTop(data, objectPath);
        Abc::ICompoundProperty start = resolveCompound(top, objectPath, root);
        // Build the real path, so shortcuts such as ".arbGeomParams" report ".geom/.arbGeomParams".
        std::string prefix;
        for (Abc::ICompoundProperty it = start; it.valid() && it.getParent().valid(); it = it.getParent()) {
            prefix = prefix.empty() ? it.getName() : it.getName() + "/" + prefix;
        }
        return list(start, prefix, recursive, Abc::ISampleSelector(time));
    });
}

PropertyValue ReadProperty(const ArchiveData& data, const std::string& objectPath, const std::string& propertyPath,
                           double time, bool expand)
{
    return guardedRead("property '" + propertyPath + "' of '" + objectPath + "'", [&] {
        Abc::ICompoundProperty top = objectTop(data, objectPath);
        const std::vector<std::string> parts = splitPath(propertyPath);
        if (parts.empty()) {
            throw AbcError(codes::InvalidArgument, "Expected a property path, e.g. '.arbGeomParams/Cd'");
        }
        Abc::ICompoundProperty parent = resolveParent(top, parts);
        if (!parent.valid()) notFound(objectPath, propertyPath);
        try {
            return ReadValue(parent, parts.back(), Abc::ISampleSelector(time), expand);
        } catch (const AbcError& e) {
            if (e.code() == codes::PropertyNotFound) notFound(objectPath, propertyPath);
            throw;
        }
    });
}

std::vector<UserProperty> ReadUserProperties(const ArchiveData& data, const std::string& objectPath, double time)
{
    return guardedRead("user properties of '" + objectPath + "'", [&] {
        Abc::ICompoundProperty top = objectTop(data, objectPath);
        Abc::ICompoundProperty user;
        if (top.getPropertyHeader(".userProperties")) {
            user = Abc::ICompoundProperty(top, ".userProperties");
        } else {
            Abc::ICompoundProperty schema = schemaCompound(top);
            if (schema.valid() && schema.getPropertyHeader(".userProperties")) {
                user = Abc::ICompoundProperty(schema, ".userProperties");
            }
        }
        if (!user.valid()) return std::vector<UserProperty>();
        return readUserCompound(user, Abc::ISampleSelector(time));
    });
}

} // namespace abcjs
