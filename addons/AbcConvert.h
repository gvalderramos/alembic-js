#pragma once

#ifndef ABCCONVERT_H
#define ABCCONVERT_H

// Conversions from decoded Alembic data to JavaScript values.

#include "AbcProperties.h"

#include <napi.h>

#include <cstring>
#include <vector>

namespace abcjs {

// Copies `values` into a new JS-owned ArrayBuffer and wraps it in a typed array.
template <class T> Napi::TypedArrayOf<T> ToTypedArray(Napi::Env env, const T* values, size_t count)
{
    auto buffer = Napi::ArrayBuffer::New(env, count * sizeof(T));
    if (count > 0) std::memcpy(buffer.Data(), values, count * sizeof(T));
    return Napi::TypedArrayOf<T>::New(env, count, buffer, 0);
}

template <class T> Napi::TypedArrayOf<T> ToTypedArray(Napi::Env env, const std::vector<T>& values)
{
    return ToTypedArray(env, values.data(), values.size());
}

// Flat data of a decoded value: a typed array matching its pod, or string[].
Napi::Value ValueData(Napi::Env env, const PropertyValue& value);

// Component `i` as a JS primitive (boolean, number, bigint or string).
Napi::Value ValueComponent(Napi::Env env, const PropertyValue& value, size_t i);

// getProperty() result: primitives/arrays for scalars, AbcArrayValue objects for arrays.
Napi::Value PropertyValueToJs(Napi::Env env, const PropertyValue& value);

// getUserProperties() value: single values unwrapped, other arrays as plain JS arrays.
Napi::Value UserValueToJs(Napi::Env env, const PropertyValue& value);
Napi::Object UserPropertiesToJs(Napi::Env env, const std::vector<UserProperty>& props);

Napi::Array PropertyInfosToJs(Napi::Env env, const std::vector<PropertyInfo>& infos);

Napi::Object MeshAttributeToJs(Napi::Env env, const MeshAttribute& attribute);

} // namespace abcjs

#endif // ABCCONVERT_H
