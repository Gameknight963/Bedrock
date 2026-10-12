export function createUnloadContext(manifest, log, requireRestart) {
    return Object.freeze({ id: manifest.id, manifest: structuredClone(manifest), log, requireRestart });
}

export async function unloadPlugin(callback, context = { requireRestart() {} }, timeout = 10000) {
    let timer, reason;
    const unloadContext = Object.freeze({ ...context, requireRestart(message) {
        reason = String(message);
        context.requireRestart(reason);
    } });
    try {
        const result = await Promise.race([Promise.resolve().then(() => callback?.(unloadContext)), new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('unload() did not finish within 10 seconds')), timeout);
        })]);
        if (result !== undefined) throw new Error('unload(ctx) must return nothing; use ctx.requireRestart(reason).');
        return { requiresRestart: reason !== undefined, reason };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const failure = `Could not unload the plugin: ${message}`;
        context.requireRestart(failure);
        return { requiresRestart: true, reason: failure, error: message };
    } finally { clearTimeout(timer); }
}
