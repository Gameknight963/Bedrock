#include <node_api.h>
#include <stdlib.h>
#include <stdio.h>
#include <string.h>
#include "window.h"

static bool check(napi_env env, napi_status status)
{
    if (status == napi_ok) return true;
    if (status != napi_pending_exception) napi_throw_error(env, NULL, "Node-API call failed");
    return false;
}

static bool win32_check(napi_env env, DWORD error)
{
    char message[100];
    if (!error) return true;
    sprintf_s(message, sizeof(message), "Window customization failed (Win32 error %lu)", error);
    napi_throw_error(env, NULL, message);
    return false;
}

static bool get_window(napi_env env, napi_value value, HWND *window)
{
    bool buffer;
    size_t size;
    void *data;
    if (!check(env, napi_is_buffer(env, value, &buffer))) return false;
    if (!buffer) { napi_throw_type_error(env, NULL, "Expected Electron's native window handle Buffer"); return false; }
    if (!check(env, napi_get_buffer_info(env, value, &data, &size))) return false;
    if (size != sizeof(HWND)) { napi_throw_range_error(env, NULL, "Invalid native window handle size"); return false; }
    memcpy(window, data, sizeof(HWND));
    return win32_check(env, window_validate(*window));
}

static bool get_options(napi_env env, napi_value options, bool *titlebar, bool *resize)
{
    napi_value value;
    if (!check(env, napi_get_named_property(env, options, "nativeTitlebar", &value)) ||
        !check(env, napi_get_value_bool(env, value, titlebar))) return false;
    if (!check(env, napi_get_named_property(env, options, "resizableFrame", &value)) ||
        !check(env, napi_get_value_bool(env, value, resize))) return false;
    return true;
}

static void finalize(napi_env env, void *data, void *hint)
{
    WindowCustomization *state = data;
    (void)env; (void)hint;
    // Never free a state that a live window subclass might still reference.
    window_dispose(state);
    if (!state->window) free(state);
}

static napi_value update(napi_env env, napi_callback_info info)
{
    size_t argc = 1;
    napi_value argument, self;
    WindowCustomization *state;
    bool titlebar, resize;
    if (!check(env, napi_get_cb_info(env, info, &argc, &argument, &self, NULL))) return NULL;
    if (argc != 1) { napi_throw_type_error(env, NULL, "Expected window options"); return NULL; }
    if (!check(env, napi_unwrap(env, self, (void **)&state)) || !state) return NULL;
    if (!get_options(env, argument, &titlebar, &resize) || !win32_check(env, window_update(state, titlebar, resize))) return NULL;
    return self;
}

static napi_value dispose(napi_env env, napi_callback_info info)
{
    napi_value self;
    WindowCustomization *state;
    if (!check(env, napi_get_cb_info(env, info, NULL, NULL, &self, NULL))) return NULL;
    if (!check(env, napi_unwrap(env, self, (void **)&state)) || !state) return NULL;
    if (!win32_check(env, window_dispose(state))) return NULL;
    return self;
}

static napi_value customize(napi_env env, napi_callback_info info)
{
    size_t argc = 2;
    napi_value arguments[2], object;
    HWND window;
    bool titlebar, resize;
    WindowCustomization *state;
    napi_property_descriptor methods[] = {
        { "update", NULL, update, NULL, NULL, NULL, napi_default, NULL },
        { "dispose", NULL, dispose, NULL, NULL, NULL, napi_default, NULL }
    };
    if (!check(env, napi_get_cb_info(env, info, &argc, arguments, NULL, NULL))) return NULL;
    if (argc != 2) { napi_throw_type_error(env, NULL, "Expected a window handle and options"); return NULL; }
    if (!get_window(env, arguments[0], &window) || !get_options(env, arguments[1], &titlebar, &resize)) return NULL;
    state = calloc(1, sizeof(*state));
    if (!state) { napi_throw_error(env, NULL, "Cannot allocate window customization"); return NULL; }
    if (!win32_check(env, window_attach(state, window))) { free(state); return NULL; }
    if (!check(env, napi_create_object(env, &object)) ||
        !check(env, napi_define_properties(env, object, sizeof(methods) / sizeof(methods[0]), methods)) ||
        !check(env, napi_wrap(env, object, state, finalize, NULL, NULL))) {
        finalize(env, state, NULL); return NULL;
    }
    if (!win32_check(env, window_update(state, titlebar, resize))) { window_dispose(state); return NULL; }
    return object;
}

static napi_value get_style(napi_env env, napi_callback_info info)
{
    size_t argc = 1;
    napi_value argument, value;
    HWND window;
    if (!check(env, napi_get_cb_info(env, info, &argc, &argument, NULL, NULL))) return NULL;
    if (argc != 1) { napi_throw_type_error(env, NULL, "Expected a window handle"); return NULL; }
    if (!get_window(env, argument, &window)) return NULL;
    if (!check(env, napi_create_uint32(env, (uint32_t)GetWindowLongPtrW(window, GWL_STYLE), &value))) return NULL;
    return value;
}

NAPI_MODULE_INIT()
{
    napi_property_descriptor methods[] = {
        { "customize", NULL, customize, NULL, NULL, NULL, napi_default, NULL },
        { "getStyle", NULL, get_style, NULL, NULL, NULL, napi_default, NULL }
    };
    if (!check(env, napi_define_properties(env, exports, sizeof(methods) / sizeof(methods[0]), methods))) return NULL;
    return exports;
}
