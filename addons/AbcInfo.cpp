#include "AbcInfo.h"

#include <string>

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
      m_abcArchive(Alembic::AbcGeom::IArchive())
{
    auto env = info.Env();

    if (info.Length() == 1 && info[0].IsString()) {
        std::filesystem::path path(info[0].As<Napi::String>().Utf8Value());
        if (std::filesystem::exists(path) && path.extension() == ".abc") {
            loadAbcFile(path);
        } else {
            Napi::TypeError::New(env, "Abc file was not found or wrong extension.")
                .ThrowAsJavaScriptException();
            return;
        }
    }
}

Napi::Value AbcInfo::load(const Napi::CallbackInfo& info) {
    auto env = info.Env();

    if (info.Length() == 1 && info[0].IsString()) {
        std::filesystem::path path(info[0].As<Napi::String>().Utf8Value());
        if (std::filesystem::exists(path) && path.extension() == ".abc") {
            loadAbcFile(path);
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

void AbcInfo::loadAbcFile(const std::filesystem::path& path) {
    Alembic::AbcCoreFactory::IFactory factory;
    factory.setPolicy(Alembic::AbcGeom::ErrorHandler::kQuietNoopPolicy);
    auto archive = factory.getArchive(path.string());

    if (archive) {
        std::string appName;
        std::string libraryVersionString;
        Alembic::Util::uint32_t libraryVersion;
        std::string whenWritten;
        std::string userDescription;
        Alembic::AbcGeom::GetArchiveInfo(archive,
            appName,
            libraryVersionString,
            libraryVersion,
            whenWritten,
            userDescription
        );

        std::cout << "  file written by: " << appName << std::endl;
        std::cout << "  using Alembic : " << libraryVersionString << std::endl;
        std::cout << "  written on : " << whenWritten << std::endl;
        std::cout << "  user description : " << userDescription << std::endl;
        std::cout << std::endl;

        visitObject(archive.getTop(), "");
    }
}

Napi::Function AbcInfo::GetClass(Napi::Env env)
{
    return DefineClass(
        env,
        "AbcInfo",
        {
            AbcInfo::InstanceMethod("load", &AbcInfo::load)
        }
    );
}

