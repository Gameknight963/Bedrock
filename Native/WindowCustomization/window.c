#include "window.h"
#include <commctrl.h>

static const LONG_PTR controlled_styles = WS_CAPTION | WS_SYSMENU | WS_THICKFRAME;

DWORD window_validate(HWND window)
{
    DWORD process = 0;
    DWORD thread = GetWindowThreadProcessId(window, &process);
    if (!thread || process != GetCurrentProcessId()) return ERROR_INVALID_WINDOW_HANDLE;
    if (thread != GetCurrentThreadId()) return ERROR_INVALID_THREAD_ID;
    return ERROR_SUCCESS;
}

static DWORD apply_style(HWND window, LONG_PTR style)
{
    SetLastError(ERROR_SUCCESS);
    if (!SetWindowLongPtrW(window, GWL_STYLE, style) && GetLastError()) return GetLastError();
    if (!SetWindowPos(window, NULL, 0, 0, 0, 0,
        SWP_FRAMECHANGED | SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOOWNERZORDER | SWP_NOACTIVATE)) return GetLastError();
    return ERROR_SUCCESS;
}

static LRESULT CALLBACK window_proc(HWND window, UINT message, WPARAM wparam, LPARAM lparam,
    UINT_PTR subclass, DWORD_PTR data)
{
    WindowCustomization *state = (WindowCustomization *)data;
    if (message == WM_NCDESTROY) {
        RemoveWindowSubclass(window, window_proc, subclass);
        state->window = NULL;
    } else if (state->titlebar) {
        // Chromium's frameless handler suppresses these; let Windows operate the native frame.
        switch (message) {
        case WM_NCCALCSIZE:
        case WM_NCPAINT:
        case WM_NCACTIVATE:
        case WM_NCHITTEST:
        case WM_NCLBUTTONDOWN:
        case WM_NCLBUTTONDBLCLK:
            return DefWindowProcW(window, message, wparam, lparam);
        }
    }
    return DefSubclassProc(window, message, wparam, lparam);
}

DWORD window_attach(WindowCustomization *state, HWND window)
{
    DWORD error = window_validate(window);
    if (error) return error;
    state->original = GetWindowLongPtrW(window, GWL_STYLE);
    state->window = window;
    if (!SetWindowSubclass(window, window_proc, (UINT_PTR)state, (DWORD_PTR)state)) {
        state->window = NULL;
        return ERROR_GEN_FAILURE;
    }
    return ERROR_SUCCESS;
}

DWORD window_update(WindowCustomization *state, bool titlebar, bool resize)
{
    LONG_PTR style;
    DWORD error;
    if (!state->window) return ERROR_INVALID_WINDOW_HANDLE;
    error = window_validate(state->window);
    if (error) return error;
    style = (GetWindowLongPtrW(state->window, GWL_STYLE) & ~controlled_styles) | (state->original & controlled_styles);
    if (titlebar) style |= WS_CAPTION | WS_SYSMENU;
    if (resize) style |= WS_THICKFRAME;
    state->titlebar = titlebar;
    state->resize = resize;
    return apply_style(state->window, style);
}

DWORD window_dispose(WindowCustomization *state)
{
    HWND window = state->window;
    DWORD error;
    if (!window) return ERROR_SUCCESS;
    error = window_validate(window);
    if (error) return error;
    if (!RemoveWindowSubclass(window, window_proc, (UINT_PTR)state)) return ERROR_GEN_FAILURE;
    state->window = NULL;
    return apply_style(window, (GetWindowLongPtrW(window, GWL_STYLE) & ~controlled_styles) | (state->original & controlled_styles));
}
