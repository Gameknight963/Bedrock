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
    } else if (state->fullscreen && message == WM_SYSCOMMAND &&
        ((wparam & 0xFFF0) == SC_MAXIMIZE || ((wparam & 0xFFF0) == SC_RESTORE && !IsIconic(window)))) {
        return 0;
    } else if (state->titlebar || state->resize) {
        // Electron suppresses native maximization and disables the system menu for transparent windows.
        if (message == WM_SYSCOMMAND && ((wparam & 0xFFF0) == SC_MAXIMIZE || (wparam & 0xFFF0) == SC_RESTORE))
            return DefWindowProcW(window, message, wparam, lparam);
        // Chromium's frameless handler suppresses these; let Windows operate the native frame.
        if (state->titlebar || state->fullscreen) switch (message) {
        case WM_INITMENU:
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
    if (state->fullscreen) {
        state->fullscreen_style = style;
        style &= ~(WS_CAPTION | WS_THICKFRAME);
    }
    return apply_style(state->window, style);
}

DWORD window_command(WindowCustomization *state, UINT command)
{
    DWORD error = window_validate(state->window);
    if (error) return error;
    if (state->fullscreen && !IsIconic(state->window)) return ERROR_SUCCESS;
    DefWindowProcW(state->window, WM_SYSCOMMAND, command, 0);
    return ERROR_SUCCESS;
}

DWORD window_fullscreen(WindowCustomization *state, bool fullscreen)
{
    DWORD error = window_validate(state->window);
    MONITORINFO monitor = { sizeof(MONITORINFO) };
    if (error || state->fullscreen == fullscreen) return error;
    if (fullscreen) {
        state->placement.length = sizeof(WINDOWPLACEMENT);
        if (!GetWindowPlacement(state->window, &state->placement) ||
            !GetMonitorInfoW(MonitorFromWindow(state->window, MONITOR_DEFAULTTONEAREST), &monitor)) return GetLastError();
        state->fullscreen_style = GetWindowLongPtrW(state->window, GWL_STYLE);
        // Fullscreen has no Windows show state: preserve native placement separately from its borderless bounds.
        if (IsZoomed(state->window) || IsIconic(state->window)) ShowWindow(state->window, SW_RESTORE);
        state->fullscreen = true;
        error = apply_style(state->window, GetWindowLongPtrW(state->window, GWL_STYLE) & ~(WS_CAPTION | WS_THICKFRAME));
        if (!error && !SetWindowPos(state->window, NULL, monitor.rcMonitor.left, monitor.rcMonitor.top,
            monitor.rcMonitor.right - monitor.rcMonitor.left, monitor.rcMonitor.bottom - monitor.rcMonitor.top,
            SWP_NOZORDER | SWP_NOOWNERZORDER | SWP_NOACTIVATE)) error = GetLastError();
        if (error) window_fullscreen(state, false);
        return error;
    }
    state->fullscreen = false;
    error = apply_style(state->window, (GetWindowLongPtrW(state->window, GWL_STYLE) & ~controlled_styles) |
        (state->fullscreen_style & controlled_styles));
    if (!error && !SetWindowPlacement(state->window, &state->placement)) error = GetLastError();
    return error;
}

DWORD window_dispose(WindowCustomization *state)
{
    HWND window = state->window;
    DWORD error;
    if (!window) return ERROR_SUCCESS;
    error = window_validate(window);
    if (error) return error;
    if (state->fullscreen && (error = window_fullscreen(state, false))) return error;
    if (!RemoveWindowSubclass(window, window_proc, (UINT_PTR)state)) return ERROR_GEN_FAILURE;
    state->window = NULL;
    return apply_style(window, (GetWindowLongPtrW(window, GWL_STYLE) & ~controlled_styles) | (state->original & controlled_styles));
}
