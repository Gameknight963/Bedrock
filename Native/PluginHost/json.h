#pragma once
#include <stdlib.h>
#include <string.h>
#include <stdio.h>
#include <stdarg.h>
#include <stdbool.h>
#define JSMN_STATIC
#define JSMN_STRICT
#include "../../lib/jsmn/jsmn.h"

typedef struct Text { char *data; size_t length, capacity; bool failed; } Text;
static void text_add(Text *text, const char *value)
{
    size_t length = strlen(value);
    if (text->failed || text->length + length + 1 > BEDROCK_MESSAGE_CAP) { text->failed = true; return; }
    if (text->length + length + 1 > text->capacity) {
        size_t capacity = (text->length + length + 1) * 2;
        char *data = realloc(text->data, capacity);
        if (!data) { text->failed = true; return; }
        text->data = data; text->capacity = capacity;
    }
    memcpy(text->data + text->length, value, length + 1); text->length += length;
}
static void text_number(Text *text, double number)
{
    char value[64]; sprintf_s(value, sizeof(value), "%.17g", number); text_add(text, value);
}
static void text_quote(Text *text, const char *value)
{
    text_add(text, "\"");
    if (value) for (const unsigned char *p = (const unsigned char *)value; *p; p++) {
        char escape[8];
        if (*p == '"' || *p == '\\') { escape[0] = '\\'; escape[1] = (char)*p; escape[2] = 0; }
        else if (*p < 32) sprintf_s(escape, sizeof(escape), "\\u%04x", *p);
        else { escape[0] = (char)*p; escape[1] = 0; }
        text_add(text, escape);
    }
    text_add(text, "\"");
}
static void text_value(Text *text, const BedrockValue *value)
{
    if (value->type == BEDROCK_VALUE_BOOLEAN) text_add(text, value->boolean ? "true" : "false");
    else if (value->type == BEDROCK_VALUE_NUMBER) text_number(text, value->number);
    else if (value->type == BEDROCK_VALUE_STRING) text_quote(text, value->string);
    else text_add(text, "null");
}
static int token_after(const jsmntok_t *tokens, int count, int index)
{
    int end = tokens[index].end;
    index++;
    while (index < count && tokens[index].start < end) index++;
    return index;
}
static int json_member(const char *json, const jsmntok_t *tokens, int count, int object, const char *key)
{
    if (object < 0 || tokens[object].type != JSMN_OBJECT) return -1;
    for (int i = object + 1; i < count && tokens[i].start < tokens[object].end;) {
        int next = i + 1;
        if (tokens[i].type == JSMN_STRING && (size_t)(tokens[i].end - tokens[i].start) == strlen(key) &&
            !memcmp(json + tokens[i].start, key, strlen(key))) return next;
        i = token_after(tokens, count, next);
    }
    return -1;
}
static char *json_string(const char *json, const jsmntok_t *token)
{
    if (token->type != JSMN_STRING) return NULL;
    char *out = calloc((size_t)(token->end - token->start) + 1, 1);
    if (!out) return NULL;
    size_t offset = 0;
    for (int i = token->start; i < token->end; i++) {
        unsigned char ch = (unsigned char)json[i];
        if (ch != '\\') { out[offset++] = (char)ch; continue; }
        if (++i >= token->end) { free(out); return NULL; }
        ch = (unsigned char)json[i];
        if (ch == 'u') {
            if (i + 4 >= token->end) { free(out); return NULL; }
            unsigned code = 0;
            for (int j = 0; j < 4; j++) {
                char hex = json[++i];
                unsigned digit = hex >= '0' && hex <= '9' ? hex - '0' : hex >= 'a' && hex <= 'f' ? hex - 'a' + 10 : hex >= 'A' && hex <= 'F' ? hex - 'A' + 10 : 99;
                if (digit > 15) { free(out); return NULL; }
                code = code * 16 + digit;
            }
            wchar_t units[2] = { (wchar_t)code, 0 }; int n = 1;
            if (code >= 0xd800 && code <= 0xdbff) {
                if (i + 6 >= token->end || json[i + 1] != '\\' || json[i + 2] != 'u') { free(out); return NULL; }
                i += 2; unsigned low = 0;
                for (int j = 0; j < 4; j++) {
                    char hex = json[++i];
                    unsigned digit = hex >= '0' && hex <= '9' ? hex - '0' : hex >= 'a' && hex <= 'f' ? hex - 'a' + 10 : hex >= 'A' && hex <= 'F' ? hex - 'A' + 10 : 99;
                    if (digit > 15) { free(out); return NULL; } low = low * 16 + digit;
                }
                if (low < 0xdc00 || low > 0xdfff) { free(out); return NULL; } units[1] = (wchar_t)low; n = 2;
            }
            if (!code) { free(out); return NULL; }
            int bytes = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, units, n, out + offset, 4, NULL, NULL);
            if (!bytes) { free(out); return NULL; } offset += bytes;
        } else {
            const char *escapes = "\"\\/bfnrt", *characters = "\"\\/\b\f\n\r\t";
            const char *found = strchr(escapes, ch);
            if (!found) { free(out); return NULL; } out[offset++] = characters[found - escapes];
        }
    }
    out[offset] = 0; return out;
}
static bool json_value(const char *json, const jsmntok_t *token, BedrockValue *value)
{
    memset(value, 0, sizeof(*value));
    if (token->type == JSMN_STRING) {
        value->type = BEDROCK_VALUE_STRING; value->string = json_string(json, token); return value->string != NULL;
    }
    size_t length = (size_t)(token->end - token->start);
    if (token->type != JSMN_PRIMITIVE) return false;
    if ((length == 4 && !memcmp(json + token->start, "true", 4)) || (length == 5 && !memcmp(json + token->start, "false", 5))) {
        value->type = BEDROCK_VALUE_BOOLEAN; value->boolean = length == 4; return true;
    }
    char number[128]; if (length >= sizeof(number)) return false;
    memcpy(number, json + token->start, length); number[length] = 0;
    char *end; value->type = BEDROCK_VALUE_NUMBER; value->number = strtod(number, &end);
    return end != number && !*end && isfinite(value->number);
}
