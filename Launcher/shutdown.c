#include <windows.h>
#include <tlhelp32.h>
#include <stdio.h>
#include <stdlib.h>
#include <wchar.h>
#include "shutdown.h"

typedef struct RunningProcess {
    HANDLE handle;
    DWORD pid;
} RunningProcess;

#include "logging.h"

static const wchar_t *normal_path(const wchar_t *path)
{
    return wcsncmp(path, L"\\\\?\\", 4) == 0 ? path + 4 : path;
}

static int request_quit(DWORD pid, ULONGLONG deadline)
{
    wchar_t name[80];
    HANDLE pipe;
    OVERLAPPED io = {0};
    DWORD server_pid, written = 0;
    int requested = 0;
    swprintf_s(name, 80, L"\\\\.\\pipe\\Bedrock-%lu", pid);
    pipe = CreateFileW(name, GENERIC_WRITE, 0, NULL, OPEN_EXISTING, FILE_FLAG_OVERLAPPED, NULL);
    if (pipe == INVALID_HANDLE_VALUE) return 0;
    if (!GetNamedPipeServerProcessId(pipe, &server_pid) || server_pid != pid) goto done;
    io.hEvent = CreateEventW(NULL, TRUE, FALSE, NULL);
    if (!io.hEvent) goto done;
    if (WriteFile(pipe, "quit\n", 5, &written, &io)) requested = written == 5;
    else if (GetLastError() == ERROR_IO_PENDING) {
        ULONGLONG now = GetTickCount64();
        if (WaitForSingleObject(io.hEvent, now < deadline ? (DWORD)(deadline - now) : 0) == WAIT_OBJECT_0)
            requested = GetOverlappedResult(pipe, &io, &written, FALSE) && written == 5;
        else {
            CancelIoEx(pipe, &io);
            GetOverlappedResult(pipe, &io, &written, TRUE);
        }
    }
done:
    if (io.hEvent) CloseHandle(io.hEvent);
    CloseHandle(pipe);
    return requested;
}

int shutdown_discord(const wchar_t *executable)
{
    HANDLE snapshot;
    PROCESSENTRY32W entry = {0};
    RunningProcess *processes = NULL;
    wchar_t *image = malloc(32768 * sizeof(*image));
    const wchar_t *name = wcsrchr(executable, L'\\');
    DWORD own_session;
    size_t count = 0, i;
    int success = 0, graceful = 0;
    ULONGLONG deadline;
    name = name ? name + 1 : executable;
    if (!image || !ProcessIdToSessionId(GetCurrentProcessId(), &own_session)) goto done;
    snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (snapshot == INVALID_HANDLE_VALUE) goto done;
    entry.dwSize = sizeof(entry);
    if (!Process32FirstW(snapshot, &entry)) { CloseHandle(snapshot); goto done; }
    do {
        DWORD session_id, size = 32768;
        HANDLE handle;
        RunningProcess *grown;
        if (entry.th32ProcessID == GetCurrentProcessId() || _wcsicmp(entry.szExeFile, name) != 0 ||
            !ProcessIdToSessionId(entry.th32ProcessID, &session_id) || session_id != own_session) continue;
        handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE | SYNCHRONIZE, FALSE, entry.th32ProcessID);
        if (!handle) {
            if (GetLastError() == ERROR_INVALID_PARAMETER) continue;
            fwprintf(stderr, L"Cannot open Discord process %lu (Windows error %lu).\n", entry.th32ProcessID, GetLastError());
            CloseHandle(snapshot); goto done;
        }
        if (!QueryFullProcessImageNameW(handle, 0, image, &size)) {
            if (WaitForSingleObject(handle, 0) == WAIT_OBJECT_0) { CloseHandle(handle); continue; }
            CloseHandle(handle); CloseHandle(snapshot); goto done;
        }
        if (_wcsicmp(normal_path(image), normal_path(executable)) != 0) { CloseHandle(handle); continue; }
        grown = realloc(processes, (count + 1) * sizeof(*processes));
        if (!grown) { CloseHandle(handle); CloseHandle(snapshot); goto done; }
        processes = grown;
        processes[count].handle = handle;
        processes[count++].pid = entry.th32ProcessID;
    } while (Process32NextW(snapshot, &entry));
    CloseHandle(snapshot);
    if (!count) { success = 1; goto done; }
    wprintf(L"Closing %zu existing Discord processes.\n", count);
    deadline = GetTickCount64() + 2000;
    for (i = 0; i < count; ++i) graceful |= request_quit(processes[i].pid, deadline);
    if (graceful) {
        wprintf(L"Asked Discord to quit. Waiting up to two seconds.\n");
        for (i = 0; i < count; ++i) {
            ULONGLONG now = GetTickCount64();
            WaitForSingleObject(processes[i].handle, now < deadline ? (DWORD)(deadline - now) : 0);
        }
    }
    success = 1;
    for (i = 0; i < count; ++i) {
        if (WaitForSingleObject(processes[i].handle, 0) == WAIT_OBJECT_0) continue;
        wprintf(L"Terminating Discord process %lu.\n", processes[i].pid);
        if (!TerminateProcess(processes[i].handle, 1) && WaitForSingleObject(processes[i].handle, 0) != WAIT_OBJECT_0) {
            fwprintf(stderr, L"Cannot terminate Discord process %lu (Windows error %lu).\n", processes[i].pid, GetLastError());
            success = 0;
        }
    }
    deadline = GetTickCount64() + 2000;
    for (i = 0; i < count; ++i) {
        ULONGLONG now = GetTickCount64();
        if (WaitForSingleObject(processes[i].handle, now < deadline ? (DWORD)(deadline - now) : 0) != WAIT_OBJECT_0) {
            fwprintf(stderr, L"Discord process %lu did not exit.\n", processes[i].pid);
            success = 0;
        }
    }
done:
    for (i = 0; i < count; ++i) CloseHandle(processes[i].handle);
    free(processes);
    free(image);
    if (!success) fwprintf(stderr, L"Cannot finish closing Discord. Launch cancelled.\n");
    return success;
}
