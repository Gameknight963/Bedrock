#include <windows.h>
#include <stdbool.h>
#include <stdint.h>
#include <stddef.h>
#include <math.h>
#include "transport.h"
#include "json.h"
#include "symbols.h"

typedef struct Host {
    HANDLE input, output;
    const BedrockPlugin *plugin;
    BedrockContext context;
    const BedrockSetting **definitions;
    BedrockValue *values;
    SRWLOCK values_lock, output_lock, symbols_lock;
    SymbolReference reference;
    volatile LONG active;
} Host;

static void *BEDROCK_CALL resolve_symbol(void *opaque, const char *name, BedrockSymbolError *error)
{
    Host *host = opaque;
    if (error) ZeroMemory(error, sizeof(*error));
    if (!InterlockedCompareExchange(&host->active, 0, 0)) {
        if (error) { error->code = BEDROCK_SYMBOL_STOPPED; strcpy_s(error->message, sizeof(error->message), "The native plugin context is stopped."); }
        return NULL;
    }
    AcquireSRWLockExclusive(&host->symbols_lock);
    void *address = symbol_resolve(&host->reference, (BYTE *)GetModuleHandleW(NULL), name, error);
    ReleaseSRWLockExclusive(&host->symbols_lock);
    return address;
}

static bool send_message(Host *host, Text *text)
{
    bool sent = false;
    if (!text->failed && text->data) {
        AcquireSRWLockExclusive(&host->output_lock);
        DWORD written; size_t offset = 0;
        while (offset < text->length) {
            if (!WriteFile(host->output, text->data + offset, (DWORD)(text->length - offset), &written, NULL) || !written) break;
            offset += written;
        }
        sent = offset == text->length && WriteFile(host->output, "\n", 1, &written, NULL) && written == 1;
        ReleaseSRWLockExclusive(&host->output_lock);
    }
    free(text->data);
    return sent;
}
static void host_error(Host *host, const char *message)
{
    Text text = {0}; text_add(&text, "{\"event\":\"error\",\"message\":"); text_quote(&text, message); text_add(&text, "}"); send_message(host, &text);
}
static void BEDROCK_CALL report_status(void *opaque, const char *message)
{
    Host *host = opaque;
    if (!message || !InterlockedCompareExchange(&host->active, 0, 0)) return;
    Text text = {0}; text_add(&text, "{\"event\":\"status\",\"message\":");
    text_quote(&text, message); text_add(&text, "}"); send_message(host, &text);
}
static void BEDROCK_CALL log_message(void *opaque, BedrockLogLevel level, const char *message)
{
    Host *host = opaque;
    if (!message || level < BEDROCK_LOG_DEBUG || level > BEDROCK_LOG_ERROR) return;
    Text text = {0}; text_add(&text, "{\"event\":\"log\",\"level\":"); text_number(&text, level);
    text_add(&text, ",\"message\":"); text_quote(&text, message); text_add(&text, "}"); send_message(host, &text);
}
static void BEDROCK_CALL release_value(void *opaque, BedrockValue *value)
{
    (void)opaque;
    if (!value) return;
    if (value->type == BEDROCK_VALUE_STRING) free((void *)value->string);
    ZeroMemory(value, sizeof(*value));
}
static bool copy_value(BedrockValue *destination, const BedrockValue *source)
{
    *destination = *source;
    if (source->type == BEDROCK_VALUE_STRING) {
        if (!source->string) return false;
        destination->string = _strdup(source->string); return destination->string != NULL;
    }
    return source->type == BEDROCK_VALUE_BOOLEAN || (source->type == BEDROCK_VALUE_NUMBER && isfinite(source->number));
}
static int setting_index(Host *host, const char *key)
{
    if (!key) return -1;
    for (uint32_t i = 0; i < host->plugin->settings_count; i++) if (!strcmp(host->definitions[i]->key, key)) return (int)i;
    return -1;
}
static bool value_equal(const BedrockValue *a, const BedrockValue *b)
{
    if (a->type != b->type) return false;
    if (a->type == BEDROCK_VALUE_STRING) return a->string && b->string && !strcmp(a->string, b->string);
    if (a->type == BEDROCK_VALUE_NUMBER) return a->number == b->number;
    return a->boolean == b->boolean;
}
static bool valid_value(const BedrockSetting *setting, const BedrockValue *value)
{
    if (setting->type == BEDROCK_SETTING_SELECT) {
        for (uint32_t i = 0; i < setting->choice_count; i++) if (value_equal(value, &setting->choices[i].value)) return true;
        return false;
    }
    if (setting->type == BEDROCK_SETTING_BOOLEAN) return value->type == BEDROCK_VALUE_BOOLEAN;
    if (setting->type == BEDROCK_SETTING_STRING) return value->type == BEDROCK_VALUE_STRING && value->string;
    if (value->type != BEDROCK_VALUE_NUMBER || !isfinite(value->number)) return false;
    if ((setting->flags & BEDROCK_SETTING_HAS_MIN) && value->number < setting->min) return false;
    if ((setting->flags & BEDROCK_SETTING_HAS_MAX) && value->number > setting->max) return false;
    if (setting->flags & BEDROCK_SETTING_HAS_STEP) {
        double steps = (value->number - ((setting->flags & BEDROCK_SETTING_HAS_MIN) ? setting->min : 0)) / setting->step;
        if (fabs(steps - round(steps)) > 1e-8) return false;
    }
    return true;
}
static BedrockResult BEDROCK_CALL get_setting(void *opaque, const char *key, BedrockValue *value)
{
    Host *host = opaque;
    if (!InterlockedCompareExchange(&host->active, 0, 0)) return BEDROCK_STOPPED;
    if (!value || !key) return BEDROCK_INVALID_ARGUMENT;
    int index = setting_index(host, key); if (index < 0) return BEDROCK_UNKNOWN_SETTING;
    AcquireSRWLockShared(&host->values_lock);
    bool copied = copy_value(value, &host->values[index]);
    ReleaseSRWLockShared(&host->values_lock);
    return copied ? BEDROCK_OK : BEDROCK_ERROR;
}
static BedrockResult BEDROCK_CALL set_setting(void *opaque, const char *key, const BedrockValue *value)
{
    Host *host = opaque;
    if (!InterlockedCompareExchange(&host->active, 0, 0)) return BEDROCK_STOPPED;
    if (!key || !value) return BEDROCK_INVALID_ARGUMENT;
    int index = setting_index(host, key); if (index < 0) return BEDROCK_UNKNOWN_SETTING;
    if (!valid_value(host->definitions[index], value)) return BEDROCK_INVALID_VALUE;
    Text text = {0}; text_add(&text, "{\"event\":\"set\",\"key\":"); text_quote(&text, key);
    text_add(&text, ",\"value\":"); text_value(&text, value); text_add(&text, "}");
    if (text.failed) { free(text.data); return BEDROCK_ERROR; }
    return send_message(host, &text) ? BEDROCK_OK : BEDROCK_ERROR;
}
static void optional_text(Text *text, const char *key, const char *value)
{
    if (!value) return;
    text_add(text, ","); text_quote(text, key); text_add(text, ":"); text_quote(text, value);
}
static bool describe(Host *host)
{
    static const char *types[] = { "boolean", "string", "number", "select", "slider" };
    Text text = {0}; text_add(&text, "{\"event\":\"ready\",\"definitions\":{");
    for (uint32_t i = 0; i < host->plugin->settings_count; i++) {
        const BedrockSetting *setting = host->definitions[i];
        if (i) text_add(&text, ","); text_quote(&text, setting->key); text_add(&text, ":{\"type\":"); text_quote(&text, types[setting->type]);
        text_add(&text, ",\"default\":"); text_value(&text, &setting->default_value);
        optional_text(&text, "label", setting->label); optional_text(&text, "description", setting->description);
        optional_text(&text, "section", setting->section); optional_text(&text, "placeholder", setting->placeholder);
        if (setting->flags & BEDROCK_SETTING_RESTART_REQUIRED) text_add(&text, ",\"restartNeeded\":true");
        if (setting->flags & BEDROCK_SETTING_MULTILINE) text_add(&text, ",\"multiline\":true");
        if (setting->flags & BEDROCK_SETTING_HAS_MIN) { text_add(&text, ",\"min\":"); text_number(&text, setting->min); }
        if (setting->flags & BEDROCK_SETTING_HAS_MAX) { text_add(&text, ",\"max\":"); text_number(&text, setting->max); }
        if (setting->flags & BEDROCK_SETTING_HAS_STEP) { text_add(&text, ",\"step\":"); text_number(&text, setting->step); }
        if (setting->type == BEDROCK_SETTING_SELECT) {
            text_add(&text, ",\"options\":[");
            for (uint32_t j = 0; j < setting->choice_count; j++) {
                if (j) text_add(&text, ","); text_add(&text, "{\"label\":"); text_quote(&text, setting->choices[j].label);
                text_add(&text, ",\"value\":"); text_value(&text, &setting->choices[j].value); text_add(&text, "}");
            }
            text_add(&text, "]");
        }
        text_add(&text, "}");
    }
    text_add(&text, "},\"requiresSymbols\":");
    text_add(&text, host->plugin->required_api.minor >= 1 ? "true" : "false");
    text_add(&text, "}"); bool okay = !text.failed; send_message(host, &text); return okay;
}
static FARPROC plugin_export(BYTE *module, const char *name)
{
    IMAGE_DOS_HEADER *dos = (IMAGE_DOS_HEADER *)module;
    IMAGE_NT_HEADERS64 *nt = (IMAGE_NT_HEADERS64 *)(module + dos->e_lfanew);
    IMAGE_DATA_DIRECTORY directory = nt->OptionalHeader.DataDirectory[IMAGE_DIRECTORY_ENTRY_EXPORT];
    if (!directory.VirtualAddress) return NULL;
    IMAGE_EXPORT_DIRECTORY *exports = (IMAGE_EXPORT_DIRECTORY *)(module + directory.VirtualAddress);
    DWORD *names = (DWORD *)(module + exports->AddressOfNames), *functions = (DWORD *)(module + exports->AddressOfFunctions);
    WORD *ordinals = (WORD *)(module + exports->AddressOfNameOrdinals);
    for (DWORD i = 0; i < exports->NumberOfNames; i++) if (!strcmp((char *)module + names[i], name)) {
        DWORD rva = functions[ordinals[i]];
        if (rva >= directory.VirtualAddress && rva < directory.VirtualAddress + directory.Size) return NULL;
        return (FARPROC)(module + rva);
    }
    return NULL;
}
static bool initialize(Host *host, const HostLaunch *launch)
{
    BYTE *image = launch->plugin;
    if (!image && launch->process_type == BEDROCK_PROCESS_MAIN) image = (BYTE *)LoadLibraryW(launch->path);
    if (!image) { host_error(host, "Cannot load the native plugin DLL."); return false; }
    typedef const BedrockPlugin *(BEDROCK_CALL *Getter)(void);
    Getter getter = (Getter)plugin_export(image, "Bedrock_GetPlugin");
    if (!getter) { host_error(host, "Native plugin must export Bedrock_GetPlugin."); return false; }
    host->plugin = getter();
    const BedrockPlugin *plugin = host->plugin;
    if (!plugin || plugin->size < offsetof(BedrockPlugin, settings_changed) + sizeof(plugin->settings_changed) || !plugin->start || !plugin->stop) {
        host_error(host, "Native plugin descriptor is incomplete; size, start and stop are required."); return false;
    }
    BedrockVersion version = plugin->required_api;
    if (version.major != BEDROCK_API_MAJOR || version.minor > BEDROCK_API_MINOR ||
        (version.minor == BEDROCK_API_MINOR && version.patch > BEDROCK_API_PATCH)) {
        char message[160]; sprintf_s(message, sizeof(message), "Native plugin requires API %u.%u.%u; host provides %u.%u.%u.",
            version.major, version.minor, version.patch, BEDROCK_API_MAJOR, BEDROCK_API_MINOR, BEDROCK_API_PATCH);
        host_error(host, message); return false;
    }
    if (plugin->settings_count > 1024 || (plugin->settings_count && !plugin->settings)) {
        host_error(host, "Invalid native settings array."); return false;
    }
    host->definitions = calloc(plugin->settings_count ? plugin->settings_count : 1, sizeof(*host->definitions));
    host->values = calloc(plugin->settings_count ? plugin->settings_count : 1, sizeof(*host->values));
    if (!host->definitions || !host->values) { host_error(host, "Cannot allocate native settings."); return false; }
    const BYTE *cursor = (const BYTE *)plugin->settings;
    for (uint32_t i = 0; i < plugin->settings_count; i++) {
        const BedrockSetting *setting = (const BedrockSetting *)cursor;
        if (setting->size < offsetof(BedrockSetting, choice_count) + sizeof(setting->choice_count) || setting->size % _Alignof(BedrockSetting) || !setting->key || !*setting->key || setting->type < 0 || setting->type > BEDROCK_SETTING_SLIDER ||
            setting->choice_count > 1024 || (setting->choice_count && !setting->choices) ||
            ((setting->flags & BEDROCK_SETTING_HAS_MIN) && !isfinite(setting->min)) ||
            ((setting->flags & BEDROCK_SETTING_HAS_MAX) && !isfinite(setting->max)) ||
            ((setting->flags & BEDROCK_SETTING_HAS_STEP) && (!isfinite(setting->step) || setting->step <= 0)) ||
            !valid_value(setting, &setting->default_value)) {
            host_error(host, "Invalid native setting definition or default."); return false;
        }
        for (uint32_t j = 0; j < i; j++) if (!strcmp(host->definitions[j]->key, setting->key)) {
            host_error(host, "Native settings contain duplicate keys."); return false;
        }
        host->definitions[i] = setting;
        if (!copy_value(&host->values[i], &setting->default_value)) { host_error(host, "Cannot copy default setting."); return false; }
        cursor += setting->size;
    }
    host->context = (BedrockContext){ sizeof(BedrockContext), { BEDROCK_API_MAJOR, BEDROCK_API_MINOR, BEDROCK_API_PATCH },
        host, launch->process_type, log_message, get_setting, set_setting, release_value, resolve_symbol, report_status };
    return describe(host);
}
static void stop_plugin(Host *host)
{
    if (InterlockedCompareExchange(&host->active, 0, 0)) {
        host->plugin->stop();
        InterlockedExchange(&host->active, 0);
    }
}
static void reply(Host *host, double id, BedrockResult result, const char *message)
{
    Text text = {0}; text_add(&text, "{\"event\":\"reply\",\"id\":"); text_number(&text, id);
    text_add(&text, ",\"result\":"); text_number(&text, result); optional_text(&text, "message", message);
    text_add(&text, "}"); send_message(host, &text);
}
static void command(Host *host, const char *json, jsmntok_t *tokens, int count)
{
    int id_index = json_member(json, tokens, count, 0, "id"), op_index = json_member(json, tokens, count, 0, "op");
    if (id_index < 0 || op_index < 0) { host_error(host, "Native command needs id and op."); return; }
    BedrockValue id; if (!json_value(json, &tokens[id_index], &id) || id.type != BEDROCK_VALUE_NUMBER) return;
    char *op = json_string(json, &tokens[op_index]); if (!op) return;
    BedrockResult result = BEDROCK_OK;
    if (!strcmp(op, "reference")) {
        const char *fields[] = { "imageHandle", "imageSize", "symbolsHandle", "symbolsSize" };
        BedrockValue values[4] = {0};
        bool valid = true;
        for (unsigned i = 0; i < 4; i++) {
            int index = json_member(json, tokens, count, 0, fields[i]);
            if (index < 0 || !json_value(json, &tokens[index], &values[i]) || values[i].type != BEDROCK_VALUE_NUMBER ||
                values[i].number <= 0 || values[i].number > MAXDWORD || floor(values[i].number) != values[i].number) valid = false;
        }
        const char *reason = "Cannot map the Electron reference files into the native host.";
        if (!valid || host->active || host->reference.image) {
            result = BEDROCK_INVALID_ARGUMENT;
            for (unsigned i = 0; i < 4; i += 2) if (values[i].type == BEDROCK_VALUE_NUMBER && values[i].number > 0 && values[i].number <= MAXDWORD)
                CloseHandle((HANDLE)(uintptr_t)values[i].number);
        }
        else {
            HANDLE image = (HANDLE)(uintptr_t)values[0].number, symbols = (HANDLE)(uintptr_t)values[2].number;
            host->reference.image_size = (size_t)values[1].number;
            host->reference.symbols_size = (size_t)values[3].number;
            host->reference.image = MapViewOfFile(image, FILE_MAP_READ, 0, 0, host->reference.image_size);
            host->reference.symbols = MapViewOfFile(symbols, FILE_MAP_READ, 0, 0, host->reference.symbols_size);
            CloseHandle(image); CloseHandle(symbols);
            if (!host->reference.image || !host->reference.symbols) { symbol_close(&host->reference); result = BEDROCK_ERROR; }
            else if (!symbol_reference_valid(&host->reference)) {
                symbol_close(&host->reference); result = BEDROCK_INVALID_VALUE;
                reason = "Electron reference symbols do not match the reference executable's PDB identity and architecture.";
            }
        }
        for (unsigned i = 0; i < 4; i++) release_value(host, &values[i]);
        reply(host, id.number, result, result == BEDROCK_OK ? NULL : reason);
        free(op); return;
    }
    else if (!strcmp(op, "stop")) stop_plugin(host);
    else if (!strcmp(op, "start")) {
        if (host->active) { reply(host, id.number, BEDROCK_ERROR, "Plugin is already running."); free(op); return; }
        int values = json_member(json, tokens, count, 0, "values");
        for (uint32_t i = 0; i < host->plugin->settings_count; i++) {
            int index = json_member(json, tokens, count, values, host->definitions[i]->key);
            BedrockValue value = {0};
            bool okay = index < 0 ? copy_value(&value, &host->definitions[i]->default_value) : json_value(json, &tokens[index], &value);
            if (!okay || !valid_value(host->definitions[i], &value)) { release_value(host, &value); result = BEDROCK_INVALID_VALUE; break; }
            release_value(host, &host->values[i]); host->values[i] = value;
        }
        if (result == BEDROCK_OK) {
            InterlockedExchange(&host->active, 1);
            result = host->plugin->start(&host->context);
            if (result != BEDROCK_OK) InterlockedExchange(&host->active, 0);
        }
    } else if (!strcmp(op, "change")) {
        int key_index = json_member(json, tokens, count, 0, "key"), value_index = json_member(json, tokens, count, 0, "value");
        char *key = key_index >= 0 ? json_string(json, &tokens[key_index]) : NULL;
        int index = setting_index(host, key); BedrockValue value = {0};
        if (index < 0) result = BEDROCK_UNKNOWN_SETTING;
        else if (value_index < 0 || !json_value(json, &tokens[value_index], &value) || !valid_value(host->definitions[index], &value)) result = BEDROCK_INVALID_VALUE;
        else {
            AcquireSRWLockExclusive(&host->values_lock);
            bool changed = !value_equal(&host->values[index], &value);
            release_value(host, &host->values[index]); host->values[index] = value; ZeroMemory(&value, sizeof(value));
            ReleaseSRWLockExclusive(&host->values_lock);
            if (changed && host->active && host->plugin->settings_changed) host->plugin->settings_changed(key, &host->values[index]);
        }
        release_value(host, &value); free(key);
    } else result = BEDROCK_INVALID_ARGUMENT;
    reply(host, id.number, result, NULL);
    free(op);
}

__declspec(dllexport) DWORD WINAPI BedrockHostRun(HostLaunch *launch)
{
    Host *host = calloc(1, sizeof(*host));
    if (!host) return ERROR_NOT_ENOUGH_MEMORY;
    host->input = launch->input; host->output = launch->output;
    if (!initialize(host, launch)) goto done;
    char *line = malloc(BEDROCK_MESSAGE_CAP); jsmntok_t *tokens = malloc(16384 * sizeof(*tokens));
    if (!line || !tokens) { free(line); free(tokens); host_error(host, "Cannot allocate native IPC buffers."); goto done; }
    size_t length = 0; char byte; DWORD read;
    while (ReadFile(host->input, &byte, 1, &read, NULL) && read) {
        if (byte != '\n') {
            if (length + 1 >= BEDROCK_MESSAGE_CAP) { host_error(host, "Native IPC message exceeds one MiB."); break; }
            line[length++] = byte; continue;
        }
        line[length] = 0;
        jsmn_parser parser; jsmn_init(&parser); int count = jsmn_parse(&parser, line, length, tokens, 16384);
        if (count > 0 && tokens[0].type == JSMN_OBJECT) command(host, line, tokens, count);
        else host_error(host, "Cannot parse native IPC command.");
        length = 0;
    }
    free(line); free(tokens); stop_plugin(host);
done:
    if (host->values && host->plugin) for (uint32_t i = 0; i < host->plugin->settings_count; i++) release_value(host, &host->values[i]);
    free(host->values); free(host->definitions); symbol_close(&host->reference);
    CloseHandle(host->input); CloseHandle(host->output); free(host);
    return ERROR_SUCCESS;
}
