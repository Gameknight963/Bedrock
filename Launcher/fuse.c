#include "fuse.h"
#include <string.h>

FuseResult fuse_find_wire(const uint8_t *data, size_t size, FuseLocation *fuse, size_t *offset)
{
    const size_t sentinel_size = sizeof(FUSE_SENTINEL) - 1;
    size_t index, found = 0, header_offset = 0;
    FuseLocation decoded = {0};
    if (!data || !fuse || !offset || size < sentinel_size) return FUSE_NOT_FOUND;
    for (index = 0; index <= size - sentinel_size; ++index) {
        if (data[index] == FUSE_SENTINEL[0] && memcmp(data + index, FUSE_SENTINEL, sentinel_size) == 0) {
            ++found;
            header_offset = index + sentinel_size;
        }
    }
    if (!found) return FUSE_NOT_FOUND;
    if (found != 1) return FUSE_AMBIGUOUS;
    if (size - header_offset < 2) return FUSE_TRUNCATED;
    decoded.version = data[header_offset];
    decoded.count = data[header_offset + 1];
    if (decoded.version != 1 || decoded.count <= FUSE_INSPECTOR_INDEX) return FUSE_UNSUPPORTED;
    if (decoded.count > size - header_offset - 2) return FUSE_TRUNCATED;
    memcpy(decoded.wire, data + header_offset + 2, decoded.count);
    for (index = 0; index < decoded.count; ++index)
        if (decoded.wire[index] != '0' && decoded.wire[index] != '1' && decoded.wire[index] != 'r') return FUSE_INVALID_STATE;
    if (decoded.wire[FUSE_INSPECTOR_INDEX] == 'r') return FUSE_INSPECTOR_REMOVED;
    *fuse = decoded;
    *offset = header_offset + 2;
    return FUSE_OK;
}
