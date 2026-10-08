#include <windows.h>
#include <delayimp.h>
#include <string.h>

static FARPROC WINAPI load_host(unsigned int event, DelayLoadInfo *info)
{
    if (event != dliNotePreLoadLibrary || _stricmp(info->szDll, "node.exe")) return NULL;
    // Discord exports Node-API itself; there is no node.exe to load inside Electron.
    return (FARPROC)GetModuleHandleW(NULL);
}

const PfnDliHook __pfnDliNotifyHook2 = load_host;
