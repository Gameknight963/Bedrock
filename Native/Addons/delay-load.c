#include <windows.h>
#include <delayimp.h>
#include <string.h>

static FARPROC WINAPI load_host(unsigned int event, DelayLoadInfo *info)
{
    if (event != dliNotePreLoadLibrary || _stricmp(info->szDll, "node.exe")) return NULL;
    // Electron exports Node-API from its own executable.
    return (FARPROC)GetModuleHandleW(NULL);
}

const PfnDliHook __pfnDliNotifyHook2 = load_host;
