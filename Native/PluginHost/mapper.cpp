#include "mapper.h"
#include "../../lib/manual-map/injector.h"

BOOL native_map(HANDLE process, BYTE *image, size_t size, BYTE **base)
{
    if (size < sizeof(IMAGE_NT_HEADERS64)) return FALSE;
    IMAGE_DOS_HEADER *dos = (IMAGE_DOS_HEADER *)image;
    if (dos->e_magic != IMAGE_DOS_SIGNATURE || dos->e_lfanew < 0 || (size_t)dos->e_lfanew > size - sizeof(IMAGE_NT_HEADERS64)) return FALSE;
    IMAGE_NT_HEADERS64 *nt = (IMAGE_NT_HEADERS64 *)(image + dos->e_lfanew);
    if (nt->Signature != IMAGE_NT_SIGNATURE || nt->FileHeader.Machine != IMAGE_FILE_MACHINE_AMD64 ||
        nt->OptionalHeader.Magic != IMAGE_NT_OPTIONAL_HDR64_MAGIC || nt->FileHeader.SizeOfOptionalHeader != sizeof(IMAGE_OPTIONAL_HEADER64) ||
        size < 4096 || nt->OptionalHeader.SizeOfHeaders > size || nt->OptionalHeader.SizeOfImage < nt->OptionalHeader.SizeOfHeaders) return FALSE;
    size_t table = (size_t)((BYTE *)IMAGE_FIRST_SECTION(nt) - image);
    if (table > size || nt->FileHeader.NumberOfSections > (size - table) / sizeof(IMAGE_SECTION_HEADER)) return FALSE;
    IMAGE_SECTION_HEADER *sections = IMAGE_FIRST_SECTION(nt);
    for (WORD i = 0; i < nt->FileHeader.NumberOfSections; ++i) {
        if (sections[i].PointerToRawData > size || sections[i].SizeOfRawData > size - sections[i].PointerToRawData ||
            sections[i].VirtualAddress > nt->OptionalHeader.SizeOfImage ||
            max(sections[i].Misc.VirtualSize, sections[i].SizeOfRawData) > nt->OptionalHeader.SizeOfImage - sections[i].VirtualAddress) return FALSE;
    }
    return ManualMapDll(process, image, size, false, false, true, true, DLL_PROCESS_ATTACH, nullptr, base);
}
