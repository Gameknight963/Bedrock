export const ready = await Promise.resolve(true);
export function start(app) {
    if (!ready) throw new Error('Module preparation failed');
    app.on('browser-window-created', () => { globalThis.preparedWindowSeen = true; });
}
