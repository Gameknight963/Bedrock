#pragma once
#include <stdio.h>
void launcher_logging_init(void);
int launcher_fwprintf(FILE *stream, const wchar_t *format, ...);
int launcher_wprintf(const wchar_t *format, ...);
#define fwprintf launcher_fwprintf
#define wprintf launcher_wprintf
