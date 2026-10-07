#ifndef BEDROCK_FUSE_H
#define BEDROCK_FUSE_H

#include <stddef.h>
#include <stdint.h>

#define FUSE_SENTINEL "dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX"
#define FUSE_INSPECTOR_INDEX 3

typedef struct FuseLocation {
    uint32_t rva;
    uint8_t version;
    uint8_t count;
    uint8_t wire[255];
} FuseLocation;

typedef enum FuseResult {
    FUSE_OK,
    FUSE_NOT_FOUND,
    FUSE_AMBIGUOUS,
    FUSE_UNSUPPORTED,
    FUSE_TRUNCATED,
    FUSE_INVALID_STATE,
    FUSE_INSPECTOR_REMOVED
} FuseResult;

#ifdef __cplusplus
extern "C" {
#endif

FuseResult fuse_find_wire(const uint8_t *data, size_t size, FuseLocation *fuse, size_t *offset);

#ifdef __cplusplus
}
#endif

#endif
