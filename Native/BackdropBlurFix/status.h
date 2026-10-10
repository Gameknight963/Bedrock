#pragma once
#include <windows.h>

typedef struct BlurStatus {
    LONG enabled;
    LONG calls;
    LONG backdrop;
    LONG replaced;
    LONG forward_filter;
    LONG shader_mask;
    LONG bypass;
    LONG split_region;
    LONG blend_mode;
    LONG opacity;
    LONG blender_failed;
} BlurStatus;

enum BlurMatchResult {
    BLUR_MATCH_OK, BLUR_MATCH_MISSING, BLUR_MATCH_DUPLICATE,
    BLUR_MATCH_NO_UNWIND, BLUR_MATCH_NOT_START, BLUR_MATCH_SIZE
};
typedef struct BlurMatchDiagnostic {
    DWORD result;
    DWORD expected_size;
    DWORD actual_size;
} BlurMatchDiagnostic;
typedef struct BlurInstallDiagnostic {
    BlurMatchDiagnostic functions[6];
    DWORD stage;
    LONG minhook_status;
} BlurInstallDiagnostic;
