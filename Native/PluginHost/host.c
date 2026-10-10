#include <windows.h>
#include <stdbool.h>
#include <stdint.h>
#include <stddef.h>
#include <math.h>
#include "transport.h"
#include "json.h"
#include "symbols.h"

typedef struct JsRequest {
    struct JsRequest *next;
    uint64_t id;
    HANDLE event;
    bool done;
    BedrockResult status;
    BedrockJsValue value;
    BedrockJsError error;
    BedrockJsCallback callback;
    void *user_data;
} JsRequest;
typedef struct HostCommand { struct HostCommand *next; char *json; } HostCommand;
typedef struct HostOutput { struct HostOutput *next; char *data; size_t length; } HostOutput;
typedef struct Host {
    HANDLE input, output;
    const BedrockPlugin *plugin;
    BedrockContext context;
    const BedrockSetting **definitions;
    BedrockValue *values;
    SRWLOCK values_lock, output_lock, symbols_lock;
    SymbolReference reference;
    volatile LONG active;
    SRWLOCK js_lock, commands_lock;
    JsRequest *requests, *completions, **completion_tail;
    uint64_t js_sequence;
    bool js_stopping, callbacks_exit, input_closed;
    HANDLE callback_event, callbacks_idle, callback_thread, command_event, reader_thread;
    HostCommand *commands, **command_tail;
    HostOutput *outgoing, **outgoing_tail;
    size_t output_bytes;
    volatile LONG output_closed, reader_exit;
    bool output_exit;
    HANDLE output_event, writer_thread;
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
    HostOutput *item = !text->failed && text->data ? calloc(1, sizeof(*item)) : NULL;
    bool accepted = false;
    if (item) {
        item->data = text->data; item->length = text->length;
        AcquireSRWLockExclusive(&host->output_lock);
        if (!host->output_closed && !host->output_exit && host->output_bytes + item->length <= 4 * BEDROCK_MESSAGE_CAP) {
            host->output_bytes += item->length;
            *host->outgoing_tail = item; host->outgoing_tail = &item->next;
            SetEvent(host->output_event); accepted = true;
        }
        ReleaseSRWLockExclusive(&host->output_lock);
    }
    if (!accepted) { free(item); free(text->data); }
    return accepted;
}

#include "javascript.h"

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
    text_add(&text, ((host->plugin->required_api.minor >= 1 && host->plugin->required_api.minor < 3) ||
        (host->plugin->size >= offsetof(BedrockPlugin, flags) + sizeof(host->plugin->flags) &&
         (host->plugin->flags & BEDROCK_PLUGIN_REQUIRES_SYMBOLS))) ? "true" : "false");
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
    if (plugin->size >= offsetof(BedrockPlugin, flags) + sizeof(plugin->flags) &&
        (plugin->flags & ~BEDROCK_PLUGIN_REQUIRES_SYMBOLS)) {
        host_error(host, "Native plugin declares unsupported descriptor flags."); return false;
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
        host, launch->process_type, log_message, get_setting, set_setting, release_value, resolve_symbol, report_status,
        launch->process_type == BEDROCK_PROCESS_GPU ? NULL : execute_js,
        launch->process_type == BEDROCK_PROCESS_GPU ? NULL : execute_js_async,
        launch->process_type == BEDROCK_PROCESS_GPU ? NULL : release_js_value };
    return describe(host);
}
static void stop_plugin(Host *host)
{
    if (InterlockedCompareExchange(&host->active, 0, 0)) {
        js_cancel_all(host, BEDROCK_JS_STOPPED, "The native plugin is stopping.");
        WaitForSingleObject(host->callbacks_idle, INFINITE);
        host->plugin->stop();
        Text reset = {0}; text_add(&reset, "{\"event\":\"js.reset\"}"); send_message(host, &reset);
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
            AcquireSRWLockExclusive(&host->js_lock); host->js_stopping = false; ReleaseSRWLockExclusive(&host->js_lock);
            InterlockedExchange(&host->active, 1);
            result = host->plugin->start(&host->context);
            if (result != BEDROCK_OK) {
                js_cancel_all(host, BEDROCK_JS_STOPPED, "Native plugin startup failed.");
                WaitForSingleObject(host->callbacks_idle, INFINITE);
                InterlockedExchange(&host->active, 0);
                Text reset = {0}; text_add(&reset, "{\"event\":\"js.reset\"}"); send_message(host, &reset);
            }
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

static DWORD WINAPI write_messages(void *opaque)
{
    Host *host = opaque;
    for (;;) {
        WaitForSingleObject(host->output_event, INFINITE);
        for (;;) {
            AcquireSRWLockExclusive(&host->output_lock);
            HostOutput *item = host->outgoing;
            bool exit = host->output_exit;
            if (item) { host->outgoing = item->next; if (!host->outgoing) host->outgoing_tail = &host->outgoing; }
            ReleaseSRWLockExclusive(&host->output_lock);
            if (!item) { if (exit) return 0; break; }
            DWORD written = 0; size_t offset = 0;
            while (offset < item->length) {
                if (!WriteFile(host->output, item->data + offset, (DWORD)(item->length - offset), &written, NULL) || !written) break;
                offset += written;
            }
            bool sent = offset == item->length && WriteFile(host->output, "\n", 1, &written, NULL) && written == 1;
            AcquireSRWLockExclusive(&host->output_lock);
            host->output_bytes -= item->length;
            if (!sent) InterlockedExchange(&host->output_closed, 1);
            ReleaseSRWLockExclusive(&host->output_lock);
            free(item->data); free(item);
            if (!sent) {
                js_cancel_all(host, BEDROCK_JS_TRANSPORT_ERROR, "The JavaScript bridge disconnected.");
                if (host->reader_thread) CancelSynchronousIo(host->reader_thread);
                AcquireSRWLockExclusive(&host->commands_lock);
                host->input_closed = true; SetEvent(host->command_event);
                ReleaseSRWLockExclusive(&host->commands_lock);
                return 0;
            }
        }
    }
}

static DWORD WINAPI read_commands(void *opaque)
{
    Host *host = opaque;
    char *line = malloc(BEDROCK_MESSAGE_CAP); jsmntok_t *tokens = malloc(16384 * sizeof(*tokens));
    size_t length = 0; char byte; DWORD read;
    if (!line || !tokens) goto done;
    while (!InterlockedCompareExchange(&host->reader_exit, 0, 0) && !InterlockedCompareExchange(&host->output_closed, 0, 0) && ReadFile(host->input, &byte, 1, &read, NULL) && read) {
        if (byte != '\n') {
            if (length + 1 >= BEDROCK_MESSAGE_CAP) { host_error(host, "Native IPC message exceeds one MiB."); break; }
            line[length++] = byte; continue;
        }
        line[length] = 0;
        jsmn_parser parser; jsmn_init(&parser); int count = jsmn_parse(&parser, line, length, tokens, 16384);
        if (count <= 0 || tokens[0].type != JSMN_OBJECT) { host_error(host, "Cannot parse native IPC command."); break; }
        int index = json_member(line, tokens, count, 0, "op");
        char *op = index >= 0 ? json_string(line, &tokens[index]) : NULL;
        if (op && !strcmp(op, "js.reply")) js_receive(host, line, tokens, count);
        else {
            if (op && !strcmp(op, "stop")) js_cancel_all(host, BEDROCK_JS_STOPPED, "The native plugin is stopping.");
            HostCommand *item = calloc(1, sizeof(*item));
            if (item) item->json = _strdup(line);
            if (!item || !item->json) { free(item); free(op); break; }
            AcquireSRWLockExclusive(&host->commands_lock);
            *host->command_tail = item; host->command_tail = &item->next;
            SetEvent(host->command_event);
            ReleaseSRWLockExclusive(&host->commands_lock);
        }
        free(op); length = 0;
    }
done:
    free(line); free(tokens);
    js_cancel_all(host, BEDROCK_JS_TRANSPORT_ERROR, "The JavaScript bridge disconnected.");
    AcquireSRWLockExclusive(&host->commands_lock);
    host->input_closed = true; SetEvent(host->command_event);
    ReleaseSRWLockExclusive(&host->commands_lock);
    return 0;
}

static void cancel_and_join(HANDLE thread)
{
    // Cancellation can miss a thread between its stop check and the next blocking I/O call.
    do { CancelSynchronousIo(thread); } while (WaitForSingleObject(thread, 50) == WAIT_TIMEOUT);
}

__declspec(dllexport) DWORD WINAPI BedrockHostRun(HostLaunch *launch)
{
    Host *host = calloc(1, sizeof(*host));
    if (!host) return ERROR_NOT_ENOUGH_MEMORY;
    host->input = launch->input; host->output = launch->output;
    host->completion_tail = &host->completions; host->command_tail = &host->commands; host->outgoing_tail = &host->outgoing;
    host->output_event = CreateEventW(NULL, FALSE, FALSE, NULL);
    host->callback_event = CreateEventW(NULL, FALSE, FALSE, NULL);
    host->callbacks_idle = CreateEventW(NULL, TRUE, TRUE, NULL);
    host->command_event = CreateEventW(NULL, FALSE, FALSE, NULL);
    if (!host->output_event || !host->callback_event || !host->callbacks_idle || !host->command_event) goto done;
    host->writer_thread = CreateThread(NULL, 0, write_messages, host, 0, NULL);
    if (!host->writer_thread) goto done;
    host->callback_thread = CreateThread(NULL, 0, js_callbacks, host, 0, NULL);
    if (!host->callback_thread || !initialize(host, launch)) goto done;
    host->reader_thread = CreateThread(NULL, 0, read_commands, host, 0, NULL);
    jsmntok_t *tokens = malloc(16384 * sizeof(*tokens));
    if (!host->reader_thread || !tokens) {
        host_error(host, "Cannot start native IPC reader.");
        if (host->reader_thread) { InterlockedExchange(&host->reader_exit, 1); cancel_and_join(host->reader_thread); }
        free(tokens); goto done;
    }
    for (;;) {
        WaitForSingleObject(host->command_event, INFINITE);
        for (;;) {
            AcquireSRWLockExclusive(&host->commands_lock);
            HostCommand *item = host->commands;
            bool closed = host->input_closed;
            if (item) { host->commands = item->next; if (!host->commands) host->command_tail = &host->commands; }
            ReleaseSRWLockExclusive(&host->commands_lock);
            if (!item) { if (closed) goto finished; break; }
            jsmn_parser parser; jsmn_init(&parser);
            int count = jsmn_parse(&parser, item->json, strlen(item->json), tokens, 16384);
            if (count > 0) command(host, item->json, tokens, count);
            free(item->json); free(item);
        }
    }
finished:
    InterlockedExchange(&host->reader_exit, 1);
    cancel_and_join(host->reader_thread);
    free(tokens); stop_plugin(host);
done:
    if (host->callback_thread) {
        AcquireSRWLockExclusive(&host->js_lock); host->callbacks_exit = true; SetEvent(host->callback_event); ReleaseSRWLockExclusive(&host->js_lock);
        WaitForSingleObject(host->callback_thread, INFINITE); CloseHandle(host->callback_thread);
    }
    if (host->writer_thread) {
        AcquireSRWLockExclusive(&host->output_lock); host->output_exit = true; SetEvent(host->output_event); ReleaseSRWLockExclusive(&host->output_lock);
        if (WaitForSingleObject(host->writer_thread, 500) != WAIT_OBJECT_0) cancel_and_join(host->writer_thread);
        CloseHandle(host->writer_thread);
    }
    while (host->outgoing) { HostOutput *item = host->outgoing; host->outgoing = item->next; free(item->data); free(item); }
    while (host->commands) { HostCommand *item = host->commands; host->commands = item->next; free(item->json); free(item); }
    if (host->output_event) CloseHandle(host->output_event);
    if (host->reader_thread) CloseHandle(host->reader_thread);
    if (host->callback_event) CloseHandle(host->callback_event);
    if (host->callbacks_idle) CloseHandle(host->callbacks_idle);
    if (host->command_event) CloseHandle(host->command_event);
    if (host->values && host->plugin) for (uint32_t i = 0; i < host->plugin->settings_count; i++) release_value(host, &host->values[i]);
    free(host->values); free(host->definitions); symbol_close(&host->reference);
    CloseHandle(host->input); CloseHandle(host->output); free(host);
    return ERROR_SUCCESS;
}
