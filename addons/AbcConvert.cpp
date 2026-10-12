#include "AbcConvert.h"

namespace abcjs {

namespace {

template <class T> Napi::Value typed(Napi::Env env, const PropertyValue& value)
{
    const size_t components = value.bytes.size() / sizeof(T);
    return ToTypedArray(env, reinterpret_cast<const T*>(value.bytes.data()), components);
}

} // namespace

Napi::Value ValueData(Napi::Env env, const PropertyValue& value)
{
    const std::string& pod = value.pod;
    if (value.isString()) {
        Napi::Array arr = Napi::Array::New(env, value.strings.size());
        for (uint32_t i = 0; i < value.strings.size(); ++i)
            arr.Set(i, value.strings[i]);
        return arr;
    }
    if (pod == "bool" || pod == "uint8") return typed<uint8_t>(env, value);
    if (pod == "int8") return typed<int8_t>(env, value);
    if (pod == "uint16") return typed<uint16_t>(env, value);
    if (pod == "int16") return typed<int16_t>(env, value);
    if (pod == "uint32") return typed<uint32_t>(env, value);
    if (pod == "int32") return typed<int32_t>(env, value);
    if (pod == "uint64") return typed<uint64_t>(env, value);
    if (pod == "int64") return typed<int64_t>(env, value);
    if (pod == "float16" || pod == "float32") return typed<float>(env, value);
    if (pod == "float64") return typed<double>(env, value);
    return env.Undefined();
}

Napi::Value ValueComponent(Napi::Env env, const PropertyValue& value, size_t i)
{
    if (value.isString()) return Napi::String::New(env, value.strings[i]);
    if (value.pod == "bool") return Napi::Boolean::New(env, value.bytes[i] != 0);
    if (value.pod == "int64") return Napi::BigInt::New(env, value.int64At(i));
    if (value.pod == "uint64") return Napi::BigInt::New(env, value.uint64At(i));
    return Napi::Number::New(env, value.numberAt(i));
}

Napi::Value PropertyValueToJs(Napi::Env env, const PropertyValue& value)
{
    if (!value.isArray) {
        if (value.extent == 1) return ValueComponent(env, value, 0);
        Napi::Array arr = Napi::Array::New(env, value.extent);
        for (uint32_t i = 0; i < value.extent; ++i)
            arr.Set(i, ValueComponent(env, value, i));
        return arr;
    }
    Napi::Object out = Napi::Object::New(env);
    out.Set("pod", value.pod);
    out.Set("extent", Napi::Number::New(env, static_cast<double>(value.extent)));
    out.Set("count", Napi::Number::New(env, static_cast<double>(value.count)));
    out.Set("data", ValueData(env, value));
    if (!value.scope.empty()) out.Set("scope", value.scope);
    if (!value.interpretation.empty()) out.Set("interpretation", value.interpretation);
    if (value.hasIndices) out.Set("indices", ToTypedArray(env, value.indices));
    return out;
}

Napi::Value UserValueToJs(Napi::Env env, const PropertyValue& value)
{
    const size_t components = value.isString() ? value.strings.size() : value.count * value.extent;
    // DCCs such as Blender write single values as one-element arrays: unwrap them.
    if (components == 1) return ValueComponent(env, value, 0);
    Napi::Array arr = Napi::Array::New(env, components);
    for (uint32_t i = 0; i < components; ++i)
        arr.Set(i, ValueComponent(env, value, i));
    return arr;
}

Napi::Object UserPropertiesToJs(Napi::Env env, const std::vector<UserProperty>& props)
{
    Napi::Object out = Napi::Object::New(env);
    for (const auto& prop : props) {
        out.Set(prop.name,
                prop.isCompound ? Napi::Value(UserPropertiesToJs(env, prop.children)) : UserValueToJs(env, prop.value));
    }
    return out;
}

Napi::Array PropertyInfosToJs(Napi::Env env, const std::vector<PropertyInfo>& infos)
{
    Napi::Array arr = Napi::Array::New(env, infos.size());
    for (uint32_t i = 0; i < infos.size(); ++i) {
        const PropertyInfo& info = infos[i];
        Napi::Object obj = Napi::Object::New(env);
        obj.Set("name", info.name);
        obj.Set("path", info.path);
        obj.Set("kind", info.kind);
        if (!info.pod.empty()) {
            obj.Set("pod", info.pod);
            obj.Set("extent", Napi::Number::New(env, static_cast<double>(info.extent)));
            obj.Set("numSamples", Napi::Number::New(env, static_cast<double>(info.numSamples)));
            obj.Set("animated", Napi::Boolean::New(env, info.animated));
        }
        if (!info.interpretation.empty()) obj.Set("interpretation", info.interpretation);
        if (!info.scope.empty()) obj.Set("scope", info.scope);
        if (info.indexed) obj.Set("indexed", Napi::Boolean::New(env, true));
        if (info.count >= 0) obj.Set("count", Napi::Number::New(env, static_cast<double>(info.count)));
        Napi::Object metadata = Napi::Object::New(env);
        for (const auto& [key, val] : info.metadata)
            metadata.Set(key, val);
        obj.Set("metadata", metadata);
        if (!info.children.empty()) obj.Set("children", PropertyInfosToJs(env, info.children));
        arr.Set(i, obj);
    }
    return arr;
}

Napi::Object MeshAttributeToJs(Napi::Env env, const MeshAttribute& attribute)
{
    Napi::Object out = Napi::Object::New(env);
    if (attribute.kind == "float32") {
        out.Set("data", ToTypedArray(env, attribute.f32));
    } else if (attribute.kind == "int32") {
        out.Set("data", ToTypedArray(env, attribute.i32));
    } else if (attribute.kind == "uint32") {
        out.Set("data", ToTypedArray(env, attribute.u32));
    } else {
        out.Set("data", ToTypedArray(env, attribute.u8));
    }
    out.Set("itemSize", Napi::Number::New(env, static_cast<double>(attribute.itemSize)));
    out.Set("count", Napi::Number::New(env, static_cast<double>(attribute.count)));
    out.Set("pod", attribute.pod);
    out.Set("sourceScope", attribute.scope);
    out.Set("constant", Napi::Boolean::New(env, attribute.constant));
    if (!attribute.interpretation.empty()) out.Set("interpretation", attribute.interpretation);
    return out;
}

} // namespace abcjs
