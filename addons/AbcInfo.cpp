#include "AbcInfo.h"

#include <string>
#include <thread>

void visitObject( Alembic::AbcGeom::IObject iObj,
                  std::string iIndent )
{
    // Object has a name, a full name, some meta data,
    // and then it has a compound property full of properties.
    std::string path = iObj.getFullName();

    if ( path != "/" )
    {
        std::cout << "Object " << "name=" << path << std::endl;
    }

    // Get the properties.
    // ICompoundProperty props = iObj.getProperties();
    // visitProperties( props, iIndent );

    // now the child objects
    for ( size_t i = 0 ; i < iObj.getNumChildren() ; i++ )
    {
        visitObject( Alembic::AbcGeom::IObject( iObj, iObj.getChildHeader( i ).getName() ),
                     iIndent );
    }
}

AbcInfo::AbcInfo(const Napi::CallbackInfo& info) 
    : Napi::ObjectWrap<AbcInfo>(info),
      m_appName(""),
      m_libraryVersionString(""),
      m_libraryVersion(0),
      m_whenWritten(""),
      m_userDescription("")
{
    auto env = info.Env();

    if (info.Length() > 0) {
        Napi::TypeError::New(env, "Wrong number of arguments.")
            .ThrowAsJavaScriptException();
        return;
    }
}

Napi::Value AbcInfo::load(const Napi::CallbackInfo& info) {
    auto env = info.Env();

    if (info.Length() == 1 && info[0].IsString()) {
        std::filesystem::path path(info[0].As<Napi::String>().Utf8Value());
        if (std::filesystem::exists(path) && path.extension() == ".abc") {
            return loadAbcFile(path, info);
        } else {
            Napi::TypeError::New(env, "Abc file was not found or wrong extension.")
                .ThrowAsJavaScriptException();
            return env.Null();
        }
    } else {
        Napi::TypeError::New(env, "Should point the ABC file path.")
            .ThrowAsJavaScriptException();
            return env.Null();
    }

    return env.Null();
}

Napi::Value AbcInfo::appName(const Napi::CallbackInfo &info)
{
    auto env = info.Env();
    return Napi::String::New(env, m_appName);
}

Napi::Value AbcInfo::libraryVersionString(const Napi::CallbackInfo &info)
{
    auto env = info.Env();
    return Napi::String::New(env, m_libraryVersionString);
}

Napi::Value AbcInfo::libraryVersion(const Napi::CallbackInfo &info)
{
    auto env = info.Env();
    return Napi::Number::New(env, m_libraryVersion);
}

Napi::Value AbcInfo::whenWritten(const Napi::CallbackInfo &info)
{
    auto env = info.Env();
    return Napi::String::New(env, m_whenWritten);
}

Napi::Value AbcInfo::userDescription(const Napi::CallbackInfo &info)
{
    auto env = info.Env();
    return Napi::String::New(env, m_userDescription);
}

Napi::Value AbcInfo::loadAbcFile(const std::filesystem::path& path, const Napi::CallbackInfo& info) {
    auto env = info.Env();
    auto deferred = Napi::Promise::Deferred::New(env);

    auto tsfn = Napi::ThreadSafeFunction::New(
        env,
        Napi::Function::New(env, [](const Napi::CallbackInfo&) {}), // dummy JS callback
        "ResolvePromise",
        0, 1
    );

    std::thread([this, path, deferred, tsfn]() {
        Alembic::AbcCoreFactory::IFactory factory;
        factory.setPolicy(Alembic::AbcGeom::ErrorHandler::kQuietNoopPolicy);
        auto archive = factory.getArchive(path.string());
    
        if (archive) {
            Alembic::AbcGeom::GetArchiveInfo(archive,
                m_appName,
                m_libraryVersionString,
                m_libraryVersion,
                m_whenWritten,
                m_userDescription
            );
    
            std::cout << "  file written by: " << m_appName << std::endl;
            std::cout << "  using Alembic : " << m_libraryVersionString << std::endl;
            std::cout << "  written on : " << m_whenWritten << std::endl;
            std::cout << "  user description : " << m_userDescription << std::endl;
            std::cout << std::endl;
    
            visitObject(archive.getTop(), "");
            tsfn.BlockingCall([deferred](Napi::Env env, Napi::Function /* jsCallback */) {
                deferred.Resolve(Napi::String::New(env, "Loaded successfully"));
            });
        } else {
            tsfn.BlockingCall([deferred](Napi::Env env, Napi::Function /* jsCallback */) {
                deferred.Reject(Napi::String::New(env, "Failed to load Alembic file"));
            });
        }

        tsfn.Release();
    }).detach();

    return deferred.Promise();
}

Napi::Function AbcInfo::GetClass(Napi::Env env)
{
    return DefineClass(
        env,
        "AbcInfo",
        {
            AbcInfo::InstanceMethod("load", &AbcInfo::load),
            AbcInfo::InstanceMethod("appName", &AbcInfo::appName),
            AbcInfo::InstanceMethod("libraryVersionString", &AbcInfo::libraryVersionString),
            AbcInfo::InstanceMethod("libraryVersion", &AbcInfo::libraryVersion),
            AbcInfo::InstanceMethod("whenWritten", &AbcInfo::whenWritten),
            AbcInfo::InstanceMethod("userDescription", &AbcInfo::userDescription),
        }
    );
}

