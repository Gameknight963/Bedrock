#pragma once
#include <windows.h>
#include "../../include/bedrock/plugin.h"

#define BEDROCK_MESSAGE_CAP (1024 * 1024)
typedef struct HostLaunch {
    HANDLE input;
    HANDLE output;
    BYTE *plugin;
    BedrockProcessType process_type;
    wchar_t path[32768];
} HostLaunch;
