#pragma once

#include <napi.h>

#include <Alembic/AbcGeom/All.h>
#include <Alembic/AbcCoreAbstract/All.h>
#include <Alembic/AbcCoreFactory/All.h>
#include <Alembic/Util/All.h>
#include <Alembic/Abc/TypedPropertyTraits.h>

#include <filesystem>

class AbcInfo : public Napi::ObjectWrap<AbcInfo>
{
public:
    AbcInfo(const Napi::CallbackInfo& info);
    Napi::Value load(const Napi::CallbackInfo& info);

    Napi::Value appName(const Napi::CallbackInfo&);
    Napi::Value libraryVersionString(const Napi::CallbackInfo&);
    Napi::Value libraryVersion(const Napi::CallbackInfo&);
    Napi::Value whenWritten(const Napi::CallbackInfo&);
    Napi::Value userDescription(const Napi::CallbackInfo&);

    static Napi::Function GetClass(Napi::Env);
private:
    Napi::Value loadAbcFile(const std::filesystem::path& path, const Napi::CallbackInfo& info);

    std::string m_appName;
    std::string m_libraryVersionString;
    Alembic::Util::uint32_t m_libraryVersion;
    std::string m_whenWritten;
    std::string m_userDescription;
};