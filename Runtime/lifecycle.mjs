export async function unloadPlugin(callback, timeout = 10000) {
    let timer;
    try {
        const result = await Promise.race([Promise.resolve().then(() => callback?.()), new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('unload() did not finish within 10 seconds')), timeout);
        })]);
        if (result === undefined || result === null) return { requiresRestart: false };
        if (typeof result !== 'object' || typeof result.requiresRestart !== 'boolean' ||
            (result.reason !== undefined && typeof result.reason !== 'string')) throw new Error('unload() must return nothing or { requiresRestart, reason }.');
        return { requiresRestart: result.requiresRestart, reason: result.reason || (result.requiresRestart ? 'The plugin requires a restart to unload.' : undefined) };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { requiresRestart: true, reason: `Could not unload the plugin: ${message}`, error: message };
    } finally { clearTimeout(timer); }
}
