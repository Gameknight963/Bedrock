#pragma once
#include <windows.h>
#include "../../include/bedrock/plugin.h"

typedef struct SymbolCache SymbolCache;
typedef struct SymbolReference {
    BYTE *image;
    size_t image_size;
    char *symbols;
    size_t symbols_size;
    SymbolCache *cache;
} SymbolReference;

#ifdef __cplusplus
extern "C" {
#endif
void *symbol_resolve(SymbolReference *reference, BYTE *module, const char *name, BedrockSymbolError *error);
bool symbol_reference_valid(SymbolReference *reference);
void symbol_close(SymbolReference *reference);
#ifdef __cplusplus
}
#endif
