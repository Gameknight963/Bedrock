#include <windows.h>
#include <stdio.h>
#include <stdarg.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>
#define JSMN_STATIC
#define JSMN_STRICT
#include "../lib/jsmn/jsmn.h"

static wchar_t log_path[32768];

void launcher_logging_init(void)
{
    FILE *stream;
    AllocConsole();
    _wfreopen_s(&stream, L"CONOUT$", L"w", stdout);
    _wfreopen_s(&stream, L"CONOUT$", L"w", stderr);
    wchar_t *root = calloc(32768, sizeof(wchar_t));
    if (!root) return;
    DWORD length = GetModuleFileNameW(NULL, root, 32768);
    if (!length || length >= 32768) { free(root); return; }
    wchar_t *slash = wcsrchr(root, L'\\');
    if (!slash) { free(root); return; }
    slash[1] = 0;
    wcscpy_s(log_path, 32768, root);
    wcscat_s(log_path, 32768, L"BedrockData\\data\\bedrock.console\\settings.json");
    char json[8192];
    jsmntok_t tokens[256];
    jsmn_parser parser;
    int enabled = 0;
    if (!_wfopen_s(&stream, log_path, L"rb")) {
        size_t size = fread(json, 1, sizeof(json) - 1, stream);
        fclose(stream);
        json[size] = 0;
        jsmn_init(&parser);
        int count = jsmn_parse(&parser, json, size, tokens, 256);
        for (int i = 1; i + 1 < count; i++) {
            if (tokens[i].type == JSMN_STRING && tokens[i].end - tokens[i].start == 9 &&
                !memcmp(json + tokens[i].start, "writeLogs", 9) &&
                tokens[i + 1].type == JSMN_PRIMITIVE && tokens[i + 1].end - tokens[i + 1].start == 4 &&
                !memcmp(json + tokens[i + 1].start, "true", 4)) enabled = 1;
        }
    }
    log_path[0] = 0;
    if (enabled) {
        wcscat_s(root, 32768, L"BedrockData"); CreateDirectoryW(root, NULL);
        wcscat_s(root, 32768, L"\\logs"); CreateDirectoryW(root, NULL);
        swprintf_s(log_path, 32768, L"%ls\\latest.log", root);
        SYSTEMTIME time; GetLocalTime(&time);
        wchar_t *archive = calloc(32768, sizeof(wchar_t));
        if (archive) {
            swprintf_s(archive, 32768, L"%ls\\%04u-%02u-%02u_%02u-%02u-%02u-%lu.log", root,
                time.wYear, time.wMonth, time.wDay, time.wHour, time.wMinute, time.wSecond, GetCurrentProcessId());
            MoveFileW(log_path, archive);
            free(archive);
        }
    }
    free(root);
}

static int print_message(FILE *stream, const wchar_t *format, va_list args)
{
    va_list copy; va_copy(copy, args);
    int length = _vscwprintf(format, copy); va_end(copy);
    if (length < 0) return length;
    wchar_t *text = malloc(((size_t)length + 1) * sizeof(wchar_t));
    if (!text) return -1;
    vswprintf_s(text, (size_t)length + 1, format, args);
    int result = fputws(text, stream); fflush(stream);
    if (log_path[0]) {
        int bytes = WideCharToMultiByte(CP_UTF8, 0, text, length, NULL, 0, NULL, NULL);
        char *utf8 = malloc((size_t)bytes);
        if (utf8) {
            WideCharToMultiByte(CP_UTF8, 0, text, length, utf8, bytes, NULL, NULL);
            HANDLE file = CreateFileW(log_path, FILE_APPEND_DATA, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                NULL, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
            if (file != INVALID_HANDLE_VALUE) { DWORD written; WriteFile(file, utf8, (DWORD)bytes, &written, NULL); CloseHandle(file); }
            free(utf8);
        }
    }
    free(text);
    return result;
}

int launcher_fwprintf(FILE *stream, const wchar_t *format, ...)
{
    va_list args; va_start(args, format);
    int result = print_message(stream, format, args); va_end(args); return result;
}
int launcher_wprintf(const wchar_t *format, ...)
{
    va_list args; va_start(args, format);
    int result = print_message(stdout, format, args); va_end(args); return result;
}
