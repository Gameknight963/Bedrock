#include <windows.h>
#include <math.h>
#include <string.h>
#include <bedrock/plugin.h>

static const BedrockContext *ctx;
static HANDLE completed;
static volatile LONG failures, callbacks;
static BedrockJsValue retained, previous_handle;
static void check(bool condition, const char *message)
{
    if (!condition) { InterlockedIncrement(&failures); ctx->log(ctx->host, BEDROCK_LOG_ERROR, message); }
}
static BedrockJsValue execute(const char *body, const BedrockJsValue *args, size_t count)
{
    BedrockJsValue value = {0}; BedrockJsError error = {0};
    BedrockResult result = ctx->execute_js(ctx->host, body, args, count, 0, &value, &error);
    check(result == BEDROCK_OK, error.message); return value;
}
static DWORD WINAPI caller_thread(void *state)
{
    (void)state;
    for (unsigned i = 0; i < 8; i++) {
        BedrockJsValue argument = { .type = BEDROCK_JS_NUMBER, .number = i };
        BedrockJsValue result = execute("return args[0] + 1", &argument, 1);
        check(result.type == BEDROCK_JS_NUMBER && result.number == i + 1, "Concurrent request received the wrong result.");
        ctx->release_js_value(ctx->host, &result);
    }
    return 0;
}
static void BEDROCK_CALL async_result(void *state, BedrockResult status, BedrockJsValue *value, const BedrockJsError *error)
{
    (void)state;
    check(status == BEDROCK_OK, error->message);
    check(value->type == BEDROCK_JS_REFERENCE, "Async result lost its reference.");
    retained = *value;
    BedrockJsValue result = execute("return args[0].answer", &retained, 1);
    check(result.type == BEDROCK_JS_NUMBER && result.number == 42, "Sync call inside async callback failed.");
    ctx->release_js_value(ctx->host, &result);
    InterlockedIncrement(&callbacks); SetEvent(completed);
}
static void BEDROCK_CALL cancelled_result(void *state, BedrockResult status, BedrockJsValue *value, const BedrockJsError *error)
{
    (void)state;
    check(status == BEDROCK_STOPPED && error->code == BEDROCK_JS_STOPPED, "Pending callback was not stopped.");
    ctx->release_js_value(ctx->host, value);
    InterlockedIncrement(&callbacks);
    ctx->log(ctx->host, BEDROCK_LOG_INFO, "Pending callback cancelled.");
}
static BedrockResult BEDROCK_CALL start(const BedrockContext *context)
{
    ctx = context; failures = callbacks = 0; ZeroMemory(&retained, sizeof(retained));
    if (ctx->process_type == BEDROCK_PROCESS_GPU) {
        check(!ctx->execute_js && !ctx->execute_js_async && !ctx->release_js_value, "GPU exposes JavaScript.");
        ctx->log(ctx->host, BEDROCK_LOG_INFO, "JavaScript fixture passed."); return failures ? BEDROCK_ERROR : BEDROCK_OK;
    }
    if (previous_handle.type == BEDROCK_JS_REFERENCE) {
        BedrockJsValue result = {0}; BedrockJsError error = {0};
        check(ctx->execute_js(ctx->host, "return args[0]", &previous_handle, 1, 0, &result, &error) == BEDROCK_ERROR &&
            error.code == BEDROCK_JS_INVALID_HANDLE, "A previous context's handle survived re-enable.");
    }
    completed = CreateEventW(NULL, TRUE, FALSE, NULL);
    check(completed != NULL, "Cannot create fixture event.");
    const char *sources[] = { "", "return null", "return true", "return 1+2", "return 'a\\0b'", "return 123456789012345678901234567890n", "return {}", "return () => 3", "return Symbol('x')", "return Promise.resolve(42)" };
    const BedrockJsType types[] = { BEDROCK_JS_UNDEFINED, BEDROCK_JS_NULL, BEDROCK_JS_BOOLEAN, BEDROCK_JS_NUMBER, BEDROCK_JS_STRING, BEDROCK_JS_BIGINT, BEDROCK_JS_REFERENCE, BEDROCK_JS_REFERENCE, BEDROCK_JS_REFERENCE, BEDROCK_JS_REFERENCE };
    for (unsigned i = 0; i < sizeof(types)/sizeof(*types); i++) {
        BedrockJsValue value = execute(sources[i], NULL, 0);
        check(value.type == types[i], "Wrong JavaScript result type.");
        if (i == 3) check(value.number == 3, "Wrong number result.");
        if (i == 4) check(value.text.length == 3 && !memcmp(value.text.data, "a\0b", 3), "String NUL was lost.");
        if (i == 5) check(value.text.length == 30 && !memcmp(value.text.data, "123456789012345678901234567890", 30), "BigInt was truncated.");
        if (i >= 6) {
            BedrockJsValue args[] = { value, value };
            BedrockJsValue same = execute("return args[0] === args[1]", args, 2);
            check(same.type == BEDROCK_JS_BOOLEAN && same.boolean, "Object identity was lost.");
            ctx->release_js_value(ctx->host, &same);
        }
        ctx->release_js_value(ctx->host, &value);
        check(value.type == BEDROCK_JS_UNDEFINED, "Released value was not cleared.");
    }
    const double numbers[] = { NAN, INFINITY, -INFINITY, -0.0 };
    for (unsigned i = 0; i < 4; i++) {
        BedrockJsValue arg = { .type = BEDROCK_JS_NUMBER, .number = numbers[i] };
        BedrockJsValue value = execute("return args[0]", &arg, 1);
        check(value.type == BEDROCK_JS_NUMBER && (i == 0 ? isnan(value.number) : i == 3 ? value.number == 0 && signbit(value.number) : value.number == numbers[i]), "Special number changed.");
        ctx->release_js_value(ctx->host, &value);
    }
    BedrockJsValue value = {0}; BedrockJsError error = {0};
    check(ctx->execute_js(ctx->host, "throw new Error('fixture exception')", NULL, 0, 0, &value, &error) == BEDROCK_ERROR && error.code == BEDROCK_JS_EXCEPTION && strstr(error.message, "fixture exception"), "JS exception was not reported.");
    value = execute("return {}", NULL, 0); BedrockJsValue stale = value;
    ctx->release_js_value(ctx->host, &value);
    check(ctx->execute_js(ctx->host, "return args[0]", &stale, 1, 0, &value, &error) == BEDROCK_ERROR && error.code == BEDROCK_JS_INVALID_HANDLE, "Released handle was accepted.");
    check(ctx->execute_js_async(ctx->host, "return { answer: 42 }", NULL, 0, async_result, NULL) == BEDROCK_OK, "Async request rejected.");
    check(WaitForSingleObject(completed, 5000) == WAIT_OBJECT_0 && callbacks == 1, "Async callback did not complete once.");
    HANDLE workers[4];
    for (unsigned i = 0; i < 4; i++) workers[i] = CreateThread(NULL, 0, caller_thread, NULL, 0, NULL);
    bool all_created = workers[0] && workers[1] && workers[2] && workers[3];
    check(all_created, "Cannot create concurrent fixture callers.");
    if (all_created) check(WaitForMultipleObjects(4, workers, TRUE, 5000) == WAIT_OBJECT_0, "Concurrent callers did not complete.");
    for (unsigned i = 0; i < 4; i++) if (workers[i]) { WaitForSingleObject(workers[i], INFINITE); CloseHandle(workers[i]); }
    previous_handle = retained;
    ctx->release_js_value(ctx->host, &retained);
    check(ctx->execute_js(ctx->host, "return 'x'.repeat(600000)", NULL, 0, 0, &value, &error) == BEDROCK_ERROR &&
        error.code == BEDROCK_JS_TRANSPORT_ERROR && strstr(error.message, "one MiB"), "Oversized result was not rejected.");
    BedrockJsValue argument = { .type = BEDROCK_JS_STRING, .text = { "a\0b", 3 } };
    value = execute("return args[0]", &argument, 1);
    check(value.type == BEDROCK_JS_STRING && value.text.length == 3 && !memcmp(value.text.data, "a\0b", 3), "String input lost its NUL.");
    ctx->release_js_value(ctx->host, &value);
    argument.type = BEDROCK_JS_BIGINT; argument.text.data = "123456789012345678901234567890"; argument.text.length = 30;
    value = execute("return args[0] + 1n", &argument, 1);
    check(value.type == BEDROCK_JS_BIGINT && value.text.length == 30 && !memcmp(value.text.data, "123456789012345678901234567891", 30), "BigInt input lost precision.");
    ctx->release_js_value(ctx->host, &value);
    check(ctx->execute_js_async(ctx->host, "", NULL, 0, NULL, NULL) == BEDROCK_INVALID_ARGUMENT, "Missing async callback accepted.");
    check(ctx->execute_js(ctx->host, "", NULL, 0, INFINITE, &value, &error) == BEDROCK_INVALID_ARGUMENT, "Infinite timeout accepted.");
    if (ctx->process_type == BEDROCK_PROCESS_RENDERER) {
        check(ctx->execute_js(ctx->host, "const end=Date.now()+200; while(Date.now()<end){}; return {}", NULL, 0, 30, &value, &error) == BEDROCK_ERROR && error.code == BEDROCK_JS_TIMEOUT, "Slow JavaScript did not time out.");
        value = execute("return document.title", NULL, 0);
        check(value.type == BEDROCK_JS_STRING && value.text.length == 7 && !memcmp(value.text.data, "Fixture", 7), "Renderer did not execute in the page.");
        ctx->release_js_value(ctx->host, &value);
    } else {
        value = execute("return process.pid", NULL, 0);
        check(value.type == BEDROCK_JS_NUMBER && value.number == GetCurrentProcessId(), "Main code ran in the wrong process.");
        ctx->release_js_value(ctx->host, &value);
    }
    ctx->log(ctx->host, BEDROCK_LOG_INFO, failures ? "JavaScript fixture failed." : "JavaScript fixture passed.");
    return failures ? BEDROCK_ERROR : BEDROCK_OK;
}
static void BEDROCK_CALL stop(void)
{
    if (ctx->process_type != BEDROCK_PROCESS_GPU) { CloseHandle(completed); completed = NULL; }
    ctx->log(ctx->host, BEDROCK_LOG_INFO, "JavaScript fixture stopped.");
}
static void BEDROCK_CALL changed(const char *key, const BedrockValue *value)
{
    if (!strcmp(key, "pending") && value->boolean && ctx->process_type == BEDROCK_PROCESS_RENDERER)
        check(ctx->execute_js_async(ctx->host, "/* pending */ return {}", NULL, 0, cancelled_result, NULL) == BEDROCK_OK, "Pending async request rejected.");
}
static const BedrockSetting settings[] = {
    { .size = sizeof(BedrockSetting), .key = "pending", .type = BEDROCK_SETTING_BOOLEAN,
      .default_value = { .type = BEDROCK_VALUE_BOOLEAN, .boolean = false } }
};
BEDROCK_EXPORT const BedrockPlugin *BEDROCK_CALL Bedrock_GetPlugin(void)
{
    static const BedrockPlugin plugin = { sizeof(BedrockPlugin), {1,3,0}, settings, 1, start, stop, changed };
    return &plugin;
}
