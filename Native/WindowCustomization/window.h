#pragma once
#include <windows.h>
#include <stdbool.h>

typedef struct WindowCustomization {
    HWND window;
    LONG_PTR original;
    bool titlebar;
    bool resize;
    bool fullscreen;
    WINDOWPLACEMENT placement;
    LONG_PTR fullscreen_style;
} WindowCustomization;

DWORD window_attach(WindowCustomization *state, HWND window);
DWORD window_update(WindowCustomization *state, bool titlebar, bool resize);
DWORD window_dispose(WindowCustomization *state);
DWORD window_validate(HWND window);
DWORD window_fullscreen(WindowCustomization *state, bool fullscreen);
DWORD window_command(WindowCustomization *state, UINT command);
