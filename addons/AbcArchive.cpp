#include "AbcArchive.h"
#include "AbcConvert.h"

#include <cmath>
#include <cstring>

using abcjs::AbcError;
namespace codes = abcjs::codes;

namespace {

[[noreturn]] void throwCoded(Napi::Env env, const std::string& code, const std::string& message)
{
    Napi::Error err = Napi::Error::New(env, message);
    err.Set("code", Napi::String::New(env, code));
    throw err;
}

// Runs fn and converts AbcError / std::exception into coded JS errors.
template <class Fn> Napi::Value translate(Napi::Env env, Fn&& fn)
{
    try {
        return fn();
    } catch (const Napi::Error&) {
        throw;
    } catch (const AbcError& e) {
        throwCoded(env, e.code(), e.what());
    } catch (const std::exception& e) {
        throwCoded(env, codes::ReadFailed, e.what());
    }
}

std::string requireObjectPath(const Napi::CallbackInfo& info)
{
    if (info.Length() < 1 || !info[0].IsString()) {
        throwCoded(info.Env(), codes::InvalidArgument, "Expected an object path string, e.g. '/Kettle/Circle'");
    }
    return info[0].As<Napi::String>().Utf8Value();
}

double optionalTime(const Napi::CallbackInfo& info, size_t index)
{
    if (info.Length() <= index || info[index].IsUndefined() || info[index].IsNull()) {
        return 0.0;
    }
    if (!info[index].IsNumber()) {
        throwCoded(info.Env(), codes::InvalidArgument, "Expected time to be a number (seconds)");
    }
    double time = info[index].As<Napi::Number>().DoubleValue();
    if (!std::isfinite(time)) {
        throwCoded(info.Env(), codes::InvalidArgument, "Expected time to be a finite number");
    }
    return time;
}

Napi::Array toArray(Napi::Env env, const abcjs::Matrix& m)
{
    Napi::Array arr = Napi::Array::New(env, m.size());
    for (uint32_t i = 0; i < m.size(); ++i)
        arr.Set(i, Napi::Number::New(env, m[i]));
    return arr;
}

// Parses getMesh's options object: { attributes?: string[] | '*', layout?: 'points' | 'corners' }.
abcjs::MeshOptions meshOptions(const Napi::CallbackInfo& info, size_t index)
{
    abcjs::MeshOptions options;
    if (info.Length() <= index || info[index].IsUndefined() || info[index].IsNull()) return options;
    if (!info[index].IsObject()) {
        throwCoded(info.Env(), codes::InvalidArgument, "Expected mesh options to be an object");
    }
    Napi::Object obj = info[index].As<Napi::Object>();
    Napi::Value attributes = obj.Get("attributes");
    if (attributes.IsString() && attributes.As<Napi::String>().Utf8Value() == "*") {
        options.allAttributes = true;
    } else if (attributes.IsArray()) {
        Napi::Array names = attributes.As<Napi::Array>();
        for (uint32_t i = 0; i < names.Length(); ++i) {
            Napi::Value name = names.Get(i);
            if (!name.IsString()) {
                throwCoded(info.Env(), codes::InvalidArgument, "Expected attribute names to be strings");
            }
            options.attributes.push_back(name.As<Napi::String>().Utf8Value());
        }
    } else if (!attributes.IsUndefined() && !attributes.IsNull()) {
        throwCoded(info.Env(), codes::InvalidArgument, "Expected attributes to be an array of names or '*'");
    }
    Napi::Value layout = obj.Get("layout");
    if (layout.IsString()) {
        const std::string value = layout.As<Napi::String>().Utf8Value();
        if (value != "points" && value != "corners") {
            throwCoded(info.Env(), codes::InvalidArgument, "Expected layout to be 'points' or 'corners'");
        }
        options.forceCorners = value == "corners";
    } else if (!layout.IsUndefined() && !layout.IsNull()) {
        throwCoded(info.Env(), codes::InvalidArgument, "Expected layout to be 'points' or 'corners'");
    }
    return options;
}

template <class TypedArrayT, class T> TypedArrayT toTypedArray(Napi::Env env, const std::vector<T>& values)
{
    // Copy into a JS-owned buffer so no native memory escapes to JavaScript.
    auto buffer = Napi::ArrayBuffer::New(env, values.size() * sizeof(T));
    if (!values.empty()) std::memcpy(buffer.Data(), values.data(), values.size() * sizeof(T));
    return TypedArrayT::New(env, values.size(), buffer, 0);
}

class OpenWorker : public Napi::AsyncWorker {
public:
    OpenWorker(Napi::Env env, Napi::Object self, std::string path)
        : Napi::AsyncWorker(env), m_deferred(Napi::Promise::Deferred::New(env)), m_self(Napi::Persistent(self)),
          m_path(std::move(path))
    {
    }

    Napi::Promise promise() const { return m_deferred.Promise(); }

    void Execute() override
    {
        try {
            m_data = abcjs::OpenArchive(m_path);
        } catch (const AbcError& e) {
            m_code = e.code();
            SetError(e.what());
        } catch (const std::exception& e) {
            m_code = codes::ReadFailed;
            SetError(e.what());
        }
    }

    void OnOK() override
    {
        AbcArchive::Unwrap(m_self.Value())->setData(m_data);
        m_deferred.Resolve(Env().Undefined());
    }

    void OnError(const Napi::Error& error) override
    {
        Napi::Error err = Napi::Error::New(Env(), error.Message());
        err.Set("code", Napi::String::New(Env(), m_code));
        m_deferred.Reject(err.Value());
    }

private:
    Napi::Promise::Deferred m_deferred;
    Napi::ObjectReference m_self;
    std::string m_path;
    std::string m_code;
    std::shared_ptr<abcjs::ArchiveData> m_data;
};

} // namespace

AbcArchive::AbcArchive(const Napi::CallbackInfo& info) : Napi::ObjectWrap<AbcArchive>(info)
{
    if (info.Length() != 1 || !info[0].IsString()) {
        throwCoded(info.Env(), codes::InvalidArgument, "AbcArchive expects a single file path string");
    }
    m_path = info[0].As<Napi::String>().Utf8Value();
}

const abcjs::ArchiveData& AbcArchive::requireData(Napi::Env env) const
{
    if (!m_data) {
        throwCoded(env, codes::NotLoaded, "Archive '" + m_path + "' is not loaded; call load() first");
    }
    return *m_data;
}

Napi::Value AbcArchive::open(const Napi::CallbackInfo& info)
{
    return translate(info.Env(), [&]() -> Napi::Value {
        m_data = abcjs::OpenArchive(m_path);
        return info.Env().Undefined();
    });
}

Napi::Value AbcArchive::openAsync(const Napi::CallbackInfo& info)
{
    auto* worker = new OpenWorker(info.Env(), info.This().As<Napi::Object>(), m_path);
    auto promise = worker->promise();
    worker->Queue();
    return promise;
}

Napi::Value AbcArchive::isOpen(const Napi::CallbackInfo& info)
{
    return Napi::Boolean::New(info.Env(), static_cast<bool>(m_data));
}

Napi::Value AbcArchive::close(const Napi::CallbackInfo& info)
{
    m_data.reset(); // releases the IArchive and its file handle
    return info.Env().Undefined();
}

Napi::Value AbcArchive::getInfo(const Napi::CallbackInfo& info)
{
    auto env = info.Env();
    const auto& data = requireData(env);
    Napi::Object out = Napi::Object::New(env);
    out.Set("path", data.path);
    out.Set("coreType", data.coreType);
    out.Set("appName", data.appName);
    out.Set("libraryVersion", Napi::Number::New(env, data.libraryVersion));
    out.Set("libraryVersionString", data.libraryVersionString);
    out.Set("archiveVersion", Napi::Number::New(env, data.archiveVersion));
    out.Set("whenWritten", data.whenWritten);
    out.Set("userDescription", data.userDescription);
    out.Set("objectCount", Napi::Number::New(env, static_cast<double>(data.objects.size())));
    out.Set("hasAnimation", Napi::Boolean::New(env, data.hasAnimation));
    out.Set("startTime", Napi::Number::New(env, data.startTime));
    out.Set("endTime", Napi::Number::New(env, data.endTime));
    return out;
}

Napi::Value AbcArchive::getObjects(const Napi::CallbackInfo& info)
{
    auto env = info.Env();
    const auto& data = requireData(env);
    Napi::Array result = Napi::Array::New(env, data.objects.size());
    for (uint32_t i = 0; i < data.objects.size(); ++i) {
        const auto& rec = data.objects[i];
        Napi::Object obj = Napi::Object::New(env);
        obj.Set("name", rec.name);
        obj.Set("path", rec.path);
        if (!rec.parent.empty()) obj.Set("parent", rec.parent);
        Napi::Array children = Napi::Array::New(env, rec.children.size());
        for (uint32_t c = 0; c < rec.children.size(); ++c)
            children.Set(c, rec.children[c]);
        obj.Set("children", children);
        obj.Set("type", rec.type);
        obj.Set("schema", rec.schema);
        obj.Set("numSamples", Napi::Number::New(env, static_cast<double>(rec.numSamples)));
        obj.Set("animated", Napi::Boolean::New(env, rec.animated));
        result.Set(i, obj);
    }
    return result;
}

Napi::Value AbcArchive::getMesh(const Napi::CallbackInfo& info)
{
    auto env = info.Env();
    const auto& data = requireData(env);
    const std::string objectPath = requireObjectPath(info);
    const double time = optionalTime(info, 1);
    const abcjs::MeshOptions options = meshOptions(info, 2);
    return translate(env, [&]() -> Napi::Value {
        abcjs::MeshData mesh = abcjs::ReadMesh(data, objectPath, time, options);
        Napi::Object out = Napi::Object::New(env);
        out.Set("name", mesh.name);
        out.Set("path", mesh.path);
        out.Set("type", mesh.type);
        out.Set("layout", mesh.layout);
        out.Set("positions", toTypedArray<Napi::Float32Array>(env, mesh.positions));
        if (!mesh.normals.empty()) out.Set("normals", toTypedArray<Napi::Float32Array>(env, mesh.normals));
        if (!mesh.uvs.empty()) out.Set("uvs", toTypedArray<Napi::Float32Array>(env, mesh.uvs));
        out.Set("indices", toTypedArray<Napi::Uint32Array>(env, mesh.indices));
        out.Set("faceCount", Napi::Number::New(env, static_cast<double>(mesh.faceCount)));
        out.Set("transform", toArray(env, mesh.transform));
        if (!mesh.attributes.empty()) {
            Napi::Object attributes = Napi::Object::New(env);
            for (const auto& attribute : mesh.attributes) {
                attributes.Set(attribute.name, abcjs::MeshAttributeToJs(env, attribute));
            }
            out.Set("attributes", attributes);
        }
        return out;
    });
}

Napi::Value AbcArchive::getProperties(const Napi::CallbackInfo& info)
{
    auto env = info.Env();
    const auto& data = requireData(env);
    const std::string objectPath = requireObjectPath(info);
    std::string root;
    if (info.Length() > 1 && info[1].IsString()) root = info[1].As<Napi::String>().Utf8Value();
    const bool recursive = info.Length() > 2 && info[2].ToBoolean().Value();
    const double time = optionalTime(info, 3);
    return translate(env, [&]() -> Napi::Value {
        return abcjs::PropertyInfosToJs(env, abcjs::ListProperties(data, objectPath, root, recursive, time));
    });
}

Napi::Value AbcArchive::getProperty(const Napi::CallbackInfo& info)
{
    auto env = info.Env();
    const auto& data = requireData(env);
    const std::string objectPath = requireObjectPath(info);
    if (info.Length() < 2 || !info[1].IsString()) {
        throwCoded(env, codes::InvalidArgument, "Expected a property path string, e.g. '.arbGeomParams/Cd'");
    }
    const std::string propertyPath = info[1].As<Napi::String>().Utf8Value();
    const double time = optionalTime(info, 2);
    const bool expand = info.Length() <= 3 || info[3].IsUndefined() || info[3].ToBoolean().Value();
    return translate(env, [&]() -> Napi::Value {
        return abcjs::PropertyValueToJs(env, abcjs::ReadProperty(data, objectPath, propertyPath, time, expand));
    });
}

Napi::Value AbcArchive::getUserProperties(const Napi::CallbackInfo& info)
{
    auto env = info.Env();
    const auto& data = requireData(env);
    const std::string objectPath = requireObjectPath(info);
    const double time = optionalTime(info, 1);
    return translate(env, [&]() -> Napi::Value {
        return abcjs::UserPropertiesToJs(env, abcjs::ReadUserProperties(data, objectPath, time));
    });
}

Napi::Value AbcArchive::getTransform(const Napi::CallbackInfo& info)
{
    auto env = info.Env();
    const auto& data = requireData(env);
    const std::string objectPath = requireObjectPath(info);
    const double time = optionalTime(info, 1);
    return translate(env, [&]() -> Napi::Value {
        abcjs::TransformData xf = abcjs::ReadTransform(data, objectPath, time);
        Napi::Object out = Napi::Object::New(env);
        out.Set("path", xf.path);
        out.Set("local", toArray(env, xf.local));
        out.Set("world", toArray(env, xf.world));
        out.Set("inheritsTransform", Napi::Boolean::New(env, xf.inheritsTransform));
        out.Set("animated", Napi::Boolean::New(env, xf.animated));
        return out;
    });
}

Napi::Value AbcArchive::getCamera(const Napi::CallbackInfo& info)
{
    auto env = info.Env();
    const auto& data = requireData(env);
    const std::string objectPath = requireObjectPath(info);
    const double time = optionalTime(info, 1);
    return translate(env, [&]() -> Napi::Value {
        abcjs::CameraData cam = abcjs::ReadCamera(data, objectPath, time);
        Napi::Object out = Napi::Object::New(env);
        out.Set("name", cam.name);
        out.Set("path", cam.path);
        out.Set("focalLength", Napi::Number::New(env, cam.focalLength));
        out.Set("horizontalAperture", Napi::Number::New(env, cam.horizontalAperture));
        out.Set("verticalAperture", Napi::Number::New(env, cam.verticalAperture));
        out.Set("near", Napi::Number::New(env, cam.nearClip));
        out.Set("far", Napi::Number::New(env, cam.farClip));
        out.Set("fov", Napi::Number::New(env, cam.fov));
        out.Set("aspect", Napi::Number::New(env, cam.aspect));
        out.Set("transform", toArray(env, cam.transform));
        return out;
    });
}

Napi::Function AbcArchive::GetClass(Napi::Env env)
{
    return DefineClass(env, "AbcArchive",
                       {
                           InstanceMethod("open", &AbcArchive::open),
                           InstanceMethod("openAsync", &AbcArchive::openAsync),
                           InstanceMethod("isOpen", &AbcArchive::isOpen),
                           InstanceMethod("close", &AbcArchive::close),
                           InstanceMethod("getInfo", &AbcArchive::getInfo),
                           InstanceMethod("getObjects", &AbcArchive::getObjects),
                           InstanceMethod("getMesh", &AbcArchive::getMesh),
                           InstanceMethod("getTransform", &AbcArchive::getTransform),
                           InstanceMethod("getCamera", &AbcArchive::getCamera),
                           InstanceMethod("getProperties", &AbcArchive::getProperties),
                           InstanceMethod("getProperty", &AbcArchive::getProperty),
                           InstanceMethod("getUserProperties", &AbcArchive::getUserProperties),
                       });
}
