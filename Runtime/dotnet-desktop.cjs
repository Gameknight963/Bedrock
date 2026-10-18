const path = require('node:path');

let shared;
function sharedHost() {
    if (shared) return shared;
    if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Desktop .NET plugins currently require Windows x64.');
    const native = require(path.join(__dirname, 'native/win32-x64/dotnet.node'));
    const pending = new Map(), plugins = new Map();
    let sequence = 0;
    async function receive(json) {
        const message = JSON.parse(json);
        if (message.kind === 'reply') {
            const request = pending.get(message.id);
            if (!request) return;
            pending.delete(message.id); clearTimeout(request.timer);
            if (message.error) request.reject(new Error(message.error)); else request.resolve(message.value);
            return;
        }
        const plugin = plugins.get(message.plugin);
        if (!plugin) return;
        if (message.kind === 'log') { plugin.log[message.level === 'warn' ? 'warn' : message.level === 'info' ? 'info' : 'error'](message.message); return; }
        if (message.kind === 'restart') { plugin.requireRestart(message.reason); return; }
        if (message.kind !== 'request') return;
        try {
            const args = message.args, ctx = plugin.context;
            if (!ctx) throw new Error('The managed plugin context is unavailable.');
            let value = null;
            switch (message.op) {
                case 'settings.define': plugin.registerSettings(args); break;
                case 'settings.get': value = ctx.settings.get(args.key, args.fallback); break;
                case 'settings.set': ctx.settings.set(args.key, args.value); break;
                case 'status': ctx.reportStatus(args.message); break;
                case 'events.emit': await ctx.events.emit(args.name, args.value); break;
                case 'events.subscribe':
                    plugin.subscriptions.set(args.token, ctx.events.on(args.name, event => {
                        const { id, ...fields } = event;
                        const value = args.name === 'settings.changed' ? fields : args.name === 'window.created'
                            ? { id: event.id, handle: event.getNativeWindowHandle().readBigUInt64LE().toString() } : event.value;
                        native.send(JSON.stringify({ op: 'event', plugin: message.plugin, token: args.token,
                            sender: args.name === 'window.created' ? message.plugin : id, value }));
                    }));
                    break;
                case 'events.unsubscribe': plugin.subscriptions.get(args.token)?.(); plugin.subscriptions.delete(args.token); break;
                case 'events.clear':
                    for (const dispose of plugin.subscriptions.values()) dispose();
                    plugin.subscriptions.clear(); break;
                case 'windows.all':
                    value = (ctx.windows?.all() || []).filter(window => !window.isDestroyed()).map(window => ({
                        id: window.id, handle: window.getNativeWindowHandle().readBigUInt64LE().toString()
                    }));
                    break;
                case 'windows.execute': {
                    const window = ctx.windows?.all().find(window => window.id === args.windowId && !window.isDestroyed());
                    if (!window || window.webContents.isDestroyed()) throw new Error('The requested window no longer exists.');
                    value = await window.webContents.executeJavaScript(args.source);
                    break;
                }
                default: throw new Error('Unknown managed service: ' + message.op);
            }
            native.send(JSON.stringify({ op: 'reply', id: message.id, value: value ?? null }));
        } catch (error) { native.send(JSON.stringify({ op: 'reply', id: message.id, error: error.message })); }
    }
    native.initialize(path.join(__dirname, 'dotnet-desktop/Bedrock.DesktopHost.runtimeconfig.json'),
        path.join(__dirname, 'dotnet-desktop/Bedrock.DesktopHost.dll'), json => {
            receive(json).catch(error => console.error('[Bedrock:dotnet]', error));
        });
    shared = { plugins, request(plugin, op, args = {}) {
        const id = ++sequence;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Managed ${op} did not finish within ten seconds.`)); }, 10000);
            pending.set(id, { resolve, reject, timer });
            try { native.send(JSON.stringify({ id, plugin, op, ...args })); }
            catch (error) { clearTimeout(timer); pending.delete(id); reject(error); }
        });
    } };
    return shared;
}

function createDesktopEntryPoint(record, registerSettings) {
    const id = record.manifest.id;
    let loaded = false, host, state;
    return {
        async start(ctx) {
            host = sharedHost();
            state ||= { subscriptions: new Map(), registerSettings };
            Object.assign(state, { context: ctx, log: ctx.log, requireRestart: reason => ctx.requireRestart(reason) });
            host.plugins.set(id, state);
            if (!loaded) { await host.request(id, 'load', { path: record.entries.main }); loaded = true; }
            await host.request(id, 'start');
        },
        async stop() {
            if (loaded) await host.request(id, 'stop');
        },
        async unload(ctx) {
            if (!loaded) { host?.plugins.delete(id); state = null; return; }
            state.log = ctx.log; state.requireRestart = reason => ctx.requireRestart(reason);
            await host.request(id, 'unload');
            host.plugins.delete(id); loaded = false; state = null;
        }
    };
}

module.exports = { createDesktopEntryPoint };
