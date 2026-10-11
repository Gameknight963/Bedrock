#include <windows.h>
#include <node_api.h>
#include <stdio.h>
#include <stdlib.h>

static napi_value windows_error(napi_env env, const char *operation)
{
    DWORD error = GetLastError();
    char message[160];
    sprintf_s(message, sizeof(message), "%s (Windows error %lu).", operation, error);
    napi_throw_error(env, NULL, message);
    return NULL;
}

static napi_value capture(napi_env env, napi_callback_info info)
{
    size_t argc = 1, length;
    napi_value argument, result;
    if (napi_get_cb_info(env, info, &argc, &argument, NULL, NULL) != napi_ok || argc != 1 ||
        napi_get_value_string_utf16(env, argument, NULL, 0, &length) != napi_ok) {
        napi_throw_type_error(env, NULL, "Expected the resolved addon filename."); return NULL;
    }
    wchar_t *filename = malloc((length + 1) * sizeof(wchar_t));
    if (!filename) { napi_throw_error(env, NULL, "Cannot allocate the addon filename."); return NULL; }
    napi_status status = napi_get_value_string_utf16(env, argument, (char16_t *)filename, length + 1, &length);
    HMODULE module = status == napi_ok ? GetModuleHandleW(filename) : NULL;
    DWORD error = GetLastError();
    free(filename);
    if (status != napi_ok) return NULL;
    if (!module) { SetLastError(error); return windows_error(env, "Cannot find the loaded addon"); }
    if (napi_create_bigint_uint64(env, (uint64_t)(uintptr_t)module, &result) != napi_ok) return NULL;
    return result;
}

static napi_value release(napi_env env, napi_callback_info info)
{
    size_t argc = 1;
    napi_value argument, result;
    uint64_t address;
    bool lossless;
    if (napi_get_cb_info(env, info, &argc, &argument, NULL, NULL) != napi_ok || argc != 1 ||
        napi_get_value_bigint_uint64(env, argument, &address, &lossless) != napi_ok || !lossless || !address ||
        address > UINTPTR_MAX) {
        napi_throw_type_error(env, NULL, "Expected the captured addon handle."); return NULL;
    }
    HMODULE module;
    if (!GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
        (LPCWSTR)(uintptr_t)address, &module) || (uintptr_t)module != (uintptr_t)address) {
        napi_throw_error(env, NULL, "The addon is no longer mapped at its captured address."); return NULL;
    }
    // Release Node's load reference only after the caller has disposed every native callback.
    if (!FreeLibrary(module)) return windows_error(env, "Cannot unload the addon");
    if (napi_get_undefined(env, &result) != napi_ok) return NULL;
    return result;
}

NAPI_MODULE_INIT()
{
    napi_property_descriptor methods[] = {
        { "capture", NULL, capture, NULL, NULL, NULL, napi_default, NULL },
        { "release", NULL, release, NULL, NULL, NULL, napi_default, NULL }
    };
    if (napi_define_properties(env, exports, 2, methods) != napi_ok) return NULL;
    return exports;
}
