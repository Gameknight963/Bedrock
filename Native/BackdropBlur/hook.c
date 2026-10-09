#include <windows.h>
#include <stdbool.h>
#include <stdint.h>
#include <intrin.h>
#include "../../lib/minhook/include/MinHook.h"
#include "signatures.h"
#include "status.h"

__declspec(dllexport) BlurStatus BlurCounters;
__declspec(dllexport) BlurInstallDiagnostic BlurDiagnostics;

typedef void (*Prepare)(void *, const unsigned char *, unsigned char *);
typedef void (*Blend)(unsigned char *, int);
typedef void (*Clear)(const unsigned char *, void *, const unsigned char *);
typedef void (*Clip)(void *, const void *, int, bool);
typedef void *(*Arithmetic)(void **, float, float, float, float, bool);

typedef struct ActiveLayer {
    const unsigned char *rpdq;
    void *canvas;
    void *blender;
} ActiveLayer;

static Prepare original_prepare;
static Blend original_blend;
static Clear original_clear;
static Clip clip_path, clip_rect;
static Arithmetic arithmetic;
static unsigned char *prepare_address;
static volatile LONG installed, enabled;
static SRWLOCK control_lock = SRWLOCK_INIT;
static DWORD active_slot = TLS_OUT_OF_INDEXES;

static void release_blender(void *blender)
{
    // SkRefCnt is a vtable followed by a 32-bit reference count in this verified ABI.
    if (blender && !InterlockedDecrement((volatile LONG *)((unsigned char *)blender + 8))) {
        void (**vtable)(void *) = *(void (***)(void *))blender;
        vtable[1](blender);
    }
}

static void blend_hook(unsigned char *paint, int mode)
{
    ActiveLayer *active = TlsGetValue(active_slot);
    original_blend(paint, mode);
    if (active && active->blender && mode == 3 && _ReturnAddress() == prepare_address + 0xaa) {
        // setBlendMode(SrcOver) cleared fBlender. Transfer Skia's owned reference to that field.
        *(void **)(paint + 0x28) = active->blender;
        active->blender = NULL;
        InterlockedIncrement(&BlurCounters.replaced);
    }
}

static void clear_hook(const unsigned char *rpdq, void *canvas, const unsigned char *params)
{
    ActiveLayer *active = TlsGetValue(active_slot);
    if (!active || active->rpdq != rpdq || active->canvas != canvas)
        original_clear(rpdq, canvas, params);
    // The outer clip already supplies coverage; clearing inside would apply rounded edges twice.
}

static void prepare_hook(void *renderer, const unsigned char *rpdq, unsigned char *params)
{
    InterlockedIncrement(&BlurCounters.calls);
    if (!InterlockedCompareExchange(&enabled, 0, 0) || !*(void *const *)(rpdq + 0x10)) {
        original_prepare(renderer, rpdq, params);
        return;
    }
    InterlockedIncrement(&BlurCounters.backdrop);
    float opacity = *(float *)(params + 0xc0);
    // Layout offsets come from the matched Electron functions, not a guessed Chromium header ABI.
    BOOL unsupported = FALSE;
    if (*(void *const *)rpdq || *(void *const *)(rpdq + 8)) { InterlockedIncrement(&BlurCounters.forward_filter); unsupported = TRUE; }
    if (rpdq[0x50]) { InterlockedIncrement(&BlurCounters.shader_mask); unsupported = TRUE; }
    // Without a split draw region, backdrop bounds stay in the original render-pass space even when bypassed.
    if (rpdq[0xcc]) InterlockedIncrement(&BlurCounters.bypass);
    if (params[0xfc]) { InterlockedIncrement(&BlurCounters.split_region); unsupported = TRUE; }
    if (*(int *)(params + 0xbc) != 3) { InterlockedIncrement(&BlurCounters.blend_mode); unsupported = TRUE; }
    if (!(opacity >= 0 && opacity <= 1)) { InterlockedIncrement(&BlurCounters.opacity); unsupported = TRUE; }
    if (unsupported) {
        original_prepare(renderer, rpdq, params);
        return;
    }
    ActiveLayer layer = { rpdq, *(void **)((unsigned char *)renderer + 0x408), NULL };
    // Windows x64 returns sk_sp through a hidden first argument. The factory owns one reference.
    // Skia applies paint opacity to src; the blender adds dst * (1 - opacity).
    arithmetic(&layer.blender, 0, 1, 1 - opacity, 0, true);
    if (!layer.blender) { InterlockedIncrement(&BlurCounters.blender_failed); original_prepare(renderer, rpdq, params); return; }
    ActiveLayer *previous = TlsGetValue(active_slot);
    clip_rect(layer.canvas, rpdq + 0x70, 1, true);
    if (rpdq[0x68]) clip_path(layer.canvas, rpdq + 0x58, 1, true);
    TlsSetValue(active_slot, &layer);
    original_prepare(renderer, rpdq, params);
    TlsSetValue(active_slot, previous);
    release_blender(layer.blender);
}

static unsigned char *find_signature(unsigned char *module, const Signature *signature, BlurMatchDiagnostic *diagnostic)
{
    diagnostic->result = BLUR_MATCH_MISSING;
    diagnostic->expected_size = signature->function_size;
    IMAGE_DOS_HEADER *dos = (IMAGE_DOS_HEADER *)module;
    IMAGE_NT_HEADERS64 *nt = (IMAGE_NT_HEADERS64 *)(module + dos->e_lfanew);
    IMAGE_SECTION_HEADER *sections = IMAGE_FIRST_SECTION(nt);
    unsigned char *found = NULL;
    for (WORD section = 0; section < nt->FileHeader.NumberOfSections; section++) {
        if (!(sections[section].Characteristics & IMAGE_SCN_MEM_EXECUTE)) continue;
        size_t size = sections[section].Misc.VirtualSize;
        unsigned char *bytes = module + sections[section].VirtualAddress;
        for (size_t offset = 0; offset + signature->length <= size; offset++) {
            if (bytes[offset] != signature->bytes[0]) continue;
            size_t index = 1;
            while (index < signature->length && (!signature->mask[index] ||
                bytes[offset + index] == signature->bytes[index])) index++;
            if (index != signature->length) continue;
            if (found) { diagnostic->result = BLUR_MATCH_DUPLICATE; return NULL; }
            found = bytes + offset;
        }
    }
    if (found) {
        DWORD64 base;
        PRUNTIME_FUNCTION function = RtlLookupFunctionEntry((DWORD64)found, &base, NULL);
        if (!function) { diagnostic->result = BLUR_MATCH_NO_UNWIND; return NULL; }
        diagnostic->actual_size = function->EndAddress - function->BeginAddress;
        if (base + function->BeginAddress != (DWORD64)found) { diagnostic->result = BLUR_MATCH_NOT_START; return NULL; }
        if (diagnostic->actual_size != signature->function_size) { diagnostic->result = BLUR_MATCH_SIZE; return NULL; }
        diagnostic->result = BLUR_MATCH_OK;
    }
    return found;
}

static DWORD install_hooks(void)
{
    if (InterlockedCompareExchange(&installed, 0, 0)) {
        InterlockedExchange(&enabled, 1);
        InterlockedExchange(&BlurCounters.enabled, 1);
        return ERROR_SUCCESS;
    }
    ZeroMemory(&BlurDiagnostics, sizeof(BlurDiagnostics));
    unsigned char *module = (unsigned char *)GetModuleHandleW(NULL);
    prepare_address = find_signature(module, &sig_prepare, &BlurDiagnostics.functions[0]);
    void *blend = find_signature(module, &sig_blend, &BlurDiagnostics.functions[1]);
    void *clear = find_signature(module, &sig_clear, &BlurDiagnostics.functions[2]);
    arithmetic = (Arithmetic)find_signature(module, &sig_arithmetic, &BlurDiagnostics.functions[3]);
    clip_path = (Clip)find_signature(module, &sig_clip_path, &BlurDiagnostics.functions[4]);
    clip_rect = (Clip)find_signature(module, &sig_clip_rect, &BlurDiagnostics.functions[5]);
    if (!prepare_address || !blend || !clear || !arithmetic || !clip_path || !clip_rect)
        return ERROR_REVISION_MISMATCH;
    BlurDiagnostics.stage = 1;
    if (active_slot == TLS_OUT_OF_INDEXES) active_slot = TlsAlloc();
    if (active_slot == TLS_OUT_OF_INDEXES) return ERROR_NOT_ENOUGH_MEMORY;
    BlurDiagnostics.stage = 2;
    MH_STATUS status = MH_Initialize();
    BlurDiagnostics.minhook_status = status;
    if (status != MH_OK) return ERROR_DLL_INIT_FAILED;
    BlurDiagnostics.stage = 3;
    status = MH_CreateHook(prepare_address, (void *)prepare_hook, (void **)&original_prepare);
    if (status == MH_OK) {
        BlurDiagnostics.stage = 4;
        status = MH_CreateHook(blend, (void *)blend_hook, (void **)&original_blend);
    }
    if (status == MH_OK) {
        BlurDiagnostics.stage = 5;
        status = MH_CreateHook(clear, (void *)clear_hook, (void **)&original_clear);
    }
    if (status == MH_OK) {
        BlurDiagnostics.stage = 6;
        status = MH_EnableHook(MH_ALL_HOOKS);
    }
    BlurDiagnostics.minhook_status = status;
    if (status != MH_OK) { MH_Uninitialize(); return ERROR_DLL_INIT_FAILED; }
    InterlockedExchange(&installed, 1);
    InterlockedExchange(&enabled, 1);
    InterlockedExchange(&BlurCounters.enabled, 1);
    return ERROR_SUCCESS;
}

__declspec(dllexport) DWORD WINAPI BlurInstall(void *unused)
{
    (void)unused;
    AcquireSRWLockExclusive(&control_lock);
    DWORD result = install_hooks();
    ReleaseSRWLockExclusive(&control_lock);
    return result;
}

__declspec(dllexport) DWORD WINAPI BlurRemove(void *unused)
{
    (void)unused;
    // Keep trampolines and the DLL resident so a render thread already inside a hook can return safely.
    AcquireSRWLockExclusive(&control_lock);
    InterlockedExchange(&enabled, 0);
    InterlockedExchange(&BlurCounters.enabled, 0);
    ReleaseSRWLockExclusive(&control_lock);
    return ERROR_SUCCESS;
}

BOOL WINAPI DllMain(HINSTANCE instance, DWORD reason, void *reserved)
{
    (void)instance;
    (void)reason;
    (void)reserved;
    return TRUE;
}
