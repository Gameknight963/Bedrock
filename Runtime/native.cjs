const path = require('node:path');
const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
const { prepareReference, waitForReference } = require('./symbols.cjs');

const { createJsTransport } = require('./javascript.cjs');

const processTypes = { main: 0, renderer: 1, gpu: 2 };
const levels = ['debug', 'info', 'warn', 'error'];

function connectHost(target, entry, services, options) {
    const directory = options.nativeDirectory || path.join(__dirname, 'native', 'win32-x64');
    const child = spawn(path.join(directory, 'native-controller.exe'), [String(target.pid), String(processTypes[entry.environment]),
        path.join(directory, 'native-host.dll'), entry.path], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    child.unref();
    child.stdin.unref?.(); child.stdout.unref?.(); child.stderr.unref?.();
    const pending = new Map();
    let javascript;
    let sequence = 0, closed = false, stderr = '', definitions = {}, requiresSymbols = false, readyResolve, readyReject;
    const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
    const fail = error => {
        if (closed) return;
        closed = true;
        javascript?.close();
        clearTimeout(readyTimer);
        readyReject(error);
        for (const request of pending.values()) { clearTimeout(request.timer); request.reject(error); }
        pending.clear();
        child.stdin.end();
    };
    const readyTimer = setTimeout(() => fail(new Error('Native host did not initialize within 15 seconds.')), 15000);
    child.stderr.on('data', bytes => { stderr = (stderr + bytes.toString()).slice(-8192); });
    child.on('error', fail);
    child.stdin.on('error', fail);
    child.on('exit', code => fail(new Error(stderr.trim() || `Native controller exited (${code}).`)));
    const lines = createInterface({ input: child.stdout });
    lines.on('line', line => {
        if (line.length > 1024 * 1024) { fail(new Error('Native host message exceeds one MiB.')); return; }
        try {
            const message = JSON.parse(line);
            if (message.event === 'ready') {
                services.registerSettings(message.definitions);
                definitions = message.definitions;
                requiresSymbols = message.requiresSymbols === true;
                clearTimeout(readyTimer); readyResolve();
            } else if (message.event === 'js.execute') {
                if (!javascript) javascript = createJsTransport(entry.environment, target, options);
                javascript.execute(message, response => {
                    if (!closed) {
                        let data = JSON.stringify({ op: 'js.reply', id: message.id, ...response }) + '\n';
                        if (Buffer.byteLength(data) >= 1024 * 1024) data = JSON.stringify({ op: 'js.reply', id: message.id,
                            code: 7, message: 'The JavaScript result exceeds one MiB.' }) + '\n';
                        child.stdin.write(data);
                    }
                });
            } else if (message.event === 'js.cancel') {
                javascript?.cancel(message.id);
            } else if (message.event === 'js.release') {
                javascript?.release(message.handle);
            } else if (message.event === 'js.reset') {
                javascript?.close(); javascript = undefined;
            } else if (message.event === 'status') {
                services.reportStatus?.(String(message.message));
            } else if (message.event === 'log') {
                if (message.level === 3) for (const request of pending.values()) {
                    if (request.op === 'start') request.diagnostics =
                        (request.diagnostics + (request.diagnostics ? '\n' : '') + String(message.message)).slice(0, 8192);
                }
                services.log(levels[message.level] || 'error', [String(message.message)]);
            } else if (message.event === 'error') {
                const error = new Error(String(message.message));
                services.log('error', [error]); fail(error);
            } else if (message.event === 'set') {
                try { services.settings.set(message.key, message.value); }
                catch (error) { services.log('error', [error]); }
            } else if (message.event === 'reply') {
                const request = pending.get(message.id);
                if (!request) return;
                pending.delete(message.id); clearTimeout(request.timer);
                if (message.result === 0) request.resolve();
                else {
                    const results = ['BEDROCK_OK', 'BEDROCK_ERROR', 'BEDROCK_UNSUPPORTED', 'BEDROCK_INVALID_ARGUMENT',
                        'BEDROCK_UNKNOWN_SETTING', 'BEDROCK_INVALID_VALUE', 'BEDROCK_STOPPED'];
                    const detail = message.message || request.diagnostics || 'The plugin returned a failure without logging a reason.';
                    request.reject(new Error(`Native ${request.op} failed: ${results[message.result] || 'unknown result'} (${message.result}).\n${detail}`));
                }
            }
        } catch (error) { services.log('error', [error]); fail(error); }
    });
    return {
        target, ready,
        get definitions() { return definitions; },
        get requiresSymbols() { return requiresSymbols; },
        get closed() { return closed; },
        request(op, args = {}) {
            if (closed) return Promise.reject(new Error(stderr.trim() || 'Native host is disconnected.'));
            const id = ++sequence;
            const data = JSON.stringify({ id, op, ...args }) + '\n';
            if (Buffer.byteLength(data) >= 1024 * 1024) return Promise.reject(new Error('Native command exceeds one MiB.'));
            return new Promise((resolve, reject) => {
                const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Native ${op} did not finish within 10 seconds.`)); }, 10000);
                pending.set(id, { resolve, reject, timer, op, diagnostics: '' });
                child.stdin.write(data, error => {
                    if (error) { pending.delete(id); clearTimeout(timer); reject(error); }
                });
            });
        },
        close() { javascript?.close(); child.stdin.end(); }
    };
}

function createNativeEntryPoints(record, services, options = {}) {
    const entries = Object.entries(record.manifest.entrypoints).filter(([, entry]) => entry.runtime === 'native')
        .map(([environment]) => ({ environment, path: record.entries[environment] }));
    const instances = new Map();
    let context, timer, work = Promise.resolve();
    const targets = environment => {
        if (options.nativeTargets) return options.nativeTargets(environment);
        if (environment === 'main') return [{ pid: process.pid, creationTime: 0 }];
        const { app } = require('electron');
        if (!app.isReady()) return [];
        if (environment === 'gpu') return app.getAppMetrics().filter(metric => metric.type === 'GPU');
        return [];
    };
    const keyFor = (entry, target) => `${entry.environment}:${target.pid}:${target.creationTime}`;
    async function update() {
        if (!context || context.signal.aborted) return;
        const live = new Set();
        let failure;
        for (const entry of entries) for (const target of targets(entry.environment)) {
            const key = keyFor(entry, target); live.add(key);
            let instance = instances.get(key);
            if (!instance) {
                instance = { host: connectHost(target, entry, services, options), started: false, attempted: false };
                instances.set(key, instance);
            }
            if (instance.host.closed) {
                const error = new Error('Native host is disconnected. Restart its target process before enabling this plugin.');
                if (!instance.disconnectionReported) { services.failed(error); instance.disconnectionReported = true; }
                failure ||= error;
                continue;
            }
            if (instance.started || instance.attempted) continue;
            instance.attempted = true;
            try {
                await instance.host.ready;
                if (context.signal.aborted) continue;
                if (instance.host.requiresSymbols && !instance.referenceReady) {
                    const signal = context.signal;
                    services.reportStatus?.("Preparing Electron symbols");
                    const reference = options.symbolReference || await waitForReference(
                        prepareReference(process.versions.electron, options.symbolCacheDirectory || path.join(path.dirname(process.execPath), 'BedrockData', 'cache', 'symbols'),
                            (level, args) => { if (!signal.aborted) services.log(level, args); },
                            message => { if (!signal.aborted) services.reportStatus?.(message); }), signal);
                    if (context.signal.aborted) continue;
                    await instance.host.request('reference', reference);
                    instance.referenceReady = true;
                }
                services.reportStatus?.("Starting native plugin");
                instance.starting = true;
                await instance.host.request('start', { values: services.settings.all() });
                instance.started = true;
                services.reportStatus?.(null);
            } catch (error) { if (!context.signal.aborted) { services.reportStatus?.(null); services.failed(error); failure ||= error; } }
            finally { instance.starting = false; }
        }
        for (const [key, instance] of instances) if (!live.has(key)) {
            instance.host.close(); instances.delete(key);
        }
        if (failure) throw failure;
    }
    const schedule = () => {
        work = work.catch(() => {}).then(update);
        return work;
    };
    return {
        async start(ctx) {
            if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Native plugins currently require Windows x64.');
            context = ctx;
            ctx.cleanup(services.subscribe(event => {
                const value = Object.hasOwn(event, 'value') ? event.value : services.defaults(event.key);
                for (const instance of instances.values()) if ((instance.started || instance.starting) && Object.hasOwn(instance.host.definitions, event.key))
                    instance.host.request('change', { key: event.key, value }).catch(error => services.failed(error));
            }));
            ctx.cleanup(() => { clearInterval(timer); });
            await schedule();
            if (!ctx.signal.aborted) { timer = setInterval(() => schedule().catch(error => services.failed(error)), 1000); timer.unref(); }
        },
        close() { for (const instance of instances.values()) instance.host.close(); },
        async stop() {
            clearInterval(timer);
            await work.catch(() => {});
            await Promise.all([...instances.values()].map(async instance => {
                if (instance.attempted && !instance.host.closed) {
                    await instance.host.request('stop');
                    instance.started = false;
                }
                // Failed startup is not retried in the same process until re-enabled.
                instance.attempted = instance.host.closed;
            }));
            context = null;
        }
    };
}

module.exports = { createNativeEntryPoints };
