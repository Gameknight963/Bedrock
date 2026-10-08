#include <stddef.h>
#include <string.h>
#pragma function(memcpy, memset)

// Avoid the static CRT's loader-managed TLS when manually mapping this small C DLL.
int _fltused;

void *memcpy(void *destination, const void *source, size_t size)
{
    volatile unsigned char *out = destination;
    const volatile unsigned char *in = source;
    for (size_t i = 0; i < size; ++i) out[i] = in[i];
    return destination;
}

void *memset(void *destination, int value, size_t size)
{
    volatile unsigned char *out = destination;
    for (size_t i = 0; i < size; ++i) out[i] = (unsigned char)value;
    return destination;
}
