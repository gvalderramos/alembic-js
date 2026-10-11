#pragma once

#ifndef ABCINFO_H
#define ABCINFO_H

#include <napi.h>

#include <Alembic/AbcGeom/All.h>
#include <Alembic/AbcCoreAbstract/All.h>
#include <Alembic/AbcCoreFactory/All.h>
#include <Alembic/Util/All.h>
#include <Alembic/Abc/TypedPropertyTraits.h>

#include <filesystem>
#include <vector>
#include <string>

struct ObjectInfo;
struct PropertyInfo;

class AbcInfo : public Napi::ObjectWrap<AbcInfo<Napi::Object>> {
public:
    AbcInfo(const Napi::CallbackInfo& info);
    Napi::Value load(const Napi::CallbackInfo& info);

    Napi::Value appName(const Napi::CallbackInfo&);
    Napi::Value libraryVersionString(const Napi::CallbackInfo&);
    Napi::Value libraryVersion(const Napi::CallbackInfo&);
    Napi::Value whenWritten(const Napi::CallbackInfo&);
    Napi::Value userDescription(const Napi::CallbackInfo&);

    Napi::Value getObjects(const Napi::CallbackInfo&);
    Napi::Value getProperties(const Napi::CallbackInfo&);

    static Napi::Function GetClass(Napi::Env);
private:
    Napi::Value loadAbcFile(const std::filesystem::path& path, const Napi::CallbackInfo& info);

    std::string m_appName;
    std::string m_libraryVersionString;
    Alembic::Util::uint32_t m_libraryVersion;
    std::string m_whenWritten;
    std::string m_userDescription;
    std::vector<ObjectInfo> m_objects;
    std::vector<PropertyInfo> m_properties;
};

#endif // ABCINFO_H
