#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <tlhelp32.h>
#include <winternl.h>
#include <stdio.h>
#include <stddef.h>
#include <stdlib.h>
#include <wchar.h>
#include "status.h"
#include "mapper.h"
#pragma comment(lib, "advapi32.lib")

typedef NTSTATUS (NTAPI *QueryProcess)(HANDLE, PROCESSINFOCLASS, PVOID, ULONG, PULONG);

static BOOL is_gpu(DWORD pid) {
    HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
    QueryProcess query = (QueryProcess)GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "NtQueryInformationProcess");
    ULONG length = 0;
    BOOL result = FALSE;
    if (!process || !query) { if (process) CloseHandle(process); return FALSE; }
    query(process, (PROCESSINFOCLASS)60, NULL, 0, &length);
    if (length >= sizeof(UNICODE_STRING) && length < 1024 * 1024) {
        BYTE *buffer = calloc(1, (size_t)length + sizeof(wchar_t));
        if (buffer && query(process, (PROCESSINFOCLASS)60, buffer, length, &length) >= 0) {
            UNICODE_STRING *command = (UNICODE_STRING *)buffer;
            ULONG_PTR begin = (ULONG_PTR)buffer, end = begin + length;
            ULONG_PTR text = (ULONG_PTR)command->Buffer;
            if (text >= begin && text <= end && command->Length <= end - text && !(command->Length % 2)) {
                wchar_t *copy = calloc(1, (size_t)command->Length + sizeof(wchar_t));
                if (copy) {
                    memcpy(copy, command->Buffer, command->Length);
                    wchar_t *type = wcsstr(copy, L"--type=gpu-process");
                    result = type && (type == copy || type[-1] == L' ' || type[-1] == L'"') &&
                        (type[18] == 0 || type[18] == L' ' || type[18] == L'"');
                    free(copy);
                }
            }
        }
        free(buffer);
    }
    CloseHandle(process);
    return result;
}

static DWORD discover(DWORD requested) {
    HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    PROCESSENTRY32W entry = {0};
    DWORD found = 0, matches = 0;
    if (snapshot == INVALID_HANDLE_VALUE) return 0;
    entry.dwSize = sizeof(entry);
    if (Process32FirstW(snapshot, &entry)) do {
        if (!_wcsicmp(entry.szExeFile, L"Discord.exe") && (!requested || requested == entry.th32ProcessID) && is_gpu(entry.th32ProcessID)) {
            found = entry.th32ProcessID;
            ++matches;
        }
    } while (Process32NextW(snapshot, &entry));
    CloseHandle(snapshot);
    if (matches != 1) { fwprintf(stderr, L"Expected one Discord GPU process; found %lu. Use --pid PID if necessary.\n", matches); return 0; }
    return found;
}

static BYTE *module_base(DWORD pid, const wchar_t *name, const wchar_t *expected_path, BOOL *mismatch) {
    HANDLE snapshot = INVALID_HANDLE_VALUE;
    for (int attempt = 0; attempt < 8; ++attempt) {
        snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPMODULE | TH32CS_SNAPMODULE32, pid);
        if (snapshot != INVALID_HANDLE_VALUE || GetLastError() != ERROR_BAD_LENGTH) break;
    }
    if (snapshot == INVALID_HANDLE_VALUE) return NULL;
    MODULEENTRY32W entry = {0};
    BYTE *base = NULL;
    entry.dwSize = sizeof(entry);
    if (Module32FirstW(snapshot, &entry)) do {
        if (!_wcsicmp(entry.szModule, name)) {
            if (expected_path) {
                wchar_t *canonical = calloc(32768, sizeof(wchar_t));
                DWORD count = canonical ? GetFullPathNameW(entry.szExePath, 32768, canonical, NULL) : 0;
                if (!count || count >= 32768 || _wcsicmp(canonical, expected_path)) {
                    fwprintf(stderr, L"The GPU process already has %s loaded from a different or unverifiable path. Restart Discord before using this DLL build.\n", name);
                    *mismatch = TRUE;
                    free(canonical);
                    break;
                }
                free(canonical);
            }
            base = entry.modBaseAddr;
            break;
        }
    } while (Module32NextW(snapshot, &entry));
    CloseHandle(snapshot);
    return base;
}

static BOOL remote_call(HANDLE process, LPTHREAD_START_ROUTINE function, void *argument, DWORD *result, BOOL *finished, const wchar_t *operation) {
    HANDLE thread = CreateRemoteThread(process, NULL, 0, function, argument, 0, NULL);
    *finished = TRUE;
    if (!thread) { fwprintf(stderr, L"%s: CreateRemoteThread failed: %lu.\n", operation, GetLastError()); return FALSE; }
    DWORD wait = WaitForSingleObject(thread, 4000);
    if (wait != WAIT_OBJECT_0) {
        *finished = FALSE;
        fwprintf(stderr, L"%s: wait %s (error %lu); its resources are retained until the process exits.\n", operation, wait == WAIT_TIMEOUT ? L"timed out" : L"failed", wait == WAIT_TIMEOUT ? ERROR_TIMEOUT : GetLastError());
        CloseHandle(thread);
        return FALSE;
    }
    BOOL success = GetExitCodeThread(thread, result);
    if (!success) fwprintf(stderr, L"%s: GetExitCodeThread failed: %lu.\n", operation, GetLastError());
    CloseHandle(thread);
    return success;
}

int wmain(int argc, wchar_t **argv) {
    BOOL restore = FALSE, status = FALSE;
    DWORD requested = 0;
    BYTE *mapped_base = NULL;
    const wchar_t *dll_path = NULL;
    for (int index = 1; index < argc; ++index) {
        if (!wcscmp(argv[index], L"--base") && index + 1 < argc) {
            wchar_t *end = NULL;
            unsigned long long address = wcstoull(argv[++index], &end, 16);
            if (!address || !end || *end) { fwprintf(stderr, L"Invalid mapped base.\n"); return 1; }
            mapped_base = (BYTE *)(ULONG_PTR)address;
        }
        else if (!wcscmp(argv[index], L"--status")) status = TRUE;
        else if (!wcscmp(argv[index], L"--restore")) restore = TRUE;
        else if (!wcscmp(argv[index], L"--dll") && index + 1 < argc) {
            dll_path = argv[++index];
            size_t count = wcslen(dll_path);
            if (!(count >= 3 && dll_path[1] == L':' && (dll_path[2] == L'\\' || dll_path[2] == L'/')) &&
                !(count >= 3 && dll_path[0] == L'\\' && dll_path[1] == L'\\')) {
                fwprintf(stderr, L"--dll requires an absolute path.\n"); return 1;
            }
        }
        else if (!wcscmp(argv[index], L"--pid") && index + 1 < argc) {
            wchar_t *end = NULL;
            requested = wcstoul(argv[++index], &end, 10);
            if (!requested || !end || *end) { fwprintf(stderr, L"Invalid PID.\n"); return 1; }
        } else { fwprintf(stderr, L"Usage: blur-controller.exe [--pid PID] [--dll ABSOLUTE_PATH] [--base HEX_ADDRESS] [--restore | --status]\n"); return 1; }
    }
    DWORD pid = discover(requested);
    if (!pid) return 1;
    HANDLE process = OpenProcess(PROCESS_CREATE_THREAD | PROCESS_QUERY_INFORMATION | PROCESS_VM_OPERATION | PROCESS_VM_WRITE | PROCESS_VM_READ | SYNCHRONIZE, FALSE, pid);
    if (!process) { fwprintf(stderr, L"OpenProcess failed: %lu.\n", GetLastError()); return 1; }
    USHORT machine = 0, native = 0;
    if (!IsWow64Process2(process, &machine, &native) || machine != IMAGE_FILE_MACHINE_UNKNOWN || native != IMAGE_FILE_MACHINE_AMD64) {
        fwprintf(stderr, L"Only native x64 Discord GPU processes are supported.\n"); CloseHandle(process); return 1;
    }
    wchar_t *path = calloc(32768, sizeof(wchar_t));
    DWORD image_length = 32768;
    if (!path || !QueryFullProcessImageNameW(process, 0, path, &image_length)) {
        fwprintf(stderr, L"QueryFullProcessImageNameW/allocation failed: %lu.\n", path ? GetLastError() : ERROR_NOT_ENOUGH_MEMORY);
        free(path); CloseHandle(process); return 1;
    }
    wchar_t *image_name = wcsrchr(path, L'\\');
    if (!image_name || _wcsicmp(image_name + 1, L"Discord.exe") || !is_gpu(pid)) {
        fwprintf(stderr, L"The selected process no longer identifies as Discord's GPU process.\n");
        free(path); CloseHandle(process); return 1;
    }
    DWORD length = dll_path ? GetFullPathNameW(dll_path, 32768, path, NULL) : GetModuleFileNameW(NULL, path, 32768);
    wchar_t *separator = length && length < 32768 ? wcsrchr(path, L'\\') : NULL;
    if (!separator || (!dll_path && wcscpy_s(separator + 1, 32768 - (size_t)(separator + 1 - path), L"blur-hook.dll"))) {
        fwprintf(stderr, L"Cannot resolve hook DLL path.\n");
        free(path); CloseHandle(process); return 1;
    }
    HMODULE image = LoadLibraryExW(path, NULL, DONT_RESOLVE_DLL_REFERENCES);
    FARPROC exported = image ? GetProcAddress(image, status ? "BlurCounters" : restore ? "BlurRemove" : "BlurInstall") : NULL;
    if (!exported) { fwprintf(stderr, L"Cannot find adjacent hook DLL/export: %lu.\n", GetLastError()); if (image) FreeLibrary(image); free(path); CloseHandle(process); return 1; }
    SIZE_T offset = (SIZE_T)((BYTE *)exported - (BYTE *)image);
    IMAGE_DOS_HEADER *local_dos = (IMAGE_DOS_HEADER *)image;
    IMAGE_NT_HEADERS64 expected = *(IMAGE_NT_HEADERS64 *)((BYTE *)image + local_dos->e_lfanew);
    FreeLibrary(image);
    const wchar_t *dll_name = wcsrchr(path, L'\\') + 1;
    BOOL mismatch = FALSE;
    BYTE *remote = mapped_base ? mapped_base : module_base(pid, dll_name, path, &mismatch);
    if (mapped_base) {
        IMAGE_DOS_HEADER dos = {0};
        IMAGE_NT_HEADERS64 nt = {0};
        if (!ReadProcessMemory(process, mapped_base, &dos, sizeof(dos), NULL) || dos.e_magic != IMAGE_DOS_SIGNATURE ||
            dos.e_lfanew < 0 || dos.e_lfanew > 4096 ||
            !ReadProcessMemory(process, mapped_base + dos.e_lfanew, &nt, sizeof(nt), NULL) ||
            nt.Signature != IMAGE_NT_SIGNATURE || nt.FileHeader.TimeDateStamp != expected.FileHeader.TimeDateStamp ||
            nt.OptionalHeader.SizeOfImage != expected.OptionalHeader.SizeOfImage || nt.FileHeader.Machine != IMAGE_FILE_MACHINE_AMD64) {
            fwprintf(stderr, L"Mapped DLL does not match this build; restart Discord.\n");
            free(path); CloseHandle(process); return 1;
        }
    }
    if (mismatch) { free(path); CloseHandle(process); return 1; }
    if (status) {
        BlurStatus counters = {0};
        SIZE_T read = 0;
        BOOL success = remote && ReadProcessMemory(process, remote + offset, &counters, sizeof(counters), &read) && read == sizeof(counters);
        if (success) wprintf(L"enabled=%ld calls=%ld backdrop=%ld replaced=%ld forward-filter=%ld shader-mask=%ld bypass=%ld split-region=%ld blend-mode=%ld opacity=%ld blender-failed=%ld\n",
            counters.enabled, counters.calls, counters.backdrop, counters.replaced, counters.forward_filter, counters.shader_mask,
            counters.bypass, counters.split_region, counters.blend_mode, counters.opacity, counters.blender_failed);
        else fwprintf(stderr, L"Cannot read hook counters. Restart Discord if it is using an older DLL.\n");
        free(path); CloseHandle(process); return success ? 0 : 1;
    }
    BOOL success = FALSE, finished = TRUE;
    DWORD result = 0;
    if (!remote && !restore) {
        HANDLE file = CreateFileW(path, GENERIC_READ, FILE_SHARE_READ, NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
        LARGE_INTEGER size = {0};
        BYTE *bytes = NULL;
        DWORD read = 0;
        if (file != INVALID_HANDLE_VALUE && GetFileSizeEx(file, &size) && size.QuadPart > 0 && size.QuadPart <= 64 * 1024 * 1024) {
            bytes = malloc((size_t)size.QuadPart);
            if (bytes && ReadFile(file, bytes, (DWORD)size.QuadPart, &read, NULL) && read == size.QuadPart)
                success = blur_map(process, bytes, (size_t)size.QuadPart, &remote);
        }
        if (file != INVALID_HANDLE_VALUE) CloseHandle(file);
        free(bytes);
        if (success) { wprintf(L"mapped-base=0x%llX\n", (unsigned long long)(ULONG_PTR)remote); fflush(stdout); }
        else fwprintf(stderr, L"Manual mapping failed.\n");
    }

    if (remote) {
        success = remote_call(process, (LPTHREAD_START_ROUTINE)(remote + offset), NULL, &result, &finished, restore ? L"BlurRemove" : L"BlurInstall");
        if (success && result != 0) fwprintf(stderr, L"%s returned error %lu.\n", restore ? L"BlurRemove" : L"BlurInstall", result);
        success = success && result == 0;
    }
    else if (restore) { wprintf(L"No hook DLL is loaded in GPU process %lu.\n", pid); success = TRUE; }
    else success = FALSE;
    if (success) wprintf(L"GPU process %lu: %s. Discord files were not modified.\n", pid, restore ? L"hook disabled" : L"hook installed");
    else fwprintf(stderr, L"Hook operation failed; see operation diagnostics above.\n");
    free(path);
    CloseHandle(process);
    return success ? 0 : 1;
}
