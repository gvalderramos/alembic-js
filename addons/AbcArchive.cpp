#include "AbcArchive.h"
#include "AbcConvert.h"
#include "AbcMaterials.h"

#include <cmath>
#include <cstring>
#include <functional>

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
    options.groupByFaceSet = obj.Get("groupByFaceSet").ToBoolean().Value();
    options.triangleToFace = obj.Get("triangleToFace").ToBoolean().Value();
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

// Parses the time and sample options ({ mode, useVelocities, velocityScale }) of a reader call.
abcjs::SampleSpec sampleSpec(const Napi::CallbackInfo& info, size_t timeIndex, size_t optionsIndex)
{
    abcjs::SampleSpec spec = abcjs::SampleSpec::at(optionalTime(info, timeIndex));
    if (info.Length() <= optionsIndex || !info[optionsIndex].IsObject()) return spec;
    Napi::Object obj = info[optionsIndex].As<Napi::Object>();
    Napi::Value mode = obj.Get("mode");
    if (mode.IsString()) {
        const std::string value = mode.As<Napi::String>().Utf8Value();
        if (value == "near") {
            spec.mode = abcjs::SampleSpec::Mode::Near;
        } else if (value == "floor") {
            spec.mode = abcjs::SampleSpec::Mode::Floor;
        } else if (value == "interpolate") {
            spec.mode = abcjs::SampleSpec::Mode::Interpolate;
        } else {
            throwCoded(info.Env(), codes::InvalidArgument, "Expected mode to be 'near', 'floor' or 'interpolate'");
        }
    } else if (!mode.IsUndefined() && !mode.IsNull()) {
        throwCoded(info.Env(), codes::InvalidArgument, "Expected mode to be 'near', 'floor' or 'interpolate'");
    }
    Napi::Value useVelocities = obj.Get("useVelocities");
    if (!useVelocities.IsUndefined() && !useVelocities.IsNull()) spec.useVelocities = useVelocities.ToBoolean();
    Napi::Value scale = obj.Get("velocityScale");
    if (scale.IsNumber()) {
        spec.velocityScale = scale.As<Napi::Number>().DoubleValue();
        if (!std::isfinite(spec.velocityScale)) {
            throwCoded(info.Env(), codes::InvalidArgument, "Expected velocityScale to be a finite number");
        }
    } else if (!scale.IsUndefined() && !scale.IsNull()) {
        throwCoded(info.Env(), codes::InvalidArgument, "Expected velocityScale to be a number");
    }
    return spec;
}

template <class TypedArrayT, class T> TypedArrayT toTypedArray(Napi::Env env, const std::vector<T>& values)
{
    // Copy into a JS-owned buffer so no native memory escapes to JavaScript.
    auto buffer = Napi::ArrayBuffer::New(env, values.size() * sizeof(T));
    if (!values.empty()) std::memcpy(buffer.Data(), values.data(), values.size() * sizeof(T));
    return TypedArrayT::New(env, values.size(), buffer, 0);
}

Napi::Value meshToJs(Napi::Env env, const abcjs::MeshData& mesh, bool withTopology)
{
    Napi::Object out = Napi::Object::New(env);
    out.Set("name", mesh.name);
    out.Set("path", mesh.path);
    out.Set("type", mesh.type);
    out.Set("layout", mesh.layout);
    out.Set("positions", toTypedArray<Napi::Float32Array>(env, mesh.positions));
    if (!mesh.normals.empty()) out.Set("normals", toTypedArray<Napi::Float32Array>(env, mesh.normals));
    if (withTopology) {
        if (!mesh.uvs.empty()) out.Set("uvs", toTypedArray<Napi::Float32Array>(env, mesh.uvs));
        out.Set("indices", toTypedArray<Napi::Uint32Array>(env, mesh.indices));
        out.Set("faceCount", Napi::Number::New(env, static_cast<double>(mesh.faceCount)));
    }
    out.Set("transform", toArray(env, mesh.transform));
    out.Set("sampleTime", Napi::Number::New(env, mesh.sampleTime));
    if (withTopology && !mesh.groups.empty()) {
        Napi::Array groups = Napi::Array::New(env, mesh.groups.size());
        for (uint32_t i = 0; i < mesh.groups.size(); ++i) {
            const auto& g = mesh.groups[i];
            Napi::Object group = Napi::Object::New(env);
            group.Set("start", Napi::Number::New(env, static_cast<double>(g.start)));
            group.Set("count", Napi::Number::New(env, static_cast<double>(g.count)));
            if (!g.faceSet.empty()) group.Set("faceSet", g.faceSet);
            group.Set("materialIndex", Napi::Number::New(env, static_cast<double>(g.materialIndex)));
            groups.Set(i, group);
        }
        out.Set("groups", groups);
        Napi::Array slots = Napi::Array::New(env, mesh.materialSlots.size());
        for (uint32_t i = 0; i < mesh.materialSlots.size(); ++i) {
            const auto& m = mesh.materialSlots[i];
            Napi::Object slot = Napi::Object::New(env);
            slot.Set("name", m.name);
            if (!m.faceSet.empty()) slot.Set("faceSet", m.faceSet);
            if (!m.materialPath.empty()) slot.Set("materialPath", m.materialPath);
            slots.Set(i, slot);
        }
        out.Set("materialSlots", slots);
        if (mesh.faceSetsOverlap) out.Set("faceSetsOverlap", Napi::Boolean::New(env, true));
    }
    if (withTopology && !mesh.triangleToFace.empty()) {
        out.Set("triangleToFace", toTypedArray<Napi::Uint32Array>(env, mesh.triangleToFace));
    }
    out.Set("interpolated", Napi::Boolean::New(env, mesh.interpolated));
    if (!mesh.attributes.empty()) {
        Napi::Object attributes = Napi::Object::New(env);
        for (const auto& attribute : mesh.attributes) {
            attributes.Set(attribute.name, abcjs::MeshAttributeToJs(env, attribute));
        }
        out.Set("attributes", attributes);
    }
    return out;
}

// Runs a read on a worker thread and resolves a promise with its JS conversion.
// It keeps the archive alive, so close() during the read is safe.
template <class Result> class ReadWorker : public Napi::AsyncWorker {
public:
    using Read = std::function<Result()>;
    using Convert = std::function<Napi::Value(Napi::Env, const Result&)>;

    ReadWorker(Napi::Env env, std::shared_ptr<abcjs::ArchiveData> keepAlive, Read read, Convert convert)
        : Napi::AsyncWorker(env), m_deferred(Napi::Promise::Deferred::New(env)), m_keepAlive(std::move(keepAlive)),
          m_read(std::move(read)), m_convert(std::move(convert))
    {
    }

    Napi::Promise promise() const { return m_deferred.Promise(); }

    void Execute() override
    {
        try {
            m_result = m_read();
        } catch (const AbcError& e) {
            m_code = e.code();
            SetError(e.what());
        } catch (const std::exception& e) {
            m_code = codes::ReadFailed;
            SetError(e.what());
        }
    }

    void OnOK() override { m_deferred.Resolve(m_convert(Env(), m_result)); }

    void OnError(const Napi::Error& error) override
    {
        Napi::Error err = Napi::Error::New(Env(), error.Message());
        err.Set("code", Napi::String::New(Env(), m_code));
        m_deferred.Reject(err.Value());
    }

private:
    Napi::Promise::Deferred m_deferred;
    std::shared_ptr<abcjs::ArchiveData> m_keepAlive;
    Read m_read;
    Convert m_convert;
    Result m_result;
    std::string m_code;
};

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
    if (data.fps > 0.0) out.Set("fps", Napi::Number::New(env, data.fps));
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
        if (rec.timeSampling.valid) {
            const auto& ts = rec.timeSampling;
            Napi::Object sampling = Napi::Object::New(env);
            sampling.Set("kind", ts.kind);
            sampling.Set("startTime", Napi::Number::New(env, ts.startTime));
            if (ts.timePerCycle > 0.0) {
                sampling.Set("timePerCycle", Napi::Number::New(env, ts.timePerCycle));
                if (ts.kind == "uniform") sampling.Set("fps", Napi::Number::New(env, 1.0 / ts.timePerCycle));
            }
            sampling.Set("sampleTimes", abcjs::ToTypedArray(env, ts.sampleTimes));
            obj.Set("timeSampling", sampling);
        }
        if (!rec.topology.empty()) obj.Set("topology", rec.topology);
        result.Set(i, obj);
    }
    return result;
}

Napi::Value AbcArchive::getMesh(const Napi::CallbackInfo& info)
{
    auto env = info.Env();
    const auto& data = requireData(env);
    const std::string objectPath = requireObjectPath(info);
    const abcjs::SampleSpec spec = sampleSpec(info, 1, 2);
    const abcjs::MeshOptions options = meshOptions(info, 2);
    return translate(
        env, [&]() -> Napi::Value { return meshToJs(env, abcjs::ReadMesh(data, objectPath, spec, options), true); });
}

Napi::Value AbcArchive::getMeshFrame(const Napi::CallbackInfo& info)
{
    auto env = info.Env();
    const auto& data = requireData(env);
    const std::string objectPath = requireObjectPath(info);
    const abcjs::SampleSpec spec = sampleSpec(info, 1, 2);
    const abcjs::MeshOptions options = meshOptions(info, 2);
    return translate(env, [&]() -> Napi::Value {
        return meshToJs(env, abcjs::ReadMeshFrame(data, objectPath, spec, options), false);
    });
}

Napi::Value AbcArchive::queueMeshRead(const Napi::CallbackInfo& info, bool withTopology)
{
    auto env = info.Env();
    requireData(env);
    std::shared_ptr<abcjs::ArchiveData> data = m_data;
    const std::string objectPath = requireObjectPath(info);
    const abcjs::SampleSpec spec = sampleSpec(info, 1, 2);
    const abcjs::MeshOptions options = meshOptions(info, 2);
    auto* worker = new ReadWorker<abcjs::MeshData>(
        env, data,
        [data, objectPath, spec, options, withTopology] {
            return withTopology ? abcjs::ReadMesh(*data, objectPath, spec, options)
                                : abcjs::ReadMeshFrame(*data, objectPath, spec, options);
        },
        [withTopology](Napi::Env e, const abcjs::MeshData& mesh) { return meshToJs(e, mesh, withTopology); });
    auto promise = worker->promise();
    worker->Queue();
    return promise;
}

Napi::Value AbcArchive::getMeshAsync(const Napi::CallbackInfo& info)
{
    return queueMeshRead(info, true);
}

Napi::Value AbcArchive::getMeshFrameAsync(const Napi::CallbackInfo& info)
{
    return queueMeshRead(info, false);
}

Napi::Value AbcArchive::getPoints(const Napi::CallbackInfo& info)
{
    auto env = info.Env();
    const auto& data = requireData(env);
    const std::string objectPath = requireObjectPath(info);
    const abcjs::SampleSpec spec = sampleSpec(info, 1, 2);
    return translate(env, [&]() -> Napi::Value {
        abcjs::PointsData points = abcjs::ReadPoints(data, objectPath, spec);
        Napi::Object out = Napi::Object::New(env);
        out.Set("name", points.name);
        out.Set("path", points.path);
        out.Set("type", "points");
        out.Set("count", Napi::Number::New(env, static_cast<double>(points.positions.size() / 3)));
        out.Set("positions", abcjs::ToTypedArray(env, points.positions));
        if (points.hasIds) out.Set("ids", abcjs::ToTypedArray(env, points.ids));
        if (!points.velocities.empty()) out.Set("velocities", abcjs::ToTypedArray(env, points.velocities));
        if (!points.widths.empty()) {
            out.Set("widths", abcjs::ToTypedArray(env, points.widths));
            out.Set("widthScope", points.widthScope);
        }
        out.Set("transform", toArray(env, points.transform));
        return out;
    });
}

Napi::Value AbcArchive::getCurves(const Napi::CallbackInfo& info)
{
    auto env = info.Env();
    const auto& data = requireData(env);
    const std::string objectPath = requireObjectPath(info);
    const abcjs::SampleSpec spec = sampleSpec(info, 1, 2);
    return translate(env, [&]() -> Napi::Value {
        abcjs::CurvesData curves = abcjs::ReadCurves(data, objectPath, spec);
        Napi::Object out = Napi::Object::New(env);
        out.Set("name", curves.name);
        out.Set("path", curves.path);
        out.Set("type", "curves");
        out.Set("positions", abcjs::ToTypedArray(env, curves.positions));
        out.Set("vertexCounts", abcjs::ToTypedArray(env, curves.vertexCounts));
        out.Set("curveCount", Napi::Number::New(env, static_cast<double>(curves.vertexCounts.size())));
        out.Set("curveType", curves.curveType);
        out.Set("periodic", Napi::Boolean::New(env, curves.periodic));
        out.Set("basis", curves.basis);
        if (!curves.orders.empty()) out.Set("orders", abcjs::ToTypedArray(env, curves.orders));
        if (!curves.knots.empty()) out.Set("knots", abcjs::ToTypedArray(env, curves.knots));
        if (!curves.weights.empty()) out.Set("weights", abcjs::ToTypedArray(env, curves.weights));
        if (!curves.widths.empty()) {
            out.Set("widths", abcjs::ToTypedArray(env, curves.widths));
            out.Set("widthScope", curves.widthScope);
        }
        if (!curves.uvs.empty()) out.Set("uvs", abcjs::ToTypedArray(env, curves.uvs));
        if (!curves.normals.empty()) out.Set("normals", abcjs::ToTypedArray(env, curves.normals));
        if (!curves.velocities.empty()) out.Set("velocities", abcjs::ToTypedArray(env, curves.velocities));
        out.Set("transform", toArray(env, curves.transform));
        return out;
    });
}

Napi::Value AbcArchive::getFaceSets(const Napi::CallbackInfo& info)
{
    auto env = info.Env();
    const auto& data = requireData(env);
    const std::string objectPath = requireObjectPath(info);
    const abcjs::SampleSpec spec = sampleSpec(info, 1, 2);
    return translate(env, [&]() -> Napi::Value {
        const auto sets = abcjs::ReadFaceSets(data, objectPath, spec);
        Napi::Array out = Napi::Array::New(env, sets.size());
        for (uint32_t i = 0; i < sets.size(); ++i) {
            Napi::Object set = Napi::Object::New(env);
            set.Set("name", sets[i].name);
            set.Set("path", sets[i].path);
            set.Set("faces", abcjs::ToTypedArray(env, sets[i].faces));
            set.Set("exclusive", Napi::Boolean::New(env, sets[i].exclusive));
            if (!sets[i].materialPath.empty()) set.Set("materialPath", sets[i].materialPath);
            out.Set(i, set);
        }
        return out;
    });
}

Napi::Value AbcArchive::getMaterialAssignment(const Napi::CallbackInfo& info)
{
    auto env = info.Env();
    const auto& data = requireData(env);
    const std::string objectPath = requireObjectPath(info);
    return translate(env, [&]() -> Napi::Value {
        const std::string path = abcjs::ReadMaterialAssignment(data, objectPath);
        return path.empty() ? env.Null() : Napi::String::New(env, path);
    });
}

Napi::Value AbcArchive::getMaterial(const Napi::CallbackInfo& info)
{
    auto env = info.Env();
    const auto& data = requireData(env);
    const std::string objectPath = requireObjectPath(info);
    return translate(env, [&]() -> Napi::Value {
        const abcjs::MaterialData material = abcjs::ReadMaterial(data, objectPath);
        Napi::Object out = Napi::Object::New(env);
        out.Set("name", material.name);
        out.Set("path", material.path);
        Napi::Array targets = Napi::Array::New(env, material.targets.size());
        for (uint32_t i = 0; i < material.targets.size(); ++i)
            targets.Set(i, material.targets[i]);
        out.Set("targets", targets);
        Napi::Array shaders = Napi::Array::New(env, material.shaders.size());
        Napi::Object parameters = Napi::Object::New(env);
        for (uint32_t i = 0; i < material.shaders.size(); ++i) {
            const auto& shader = material.shaders[i];
            Napi::Object s = Napi::Object::New(env);
            s.Set("target", shader.target);
            s.Set("shaderType", shader.shaderType);
            s.Set("shaderName", shader.shaderName);
            shaders.Set(i, s);
            Napi::Object params = Napi::Object::New(env);
            for (const auto& [name, value] : shader.parameters)
                params.Set(name, abcjs::UserValueToJs(env, value));
            parameters.Set(shader.target + "." + shader.shaderType, params);
        }
        out.Set("shaders", shaders);
        out.Set("parameters", parameters);
        if (!material.network.empty()) {
            Napi::Array nodes = Napi::Array::New(env, material.network.size());
            for (uint32_t i = 0; i < material.network.size(); ++i) {
                const auto& node = material.network[i];
                Napi::Object n = Napi::Object::New(env);
                n.Set("name", node.name);
                n.Set("target", node.target);
                n.Set("nodeType", node.nodeType);
                Napi::Object connections = Napi::Object::New(env);
                for (const auto& [input, source] : node.connections)
                    connections.Set(input, source);
                n.Set("connections", connections);
                nodes.Set(i, n);
            }
            out.Set("network", nodes);
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
    const abcjs::SampleSpec spec = sampleSpec(info, 1, 2);
    return translate(env, [&]() -> Napi::Value {
        abcjs::TransformData xf = abcjs::ReadTransform(data, objectPath, spec);
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
    const abcjs::SampleSpec spec = sampleSpec(info, 1, 2);
    return translate(env, [&]() -> Napi::Value {
        abcjs::CameraData cam = abcjs::ReadCamera(data, objectPath, spec);
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
                           InstanceMethod("getMeshFrame", &AbcArchive::getMeshFrame),
                           InstanceMethod("getMeshAsync", &AbcArchive::getMeshAsync),
                           InstanceMethod("getMeshFrameAsync", &AbcArchive::getMeshFrameAsync),
                           InstanceMethod("getTransform", &AbcArchive::getTransform),
                           InstanceMethod("getCamera", &AbcArchive::getCamera),
                           InstanceMethod("getPoints", &AbcArchive::getPoints),
                           InstanceMethod("getCurves", &AbcArchive::getCurves),
                           InstanceMethod("getFaceSets", &AbcArchive::getFaceSets),
                           InstanceMethod("getMaterialAssignment", &AbcArchive::getMaterialAssignment),
                           InstanceMethod("getMaterial", &AbcArchive::getMaterial),
                           InstanceMethod("getProperties", &AbcArchive::getProperties),
                           InstanceMethod("getProperty", &AbcArchive::getProperty),
                           InstanceMethod("getUserProperties", &AbcArchive::getUserProperties),
                       });
}
