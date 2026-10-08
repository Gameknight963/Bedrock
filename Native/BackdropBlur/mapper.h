#pragma once
#include <windows.h>
#include <stddef.h>
#ifdef __cplusplus
extern "C" {
#endif
BOOL blur_map(HANDLE process, BYTE *image, size_t size, BYTE **base);
#ifdef __cplusplus
}
#endif
