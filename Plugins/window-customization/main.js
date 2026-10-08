import { createRequire } from 'node:module';

const { definePluginSettings, OptionType } = Bedrock;
const require = createRequire(import.meta.url);
const native = require(`./native/${process.platform}-${process.arch}/window.node`);

export const settings = definePluginSettings({
    nativeTitlebar: {
        type: OptionType.BOOLEAN,
        label: 'Native title bar',
        description: 'Use the Windows title bar and window frame. Changes apply immediately.',
        default: false
    },
    resizableFrame: {
        type: OptionType.BOOLEAN,
        label: 'Restore resizable frame',
        description: 'Add WS_THICKFRAME to support resizing transparent windows. Changes apply immediately.',
        default: true
    }
});

export function start(ctx) {
    const windows = new Map();
    const apply = window => {
        if (window.isDestroyed()) return;
        let url;
        try { url = new URL(window.webContents.getURL()); } catch { return; }
        if (url.protocol !== 'https:' || !['discord.com', 'canary.discord.com', 'ptb.discord.com'].includes(url.hostname)) return;
        const options = { nativeTitlebar: settings.store.nativeTitlebar, resizableFrame: settings.store.resizableFrame };
        const record = windows.get(window);
        if (record.customization) record.customization.update(options);
        else record.customization = native.customize(window.getNativeWindowHandle(), options);
    };
    const attach = window => {
        if (window.isDestroyed() || windows.has(window)) return;
        const record = {};
        windows.set(window, record);
        const contents = window.webContents;
        const loaded = () => {
            if (ctx.signal.aborted || !windows.has(window)) return;
            try { apply(window); } catch (error) { ctx.log.error(error); }
        };
        contents.on('did-finish-load', loaded);
        const dispose = ctx.cleanup(() => {
            windows.delete(window);
            window.off('closed', dispose);
            contents.off('did-finish-load', loaded);
            record.customization?.dispose();
        });
        window.once('closed', dispose);
        // Reading the URL inside browser-window-created can block the unfinished constructor.
        queueMicrotask(loaded);
    };
    ctx.cleanup(settings.subscribe(() => {
        for (const window of windows.keys()) {
            try { apply(window); } catch (error) { ctx.log.error(error); }
        }
    }));
    ctx.windows.onCreated(attach);
    for (const window of ctx.windows.all()) attach(window);
}
