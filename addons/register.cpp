#include "AbcInfo.h"

#include <napi.h>

Napi::Object Init(Napi::Env env, Napi::Object exports)
{
    Napi::String abcInfoClass = Napi::String::New(env, "AbcInfo");
    exports.Set(abcInfoClass, AbcInfo::GetClass(env));

    return exports;
}

NODE_API_MODULE(alembic_js, Init)