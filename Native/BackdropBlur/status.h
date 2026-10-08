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
