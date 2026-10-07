#include <winsock2.h>
#include <windows.h>
#include <winternl.h>
#include <winhttp.h>
#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <string.h>
#include <wchar.h>

#define PATH_CAP 32768
#define SENTINEL "dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX"
#define SENTINEL_SIZE (sizeof(SENTINEL) - 1)
#define INSPECTOR_INDEX 3

typedef struct FuseLocation {
    DWORD rva;
    BYTE version;
    BYTE count;
    BYTE wire[255];
} FuseLocation;

static void win_error(const wchar_t *operation)
{
    DWORD code = GetLastError();
    wchar_t message[512] = {0};
    FormatMessageW(FORMAT_MESSAGE_FROM_SYSTEM | FORMAT_MESSAGE_IGNORE_INSERTS,
        NULL, code, 0, message, 512, NULL);
    fwprintf(stderr, L"%ls failed (%lu): %ls\n", operation, code, message);
}

static int range_ok(size_t offset, size_t length, size_t size)
{
    return offset <= size && length <= size - offset;
}

/* Translate a file offset to a mapped-image RVA; these are not interchangeable. */
static int locate_fuse(const wchar_t *path, FuseLocation *fuse)
{
    HANDLE file = INVALID_HANDLE_VALUE, mapping = NULL;
    const BYTE *data = NULL;
    LARGE_INTEGER length;
    size_t size, i, found = 0, wire_offset = 0, section_offset;
    IMAGE_DOS_HEADER dos;
    IMAGE_FILE_HEADER header;
    DWORD signature;
    WORD magic;
    int result = 0;

    file = CreateFileW(path, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
        NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
    if (file == INVALID_HANDLE_VALUE) { win_error(L"Open executable"); goto done; }
    if (!GetFileSizeEx(file, &length)) { win_error(L"GetFileSizeEx"); goto done; }
    if (length.QuadPart <= 0 || (ULONGLONG)length.QuadPart > SIZE_MAX) goto invalid;
    size = (size_t)length.QuadPart;
    mapping = CreateFileMappingW(file, NULL, PAGE_READONLY, 0, 0, NULL);
    if (!mapping) { win_error(L"CreateFileMappingW"); goto done; }
    data = MapViewOfFile(mapping, FILE_MAP_READ, 0, 0, 0);
    if (!data) { win_error(L"MapViewOfFile"); goto done; }
    if (!range_ok(0, sizeof(dos), size)) goto invalid;
    memcpy(&dos, data, sizeof(dos));
    if (dos.e_magic != IMAGE_DOS_SIGNATURE || dos.e_lfanew < 0 ||
        !range_ok((size_t)dos.e_lfanew, sizeof(signature) + sizeof(header), size)) goto invalid;
    memcpy(&signature, data + dos.e_lfanew, sizeof(signature));
    memcpy(&header, data + dos.e_lfanew + sizeof(signature), sizeof(header));
    if (signature != IMAGE_NT_SIGNATURE) goto invalid;
    section_offset = (size_t)dos.e_lfanew + sizeof(signature) + sizeof(header);
    if (header.SizeOfOptionalHeader < sizeof(magic) ||
        !range_ok(section_offset, header.SizeOfOptionalHeader, size)) goto invalid;
    memcpy(&magic, data + section_offset, sizeof(magic));
#ifdef _WIN64
    if (header.Machine != IMAGE_FILE_MACHINE_AMD64 || magic != IMAGE_NT_OPTIONAL_HDR64_MAGIC) {
        fwprintf(stderr, L"Use a launcher matching the executable architecture (this build is x64).\n"); goto done;
    }
#else
    if (header.Machine != IMAGE_FILE_MACHINE_I386 || magic != IMAGE_NT_OPTIONAL_HDR32_MAGIC) {
        fwprintf(stderr, L"Use a launcher matching the executable architecture (this build is x86).\n"); goto done;
    }
#endif
    section_offset += header.SizeOfOptionalHeader;
    if (!range_ok(section_offset, (size_t)header.NumberOfSections * sizeof(IMAGE_SECTION_HEADER), size)) goto invalid;
    for (i = 0; range_ok(i, SENTINEL_SIZE + 2, size); ++i) {
        if (data[i] == SENTINEL[0] && memcmp(data + i, SENTINEL, SENTINEL_SIZE) == 0) {
            ++found;
            wire_offset = i + SENTINEL_SIZE;
        }
    }
    if (found != 1) {
        fwprintf(stderr, L"Expected exactly one Electron fuse sentinel; found %zu.\n", found); goto done;
    }
    fuse->version = data[wire_offset];
    fuse->count = data[wire_offset + 1];
    if (fuse->version != 1 || fuse->count <= INSPECTOR_INDEX ||
        !range_ok(wire_offset + 2, fuse->count, size)) goto invalid;
    memcpy(fuse->wire, data + wire_offset + 2, fuse->count);
    for (i = 0; i < fuse->count; ++i)
        if (fuse->wire[i] != '0' && fuse->wire[i] != '1' && fuse->wire[i] != 'r') goto invalid;
    if (fuse->wire[INSPECTOR_INDEX] == 'r') {
        fwprintf(stderr, L"The inspector fuse has been removed in this executable.\n"); goto done;
    }
    for (i = 0; i < header.NumberOfSections; ++i) {
        IMAGE_SECTION_HEADER section;
        size_t offset = wire_offset + 2;
        memcpy(&section, data + section_offset + i * sizeof(section), sizeof(section));
        if (offset >= section.PointerToRawData &&
            offset - section.PointerToRawData <= section.SizeOfRawData &&
            fuse->count <= section.SizeOfRawData - (offset - section.PointerToRawData)) {
            size_t rva = section.VirtualAddress + (offset - section.PointerToRawData);
            if (rva > MAXDWORD) goto invalid;
            fuse->rva = (DWORD)rva;
            result = 1;
            goto done;
        }
    }
invalid:
    fwprintf(stderr, L"Unsupported or malformed PE/fuse layout; nothing will be patched.\n");
done:
    if (data) UnmapViewOfFile(data);
    if (mapping) CloseHandle(mapping);
    if (file != INVALID_HANDLE_VALUE) CloseHandle(file);
    return result;
}

static int discover_discord(wchar_t *path)
{
    wchar_t root[PATH_CAP], pattern[PATH_CAP], candidate[PATH_CAP];
    WIN32_FIND_DATAW entry;
    HANDLE search;
    unsigned best[4] = {0}, version[4];
    DWORD n = GetEnvironmentVariableW(L"LOCALAPPDATA", root, PATH_CAP);
    int have_best = 0;
    if (!n || n >= PATH_CAP || swprintf_s(pattern, PATH_CAP, L"%ls\\Discord\\app-*", root) < 0) return 0;
    search = FindFirstFileW(pattern, &entry);
    if (search == INVALID_HANDLE_VALUE) return 0;
    do {
        wchar_t extra;
        int newer = !have_best, j;
        memset(version, 0, sizeof(version));
        if (!(entry.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) ||
            swscanf_s(entry.cFileName, L"app-%u.%u.%u%lc", &version[0], &version[1], &version[2], &extra, 1) != 3) continue;
        for (j = 0; j < 4 && have_best; ++j) {
            if (version[j] != best[j]) { newer = version[j] > best[j]; break; }
        }
        if (!newer || swprintf_s(candidate, PATH_CAP, L"%ls\\Discord\\%ls\\Discord.exe", root, entry.cFileName) < 0) continue;
        n = GetFileAttributesW(candidate);
        if (n == INVALID_FILE_ATTRIBUTES || (n & FILE_ATTRIBUTE_DIRECTORY)) continue;
        wcscpy_s(path, PATH_CAP, candidate);
        memcpy(best, version, sizeof(best));
        have_best = 1;
    } while (FindNextFileW(search, &entry));
    FindClose(search);
    return have_best;
}

/* The initial executable is mapped even before its suspended thread runs.
   Query its PEB rather than relying on loader module lists being initialized. */
static int patch_child(HANDLE process, const FuseLocation *fuse)
{
    typedef NTSTATUS (NTAPI *QueryProcess)(HANDLE, PROCESSINFOCLASS, PVOID, ULONG, PULONG);
    QueryProcess query = (QueryProcess)GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "NtQueryInformationProcess");
    PROCESS_BASIC_INFORMATION basic;
    uintptr_t image_base = 0;
    BYTE actual[255], enabled = '1', verify = 0;
    SIZE_T transferred;
    DWORD old_protection, ignored;
    BYTE *wire, *target;
    NTSTATUS status;
    int written, restored;
    if (!query) { win_error(L"Resolve NtQueryInformationProcess"); return 0; }
    status = query(process, ProcessBasicInformation, &basic, sizeof(basic), NULL);
    if (status < 0) { fwprintf(stderr, L"NtQueryInformationProcess failed: 0x%08lX\n", (ULONG)status); return 0; }
    /* ImageBaseAddress is at two pointer widths in the Windows x86/x64 PEB. */
    if (!ReadProcessMemory(process, (BYTE *)basic.PebBaseAddress + 2 * sizeof(void *),
        &image_base, sizeof(image_base), &transferred) || transferred != sizeof(image_base)) {
        win_error(L"Read image base"); return 0;
    }
    wire = (BYTE *)image_base + fuse->rva;
    if (!ReadProcessMemory(process, wire, actual, fuse->count, &transferred) || transferred != fuse->count) {
        win_error(L"Read mapped fuse wire"); return 0;
    }
    if (memcmp(actual, fuse->wire, fuse->count) != 0) {
        fwprintf(stderr, L"Mapped fuse wire differs from the inspected file; refusing to patch.\n"); return 0;
    }
    target = wire + INSPECTOR_INDEX;
    wprintf(L"Mapped inspector fuse: %p (%lc).\n", (void *)target, actual[INSPECTOR_INDEX]);
    if (actual[INSPECTOR_INDEX] == '1') return 1;
    if (!VirtualProtectEx(process, target, 1, PAGE_READWRITE, &old_protection)) {
        win_error(L"VirtualProtectEx"); return 0;
    }
    written = WriteProcessMemory(process, target, &enabled, 1, &transferred) && transferred == 1;
    if (!written) win_error(L"Write inspector fuse");
    restored = VirtualProtectEx(process, target, 1, old_protection, &ignored);
    if (!restored) win_error(L"Restore page protection");
    if (!written || !restored) return 0;
    if (!ReadProcessMemory(process, target, &verify, 1, &transferred) || transferred != 1 || verify != '1') {
        fwprintf(stderr, L"Inspector fuse readback failed.\n"); return 0;
    }
    wprintf(L"Inspector fuse enabled in process memory; page protection restored.\n");
    return 1;
}

static int port_available(unsigned short port)
{
    WSADATA data;
    SOCKET socket_handle;
    struct sockaddr_in address = {0};
    BOOL exclusive = TRUE;
    int available = 0;
    if (WSAStartup(MAKEWORD(2, 2), &data)) return 0;
    socket_handle = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (socket_handle != INVALID_SOCKET) {
        address.sin_family = AF_INET;
        address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
        address.sin_port = htons(port);
        if (setsockopt(socket_handle, SOL_SOCKET, SO_EXCLUSIVEADDRUSE, (const char *)&exclusive, sizeof(exclusive)) == 0)
            available = bind(socket_handle, (const struct sockaddr *)&address, sizeof(address)) == 0;
        closesocket(socket_handle);
    }
    WSACleanup();
    return available;
}

static int probe_inspector(HINTERNET session, unsigned short port)
{
    HINTERNET connection = WinHttpConnect(session, L"127.0.0.1", port, 0), request = NULL;
    char body[16384];
    DWORD status = 0, status_size = sizeof(status), read = 0, total = 0;
    int result = 0;
    if (!connection) return 0;
    request = WinHttpOpenRequest(connection, L"GET", L"/json/list", NULL, WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES, 0);
    if (!request) goto done;
    if (!WinHttpSendRequest(request, WINHTTP_NO_ADDITIONAL_HEADERS, 0, WINHTTP_NO_REQUEST_DATA, 0, 0, 0) ||
        !WinHttpReceiveResponse(request, NULL) ||
        !WinHttpQueryHeaders(request, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
            WINHTTP_HEADER_NAME_BY_INDEX, &status, &status_size, WINHTTP_NO_HEADER_INDEX) || status != 200) goto done;
    while (total < sizeof(body) - 1) {
        if (!WinHttpReadData(request, body + total, (DWORD)sizeof(body) - 1 - total, &read)) goto done;
        if (!read) break;
        total += read;
    }
    body[total] = 0;
    if (strstr(body, "webSocketDebuggerUrl")) {
        wprintf(L"Inspector responded at http://127.0.0.1:%hu/json/list\n", port);
        /* Print only the endpoint, not runtime data. */
        {
            char *start = strstr(body, "ws://"), *end;
            if (start && (end = strchr(start, '"')) != NULL) {
                *end = 0;
                wprintf(L"Debugger WebSocket: %hs\n", start);
            }
        }
        result = 1;
    }
done:
    if (request) WinHttpCloseHandle(request);
    WinHttpCloseHandle(connection);
    return result;
}

int wmain(int argc, wchar_t **argv)
{
    wchar_t path[PATH_CAP] = {0}, directory[PATH_CAP], command[PATH_CAP + 128];
    unsigned short port = 9229;
    int check_only = 0, i, success = 0;
    FuseLocation fuse = {0};
    STARTUPINFOW startup = {0};
    PROCESS_INFORMATION child = {0};
    HINTERNET session = NULL;
    ULONGLONG deadline;
    for (i = 1; i < argc; ++i) {
        if (wcscmp(argv[i], L"--check") == 0) check_only = 1;
        else if (wcscmp(argv[i], L"--exe") == 0 && i + 1 < argc) {
            DWORD length = GetFullPathNameW(argv[++i], PATH_CAP, path, NULL);
            if (!length) { win_error(L"Resolve executable"); return 1; }
            if (length >= PATH_CAP) { fwprintf(stderr, L"Executable path is too long.\n"); return 1; }
        } else if (wcscmp(argv[i], L"--port") == 0 && i + 1 < argc) {
            wchar_t *end;
            unsigned long value = wcstoul(argv[++i], &end, 10);
            if (*end || value < 1 || value > 65535) { fwprintf(stderr, L"Invalid port.\n"); return 1; }
            port = (unsigned short)value;
        } else {
            wprintf(L"Usage: BedrockLauncher [--check] [--exe <Discord.exe>] [--port <1-65535>]\n");
            return wcscmp(argv[i], L"--help") == 0 ? 0 : 1;
        }
    }
    if (!path[0] && !discover_discord(path)) {
        fwprintf(stderr, L"Cannot locate Discord. Supply --exe with the application executable.\n"); return 1;
    }
    if (wcschr(path, L'"')) return 1;
    wprintf(L"Executable: %ls\n", path);
    if (!locate_fuse(path, &fuse)) return 1;
    wprintf(L"Fuse format %u, %u settings; inspector %lc; wire RVA 0x%08lX.\n",
        fuse.version, fuse.count, fuse.wire[INSPECTOR_INDEX], fuse.rva);
    if (check_only) { wprintf(L"Read-only check passed. No process started or memory changed.\n"); return 0; }
    if (!port_available(port)) {
        fwprintf(stderr, L"Loopback port %hu unavailable. Choose another with --port.\n", port); return 1;
    }
    wcscpy_s(directory, PATH_CAP, path);
    { wchar_t *slash = wcsrchr(directory, L'\\'); if (!slash) return 1; *slash = 0; }
    if (swprintf_s(command, PATH_CAP + 128, L"\"%ls\" --inspect-brk=127.0.0.1:%hu", path, port) < 0) return 1;
    startup.cb = sizeof(startup);
    if (!CreateProcessW(path, command, NULL, NULL, FALSE, CREATE_SUSPENDED, NULL, directory, &startup, &child)) {
        win_error(L"CreateProcessW"); return 1;
    }
    wprintf(L"Created suspended process %lu.\n", child.dwProcessId);
    if (!patch_child(child.hProcess, &fuse)) goto done;
    if (ResumeThread(child.hThread) == (DWORD)-1) { win_error(L"ResumeThread"); goto done; }
    session = WinHttpOpen(L"BedrockLauncher/0.1", WINHTTP_ACCESS_TYPE_NO_PROXY,
        WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0);
    if (!session) { win_error(L"WinHttpOpen"); goto done; }
    WinHttpSetTimeouts(session, 300, 300, 300, 300);
    deadline = GetTickCount64() + 15000;
    while (GetTickCount64() < deadline) {
        if (WaitForSingleObject(child.hProcess, 0) != WAIT_TIMEOUT) break;
        if (probe_inspector(session, port)) { success = 1; break; }
        Sleep(100);
    }
    if (success) {
        wprintf(L"Success: Node inspector is reachable. JavaScript remains paused.\n"
            L"In Chrome/Edge, open chrome://inspect or edge://inspect, configure localhost:%hu,\n"
            L"then inspect the Node target and resume execution. Quit Discord before retrying.\n", port);
    } else fwprintf(stderr, L"Inspector did not appear within 15 seconds, or the child exited.\n"
        L"Quit any existing Discord instance before retrying.\n");
done:
    if (!success) {
        /* Never leave an unsuccessful suspended/debugger-waiting child behind. */
        if (!TerminateProcess(child.hProcess, 1) && WaitForSingleObject(child.hProcess, 0) == WAIT_TIMEOUT)
            win_error(L"Terminate failed experiment");
        WaitForSingleObject(child.hProcess, 3000);
    }
    if (session) WinHttpCloseHandle(session);
    CloseHandle(child.hThread);
    CloseHandle(child.hProcess);
    return success ? 0 : 1;
}
