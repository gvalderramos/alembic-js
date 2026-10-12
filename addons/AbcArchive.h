#pragma once

#ifndef ABCARCHIVE_H
#define ABCARCHIVE_H

#include "AbcScene.h"

#include <napi.h>

#include <memory>
#include <string>

// Native handle for one Alembic archive. The TypeScript `AbcFile` class in
// src/AbcFile.ts is the public API; this class is an implementation detail.
class AbcArchive : public Napi::ObjectWrap<AbcArchive> {
public:
    explicit AbcArchive(const Napi::CallbackInfo& info);

    static Napi::Function GetClass(Napi::Env env);

    void setData(std::shared_ptr<abcjs::ArchiveData> data) { m_data = std::move(data); }
    const std::string& path() const { return m_path; }

private:
    Napi::Value open(const Napi::CallbackInfo& info);
    Napi::Value openAsync(const Napi::CallbackInfo& info);
    Napi::Value isOpen(const Napi::CallbackInfo& info);
    Napi::Value close(const Napi::CallbackInfo& info);
    Napi::Value getInfo(const Napi::CallbackInfo& info);
    Napi::Value getObjects(const Napi::CallbackInfo& info);
    Napi::Value getMesh(const Napi::CallbackInfo& info);
    Napi::Value getProperties(const Napi::CallbackInfo& info);
    Napi::Value getProperty(const Napi::CallbackInfo& info);
    Napi::Value getUserProperties(const Napi::CallbackInfo& info);
    Napi::Value getTransform(const Napi::CallbackInfo& info);
    Napi::Value getCamera(const Napi::CallbackInfo& info);

    const abcjs::ArchiveData& requireData(Napi::Env env) const;

    std::string m_path;
    std::shared_ptr<abcjs::ArchiveData> m_data;
};

#endif // ABCARCHIVE_H
