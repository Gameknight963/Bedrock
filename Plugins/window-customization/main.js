import { createRequire } from 'node:module';

const { definePluginSettings, OptionType } = Bedrock;
const require = createRequire(import.meta.url);
let native;

export const settings = definePluginSettings({
    transparency: {
        type: OptionType.BOOLEAN,
        label: 'Window transparency',
        description: 'Allow transparent CSS themes to show through the window. Requires a restart.',
        default: false,
        restartNeeded: true
    },
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
    let disposeTransparency;
    const applyTransparency = () => {
        if (settings.store.transparency && !disposeTransparency) {
            disposeTransparency = ctx.windows.beforeCreate(options => {
                options.transparent = true;
                options.backgroundColor = '#00000000';
                // Electron requires frameless windows for transparency on Windows.
                options.frame = false;
            });
        } else if (!settings.store.transparency && disposeTransparency) {
            disposeTransparency();
            disposeTransparency = undefined;
        }
    };
    applyTransparency();
    const apply = window => {
        if (window.isDestroyed()) return;
        let url;
        try { url = new URL(window.webContents.getURL()); } catch { return; }
        if (url.protocol !== 'https:' || !['discord.com', 'canary.discord.com', 'ptb.discord.com'].includes(url.hostname)) return;
        native ||= require(`./native/${process.platform}-${process.arch}/window.node`);
        const options = { nativeTitlebar: settings.store.nativeTitlebar, resizableFrame: settings.store.resizableFrame };
        const record = windows.get(window);
        if (record.customization) record.customization.update(options);
        else {
            record.customization = native.customize(window.getNativeWindowHandle(), options);
            record.fullscreen = false;
            record.patches = [];
            // Keep Electron callers and native caption commands on the same Windows maximize/restore path.
            for (const method of ['maximize', 'unmaximize', 'restore']) {
                record.patches.push(ctx.patches.instead(window, method, () => {
                    if (method === 'unmaximize' && !window.isMaximized()) return;
                    record.customization[method === 'maximize' ? 'maximize' : 'restore']();
                }));
            }
            record.patches.push(ctx.patches.instead(window, 'setFullScreen', ([enabled]) => {
                if (typeof enabled !== 'boolean') throw new TypeError('Expected a fullscreen boolean');
                if (!window.isFullScreenable() || record.fullscreen === enabled) return;
                record.customization.setFullScreen(enabled);
                record.fullscreen = enabled;
                window.emit(enabled ? 'enter-full-screen' : 'leave-full-screen');
            }));
            record.patches.push(ctx.patches.instead(window, 'isFullScreen', () => record.fullscreen));
            record.patches.push(ctx.patches.instead(window, 'isMaximized', () =>
                !record.fullscreen && !window.isMinimized() && Boolean(native.getStyle(window.getNativeWindowHandle()) & 0x01000000))); // WS_MAXIMIZE
            record.patches.push(ctx.patches.instead(window, 'getNormalBounds', () =>
                require('electron').screen.screenToDipRect(window, record.customization.getNormalBounds())));
            record.key = (event, input) => {
                if (input.type !== 'keyDown' || input.key !== 'F11' || input.control || input.alt || input.meta || input.shift) return;
                event.preventDefault();
                if (!input.isAutoRepeat) window.setFullScreen(!window.isFullScreen());
            };
            window.webContents.on('before-input-event', record.key);
        }
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
            if (record.key) contents.off('before-input-event', record.key);
            for (const disposePatch of record.patches || []) disposePatch();
            record.customization?.dispose();
            if (record.fullscreen && !window.isDestroyed()) window.emit('leave-full-screen');
        });
        window.once('closed', dispose);
        // Reading the URL inside browser-window-created can block the unfinished constructor.
        queueMicrotask(loaded);
    };
    ctx.cleanup(settings.subscribe(() => {
        applyTransparency();
        for (const window of windows.keys()) {
            try { apply(window); } catch (error) { ctx.log.error(error); }
        }
    }));
    ctx.windows.onCreated(attach);
    for (const window of ctx.windows.all()) attach(window);
}
