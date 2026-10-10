#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "symbols.h"
#include "../../lib/minhook/src/hde/hde64.h"

struct SymbolCache {
    SymbolCache *next;
    char *name;
    void *address;
    BedrockSymbolError error;
};

static void *failure(BedrockSymbolError *error, BedrockSymbolResult code, const char *name, const char *reason)
{
    if (error) {
        error->code = code;
        size_t length = strlen(name);
        if (length > 220) {
            length = 220;
            while (((unsigned char)name[length] & 0xc0) == 0x80) length--;
        }
        snprintf(error->message, sizeof(error->message), "%.*s%s: %s.", (int)length, name,
            name[length] ? "..." : "", reason);
    }
    return NULL;
}

static IMAGE_NT_HEADERS64 *pe_headers(BYTE *image, size_t size)
{
    if (size < sizeof(IMAGE_NT_HEADERS64)) return NULL;
    IMAGE_DOS_HEADER *dos = (IMAGE_DOS_HEADER *)image;
    if (dos->e_magic != IMAGE_DOS_SIGNATURE || dos->e_lfanew < 0 ||
        (size_t)dos->e_lfanew > size - sizeof(IMAGE_NT_HEADERS64)) return NULL;
    IMAGE_NT_HEADERS64 *nt = (IMAGE_NT_HEADERS64 *)(image + dos->e_lfanew);
    if (nt->Signature != IMAGE_NT_SIGNATURE || nt->FileHeader.Machine != IMAGE_FILE_MACHINE_AMD64 ||
        nt->OptionalHeader.Magic != IMAGE_NT_OPTIONAL_HDR64_MAGIC ||
        nt->FileHeader.SizeOfOptionalHeader != sizeof(IMAGE_OPTIONAL_HEADER64)) return NULL;
    size_t section_offset = (BYTE *)IMAGE_FIRST_SECTION(nt) - image;
    if (section_offset > size || nt->FileHeader.NumberOfSections > (size - section_offset) / sizeof(IMAGE_SECTION_HEADER)) return NULL;
    return nt;
}

static BYTE *file_rva(SymbolReference *reference, IMAGE_NT_HEADERS64 *nt, DWORD rva, size_t length)
{
    IMAGE_SECTION_HEADER *sections = IMAGE_FIRST_SECTION(nt);
    for (WORD i = 0; i < nt->FileHeader.NumberOfSections; i++) {
        IMAGE_SECTION_HEADER *section = &sections[i];
        if (rva < section->VirtualAddress) continue;
        size_t offset = rva - section->VirtualAddress;
        if (offset > section->SizeOfRawData || length > section->SizeOfRawData - offset) continue;
        size_t file_offset = (size_t)section->PointerToRawData + offset;
        if (file_offset <= reference->image_size && length <= reference->image_size - file_offset)
            return reference->image + file_offset;
    }
    return NULL;
}

bool symbol_reference_valid(SymbolReference *reference)
{
    IMAGE_NT_HEADERS64 *nt = pe_headers(reference->image, reference->image_size);
    const char prefix[] = "MODULE windows x86_64 ";
    if (!nt || !reference->symbols || reference->symbols_size < sizeof(prefix) ||
        memcmp(reference->symbols, prefix, sizeof(prefix) - 1)) return false;
    IMAGE_DATA_DIRECTORY directory = nt->OptionalHeader.DataDirectory[IMAGE_DIRECTORY_ENTRY_DEBUG];
    BYTE *bytes = file_rva(reference, nt, directory.VirtualAddress, directory.Size);
    if (!bytes || !directory.Size || directory.Size % sizeof(IMAGE_DEBUG_DIRECTORY)) return false;
    for (size_t i = 0; i < directory.Size / sizeof(IMAGE_DEBUG_DIRECTORY); i++) {
        IMAGE_DEBUG_DIRECTORY *entry = (IMAGE_DEBUG_DIRECTORY *)bytes + i;
        if (entry->Type != IMAGE_DEBUG_TYPE_CODEVIEW || entry->SizeOfData < 24 ||
            entry->PointerToRawData > reference->image_size || entry->SizeOfData > reference->image_size - entry->PointerToRawData) continue;
        BYTE *record = reference->image + entry->PointerToRawData;
        if (memcmp(record, "RSDS", 4)) continue;
        GUID guid; DWORD age;
        memcpy(&guid, record + 4, sizeof(guid)); memcpy(&age, record + 20, sizeof(age));
        char identity[48];
        int length = snprintf(identity, sizeof(identity), "%08lX%04X%04X%02X%02X%02X%02X%02X%02X%02X%02X%lX",
            guid.Data1, guid.Data2, guid.Data3, guid.Data4[0], guid.Data4[1], guid.Data4[2], guid.Data4[3],
            guid.Data4[4], guid.Data4[5], guid.Data4[6], guid.Data4[7], age);
        size_t offset = sizeof(prefix) - 1;
        if (length > 0 && offset + length < reference->symbols_size && reference->symbols[offset + length] == ' ' &&
            !memcmp(reference->symbols + offset, identity, length)) return true;
    }
    return false;
}

static bool hex_field(const char **cursor, const char *end, DWORD *value)
{
    const char *p = *cursor; unsigned long long number = 0; bool any = false;
    while (p < end && *p != ' ') {
        unsigned digit = *p >= '0' && *p <= '9' ? *p - '0' :
            *p >= 'a' && *p <= 'f' ? *p - 'a' + 10 : *p >= 'A' && *p <= 'F' ? *p - 'A' + 10 : 16;
        if (digit == 16 || number > (MAXDWORD - digit) / 16) return false;
        number = number * 16 + digit; p++; any = true;
    }
    if (!any || p == end) return false;
    *cursor = p + 1; *value = (DWORD)number; return true;
}

static bool make_mask(const BYTE *code, size_t length, BYTE *mask, size_t *failed_offset)
{
    memset(mask, 255, length);
    for (size_t offset = 0; offset < length;) {
        *failed_offset = offset;
        BYTE padded[32] = {0};
        size_t remaining = length - offset;
        memcpy(padded, code + offset, remaining < 16 ? remaining : 16);
        // HDE rejects UD2, but this fixed two-byte trap has no operands to mask.
        if (remaining >= 2 && padded[0] == 0x0f && padded[1] == 0x0b) { offset += 2; continue; }
        hde64s instruction;
        hde64_disasm(padded, &instruction);
        if (!instruction.len || instruction.len > remaining || (instruction.flags & F_ERROR) || instruction.p_67 ||
            instruction.opcode == 0xc4 || instruction.opcode == 0xc5 || instruction.opcode == 0x62) return false;
        unsigned immediate = (instruction.flags & F_IMM8 ? 1 : 0) + (instruction.flags & F_IMM16 ? 2 : 0) +
            (instruction.flags & F_IMM32 ? 4 : 0) + (instruction.flags & F_IMM64 ? 8 : 0);
        if (immediate > instruction.len) return false;
        if ((instruction.flags & F_MODRM) && instruction.modrm_mod == 0 && instruction.modrm_rm == 5) {
            // RIP-relative addressing has a four-byte displacement, including with a 66 prefix.
            if (instruction.len < immediate + 4) return false;
            memset(mask + offset + instruction.len - immediate - 4, 0, 4);
        }
        if (instruction.flags & F_RELATIVE) {
            if (!immediate) return false;
            memset(mask + offset + instruction.len - immediate, 0, immediate);
        }
        offset += instruction.len;
    }
    return true;
}

static bool mask_relocations(SymbolReference *reference, IMAGE_NT_HEADERS64 *nt, DWORD rva, size_t length, BYTE *mask)
{
    IMAGE_DATA_DIRECTORY directory = nt->OptionalHeader.DataDirectory[IMAGE_DIRECTORY_ENTRY_BASERELOC];
    if (!directory.Size) return true;
    BYTE *bytes = file_rva(reference, nt, directory.VirtualAddress, directory.Size);
    if (!bytes) return false;
    for (size_t offset = 0; offset < directory.Size;) {
        if (directory.Size - offset < sizeof(IMAGE_BASE_RELOCATION)) return false;
        IMAGE_BASE_RELOCATION *block = (IMAGE_BASE_RELOCATION *)(bytes + offset);
        if (block->SizeOfBlock < sizeof(*block) || block->SizeOfBlock > directory.Size - offset || block->SizeOfBlock % 2) return false;
        WORD *entries = (WORD *)(block + 1);
        size_t count = (block->SizeOfBlock - sizeof(*block)) / sizeof(WORD);
        for (size_t i = 0; i < count; i++) {
            DWORD address = block->VirtualAddress + (entries[i] & 0xfff);
            if (address < rva || address - rva >= length || !(entries[i] >> 12)) continue;
            if ((entries[i] >> 12) != IMAGE_REL_BASED_DIR64 || length - (address - rva) < 8) return false;
            memset(mask + address - rva, 0, 8);
        }
        offset += block->SizeOfBlock;
    }
    return true;
}

static void *locate(SymbolReference *reference, BYTE *module, const char *name, BedrockSymbolError *error)
{
    if (!reference->image || !reference->symbols) return failure(error, BEDROCK_SYMBOL_REFERENCE_UNAVAILABLE, name, "Electron reference files are unavailable");
    const char *cursor = reference->symbols, *end = cursor + reference->symbols_size;
    DWORD rva = 0, size = 0; bool found = false;
    size_t name_length = strlen(name);
    while (cursor < end) {
        const char *line_end = memchr(cursor, '\n', end - cursor);
        if (!line_end) line_end = end;
        const char *content_end = line_end;
        while (content_end > cursor && content_end[-1] == '\r') content_end--;
        if (content_end - cursor > 5 && !memcmp(cursor, "FUNC ", 5)) {
            const char *p = cursor + 5;
            if (content_end - p > 2 && !memcmp(p, "m ", 2)) p += 2;
            DWORD function_rva, function_size, parameters;
            if (hex_field(&p, content_end, &function_rva) && hex_field(&p, content_end, &function_size) && hex_field(&p, content_end, &parameters) &&
                (size_t)(content_end - p) == name_length && !memcmp(p, name, name_length)) {
                if (found && (rva != function_rva || size != function_size))
                    return failure(error, BEDROCK_SYMBOL_NAME_AMBIGUOUS, name, "the reference contains multiple functions with this name");
                rva = function_rva; size = function_size; found = true;
            }
        }
        cursor = line_end < end ? line_end + 1 : end;
    }
    if (!found) return failure(error, BEDROCK_SYMBOL_NAME_NOT_FOUND, name, "the exact name is absent from the Electron reference symbols");
    IMAGE_NT_HEADERS64 *nt = pe_headers(reference->image, reference->image_size);
    BYTE *code = nt && size && size <= 256 * 1024 ? file_rva(reference, nt, rva, size) : NULL;
    if (!code) return failure(error, BEDROCK_SYMBOL_REFERENCE_INVALID, name, "the reference function has an invalid or unsupported code range");
    BYTE *mask = malloc(size);
    if (!mask) return failure(error, BEDROCK_SYMBOL_REFERENCE_UNAVAILABLE, name, "cannot allocate a function signature");
    size_t failed_offset = 0;
    if (!make_mask(code, size, mask, &failed_offset)) {
        char reason[160]; snprintf(reason, sizeof(reason), "cannot safely decode the reference instruction at function offset 0x%zx", failed_offset);
        free(mask); return failure(error, BEDROCK_SYMBOL_REFERENCE_INVALID, name, reason);
    }
    if (!mask_relocations(reference, nt, rva, size, mask)) {
        free(mask); return failure(error, BEDROCK_SYMBOL_REFERENCE_INVALID, name, "invalid reference relocations");
    }
    size_t anchor = 0, anchor_length = 0, run = 0;
    for (size_t i = 0; i < size; i++) {
        run = mask[i] ? run + 1 : 0;
        if (run > anchor_length) { anchor = i + 1 - run; anchor_length = run; }
    }
    if (anchor_length < 8) { free(mask); return failure(error, BEDROCK_SYMBOL_REFERENCE_INVALID, name, "too few consecutive fixed bytes for a reliable signature"); }
    IMAGE_DOS_HEADER *dos = (IMAGE_DOS_HEADER *)module;
    IMAGE_NT_HEADERS64 *target = (IMAGE_NT_HEADERS64 *)(module + dos->e_lfanew);
    IMAGE_SECTION_HEADER *sections = IMAGE_FIRST_SECTION(target);
    BYTE *match = NULL;
    for (WORD i = 0; i < target->FileHeader.NumberOfSections; i++) {
        IMAGE_SECTION_HEADER *section = &sections[i];
        if (!(section->Characteristics & IMAGE_SCN_MEM_EXECUTE) || section->Misc.VirtualSize < size) continue;
        if (section->VirtualAddress > target->OptionalHeader.SizeOfImage || section->Misc.VirtualSize > target->OptionalHeader.SizeOfImage - section->VirtualAddress) continue;
        BYTE *base = module + section->VirtualAddress;
        size_t maximum = section->Misc.VirtualSize - size;
        for (size_t offset = 0; offset <= maximum;) {
            BYTE *hit = memchr(base + offset + anchor, code[anchor], maximum - offset + 1);
            if (!hit) break;
            offset = hit - base - anchor;
            if (!memcmp(hit, code + anchor, anchor_length)) {
                size_t j = 0;
                while (j < size && (!mask[j] || base[offset + j] == code[j])) j++;
                if (j == size) {
                    if (match) { free(mask); return failure(error, BEDROCK_SYMBOL_TARGET_AMBIGUOUS, name, "multiple matching functions were found in the current executable"); }
                    match = base + offset;
                }
            }
            offset++;
        }
    }
    free(mask);
    if (!match) return failure(error, BEDROCK_SYMBOL_TARGET_NOT_FOUND, name, "no matching function was found in the current executable");
    DWORD64 image_base;
    PRUNTIME_FUNCTION function = RtlLookupFunctionEntry((DWORD64)match, &image_base, NULL);
    if (!function || image_base + function->BeginAddress != (DWORD64)match || function->EndAddress - function->BeginAddress != size)
        return failure(error, BEDROCK_SYMBOL_TARGET_INVALID, name, "the match does not agree with PE unwind function boundaries and size");
    return match;
}

void *symbol_resolve(SymbolReference *reference, BYTE *module, const char *name, BedrockSymbolError *error)
{
    if (error) memset(error, 0, sizeof(*error));
    if (!name || !*name || strlen(name) > 4096 || !MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, name, -1, NULL, 0))
        return failure(error, BEDROCK_SYMBOL_INVALID_ARGUMENT, "Symbol lookup", "name must contain between 1 and 4096 valid UTF-8 bytes");
    for (SymbolCache *entry = reference->cache; entry; entry = entry->next) if (!strcmp(entry->name, name)) {
        if (error) *error = entry->error;
        return entry->address;
    }
    BedrockSymbolError detail = {0};
    void *address = locate(reference, module, name, &detail);
    SymbolCache *entry = calloc(1, sizeof(*entry));
    if (entry) {
        entry->name = _strdup(name);
        if (entry->name) {
            entry->address = address; entry->error = detail; entry->next = reference->cache; reference->cache = entry;
        } else free(entry);
    }
    if (error) *error = detail;
    return address;
}

void symbol_close(SymbolReference *reference)
{
    while (reference->cache) {
        SymbolCache *entry = reference->cache; reference->cache = entry->next;
        free(entry->name); free(entry);
    }
    if (reference->image) UnmapViewOfFile(reference->image);
    if (reference->symbols) UnmapViewOfFile(reference->symbols);
    memset(reference, 0, sizeof(*reference));
}
