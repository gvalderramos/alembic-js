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

    static Napi::Function GetClass(Napi::Env);
private:
    void loadAbcFile(const std::filesystem::path& path);

    Alembic::AbcGeom::IArchive m_abcArchive;
};