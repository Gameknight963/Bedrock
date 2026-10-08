#include <windows.h>
#include <node_api.h>
#include <stdlib.h>

static HANDLE output = INVALID_HANDLE_VALUE;
static HANDLE saved_out, saved_error, quiet = INVALID_HANDLE_VALUE;
static BOOL filtering;

static napi_value result(napi_env env)
{
    napi_value value;
    napi_get_undefined(env, &value);
    return value;
}

static napi_value show(napi_env env, napi_callback_info info)
{
    (void)info;
    if (output != INVALID_HANDLE_VALUE) CloseHandle(output);
    output = INVALID_HANDLE_VALUE;
    if (!GetConsoleCP() && !AllocConsole()) {
        napi_throw_error(env, NULL, "Cannot allocate a console.");
        return NULL;
    }
    output = CreateFileW(L"CONOUT$", GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE,
        NULL, OPEN_EXISTING, 0, NULL);
    if (output == INVALID_HANDLE_VALUE) {
        napi_throw_error(env, NULL, "Cannot open console output.");
        return NULL;
    }
    SetConsoleTitleW(L"Bedrock");
    ShowWindow(GetConsoleWindow(), SW_SHOW);
    return result(env);
}

static napi_value hide(napi_env env, napi_callback_info info)
{
    (void)info;
    HWND window = GetConsoleWindow();
    if (window) ShowWindow(window, SW_HIDE);
    return result(env);
}

static napi_value write_text(napi_env env, napi_callback_info info)
{
    napi_value argument;
    size_t argc = 1, length = 0;
    if (napi_get_cb_info(env, info, &argc, &argument, NULL, NULL) != napi_ok || argc != 1 ||
        napi_get_value_string_utf16(env, argument, NULL, 0, &length) != napi_ok) return NULL;
    wchar_t *text = malloc((length + 1) * sizeof(wchar_t));
    if (!text) { napi_throw_error(env, NULL, "Cannot allocate console text."); return NULL; }
    if (napi_get_value_string_utf16(env, argument, (char16_t *)text, length + 1, &length) == napi_ok &&
        output != INVALID_HANDLE_VALUE) {
        size_t offset = 0;
        while (offset < length) {
            DWORD written = 0;
            DWORD count = (DWORD)((length - offset > 16384) ? 16384 : length - offset);
            if (!WriteConsoleW(output, text + offset, count, &written, NULL) || !written) break;
            offset += written;
        }
    }
    free(text);
    return result(env);
}

static napi_value filter(napi_env env, napi_callback_info info)
{
    napi_value argument;
    size_t argc = 1;
    bool enabled;
    if (napi_get_cb_info(env, info, &argc, &argument, NULL, NULL) != napi_ok || argc != 1 ||
        napi_get_value_bool(env, argument, &enabled) != napi_ok) return NULL;
    if (enabled && !filtering) {
        quiet = CreateFileW(L"NUL", GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE,
            NULL, OPEN_EXISTING, 0, NULL);
        if (quiet == INVALID_HANDLE_VALUE) { napi_throw_error(env, NULL, "Cannot open NUL."); return NULL; }
        saved_out = GetStdHandle(STD_OUTPUT_HANDLE);
        saved_error = GetStdHandle(STD_ERROR_HANDLE);
        SetStdHandle(STD_OUTPUT_HANDLE, quiet);
        SetStdHandle(STD_ERROR_HANDLE, quiet);
        filtering = TRUE;
    } else if (!enabled && filtering) {
        SetStdHandle(STD_OUTPUT_HANDLE, saved_out);
        SetStdHandle(STD_ERROR_HANDLE, saved_error);
        CloseHandle(quiet);
        quiet = INVALID_HANDLE_VALUE;
        filtering = FALSE;
    }
    return result(env);
}

NAPI_MODULE_INIT()
{
    napi_property_descriptor methods[] = {
        { "show", NULL, show, NULL, NULL, NULL, napi_default, NULL },
        { "hide", NULL, hide, NULL, NULL, NULL, napi_default, NULL },
        { "write", NULL, write_text, NULL, NULL, NULL, napi_default, NULL },
        { "filter", NULL, filter, NULL, NULL, NULL, napi_default, NULL }
    };
    if (napi_define_properties(env, exports, 4, methods) != napi_ok) return NULL;
    return exports;
}
