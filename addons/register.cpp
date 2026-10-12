#include "AbcArchive.h"

#include <napi.h>

Napi::Object Init(Napi::Env env, Napi::Object exports)
{
    exports.Set("AbcArchive", AbcArchive::GetClass(env));
    return exports;
}

NODE_API_MODULE(alembic_js, Init)
