export function start(ctx) {
    ctx.windows.beforeCreate(options => { options.webPreferences.devTools = true; });
    const attached = new Set();
    const attach = window => {
        const contents = window.webContents;
        if (contents.isDestroyed() || attached.has(contents)) return;
        attached.add(contents);
        let opened = false;
        const input = (event, input) => {
            if (input.type !== 'keyDown' || input.isAutoRepeat || input.alt || input.meta) return;
            const shortcut = (input.control && input.shift && input.key.toLowerCase() === 'i') ||
                (!input.control && !input.shift && input.key === 'F12');
            if (!shortcut) return;
            let url;
            try { url = new URL(contents.getURL()); } catch { return; }
            if (url.protocol !== 'https:' || !['discord.com', 'canary.discord.com', 'ptb.discord.com'].includes(url.hostname)) return;
            event.preventDefault();
            if (contents.getLastWebPreferences().devTools === false) {
                ctx.requireRestart('Restart Discord to enable DevTools for this window.');
                return;
            }
            if (contents.isDevToolsOpened()) { contents.closeDevTools(); opened = false; }
            else { contents.openDevTools(); opened = true; }
        };
        contents.on('before-input-event', input);
        const dispose = ctx.cleanup(() => {
            attached.delete(contents);
            contents.off('before-input-event', input);
            contents.off('destroyed', dispose);
            if (opened && !contents.isDestroyed() && contents.isDevToolsOpened()) contents.closeDevTools();
        });
        contents.once('destroyed', dispose);
    };
    ctx.windows.onCreated(attach);
    for (const window of ctx.windows.all()) attach(window);
}
