#ifndef BEDROCK_PLUGIN_H
#define BEDROCK_PLUGIN_H

#include <stdbool.h>
#include <stdint.h>

#ifdef _WIN32
#define BEDROCK_CALL __cdecl
#define BEDROCK_EXPORT __declspec(dllexport)
#else
#define BEDROCK_CALL
#define BEDROCK_EXPORT __attribute__((visibility("default")))
#endif

#ifdef __cplusplus
extern "C" {
#endif

typedef struct BedrockVersion { uint32_t major, minor, patch; } BedrockVersion;
#define BEDROCK_API_MAJOR 1
#define BEDROCK_API_MINOR 1
#define BEDROCK_API_PATCH 0

typedef int32_t BedrockResult;
#define BEDROCK_OK 0
#define BEDROCK_ERROR 1
#define BEDROCK_UNSUPPORTED 2
#define BEDROCK_INVALID_ARGUMENT 3
#define BEDROCK_UNKNOWN_SETTING 4
#define BEDROCK_INVALID_VALUE 5
#define BEDROCK_STOPPED 6

typedef enum BedrockProcessType {
    BEDROCK_PROCESS_MAIN, BEDROCK_PROCESS_RENDERER, BEDROCK_PROCESS_GPU
} BedrockProcessType;
typedef enum BedrockLogLevel {
    BEDROCK_LOG_DEBUG, BEDROCK_LOG_INFO, BEDROCK_LOG_WARNING, BEDROCK_LOG_ERROR
} BedrockLogLevel;
typedef enum BedrockValueType {
    BEDROCK_VALUE_BOOLEAN, BEDROCK_VALUE_NUMBER, BEDROCK_VALUE_STRING
} BedrockValueType;

typedef struct BedrockValue {
    BedrockValueType type;
    union { bool boolean; double number; const char *string; };
} BedrockValue;

typedef enum BedrockSettingType {
    BEDROCK_SETTING_BOOLEAN, BEDROCK_SETTING_STRING, BEDROCK_SETTING_NUMBER,
    BEDROCK_SETTING_SELECT, BEDROCK_SETTING_SLIDER
} BedrockSettingType;
typedef struct BedrockSettingChoice {
    const char *label;
    BedrockValue value;
} BedrockSettingChoice;

#define BEDROCK_SETTING_RESTART_REQUIRED (1u << 0)
#define BEDROCK_SETTING_MULTILINE (1u << 1)
#define BEDROCK_SETTING_HAS_MIN (1u << 2)
#define BEDROCK_SETTING_HAS_MAX (1u << 3)
#define BEDROCK_SETTING_HAS_STEP (1u << 4)

/* Definitions and their strings remain valid for the DLL's lifetime.
   Optional text can be NULL. Set size to sizeof(BedrockSetting).
   Arrays are traversed using each element's size, allowing appended fields. */
typedef struct BedrockSetting {
    uint32_t size;
    const char *key, *label, *description, *section, *placeholder;
    BedrockSettingType type;
    uint32_t flags;
    BedrockValue default_value;
    double min, max, step;
    const BedrockSettingChoice *choices;
    uint32_t choice_count;
} BedrockSetting;

typedef int32_t BedrockSymbolResult;
#define BEDROCK_SYMBOL_OK 0
#define BEDROCK_SYMBOL_INVALID_ARGUMENT 1
#define BEDROCK_SYMBOL_REFERENCE_UNAVAILABLE 2
#define BEDROCK_SYMBOL_NAME_NOT_FOUND 3
#define BEDROCK_SYMBOL_NAME_AMBIGUOUS 4
#define BEDROCK_SYMBOL_TARGET_NOT_FOUND 5
#define BEDROCK_SYMBOL_TARGET_AMBIGUOUS 6
#define BEDROCK_SYMBOL_TARGET_INVALID 7
#define BEDROCK_SYMBOL_STOPPED 8
#define BEDROCK_SYMBOL_REFERENCE_INVALID 9

/* Fixed layout for API major 1. No allocation or release is needed. */
typedef struct BedrockSymbolError {
    BedrockSymbolResult code;
    char message[512];
} BedrockSymbolError;

/* UTF-8 strings throughout. Host services may be called from plugin threads.
   The context is valid through stop(); finish those threads before returning.
   log and settings_set copy inputs. Successful settings_set means validated
   and queued, not written to disk. settings_get reads the local snapshot;
   release every successful result with value_release (also safe for scalars).
   Settings callbacks confirm saved changes; errors are reported in host logs. */
typedef struct BedrockContext {
    uint32_t size;
    BedrockVersion api_version;
    void *host;
    BedrockProcessType process_type;
    void (BEDROCK_CALL *log)(void *host, BedrockLogLevel level, const char *message);
    BedrockResult (BEDROCK_CALL *settings_get)(void *host, const char *key, BedrockValue *value);
    BedrockResult (BEDROCK_CALL *settings_set)(void *host, const char *key, const BedrockValue *value);
    void (BEDROCK_CALL *value_release)(void *host, BedrockValue *value);
    /* API 1.1.0: one exact UTF-8 reference symbol name; current executable only.
       Returns NULL on failure. Optional error is cleared on success.
       Synchronous; call during initialization, not from a rendering hook. */
    void *(BEDROCK_CALL *resolve_symbol)(void *host, const char *name, BedrockSymbolError *error);
} BedrockContext;

/* Same major, required minor/patch no newer than host. Fields are appended
   within a major version. The descriptor remains valid for the DLL's lifetime.
   start, settings_changed and stop run serially on a host worker, outside
   DllMain. Failed start must undo partial work. stop removes hooks and waits
   for outstanding work; the DLL remains resident. Re-enable calls start again.
   Callback values are borrowed only until the callback returns.
   start/stop are required; settings_changed is optional. No exceptions may
   cross this interface. Use no nondefault packing or enum-size compiler flags. */
typedef struct BedrockPlugin {
    uint32_t size;
    BedrockVersion required_api;
    const BedrockSetting *settings;
    uint32_t settings_count;
    BedrockResult (BEDROCK_CALL *start)(const BedrockContext *context);
    void (BEDROCK_CALL *stop)(void);
    void (BEDROCK_CALL *settings_changed)(const char *key, const BedrockValue *value);
} BedrockPlugin;

BEDROCK_EXPORT const BedrockPlugin *BEDROCK_CALL Bedrock_GetPlugin(void);

#ifdef __cplusplus
}
#endif
#endif
