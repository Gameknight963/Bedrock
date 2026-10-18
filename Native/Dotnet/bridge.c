#include <windows.h>
#include <node_api.h>
#include <stdint.h>
#include <stdlib.h>
#include <stdio.h>

typedef void *hostfxr_handle;
typedef int32_t (__cdecl *initialize_fn)(const wchar_t *, const void *, hostfxr_handle *);
typedef int32_t (__cdecl *delegate_fn)(hostfxr_handle, int, void **);
typedef int32_t (__cdecl *close_fn)(hostfxr_handle);
typedef int32_t (__stdcall *load_fn)(const wchar_t *, const wchar_t *, const wchar_t *, const wchar_t *, void *, void **);
typedef int (__cdecl *managed_fn)(const void *, int);
typedef struct Bridge {
    SRWLOCK lock;
    napi_threadsafe_function messages;
    managed_fn dispatch;
} Bridge;
typedef struct Bootstrap {
    void (__cdecl *publish)(const char *, int, void *);
    void *state;
} Bootstrap;
static Bridge bridge = { SRWLOCK_INIT, NULL, NULL };

static void deliver(napi_env env, napi_value callback, void *context, void *data)
{
    (void)context;
    char *json = data;
    if (env && callback) {
        napi_value argument, receiver;
        if (napi_create_string_utf8(env, json, NAPI_AUTO_LENGTH, &argument) == napi_ok &&
            napi_get_undefined(env, &receiver) == napi_ok)
            napi_call_function(env, receiver, callback, 1, &argument, NULL);
    }
    free(json);
}

static void __cdecl publish(const char *json, int length, void *state)
{
    Bridge *target = state;
    if (length < 0 || length > 4 * 1024 * 1024) return;
    char *copy = malloc((size_t)length + 1);
    if (!copy) return;
    memcpy(copy, json, (size_t)length); copy[length] = 0;
    AcquireSRWLockShared(&target->lock);
    if (!target->messages || napi_call_threadsafe_function(target->messages, copy, napi_tsfn_nonblocking) != napi_ok) free(copy);
    ReleaseSRWLockShared(&target->lock);
}

static void cleanup(void *state)
{
    Bridge *target = state;
    if (target->dispatch) target->dispatch("{\"op\":\"shutdown\"}", 17);
    AcquireSRWLockExclusive(&target->lock);
    napi_threadsafe_function messages = target->messages;
    target->messages = NULL;
    ReleaseSRWLockExclusive(&target->lock);
    if (messages) napi_release_threadsafe_function(messages, napi_tsfn_abort);
}

static wchar_t *string(napi_env env, napi_value value)
{
    size_t length;
    if (napi_get_value_string_utf16(env, value, NULL, 0, &length) != napi_ok) return NULL;
    wchar_t *text = calloc(length + 1, sizeof(wchar_t));
    if (!text) return NULL;
    if (napi_get_value_string_utf16(env, value, (char16_t *)text, length + 1, &length) != napi_ok) { free(text); return NULL; }
    return text;
}

static HMODULE hosting_library(void)
{
    wchar_t root[1024] = {0}, pattern[1200], selected[1200];
    DWORD bytes = sizeof(root);
    if (!GetEnvironmentVariableW(L"DOTNET_ROOT_X64", root, ARRAYSIZE(root)) &&
        RegGetValueW(HKEY_LOCAL_MACHINE, L"SOFTWARE\\dotnet\\Setup\\InstalledVersions\\x64", L"InstallLocation",
            RRF_RT_REG_SZ | RRF_SUBKEY_WOW6464KEY, NULL, root, &bytes) != ERROR_SUCCESS) {
        if (!GetEnvironmentVariableW(L"ProgramW6432", root, ARRAYSIZE(root))) return NULL;
        if (wcscat_s(root, ARRAYSIZE(root), L"\\dotnet")) return NULL;
    }
    if (swprintf_s(pattern, ARRAYSIZE(pattern), L"%s\\host\\fxr\\*", root) < 0) return NULL;
    WIN32_FIND_DATAW item;
    HANDLE search = FindFirstFileW(pattern, &item);
    if (search == INVALID_HANDLE_VALUE) return NULL;
    unsigned best_major = 0, best_minor = 0, best_patch = 0;
    selected[0] = 0;
    do {
        unsigned major, minor, patch; wchar_t suffix;
        if (!(item.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) ||
            swscanf_s(item.cFileName, L"%u.%u.%u%c", &major, &minor, &patch, &suffix, 1) != 3 || major < 10) continue;
        if (major < best_major || (major == best_major && minor < best_minor) ||
            (major == best_major && minor == best_minor && patch <= best_patch && selected[0])) continue;
        best_major = major; best_minor = minor; best_patch = patch;
        swprintf_s(selected, ARRAYSIZE(selected), L"%s\\host\\fxr\\%s\\hostfxr.dll", root, item.cFileName);
    } while (FindNextFileW(search, &item));
    FindClose(search);
    return selected[0] ? LoadLibraryExW(selected, NULL, LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_DEFAULT_DIRS) : NULL;
}

static napi_value initialize(napi_env env, napi_callback_info info)
{
    size_t count = 3;
    napi_value args[3], result, name;
    napi_valuetype type;
    if (napi_get_cb_info(env, info, &count, args, NULL, NULL) != napi_ok || count != 3 ||
        napi_typeof(env, args[2], &type) != napi_ok || type != napi_function) {
        napi_throw_type_error(env, NULL, "Expected runtime configuration, host assembly and message callback."); return NULL;
    }
    if (bridge.dispatch) { napi_throw_error(env, NULL, "The desktop .NET host is already initialized."); return NULL; }
    wchar_t *configuration = string(env, args[0]), *assembly = string(env, args[1]);
    if (!configuration || !assembly) { free(configuration); free(assembly); napi_throw_type_error(env, NULL, "Expected file paths."); return NULL; }
    HMODULE fxr = hosting_library();
    int32_t status = (int32_t)0x80008083;
    managed_fn start = NULL, dispatch = NULL;
    if (fxr) {
        initialize_fn init = (initialize_fn)GetProcAddress(fxr, "hostfxr_initialize_for_runtime_config");
        delegate_fn get_delegate = (delegate_fn)GetProcAddress(fxr, "hostfxr_get_runtime_delegate");
        close_fn close = (close_fn)GetProcAddress(fxr, "hostfxr_close");
        hostfxr_handle host = NULL;
        load_fn load = NULL;
        if (init && get_delegate && close) {
            status = init(configuration, NULL, &host);
            // hdt_load_assembly_and_get_function_pointer is delegate type 5.
            if (status >= 0) status = get_delegate(host, 5, (void **)&load);
            if (host) close(host);
            // -1 asks for an UnmanagedCallersOnly entry point rather than a managed delegate.
            if (status >= 0) status = load(assembly, L"Bedrock.DesktopHost.Host, Bedrock.DesktopHost", L"Initialize", (const wchar_t *)-1, NULL, (void **)&start);
            if (status >= 0) status = load(assembly, L"Bedrock.DesktopHost.Host, Bedrock.DesktopHost", L"Dispatch", (const wchar_t *)-1, NULL, (void **)&dispatch);
        }
    }
    free(configuration); free(assembly);
    if (status < 0 || !start || !dispatch) {
        char message[320];
        sprintf_s(message, sizeof(message), "Could not initialize desktop .NET (0x%08X). Bedrock requires the .NET 10 Windows Desktop Runtime (x64).", (unsigned)status);
        napi_throw_error(env, NULL, message); return NULL;
    }
    if (napi_create_string_utf8(env, "Bedrock desktop .NET", NAPI_AUTO_LENGTH, &name) != napi_ok ||
        napi_create_threadsafe_function(env, args[2], NULL, name, 0, 1, NULL, NULL, NULL, deliver, &bridge.messages) != napi_ok) return NULL;
    Bootstrap bootstrap = { publish, &bridge };
    if (start(&bootstrap, sizeof(bootstrap)) != 0) {
        cleanup(&bridge); napi_throw_error(env, NULL, "The managed Bedrock host could not initialize."); return NULL;
    }
    bridge.dispatch = dispatch;
    // CLR delegates and background callbacks keep this bridge alive for the process lifetime.
    HMODULE pinned;
    GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_PIN, (LPCWSTR)&bridge, &pinned);
    napi_unref_threadsafe_function(env, bridge.messages);
    napi_add_env_cleanup_hook(env, cleanup, &bridge);
    napi_get_undefined(env, &result);
    return result;
}

static napi_value send(napi_env env, napi_callback_info info)
{
    size_t count = 1, length;
    napi_value argument, result;
    if (!bridge.dispatch) { napi_throw_error(env, NULL, "Desktop .NET is not initialized."); return NULL; }
    if (napi_get_cb_info(env, info, &count, &argument, NULL, NULL) != napi_ok || count != 1 ||
        napi_get_value_string_utf8(env, argument, NULL, 0, &length) != napi_ok || length > 4 * 1024 * 1024) {
        napi_throw_type_error(env, NULL, "Expected a managed request of at most four MiB."); return NULL;
    }
    char *json = malloc(length + 1);
    if (!json) { napi_throw_error(env, NULL, "Cannot allocate the managed request."); return NULL; }
    napi_status status = napi_get_value_string_utf8(env, argument, json, length + 1, &length);
    int code = status == napi_ok ? bridge.dispatch(json, (int)length) : -1;
    free(json);
    if (code) { napi_throw_error(env, NULL, "The managed host rejected the request."); return NULL; }
    napi_get_undefined(env, &result); return result;
}

NAPI_MODULE_INIT()
{
    napi_property_descriptor methods[] = {
        { "initialize", NULL, initialize, NULL, NULL, NULL, napi_default, NULL },
        { "send", NULL, send, NULL, NULL, NULL, napi_default, NULL }
    };
    return napi_define_properties(env, exports, ARRAYSIZE(methods), methods) == napi_ok ? exports : NULL;
}
