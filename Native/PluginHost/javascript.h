#pragma once

static void js_error(BedrockJsError *error, BedrockJsErrorCode code, const char *message)
{
    if (!error) return;
    ZeroMemory(error, sizeof(*error)); error->code = code;
    if (message) {
        strncpy_s(error->message, sizeof(error->message), message, _TRUNCATE);
        size_t end = strlen(error->message);
        if (message[end]) {
            while (end && ((unsigned char)message[end] & 0xc0) == 0x80) end--;
            error->message[end] = 0;
        }
    }
}
static void js_id(Text *text, uint64_t id)
{
    char number[32]; sprintf_s(number, sizeof(number), "%llu", (unsigned long long)id); text_quote(text, number);
}
static void js_event(Host *host, const char *event, const char *field, uint64_t id)
{
    Text text = {0}; text_add(&text, "{\"event\":"); text_quote(&text, event);
    if (field) { text_add(&text, ","); text_quote(&text, field); text_add(&text, ":"); js_id(&text, id); }
    text_add(&text, "}"); send_message(host, &text);
}
static bool js_text(Text *text, const char *data, size_t length)
{
    if ((!data && length) || length > BEDROCK_MESSAGE_CAP / 2) return false;
    text_add(text, "\"");
    for (size_t i = 0; i < length && !text->failed; i++) {
        char hex[3]; sprintf_s(hex, sizeof(hex), "%02x", (unsigned char)data[i]); text_add(text, hex);
    }
    text_add(text, "\""); return !text->failed;
}
static bool js_write_value(Text *text, const BedrockJsValue *value)
{
    if (value->type < BEDROCK_JS_UNDEFINED || value->type > BEDROCK_JS_REFERENCE) return false;
    text_add(text, "{\"type\":"); text_number(text, value->type);
    if (value->type >= BEDROCK_JS_BOOLEAN) text_add(text, ",\"value\":");
    switch (value->type) {
    case BEDROCK_JS_BOOLEAN: text_add(text, value->boolean ? "true" : "false"); break;
    case BEDROCK_JS_NUMBER:
        if (isnan(value->number)) text_quote(text, "NaN");
        else if (!isfinite(value->number)) text_quote(text, value->number < 0 ? "-Infinity" : "Infinity");
        else if (value->number == 0 && signbit(value->number)) text_quote(text, "-0");
        else text_number(text, value->number);
        break;
    case BEDROCK_JS_STRING: case BEDROCK_JS_BIGINT:
        if (!js_text(text, value->text.data, value->text.length)) return false;
        break;
    case BEDROCK_JS_REFERENCE:
        if (!value->reference) return false;
        js_id(text, value->reference); break;
    default: break;
    }
    text_add(text, "}"); return !text->failed;
}
static bool js_read_id(const char *json, const jsmntok_t *token, uint64_t *id)
{
    if (token->type != JSMN_STRING || token->end <= token->start || token->end - token->start > 20) return false;
    uint64_t value = 0;
    for (int i = token->start; i < token->end; i++) {
        unsigned digit = (unsigned)(json[i] - '0');
        if (digit > 9 || value > (UINT64_MAX - digit) / 10) return false;
        value = value * 10 + digit;
    }
    if (!value) return false;
    *id = value; return true;
}
static int js_hex(char ch)
{
    if (ch >= '0' && ch <= '9') return ch - '0';
    if (ch >= 'a' && ch <= 'f') return ch - 'a' + 10;
    return -1;
}
static bool js_read_value(const char *json, const jsmntok_t *tokens, int count, int object, BedrockJsValue *value)
{
    ZeroMemory(value, sizeof(*value));
    int type = json_member(json, tokens, count, object, "type");
    BedrockValue scalar;
    if (type < 0 || !json_value(json, &tokens[type], &scalar) || scalar.type != BEDROCK_VALUE_NUMBER ||
        scalar.number < 0 || scalar.number > BEDROCK_JS_REFERENCE || floor(scalar.number) != scalar.number) return false;
    value->type = (BedrockJsType)scalar.number;
    int index = json_member(json, tokens, count, object, "value");
    if (value->type < BEDROCK_JS_BOOLEAN) return true;
    if (index < 0) return false;
    if (value->type == BEDROCK_JS_REFERENCE) return js_read_id(json, &tokens[index], &value->reference);
    if (value->type == BEDROCK_JS_STRING || value->type == BEDROCK_JS_BIGINT) {
        const jsmntok_t *token = &tokens[index];
        size_t length = (size_t)(token->end - token->start);
        if (token->type != JSMN_STRING || length % 2) return false;
        char *data = malloc(length / 2 + 1); if (!data) return false;
        for (size_t i = 0; i < length; i += 2) {
            int hi = js_hex(json[token->start + i]), lo = js_hex(json[token->start + i + 1]);
            if (hi < 0 || lo < 0) { free(data); return false; }
            data[i / 2] = (char)(hi * 16 + lo);
        }
        data[length / 2] = 0; value->text.data = data; value->text.length = length / 2;
        return true;
    }
    if (value->type == BEDROCK_JS_NUMBER && tokens[index].type == JSMN_STRING) {
        char *name = json_string(json, &tokens[index]); bool valid = true;
        if (!name) return false;
        if (!strcmp(name, "NaN")) value->number = NAN;
        else if (!strcmp(name, "Infinity")) value->number = INFINITY;
        else if (!strcmp(name, "-Infinity")) value->number = -INFINITY;
        else if (!strcmp(name, "-0")) value->number = -0.0;
        else valid = false;
        free(name); return valid;
    }
    if (!json_value(json, &tokens[index], &scalar)) return false;
    if (value->type == BEDROCK_JS_BOOLEAN && scalar.type == BEDROCK_VALUE_BOOLEAN) { value->boolean = scalar.boolean; return true; }
    if (value->type == BEDROCK_JS_NUMBER && scalar.type == BEDROCK_VALUE_NUMBER) { value->number = scalar.number; return true; }
    if (scalar.type == BEDROCK_VALUE_STRING) free((void *)scalar.string);
    return false;
}
static BedrockResult BEDROCK_CALL release_js_value(void *opaque, BedrockJsValue *value)
{
    Host *host = opaque;
    if (!value || value->type < BEDROCK_JS_UNDEFINED || value->type > BEDROCK_JS_REFERENCE) return BEDROCK_INVALID_ARGUMENT;
    if (value->type == BEDROCK_JS_STRING || value->type == BEDROCK_JS_BIGINT) free((void *)value->text.data);
    if (value->type == BEDROCK_JS_REFERENCE && value->reference) js_event(host, "js.release", "handle", value->reference);
    ZeroMemory(value, sizeof(*value)); return BEDROCK_OK;
}
static void js_finish_locked(Host *host, JsRequest *request)
{
    request->done = true;
    if (request->callback) {
        request->next = NULL; *host->completion_tail = request; host->completion_tail = &request->next;
        ResetEvent(host->callbacks_idle); SetEvent(host->callback_event);
    } else SetEvent(request->event);
}
static void js_cancel_all(Host *host, BedrockJsErrorCode code, const char *message)
{
    AcquireSRWLockExclusive(&host->js_lock);
    host->js_stopping = true;
    JsRequest *request = host->requests; host->requests = NULL;
    while (request) {
        JsRequest *next = request->next;
        request->status = code == BEDROCK_JS_STOPPED ? BEDROCK_STOPPED : BEDROCK_ERROR;
        js_error(&request->error, code, message);
        js_finish_locked(host, request); js_event(host, "js.cancel", "id", request->id); request = next;
    }
    ReleaseSRWLockExclusive(&host->js_lock);
}
static DWORD WINAPI js_callbacks(void *opaque)
{
    Host *host = opaque;
    for (;;) {
        WaitForSingleObject(host->callback_event, INFINITE);
        for (;;) {
            AcquireSRWLockExclusive(&host->js_lock);
            JsRequest *request = host->completions;
            bool exit = host->callbacks_exit;
            if (request) { host->completions = request->next; if (!host->completions) host->completion_tail = &host->completions; }
            else SetEvent(host->callbacks_idle);
            ReleaseSRWLockExclusive(&host->js_lock);
            if (!request) { if (exit) return 0; break; }
            request->callback(request->user_data, request->status, &request->value, &request->error);
            // The callback owns successful result contents, including if it copies the container.
            free(request);
        }
    }
}
static void js_receive(Host *host, const char *json, const jsmntok_t *tokens, int count)
{
    int index = json_member(json, tokens, count, 0, "id"); uint64_t id;
    if (index < 0 || !js_read_id(json, &tokens[index], &id)) return;
    BedrockJsValue value = {0}; BedrockJsError error = {0};
    index = json_member(json, tokens, count, 0, "code"); BedrockValue code = {0};
    bool valid = index >= 0 && json_value(json, &tokens[index], &code) && code.type == BEDROCK_VALUE_NUMBER &&
        code.number >= 0 && code.number <= BEDROCK_JS_TRANSPORT_ERROR && floor(code.number) == code.number;
    if (valid && code.number == 0) valid = js_read_value(json, tokens, count, json_member(json, tokens, count, 0, "value"), &value);
    else if (valid) {
        index = json_member(json, tokens, count, 0, "message");
        char *message = index >= 0 ? json_string(json, &tokens[index]) : NULL;
        js_error(&error, (BedrockJsErrorCode)code.number, message ? message : "JavaScript execution failed."); free(message);
    }
    if (!valid) js_error(&error, BEDROCK_JS_TRANSPORT_ERROR, "Cannot decode the JavaScript result.");
    AcquireSRWLockExclusive(&host->js_lock);
    JsRequest **link = &host->requests;
    while (*link && (*link)->id != id) link = &(*link)->next;
    JsRequest *request = *link;
    if (request) {
        *link = request->next; request->value = value; request->error = error;
        request->status = error.code == BEDROCK_JS_OK ? BEDROCK_OK : error.code == BEDROCK_JS_STOPPED ? BEDROCK_STOPPED : BEDROCK_ERROR;
        js_finish_locked(host, request);
    }
    ReleaseSRWLockExclusive(&host->js_lock);
    if (!request) release_js_value(host, &value);
}
static BedrockResult js_submit(Host *host, const char *body, const BedrockJsValue *arguments, size_t count,
    BedrockJsCallback callback, void *user_data, JsRequest **out, BedrockJsError *error)
{
    js_error(error, BEDROCK_JS_OK, NULL);
    if (!body || (count && !arguments) || count > 16384) {
        js_error(error, BEDROCK_JS_INVALID_ARGUMENT, "Expected a function body and a valid argument array."); return BEDROCK_INVALID_ARGUMENT;
    }
    JsRequest *request = calloc(1, sizeof(*request));
    if (!request) { js_error(error, BEDROCK_JS_TRANSPORT_ERROR, "Cannot allocate a JavaScript request."); return BEDROCK_ERROR; }
    request->callback = callback; request->user_data = user_data;
    if (!callback) request->event = CreateEventW(NULL, TRUE, FALSE, NULL);
    if (!callback && !request->event) { free(request); js_error(error, BEDROCK_JS_TRANSPORT_ERROR, "Cannot create a JavaScript completion event."); return BEDROCK_ERROR; }
    Text text = {0};
    AcquireSRWLockExclusive(&host->js_lock);
    if (host->js_stopping || !InterlockedCompareExchange(&host->active, 0, 0)) {
        ReleaseSRWLockExclusive(&host->js_lock); if (request->event) CloseHandle(request->event); free(request);
        js_error(error, BEDROCK_JS_STOPPED, "The native plugin context is stopped."); return BEDROCK_STOPPED;
    }
    request->id = ++host->js_sequence;
    text_add(&text, "{\"event\":\"js.execute\",\"id\":"); js_id(&text, request->id);
    text_add(&text, ",\"body\":"); text_quote(&text, body); text_add(&text, ",\"arguments\":[");
    bool valid = request->id != 0;
    for (size_t i = 0; valid && i < count; i++) { if (i) text_add(&text, ","); valid = js_write_value(&text, &arguments[i]); }
    text_add(&text, "]}"); valid = valid && !text.failed;
    if (!valid) {
        ReleaseSRWLockExclusive(&host->js_lock); free(text.data); if (request->event) CloseHandle(request->event); free(request);
        js_error(error, BEDROCK_JS_INVALID_ARGUMENT, "Invalid JavaScript argument or request exceeds one MiB."); return BEDROCK_INVALID_ARGUMENT;
    }
    request->next = host->requests; host->requests = request;
    // Keep the request registered until the complete line is written; replies use this lock too.
    bool sent = send_message(host, &text);
    if (!sent) host->requests = request->next;
    ReleaseSRWLockExclusive(&host->js_lock);
    if (!sent) {
        if (request->event) CloseHandle(request->event); free(request);
        js_error(error, BEDROCK_JS_TRANSPORT_ERROR, "Cannot send the JavaScript request."); return BEDROCK_ERROR;
    }
    if (out) *out = request;
    return BEDROCK_OK;
}
static BedrockResult BEDROCK_CALL execute_js_async(void *opaque, const char *body,
    const BedrockJsValue *arguments, size_t count, BedrockJsCallback callback, void *user_data)
{
    if (!callback) return BEDROCK_INVALID_ARGUMENT;
    return js_submit(opaque, body, arguments, count, callback, user_data, NULL, NULL);
}
static BedrockResult BEDROCK_CALL execute_js(void *opaque, const char *body,
    const BedrockJsValue *arguments, size_t count, uint32_t timeout, BedrockJsValue *value, BedrockJsError *error)
{
    Host *host = opaque;
    js_error(error, BEDROCK_JS_OK, NULL);
    if (!value || timeout == INFINITE) { js_error(error, BEDROCK_JS_INVALID_ARGUMENT, "A result and a finite timeout are required."); return BEDROCK_INVALID_ARGUMENT; }
    ZeroMemory(value, sizeof(*value));
    JsRequest *request;
    BedrockResult status = js_submit(host, body, arguments, count, NULL, NULL, &request, error);
    if (status != BEDROCK_OK) return status;
    DWORD waited = WaitForSingleObject(request->event, timeout ? timeout : 5000);
    AcquireSRWLockExclusive(&host->js_lock);
    bool cancelled = !request->done;
    if (cancelled) {
        JsRequest **link = &host->requests;
        while (*link && *link != request) link = &(*link)->next;
        if (*link) *link = request->next;
        request->status = BEDROCK_ERROR;
        js_error(&request->error, waited == WAIT_TIMEOUT ? BEDROCK_JS_TIMEOUT : BEDROCK_JS_TRANSPORT_ERROR,
            waited == WAIT_TIMEOUT ? "JavaScript did not complete within the timeout; running JavaScript cannot be undone." : "Cannot wait for the JavaScript result.");
    }
    *value = request->value; if (error) *error = request->error; status = request->status;
    ReleaseSRWLockExclusive(&host->js_lock);
    if (cancelled) js_event(host, "js.cancel", "id", request->id);
    CloseHandle(request->event); free(request); return status;
}
