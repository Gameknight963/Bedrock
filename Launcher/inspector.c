#include <winsock2.h>
#include "inspector.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>
#include "logging.h"

#define JSMN_STATIC
#define JSMN_STRICT
#include "../lib/jsmn/jsmn.h"

#define MESSAGE_CAP (1024 * 1024)
#define TOKEN_CAP 32768

typedef struct Json {
    const char *text;
    jsmntok_t *tokens;
    int count;
} Json;

typedef struct Inspector {
    HINTERNET socket;
    unsigned next_id;
    char frame[256];
} Inspector;

static int json_parse(Json *json, const char *text)
{
    jsmn_parser parser;
    json->text = text;
    json->tokens = malloc(TOKEN_CAP * sizeof(*json->tokens));
    if (!json->tokens) return 0;
    jsmn_init(&parser);
    json->count = jsmn_parse(&parser, text, strlen(text), json->tokens, TOKEN_CAP);
    return json->count > 0;
}

static int json_equal(const Json *json, int token, const char *value)
{
    return token >= 0 && token < json->count &&
        (size_t)(json->tokens[token].end - json->tokens[token].start) == strlen(value) &&
        memcmp(json->text + json->tokens[token].start, value, strlen(value)) == 0;
}

static int json_next(const Json *json, int token)
{
    int end = json->tokens[token].end;
    ++token;
    while (token < json->count && json->tokens[token].start < end) ++token;
    return token;
}

static int json_field(const Json *json, int object, const char *key)
{
    int token;
    if (object < 0 || object >= json->count || json->tokens[object].type != JSMN_OBJECT) return -1;
    for (token = object + 1; token < json->count && json->tokens[token].start < json->tokens[object].end;) {
        if (token + 1 >= json->count) return -1;
        if (json_equal(json, token, key)) return token + 1;
        token = json_next(json, token + 1);
    }
    return -1;
}

static int json_copy(const Json *json, int token, char *out, size_t capacity)
{
    size_t length;
    if (token < 0 || token >= json->count || json->tokens[token].type != JSMN_STRING) return 0;
    length = (size_t)(json->tokens[token].end - json->tokens[token].start);
    if (length >= capacity) return 0;
    memcpy(out, json->text + json->tokens[token].start, length);
    out[length] = 0;
    /* Endpoint UUIDs and frame IDs need no JSON unescaping. Reject escapes. */
    return strchr(out, '\\') == NULL;
}

int inspector_endpoint(HINTERNET session, INTERNET_PORT port, wchar_t *endpoint, size_t capacity)
{
    HINTERNET connection = NULL, request = NULL;
    char *body = malloc(16384), url[512], prefix[64];
    DWORD status, status_size = sizeof(status), total = 0, received;
    Json json = {0};
    int result = 0, token, url_token;
    if (!body) return 0;
    connection = WinHttpConnect(session, L"127.0.0.1", port, 0);
    if (!connection) goto done;
    request = WinHttpOpenRequest(connection, L"GET", L"/json/list", NULL, WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES, 0);
    if (!request || !WinHttpSendRequest(request, WINHTTP_NO_ADDITIONAL_HEADERS, 0, WINHTTP_NO_REQUEST_DATA, 0, 0, 0) ||
        !WinHttpReceiveResponse(request, NULL) ||
        !WinHttpQueryHeaders(request, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
            WINHTTP_HEADER_NAME_BY_INDEX, &status, &status_size, WINHTTP_NO_HEADER_INDEX) || status != 200) goto done;
    for (;;) {
        if (total == 16383) goto done;
        if (!WinHttpReadData(request, body + total, 16383 - total, &received)) goto done;
        if (!received) break;
        total += received;
    }
    body[total] = 0;
    if (!json_parse(&json, body) || !json.tokens || json.tokens[0].type != JSMN_ARRAY) goto done;
    sprintf_s(prefix, sizeof(prefix), "ws://127.0.0.1:%hu/", port);
    for (token = 1; token < json.count; token = json_next(&json, token)) {
        url_token = json_field(&json, token, "webSocketDebuggerUrl");
        if (!json_copy(&json, url_token, url, sizeof(url)) || strncmp(url, prefix, strlen(prefix)) != 0) continue;
        result = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, url + strlen(prefix) - 1,
            -1, endpoint, (int)capacity) != 0;
        break;
    }
done:
    free(json.tokens);
    free(body);
    if (request) WinHttpCloseHandle(request);
    if (connection) WinHttpCloseHandle(connection);
    return result;
}

static HINTERNET connect_inspector(HINTERNET session, INTERNET_PORT port, const wchar_t *endpoint)
{
    HINTERNET connection = NULL, request = NULL, socket = NULL;
    DWORD status = 0, size = sizeof(status);
    connection = WinHttpConnect(session, L"127.0.0.1", port, 0);
    if (!connection) goto done;
    request = WinHttpOpenRequest(connection, L"GET", endpoint, NULL, WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES, 0);
    if (!request) goto done;
    /* This option requires NULL/0 despite WinHTTP's generic buffer annotation. */
#pragma warning(suppress: 6387)
    if (!WinHttpSetOption(request, WINHTTP_OPTION_UPGRADE_TO_WEB_SOCKET, NULL, 0) ||
        !WinHttpSendRequest(request, WINHTTP_NO_ADDITIONAL_HEADERS, 0, WINHTTP_NO_REQUEST_DATA, 0, 0, 0) ||
        !WinHttpReceiveResponse(request, NULL) ||
        !WinHttpQueryHeaders(request, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
            WINHTTP_HEADER_NAME_BY_INDEX, &status, &size, WINHTTP_NO_HEADER_INDEX) || status != 101) goto done;
    socket = WinHttpWebSocketCompleteUpgrade(request, 0);
done:
    if (!socket) fwprintf(stderr, L"Inspector WebSocket connection failed (HTTP %lu, Windows error %lu).\n", status, GetLastError());
    if (request) WinHttpCloseHandle(request);
    if (connection) WinHttpCloseHandle(connection);
    return socket;
}

static char *receive_message(HINTERNET socket)
{
    size_t capacity = 4096, total = 0;
    char *message = malloc(capacity);
    WINHTTP_WEB_SOCKET_BUFFER_TYPE type;
    DWORD error, received;
    if (!message) return NULL;
    for (;;) {
        if (total == capacity - 1) {
            char *larger;
            if (capacity >= MESSAGE_CAP) break;
            capacity *= 2;
            larger = realloc(message, capacity);
            if (!larger) break;
            message = larger;
        }
        error = WinHttpWebSocketReceive(socket, message + total, (DWORD)(capacity - 1 - total), &received, &type);
        if (error != NO_ERROR) {
            fwprintf(stderr, L"Cannot receive an inspector message (Windows error %lu).\n", error);
            break;
        }
        if (type != WINHTTP_WEB_SOCKET_UTF8_FRAGMENT_BUFFER_TYPE && type != WINHTTP_WEB_SOCKET_UTF8_MESSAGE_BUFFER_TYPE) break;
        total += received;
        if (type == WINHTTP_WEB_SOCKET_UTF8_MESSAGE_BUFFER_TYPE) {
            message[total] = 0;
            return message;
        }
    }
    free(message);
    return NULL;
}

static void remember_pause(Inspector *inspector, const Json *json)
{
    int params, frames, frame;
    if (!json_equal(json, json_field(json, 0, "method"), "Debugger.paused")) return;
    params = json_field(json, 0, "params");
    frames = json_field(json, params, "callFrames");
    if (frames < 0 || json->tokens[frames].type != JSMN_ARRAY || json->tokens[frames].size < 1) return;
    frame = json_field(json, frames + 1, "callFrameId");
    json_copy(json, frame, inspector->frame, sizeof(inspector->frame));
}

static char *command(Inspector *inspector, const char *method, const char *params)
{
    unsigned id = ++inspector->next_id;
    size_t capacity = strlen(method) + strlen(params) + 80;
    char *out = malloc(capacity), id_text[32];
    DWORD error;
    ULONGLONG deadline = GetTickCount64() + 15000;
    if (!out) return NULL;
    sprintf_s(out, capacity, "{\"id\":%u,\"method\":\"%s\",\"params\":%s}", id, method, params);
    sprintf_s(id_text, sizeof(id_text), "%u", id);
    error = WinHttpWebSocketSend(inspector->socket, WINHTTP_WEB_SOCKET_UTF8_MESSAGE_BUFFER_TYPE, out, (DWORD)strlen(out));
    free(out);
    if (error != NO_ERROR) { fwprintf(stderr, L"Cannot send an inspector command (Windows error %lu).\n", error); return NULL; }
    while (GetTickCount64() < deadline) {
        char *reply = receive_message(inspector->socket);
        Json json = {0};
        int matches, failed;
        if (!reply) return NULL;
        if (!json_parse(&json, reply)) { free(json.tokens); free(reply); return NULL; }
        remember_pause(inspector, &json);
        matches = json_equal(&json, json_field(&json, 0, "id"), id_text);
        failed = json_field(&json, 0, "error") >= 0 ||
            json_field(&json, json_field(&json, 0, "result"), "exceptionDetails") >= 0;
        free(json.tokens);
        if (matches && !failed) return reply;
        if (matches) fwprintf(stderr, L"Inspector command %hs failed. Reply: %hs\n", method, reply);
        free(reply);
        if (matches) return NULL;
    }
    return NULL;
}

static int simple_command(Inspector *inspector, const char *method)
{
    char *reply = command(inspector, method, "{}");
    if (!reply) return 0;
    free(reply);
    return 1;
}

typedef struct Watchdog {
    HANDLE stop;
    HINTERNET socket;
} Watchdog;

static DWORD WINAPI receive_watchdog(void *context)
{
    Watchdog *watchdog = context;
    /* WinHTTP WebSocket receives do not support the HTTP receive-timeout option.
       Closing the connection cancels a stalled synchronous receive. */
    if (WaitForSingleObject(watchdog->stop, 20000) == WAIT_TIMEOUT)
        WinHttpWebSocketClose(watchdog->socket, WINHTTP_WEB_SOCKET_SUCCESS_CLOSE_STATUS, NULL, 0);
    return 0;
}

static int inspector_port_closed(INTERNET_PORT port)
{
    WSADATA data;
    SOCKET probe;
    struct sockaddr_in address = {0};
    int closed = 0;
    if (WSAStartup(MAKEWORD(2, 2), &data)) return 0;
    probe = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (probe != INVALID_SOCKET) {
        address.sin_family = AF_INET;
        address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
        address.sin_port = htons(port);
        if (connect(probe, (const struct sockaddr *)&address, sizeof(address)) == SOCKET_ERROR)
            closed = WSAGetLastError() == WSAECONNREFUSED;
        closesocket(probe);
    }
    WSACleanup();
    return closed;
}

static char *json_string(const char *text)
{
    size_t length = strlen(text), index;
    char *result = malloc(length * 6 + 3), *out;
    if (!result) return NULL;
    out = result; *out++ = '"';
    for (index = 0; index < length; ++index) {
        unsigned char byte = (unsigned char)text[index];
        if (byte == '"' || byte == '\\') { *out++ = '\\'; *out++ = (char)byte; }
        else if (byte < 32) { sprintf_s(out, 7, "\\u%04x", byte); out += 6; }
        else *out++ = (char)byte;
    }
    *out++ = '"'; *out = 0;
    return result;
}

static int load_bootstrap(Inspector *inspector, const wchar_t *path)
{
    int length = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, path, -1, NULL, 0, NULL, NULL);
    char *utf8 = NULL, *quoted_path = NULL, *expression = NULL, *quoted_expression = NULL, *params = NULL, *reply = NULL;
    size_t capacity;
    int success = 0;
    if (!length) goto done;
    utf8 = malloc((size_t)length);
    if (!utf8 || !WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, path, -1, utf8, length, NULL, NULL)) goto done;
    quoted_path = json_string(utf8);
    if (!quoted_path) goto done;
    capacity = strlen(quoted_path) * 2 + 256;
    expression = malloc(capacity);
    if (!expression) goto done;
    sprintf_s(expression, capacity, "(() => { const file = %s; const require = process.getBuiltinModule('module').createRequire(file); if (require(file).install() !== true) throw new Error('Bootstrap installation failed'); return true; })()", quoted_path);
    quoted_expression = json_string(expression);
    if (!quoted_expression) goto done;
    capacity = strlen(quoted_expression) + strlen(inspector->frame) + 128;
    params = malloc(capacity);
    if (!params) goto done;
    sprintf_s(params, capacity, "{\"callFrameId\":\"%s\",\"expression\":%s,\"returnByValue\":true}", inspector->frame, quoted_expression);
    reply = command(inspector, "Debugger.evaluateOnCallFrame", params);
    success = reply != NULL;
done:
    free(utf8); free(quoted_path); free(expression); free(quoted_expression); free(params); free(reply);
    return success;
}

static int inspector_run(HINTERNET session, INTERNET_PORT port, const wchar_t *endpoint, DWORD expected_pid, const wchar_t *bootstrap_path)
{
    Inspector inspector = {0};
    Json json = {0};
    char params[1024], pid[32], *reply = NULL;
    int result, value, success = 0;
    ULONGLONG deadline;
    Watchdog watchdog = {0};
    HANDLE watchdog_thread = NULL;
    inspector.socket = connect_inspector(session, port, endpoint);
    if (!inspector.socket) return 0;
    watchdog.socket = inspector.socket;
    watchdog.stop = CreateEventW(NULL, TRUE, FALSE, NULL);
    if (!watchdog.stop) goto done;
    watchdog_thread = CreateThread(NULL, 0, receive_watchdog, &watchdog, 0, NULL);
    if (!watchdog_thread) goto done;
    wprintf(L"Connected to Node inspector over WebSocket.\n");
    if (!simple_command(&inspector, "Debugger.enable") ||
        !simple_command(&inspector, "Runtime.runIfWaitingForDebugger")) goto done;
    deadline = GetTickCount64() + 15000;
    while (!inspector.frame[0] && GetTickCount64() < deadline) {
        reply = receive_message(inspector.socket);
        if (!reply || !json_parse(&json, reply)) goto done;
        remember_pause(&inspector, &json);
        free(json.tokens); json.tokens = NULL;
        free(reply); reply = NULL;
    }
    if (!inspector.frame[0]) goto done;
    wprintf(L"Paused at the JavaScript entry point.\n");
    sprintf_s(params, sizeof(params),
        "{\"callFrameId\":\"%s\",\"expression\":\"({value: 1 + 2, pid: process.pid})\",\"returnByValue\":true}", inspector.frame);
    reply = command(&inspector, "Debugger.evaluateOnCallFrame", params);
    if (!reply || !json_parse(&json, reply)) goto done;
    result = json_field(&json, json_field(&json, 0, "result"), "result");
    value = json_field(&json, result, "value");
    sprintf_s(pid, sizeof(pid), "%lu", expected_pid);
    if (!json_equal(&json, json_field(&json, value, "value"), "3") ||
        !json_equal(&json, json_field(&json, value, "pid"), pid)) {
        fwprintf(stderr, L"The JavaScript result or process ID did not match. Reply: %hs\n", reply); goto done;
    }
    wprintf(L"JavaScript test: 1 + 2 = 3 (inside process %lu).\n", expected_pid);
    free(json.tokens); json.tokens = NULL;
    free(reply); reply = NULL;
    if (bootstrap_path) {
        if (!load_bootstrap(&inspector, bootstrap_path)) goto done;
        wprintf(L"Bootstrap loaded: %ls\n", bootstrap_path);
    }
    /* Closing synchronously while paused would interrupt our own command.
       Schedule shutdown for the first event-loop turn after resuming instead. */
    sprintf_s(params, sizeof(params),
        "{\"callFrameId\":\"%s\",\"expression\":\"(() => { const inspector = process.getBuiltinModule('inspector'); if (typeof inspector.close !== 'function') throw new Error('Inspector shutdown unavailable'); setImmediate(() => inspector.close()); return 'shutdown scheduled'; })()\",\"returnByValue\":true}", inspector.frame);
    reply = command(&inspector, "Debugger.evaluateOnCallFrame", params);
    if (!reply) goto done;
    free(reply); reply = NULL;
    if (!simple_command(&inspector, "Debugger.resume")) goto done;
    SetEvent(watchdog.stop);
    WaitForSingleObject(watchdog_thread, INFINITE);
    WinHttpWebSocketClose(inspector.socket, WINHTTP_WEB_SOCKET_SUCCESS_CLOSE_STATUS, NULL, 0);
    WinHttpCloseHandle(inspector.socket); inspector.socket = NULL;
    deadline = GetTickCount64() + 15000;
    while (GetTickCount64() < deadline) {
        if (inspector_port_closed(port)) { success = 1; break; }
        Sleep(100);
    }
    if (success) wprintf(L"Closed the inspector port and resumed Discord startup.\n");
    else fwprintf(stderr, L"The inspector port is still open after the shutdown request.\n");
done:
    if (watchdog_thread) {
        SetEvent(watchdog.stop);
        WaitForSingleObject(watchdog_thread, INFINITE);
        CloseHandle(watchdog_thread);
    }
    if (watchdog.stop) CloseHandle(watchdog.stop);
    free(json.tokens);
    free(reply);
    if (inspector.socket) WinHttpCloseHandle(inspector.socket);
    return success;
}

int inspector_test(HINTERNET session, INTERNET_PORT port, const wchar_t *endpoint, DWORD expected_pid)
{
    return inspector_run(session, port, endpoint, expected_pid, NULL);
}

int inspector_bootstrap(HINTERNET session, INTERNET_PORT port, const wchar_t *endpoint, DWORD expected_pid, const wchar_t *bootstrap_path)
{
    return inspector_run(session, port, endpoint, expected_pid, bootstrap_path);
}
