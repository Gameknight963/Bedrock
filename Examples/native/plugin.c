#include <bedrock/plugin.h>
#include <string.h>
#include <stdio.h>

static const BedrockContext *context;
static const BedrockSetting settings[] = {
    { .size = sizeof(BedrockSetting), .key = "enabled", .label = "Enable example",
      .type = BEDROCK_SETTING_BOOLEAN, .default_value = { .type = BEDROCK_VALUE_BOOLEAN, .boolean = true } },
    { .size = sizeof(BedrockSetting), .key = "message", .label = "Message",
      .type = BEDROCK_SETTING_STRING, .default_value = { .type = BEDROCK_VALUE_STRING, .string = "Hello from C." } },
    { .size = sizeof(BedrockSetting), .key = "strength", .label = "Strength",
      .type = BEDROCK_SETTING_SLIDER, .default_value = { .type = BEDROCK_VALUE_NUMBER, .number = 50 },
      .flags = BEDROCK_SETTING_HAS_MIN | BEDROCK_SETTING_HAS_MAX | BEDROCK_SETTING_HAS_STEP, .min = 0, .max = 100, .step = 1 }
};
static BedrockResult BEDROCK_CALL start(const BedrockContext *ctx)
{
    context = ctx;
    BedrockValue value;
    BedrockResult result = ctx->settings_get(ctx->host, "message", &value);
    if (result != BEDROCK_OK) { context = NULL; return result; }
    ctx->log(ctx->host, BEDROCK_LOG_INFO, value.string);
    ctx->value_release(ctx->host, &value);
    ctx->log(ctx->host, BEDROCK_LOG_INFO, "Native example started.");
    return BEDROCK_OK;
}
static void BEDROCK_CALL stop(void)
{
    context->log(context->host, BEDROCK_LOG_INFO, "Native example stopped.");
    context = NULL;
}
static void BEDROCK_CALL changed(const char *key, const BedrockValue *value)
{
    char message[256];
    snprintf(message, sizeof(message), "Setting changed: %s.", key);
    context->log(context->host, BEDROCK_LOG_INFO, message);
    if (!strcmp(key, "message")) context->log(context->host, BEDROCK_LOG_INFO, value->string);
}
BEDROCK_EXPORT const BedrockPlugin *BEDROCK_CALL Bedrock_GetPlugin(void)
{
    static const BedrockPlugin plugin = {
        .size = sizeof(BedrockPlugin), .required_api = { 1, 0, 0 },
        .settings = settings, .settings_count = sizeof(settings) / sizeof(settings[0]),
        .start = start, .stop = stop, .settings_changed = changed
    };
    return &plugin;
}
