export function start(app) {
    app.on('browser-window-created', () => { globalThis.preparedWindowSeen = true; });
}
