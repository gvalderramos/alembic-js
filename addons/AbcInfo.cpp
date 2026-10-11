#include "AbcInfo.h"

#include <string>
#include <vector>
#include <thread>

struct ObjectInfo {
    std::string name;
    std::string type;
    std::vector<ObjectInfo> children;
};

struct PropertyInfo {
    std::string name;
    std::string type;
    std::string value;
};

void visitObject(Alembic::AbcGeom::IObject iObj, std::string iIndent, std::vector<ObjectInfo>& objects) {
    ObjectInfo obj;
    obj.name = iObj.getFullName();
    obj.type = "Object";
    
    // Get the properties
    Alembic::AbcGeom::ICompoundProperty props = iObj.getProperties();
    std::vector<PropertyInfo> propsData;
    
    // Add properties
    for (size_t i = 0; i < props.getNumChildren(); i++) {
        Alembic::Abc::IProperty iprop = props.getChild(i);
        PropertyInfo prop;
        prop.name = iprop.getName();
        prop.type = iprop.getType().getName();
        if (iprop.isScalar()) {
            prop.value = "Scalar";
        } else if (iprop.isArray()) {
            prop.value = "Array";
        } else {
            prop.value = "Compound";
        }
        propsData.push_back(prop);
    }
    
    // Add to objects vector
    objects.push_back(obj);

    // Visit children
    for (size_t i = 0; i < iObj.getNumChildren(); i++) {
        visitObject(iObj.getChild(i), iIndent + "  ", objects);
    }
}

AbcInfo::AbcInfo(const Napi::CallbackInfo& info) 
    : Napi::ObjectWrap<AbcInfo>(info),
      m_appName(""),
      m_libraryVersionString(""),
      m_libraryVersion(0),
      m_whenWritten(""),
      m_userDescription(""),
      m_objects {},
      m_properties {}
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

Napi::Value AbcInfo::getObjects(const Napi::CallbackInfo& info) {
    auto env = info.Env();
    Napi::Array result = Napi::Array::New(env);
    
    for (size_t i = 0; i < m_objects.size(); i++) {
        auto& obj = m_objects[i];
        Napi::Object objJs = Napi::Object::New(env);
        objJs.Set("name", Napi::String::New(env, obj.name));
        objJs.Set("type", Napi::String::New(env, obj.type));
        result.Set(i, objJs);
    }
    
    return result;
}

Napi::Value AbcInfo::getProperties(const Napi::CallbackInfo& info) {
    auto env = info.Env();
    Napi::Array result = Napi::Array::New(env);
    
    for (size_t i = 0; i < m_properties.size(); i++) {
        auto& prop = m_properties[i];
        Napi::Object propJs = Napi::Object::New(env);
        propJs.Set("name", Napi::String::New(env, prop.name));
        propJs.Set("type", Napi::String::New(env, prop.type));
        propJs.Set("value", Napi::String::New(env, prop.value));
        result.Set(i, propJs);
    }
    
    return result;
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

            std::vector<ObjectInfo> objects;
            visitObject(archive.getTop(), "", objects);
            m_objects = objects;

            // You might want to collect properties here as well
            // This is just a basic example
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
            AbcInfo::InstanceMethod("getObjects", &AbcInfo::getObjects),
            AbcInfo::InstanceMethod("getProperties", &AbcInfo::getProperties),
        }
    );
}
