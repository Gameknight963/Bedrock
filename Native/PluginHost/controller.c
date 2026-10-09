#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <wchar.h>
#include <fcntl.h>
#include <io.h>
#include "transport.h"
#include "mapper.h"

static HANDLE target, pipe_input;
static void fail(const wchar_t *operation)
{
    fwprintf(stderr, L"%ls failed (Windows error %lu).\n", operation, GetLastError());
}
static DWORD WINAPI forward_input(void *unused)
{
    (void)unused;
    BYTE buffer[4096]; DWORD read;
    while (ReadFile(GetStdHandle(STD_INPUT_HANDLE), buffer, sizeof(buffer), &read, NULL) && read) {
        DWORD offset = 0, written;
        while (offset < read) {
            if (!WriteFile(pipe_input, buffer + offset, read - offset, &written, NULL) || !written) return 1;
            offset += written;
        }
    }
    CloseHandle(pipe_input); pipe_input = NULL;
    return 0;
}
static bool map_file(const wchar_t *path, BYTE **base)
{
    HANDLE file = CreateFileW(path, GENERIC_READ, FILE_SHARE_READ, NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
    LARGE_INTEGER size; DWORD read; bool okay = false;
    if (file == INVALID_HANDLE_VALUE) { fail(L"Open native DLL"); return false; }
    if (GetFileSizeEx(file, &size) && size.QuadPart > 0 && size.QuadPart <= 64 * 1024 * 1024) {
        BYTE *bytes = malloc((size_t)size.QuadPart);
        if (bytes && ReadFile(file, bytes, (DWORD)size.QuadPart, &read, NULL) && read == size.QuadPart)
            okay = native_map(target, bytes, (size_t)size.QuadPart, base) != FALSE;
        free(bytes);
    }
    CloseHandle(file);
    if (!okay) fwprintf(stderr, L"Cannot manually map the native DLL. Check its architecture and imports.\n");
    return okay;
}
int wmain(int argc, wchar_t **argv)
{
    if (argc != 5) { fwprintf(stderr, L"Usage: native-controller PID TYPE HOST_DLL PLUGIN_DLL\n"); return 1; }
    wchar_t *end; unsigned long pid = wcstoul(argv[1], &end, 10);
    if (!pid || *end) return 1;
    unsigned long type = wcstoul(argv[2], &end, 10);
    if (*end || type > BEDROCK_PROCESS_GPU) return 1;
    _setmode(_fileno(stdin), _O_BINARY); _setmode(_fileno(stdout), _O_BINARY);
    target = OpenProcess(PROCESS_CREATE_THREAD | PROCESS_QUERY_INFORMATION | PROCESS_VM_OPERATION | PROCESS_VM_READ | PROCESS_VM_WRITE | PROCESS_DUP_HANDLE | SYNCHRONIZE, FALSE, pid);
    if (!target) { fail(L"Open native plugin target"); return 1; }
    BOOL wow64 = FALSE;
    if (!IsWow64Process(target, &wow64) || wow64) { fwprintf(stderr, L"Native plugin targets must be Windows x64 processes.\n"); return 1; }
    BYTE *host_base = NULL, *plugin_base = NULL;
    if (!map_file(argv[3], &host_base)) return 1;
    if (type != BEDROCK_PROCESS_MAIN && !map_file(argv[4], &plugin_base)) return 1;
    HMODULE local = LoadLibraryExW(argv[3], NULL, DONT_RESOLVE_DLL_REFERENCES);
    FARPROC run = local ? GetProcAddress(local, "BedrockHostRun") : NULL;
    if (!run) { fwprintf(stderr, L"Native host DLL is missing BedrockHostRun.\n"); return 1; }
    SIZE_T offset = (BYTE *)run - (BYTE *)local; FreeLibrary(local);
    HANDLE input_read, output_read, output_write;
    if (!CreatePipe(&input_read, &pipe_input, NULL, 65536) || !CreatePipe(&output_read, &output_write, NULL, 65536)) { fail(L"Create native host pipes"); return 1; }
    HostLaunch *launch = calloc(1, sizeof(*launch));
    if (!launch) return 1;
    // Duplicate existing pipe handles; the sandbox never has to open a pipe by name.
    if (!DuplicateHandle(GetCurrentProcess(), input_read, target, &launch->input, 0, FALSE, DUPLICATE_SAME_ACCESS) ||
        !DuplicateHandle(GetCurrentProcess(), output_write, target, &launch->output, 0, FALSE, DUPLICATE_SAME_ACCESS)) { fail(L"Duplicate native host pipes"); return 1; }
    CloseHandle(input_read); CloseHandle(output_write);
    launch->plugin = plugin_base; launch->process_type = (BedrockProcessType)type;
    if (wcslen(argv[4]) >= 32768) return 1;
    wcscpy_s(launch->path, 32768, argv[4]);
    HostLaunch *remote = VirtualAllocEx(target, NULL, sizeof(*launch), MEM_RESERVE | MEM_COMMIT, PAGE_READWRITE);
    if (!remote || !WriteProcessMemory(target, remote, launch, sizeof(*launch), NULL)) { fail(L"Write native host arguments"); return 1; }
    free(launch);
    HANDLE worker = CreateRemoteThread(target, NULL, 0, (LPTHREAD_START_ROUTINE)(host_base + offset), remote, 0, NULL);
    if (!worker) { fail(L"Start native host worker"); return 1; }
    HANDLE input_thread = CreateThread(NULL, 0, forward_input, NULL, 0, NULL);
    if (!input_thread) { fail(L"Start native IPC forwarding"); return 1; }
    BYTE bytes[4096]; DWORD read;
    while (ReadFile(output_read, bytes, sizeof(bytes), &read, NULL) && read) {
        if (fwrite(bytes, 1, read, stdout) != read) break;
        fflush(stdout);
    }
    CancelSynchronousIo(input_thread);
    WaitForSingleObject(input_thread, 1000);
    CloseHandle(input_thread); CloseHandle(output_read);
    if (pipe_input) CloseHandle(pipe_input);
    if (WaitForSingleObject(worker, 1000) == WAIT_OBJECT_0) VirtualFreeEx(target, remote, 0, MEM_RELEASE);
    CloseHandle(worker); CloseHandle(target);
    return 0;
}
