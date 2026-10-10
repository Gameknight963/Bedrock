#include <windows.h>
#include "../../include/bedrock/plugin.h"
#include "../../lib/minhook/include/MinHook.h"
#include "status.h"

DWORD WINAPI BlurInstall(const BedrockContext *context);
DWORD WINAPI BlurRemove(void *unused);
extern BlurInstallDiagnostic BlurDiagnostics;
static const BedrockContext *context;

static void append_number(char *text, DWORD number)
{
    char digits[10];
    unsigned count = 0;
    while (*text) text++;
    do { digits[count++] = (char)('0' + number % 10); number /= 10; } while (number);
    while (count) *text++ = digits[--count];
    *text = 0;
}

static BedrockResult apply(void)
{
    DWORD result = BlurInstall(context);
    if (!result) {
        context->log(context->host, BEDROCK_LOG_INFO, "Native blur hook installed.");
        return BEDROCK_OK;
    }
    char message[256] = "BlurInstall failed: ";
    const char *name = result == ERROR_REVISION_MISMATCH ? "ERROR_REVISION_MISMATCH" :
        result == ERROR_DLL_INIT_FAILED ? "ERROR_DLL_INIT_FAILED" : "ERROR_NOT_ENOUGH_MEMORY";
    lstrcatA(message, name); lstrcatA(message, " ("); append_number(message, result); lstrcatA(message, ").");
    context->log(context->host, BEDROCK_LOG_ERROR, message);
    if (result != ERROR_REVISION_MISMATCH) {
        const char *stages[] = { "locating functions", "allocating a Windows TLS slot", "initializing MinHook",
            "creating the render-pass hook", "creating the blend-mode hook", "creating the backdrop-clearing hook", "enabling hooks" };
        lstrcpyA(message, "Failed while ");
        lstrcatA(message, BlurDiagnostics.stage < 7 ? stages[BlurDiagnostics.stage] : "performing an unknown installation step");
        if (result == ERROR_DLL_INIT_FAILED) {
            lstrcatA(message, " ("); lstrcatA(message, MH_StatusToString((MH_STATUS)BlurDiagnostics.minhook_status)); lstrcatA(message, ")");
        }
        lstrcatA(message, "."); context->log(context->host, BEDROCK_LOG_ERROR, message);
    }
    return BEDROCK_ERROR;
}

static BedrockResult BEDROCK_CALL start(const BedrockContext *host)
{
    if (host->process_type != BEDROCK_PROCESS_GPU) return BEDROCK_UNSUPPORTED;
    context = host;
    BedrockValue value;
    BedrockResult result = host->settings_get(host->host, "allowGpuInjection", &value);
    if (result != BEDROCK_OK) { context = NULL; return result; }
    bool enable = value.boolean;
    host->value_release(host->host, &value);
    result = enable ? apply() : BEDROCK_OK;
    if (result != BEDROCK_OK) { BlurRemove(NULL); context = NULL; }
    return result;
}

static void BEDROCK_CALL stop(void)
{
    BlurRemove(NULL);
    context = NULL;
}

static void BEDROCK_CALL settings_changed(const char *key, const BedrockValue *value)
{
    if (lstrcmpA(key, "allowGpuInjection")) return;
    if (value->boolean) apply();
    else {
        BlurRemove(NULL);
        context->log(context->host, BEDROCK_LOG_INFO, "Restored original backdrop compositing.");
    }
}

static const BedrockSetting settings[] = {{
    .size = sizeof(BedrockSetting), .key = "allowGpuInjection", .label = "Enable native GPU hook",
    .description = "Prevents sharp content from showing through backdrop blur on transparent backgrounds.",
    .type = BEDROCK_SETTING_BOOLEAN, .default_value = { .type = BEDROCK_VALUE_BOOLEAN, .boolean = false }
}};
static const BedrockPlugin plugin = {
    .size = sizeof(BedrockPlugin), .required_api = {1, 1, 0}, .settings = settings, .settings_count = 1,
    .start = start, .stop = stop, .settings_changed = settings_changed
};
BEDROCK_EXPORT const BedrockPlugin *BEDROCK_CALL Bedrock_GetPlugin(void) { return &plugin; }
