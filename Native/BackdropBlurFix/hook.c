#include <windows.h>
#include <stdbool.h>
#include <stdint.h>
#include <intrin.h>
#include "../../lib/minhook/include/MinHook.h"
#include "signatures.h"
#include "status.h"
#include "../../include/bedrock/plugin.h"

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

static BOOL compatible_function(const unsigned char *function, const Signature *signature)
{
    DWORD64 base;
    PRUNTIME_FUNCTION bounds = RtlLookupFunctionEntry((DWORD64)function, &base, NULL);
    if (!bounds || bounds->EndAddress - bounds->BeginAddress != signature->function_size) return FALSE;
    for (size_t i = 0; i < signature->length; i++)
        if (signature->mask[i] && function[i] != signature->bytes[i]) return FALSE;
    return TRUE;
}

static DWORD install_hooks(const BedrockContext *context)
{
    if (InterlockedCompareExchange(&installed, 0, 0)) {
        InterlockedExchange(&enabled, 1);
        InterlockedExchange(&BlurCounters.enabled, 1);
        return ERROR_SUCCESS;
    }
    ZeroMemory(&BlurDiagnostics, sizeof(BlurDiagnostics));
    const char *names[] = {
        "viz::SkiaRenderer::PrepareCanvasForRPDQ(const struct viz::SkiaRenderer::DrawRPDQParams & const, struct viz::SkiaRenderer::DrawQuadParams *)",
        "SkPaint::setBlendMode(SkBlendMode)",
        "viz::SkiaRenderer::DrawRPDQParams::ClearOutsideBackdropBounds(class SkCanvas *, const struct viz::SkiaRenderer::DrawQuadParams *)",
        "SkBlenders::Arithmetic(float,float,float,float,bool)",
        "SkCanvas::clipPath(SkPath const &,SkClipOp,bool)",
        "SkCanvas::clipRect(SkRect const &,SkClipOp,bool)"
    };
    void *functions[6];
    for (unsigned i = 0; i < 6; i++) {
        BedrockSymbolError error = {0};
        functions[i] = context->resolve_symbol(context->host, names[i], &error);
        if (!functions[i]) {
            context->log(context->host, BEDROCK_LOG_ERROR, error.message);
            return ERROR_REVISION_MISMATCH;
        }
    }
    // Locating code does not validate our private Skia layouts. Guard the functions whose internals we depend on.
    const Signature *guards[] = { &sig_prepare, &sig_blend, &sig_clear, &sig_arithmetic };
    for (unsigned i = 0; i < 4; i++) if (!compatible_function(functions[i], guards[i])) {
        context->log(context->host, BEDROCK_LOG_ERROR, names[i]);
        context->log(context->host, BEDROCK_LOG_ERROR, "Function located, but its machine code differs from the layouts supported by the blur hook.");
        return ERROR_REVISION_MISMATCH;
    }
    prepare_address = functions[0];
    void *blend = functions[1], *clear = functions[2];
    arithmetic = (Arithmetic)functions[3]; clip_path = (Clip)functions[4]; clip_rect = (Clip)functions[5];
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

__declspec(dllexport) DWORD WINAPI BlurInstall(const BedrockContext *context)
{
    AcquireSRWLockExclusive(&control_lock);
    DWORD result = install_hooks(context);
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
