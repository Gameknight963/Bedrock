const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { spawn } = require('node:child_process');
const { createPluginManager } = require('./plugins.cjs');
const { packagePath } = require('./storage.cjs');
const { startControl } = require('./control.cjs');
const { createLogFeed } = require('./logs.cjs');
const { createJsSession, rendererJsRequest } = require('./javascript.cjs');
const { createThemeManager } = require('./themes.cjs');

function install(options = {}) {
    if (globalThis.BedrockMain) return true;
    const electron = options.electron || require('electron');
    const { app, ipcMain, protocol, session, shell } = electron;
    const root = path.resolve(options.root || path.join(__dirname, '..', 'BedrockData'));
    try {
        fs.mkdirSync(root, { recursive: true });
        fs.accessSync(root, fs.constants.W_OK);
    } catch (error) {
        throw new Error(`Cannot write Bedrock data at ${root}. Move Bedrock to a writable folder. ${error.message}`);
    }
    const devtools = options.devtools ?? process.argv.includes('--bedrock-devtools');
    const sessions = new WeakSet();
    const windows = new Set();
    const beforeCreate = new Set();
    const created = new Set();
    const allowed = url => {
        try {
            const parsed = new URL(url);
            return options.allowURL ? options.allowURL(parsed) : parsed.protocol === 'https:' &&
                ['discord.com', 'canary.discord.com', 'ptb.discord.com'].includes(parsed.hostname);
        } catch { return false; }
    };
    let revision = 0;
    const snapshot = () => ({ revision, plugins: manager.list(), errors: manager.errors(), themes: themes.list(), themeErrors: themes.errors() });
    function broadcast(channel, value) {
        for (const window of windows) {
            const contents = window.webContents;
            if (!contents.isDestroyed() && allowed(contents.getURL())) contents.send(channel, value);
        }
    }
    const logs = createLogFeed(root);
    const manager = createPluginManager(root, {
        nativeJavaScript(target, identity, op, message) {
            const window = [...windows].find(window => !window.isDestroyed() &&
                !window.webContents.isDestroyed() && allowed(window.webContents.getURL()) &&
                window.webContents.getOSProcessId() === target.pid);
            if (!window) throw new Error('The native plugin renderer no longer exists.');
            return window.webContents.executeJavaScript(`(${rendererJsRequest})(${createJsSession},
                ${JSON.stringify(identity)}, ${JSON.stringify(op)}, ${JSON.stringify(message)})`);
        },
        nativeTargets(environment) {
            if (environment === 'main') return [{ pid: process.pid, creationTime: 0 }];
            if (!app.isReady()) return [];
            const metrics = app.getAppMetrics();
            if (environment === 'gpu') return metrics.filter(metric => metric.type === 'GPU');
            const pids = new Set([...windows].filter(window => !window.isDestroyed() && allowed(window.webContents.getURL()))
                .map(window => window.webContents.getOSProcessId()));
            return metrics.filter(metric => pids.has(metric.pid));
        },
        changed() { revision++; broadcast('bedrock:update', snapshot()); },
        context(record, own) {
            return { logs: { configureFile: logs.configureFile, publish: logs.publish, subscribe: callback => own(logs.subscribe(callback)) }, windows: {
                beforeCreate(callback) {
                    if (typeof callback !== 'function') throw new Error('Expected callback');
                    let applied = false;
                    if (windows.size) record.restartReason = 'Restart Discord to apply window creation options.';
                    const guarded = options => {
                        callback(options);
                        applied = true;
                    };
                    beforeCreate.add(guarded);
                    return own(() => {
                        beforeCreate.delete(guarded);
                        if (applied && windows.size) record.restartReason = 'Restart Discord to restore window creation options.';
                    });
                },
                onCreated(callback) {
                    if (typeof callback !== 'function') throw new Error('Expected callback');
                    created.add(callback);
                    return own(() => created.delete(callback));
                },
                all: () => [...windows]
            } };
        }
    });
    const themes = createThemeManager(root, () => { revision++; broadcast('bedrock:update', snapshot()); });
    app.once('will-quit', () => themes.close());
    manager.events.on('settings.changed', () => { revision++; broadcast('bedrock:update', snapshot()); });
    manager.events.on('plugin.event', value => broadcast('bedrock:event', value));
    const bedrockScheme = { scheme: 'bedrock', privileges: {
        standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, bypassCSP: true
    } };
    const registerSchemes = protocol.registerSchemesAsPrivileged;
    // Later registrations replace privilege lists; retain Bedrock when Discord registers its own schemes.
    protocol.registerSchemesAsPrivileged = function (schemes) {
        return registerSchemes.call(this, [...schemes.filter(item => item.scheme !== 'bedrock'), bedrockScheme]);
    };
    protocol.registerSchemesAsPrivileged([]);

    function registerSession(ses) {
        if (sessions.has(ses)) return;
        sessions.add(ses);
        ses.registerPreloadScript({ type: 'frame', filePath: path.join(__dirname, 'preload.cjs') });
        ses.protocol.handle('bedrock', request => {
            try {
                const url = new URL(request.url);
                if (request.method === 'GET' && url.hostname === 'api' && ['/settings.mjs', '/dotnet.mjs'].includes(url.pathname))
                    return new Response(fs.readFileSync(path.join(__dirname, url.pathname.slice(1))), { headers: {
                        'Content-Type': 'text/javascript', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store'
                    } });
                if (request.method === 'GET' && url.hostname === 'managed') {
                    const relative = url.pathname.slice(1).split('/').map(decodeURIComponent).join('/');
                    const file = packagePath(path.join(__dirname, 'dotnet'), relative);
                    const types = { '.js': 'text/javascript', '.wasm': 'application/wasm', '.json': 'application/json' };
                    return new Response(fs.readFileSync(file), { headers: {
                        'Content-Type': types[path.extname(file)] || 'application/octet-stream',
                        'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store'
                    } });
                }
                if (request.method === 'GET' && url.hostname === 'themes') {
                    const relative = url.pathname.slice(1).split('/').map(decodeURIComponent).join('/');
                    const file = packagePath(themes.directory, relative);
                    const types = { '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg',
                        '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf' };
                    return new Response(fs.readFileSync(file), { headers: { 'Content-Type': types[path.extname(file).toLowerCase()] || 'application/octet-stream',
                        'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' } });
                }
                if (request.method !== 'GET' || url.hostname !== 'plugins') return new Response(null, { status: 404 });
                const parts = url.pathname.split('/').slice(1).map(decodeURIComponent);
                const record = manager.records.get(parts.shift());
                if (!record) return new Response(null, { status: 404 });
                const file = packagePath(record.folder, parts.join('/'));
                const types = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
                    '.json': 'application/json', '.md': 'text/plain', '.png': 'image/png', '.svg': 'image/svg+xml',
                    '.jpg': 'image/jpeg', '.webp': 'image/webp', '.woff2': 'font/woff2' };
                return new Response(fs.readFileSync(file), { headers: {
                    'Content-Type': types[path.extname(file)] || 'application/octet-stream',
                    'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store'
                } });
            } catch { return new Response(null, { status: 404 }); }
        });
    }
    app.on('session-created', registerSession);
    app.whenReady().then(() => registerSession(session.defaultSession)).catch(console.error);
    const BrowserWindow = new Proxy(electron.BrowserWindow, {
        construct(target, args, newTarget) {
            const preferences = { ...(args[0] || {}), webPreferences: { ...args[0]?.webPreferences } };
            for (const callback of beforeCreate) {
                try { callback(preferences); } catch (error) { console.error('[Bedrock:windows]', error); }
            }
            if (devtools) preferences.webPreferences.devTools = true;
            const ses = preferences.webPreferences.session || session.fromPartition(preferences.webPreferences.partition || '');
            registerSession(ses);
            args[0] = preferences;
            return Reflect.construct(target, args, newTarget);
        }
    });
    const facade = new Proxy({}, { get: (_, key) => key === 'BrowserWindow' ? BrowserWindow : electron[key],
        ownKeys: () => Reflect.ownKeys(electron), getOwnPropertyDescriptor: () => ({ configurable: true, enumerable: true }) });
    if (!options.electron) {
        const load = Module._load;
        // Electron exports can have nonconfigurable properties; substitute a facade at the require boundary.
        Module._load = function (request, ...args) {
            if (request === 'electron' || request === 'electron/main') return facade;
            return load.call(this, request, ...args);
        };
    }
    app.on('browser-window-created', (_, window) => {
        windows.add(window);
        window.webContents.on('console-message', (event, details, message) => {
            details = event.message ? event : typeof details === 'object' ? details : { message };
            if (typeof details.message !== 'string') return;
            logs.publish({ level: 'info', text: details.message, bedrock: details.message.startsWith('[Bedrock') });
        });
        window.once('closed', () => windows.delete(window));
        if (devtools) window.webContents.on('did-finish-load', () => {
            if (allowed(window.webContents.getURL())) window.webContents.openDevTools({ mode: 'detach' });
        });
        for (const callback of created) {
            try { callback(window); } catch (error) { console.error('[Bedrock:windows]', error); }
        }
        manager.events.emit('window.created', window);
    });
    function authorized(event) {
        return event.senderFrame === event.sender.mainFrame && allowed(event.senderFrame.url);
    }
    ipcMain.on('bedrock:config', event => { event.returnValue = authorized(event) ? snapshot() : null; });
    ipcMain.handle('bedrock:request', async (event, operation, ...args) => {
        if (!authorized(event)) throw new Error('Bedrock is only available in Discord');
        const [id, key, value] = args;
        if (operation === 'list') return snapshot();
        if (operation === 'enable') { await manager.setEnabled(id, key); return snapshot(); }
        if (operation === 'rescan') { await manager.refresh(); return snapshot(); }
        if (operation === 'remove') { await manager.remove(id, key === true); return snapshot(); }
        if (operation === 'themesEnable') { themes.setEnabled(id, key); return snapshot(); }
        if (operation === 'themeWebsite') {
            const theme = themes.list().find(theme => theme.id === id);
            if (!theme?.website) throw new Error('This theme has no website');
            await shell.openExternal(theme.website);
            return true;
        }
        if (operation === 'openThemesFolder') {
            const error = await shell.openPath(themes.directory);
            if (error) throw new Error(error);
            return true;
        }
        if (operation === 'restart') {
            if (options.restart) return options.restart();
            const launcher = path.join(__dirname, '..', 'BedrockLauncher.exe');
            if (!fs.existsSync(launcher)) throw new Error('Cannot find the Bedrock launcher. Restart through the launcher manually.');
            const restartArguments = ['--exe', process.execPath];
            if (devtools) restartArguments.push('--devtools');
            const inspector = process.argv.find(argument => argument.startsWith('--inspect-brk='));
            const port = inspector?.match(/:(\d+)$/)?.[1];
            if (port) restartArguments.push('--port', port);
            await new Promise((resolve, reject) => {
                // Relaunching Discord directly would lose the bootstrap; the launcher performs our graceful shutdown instead.
                const child = spawn(launcher, restartArguments, { detached: true, stdio: 'ignore', windowsHide: true });
                child.once('error', reject);
                child.once('spawn', () => { child.unref(); resolve(); });
            });
            return true;
        }
        if (operation === 'openFolder') {
            const error = await shell.openPath(path.join(root, 'plugins'));
            if (error) throw new Error(error);
            return true;
        }
        const record = manager.records.get(id);
        if (!record) throw new Error('Unknown plugin');
        if (operation === 'settingsDefine') { manager.registerSettings(id, key); return snapshot(); }
        if (operation === 'settingsSet') { manager.settings(id).set(key, value); return snapshot(); }
        if (operation === 'settingsDelete') { manager.settings(id).delete(key); return snapshot(); }
        if (operation === 'readme') return record.manifest.readme ? fs.readFileSync(packagePath(record.folder, record.manifest.readme), 'utf8') : '';
        if (operation === 'emit') { manager.events.emit('plugin.event', { id, name: key, value }); return true; }
        throw new Error('Unknown Bedrock operation');
    });
    globalThis.BedrockMain = manager;
    manager.themes = themes;
    globalThis.Bedrock = { definePluginSettings: manager.definePluginSettings, OptionType: manager.OptionType };
    themes.scan();
    manager.scan();
    startControl(app);
    console.info(`[Bedrock] Bootstrap installed. Plugins: ${path.join(root, 'plugins')}`);
    return true;
}

module.exports = { install };
