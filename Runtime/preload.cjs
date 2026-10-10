function installRenderer(configuration) {
    if (globalThis.Bedrock) return;
    const native = globalThis.BedrockNative;
    const records = new Map();
    const subscribers = new Set();
    const listeners = new Map();
    const patchSlots = new WeakMap();
    const themeLinks = new Map();
    const themeLoadErrors = new Map();
    let settingsAPI;
    const settingsReady = import('bedrock://api/settings.mjs').then(api => {
        settingsAPI = api;
        Object.assign(globalThis.Bedrock, { definePluginSettings: api.definePluginSettings, OptionType: api.OptionType });
        notify();
    });
    settingsReady.catch(error => log('settings', error));
    let snapshot = configuration;
    let webpackRequire;
    const loadedModules = new Set();
    const webpackRuntimes = new Set();
    const settingsDiagnostics = { patchedFactories: 0, rootCalls: 0 };
    let React;
    let layoutTypes;
    const moduleWaiters = new Set();
    const notify = () => { for (const callback of subscribers) callback(); updateTasks(); };
    const log = (id, error) => console.error(`[Bedrock:${id}]`, error);
    const subscribe = callback => { subscribers.add(callback); return () => subscribers.delete(callback); };
    const emitLocal = (name, value) => {
        for (const callback of listeners.get(name) || []) {
            try { Promise.resolve(callback(value)).catch(error => log('events', error)); }
            catch (error) { log('events', error); }
        }
    };
    function candidates(exports) {
        if (!exports) return [];
        const values = [exports];
        if (typeof exports === 'object' || typeof exports === 'function') {
            for (const key of Object.keys(exports)) {
                try { values.push(exports[key]); } catch {}
            }
        }
        return values;
    }
    function findModule(filter) {
        const modules = new Set(loadedModules.values());
        for (const require of webpackRuntimes) {
            if (require.c) for (const module of Object.values(require.c)) modules.add(module);
        }
        for (const module of modules) {
            if (!module) continue;
            for (const candidate of candidates(module.exports)) {
                try { if (filter(candidate)) return candidate; } catch {}
            }
        }
    }
    function inspectModules() {
        React ||= findModule(value => value?.createElement && value?.useState && value?.useEffect);
        layoutTypes ||= findModule(value => value && ['SECTION', 'SIDEBAR_ITEM', 'PANEL', 'CATEGORY', 'CUSTOM'].every(key =>
            ['number', 'string'].includes(typeof value[key])));
        for (const waiter of moduleWaiters) {
            const value = findModule(waiter.filter);
            if (value) { moduleWaiters.delete(waiter); waiter.resolve(value); }
        }
    }
    function renderingReact() {
        return findModule(value => {
            if (!value?.createElement || !value?.useState || !value?.useEffect) return false;
            // React 18 and 19 keep the renderer's current hook dispatcher in different internal fields.
            const dispatcher = value.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED?.ReactCurrentDispatcher?.current ||
                value.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE?.H;
            return typeof dispatcher?.useState === 'function' && dispatcher.useState !== dispatcher.useEffect;
        });
    }
    function patch(kind, object, method, callback) {
        if (typeof object?.[method] !== 'function') throw new Error('Expected an object method');
        let methods = patchSlots.get(object);
        if (!methods) patchSlots.set(object, methods = new Map());
        let slot = methods.get(method);
        if (!slot) {
            slot = { descriptor: Object.getOwnPropertyDescriptor(object, method), original: object[method], hooks: [] };
            slot.wrapper = function (...args) {
                const hooks = [...slot.hooks];
                for (const hook of hooks) if (hook.kind === 'before') hook.callback(args, this);
                let next = (...values) => slot.original.apply(this, values);
                for (const hook of hooks.filter(hook => hook.kind === 'instead').reverse()) {
                    const previous = next;
                    next = (...values) => hook.callback(values, previous, this);
                }
                let result = next(...args);
                for (const hook of hooks) if (hook.kind === 'after') {
                    const value = hook.callback(args, result, this);
                    if (value !== undefined) result = value;
                }
                return result;
            };
            Object.defineProperty(object, method, { configurable: true, enumerable: slot.descriptor?.enumerable ?? true,
                writable: true, value: slot.wrapper });
            methods.set(method, slot);
        }
        const hook = { kind, callback };
        slot.hooks.push(hook);
        return () => {
            const index = slot.hooks.indexOf(hook);
            if (index >= 0) slot.hooks.splice(index, 1);
            if (!slot.hooks.length) {
                if (object[method] === slot.wrapper) {
                    if (slot.descriptor) Object.defineProperty(object, method, slot.descriptor);
                    else delete object[method];
                }
                methods.delete(method);
            }
        };
    }
    function contextFor(record) {
        const disposers = new Set();
        let active = true;
        const controller = new AbortController();
        const own = callback => {
            if (!active) { callback(); throw new Error('Plugin context has stopped'); }
            let done = false;
            const dispose = () => { if (!done) { done = true; disposers.delete(dispose); callback(); } };
            disposers.add(dispose);
            return dispose;
        };
        const id = record.info.manifest.id;
        const context = {
            reportStatus(message) { if (active) { record.statusMessage = String(message); notify(); } },
            id, signal: controller.signal, manifest: structuredClone(record.info.manifest),
            log: Object.fromEntries(['info', 'warn', 'error'].map(level => [level, (...args) => console[level](`[Bedrock:${id}]`, ...args)])),
            settings: {
                get: (key, fallback) => Object.hasOwn(record.info.settings, key) ? structuredClone(record.info.settings[key]) : fallback,
                async set(key, value) { update(await native.request('settingsSet', id, key, value)); },
                async delete(key) { update(await native.request('settingsDelete', id, key)); },
                all: () => structuredClone(record.info.settings)
            },
            cleanup: own,
            requireRestart(reason) { record.restartReason = String(reason); notify(); },
            styles: {
                add(css) {
                    const element = document.createElement('style');
                    element.dataset.bedrockPlugin = id;
                    element.textContent = String(css);
                    const append = () => document.documentElement.append(element);
                    if (document.documentElement) append();
                    else document.addEventListener('DOMContentLoaded', append, { once: true });
                    return own(() => { document.removeEventListener('DOMContentLoaded', append); element.remove(); });
                }
            },
            events: {
                on(name, callback) {
                    if (!listeners.has(name)) listeners.set(name, new Set());
                    listeners.get(name).add(callback);
                    return own(() => listeners.get(name)?.delete(callback));
                },
                emit: (name, value) => native.request('emit', id, name, value)
            },
            patches: Object.fromEntries(['before', 'after', 'instead'].map(kind => [kind, (object, method, callback) => own(patch(kind, object, method, callback))])),
            webpack: {
                find: findModule,
                waitFor(filter) {
                    const found = findModule(filter);
                    if (found) return Promise.resolve(found);
                    return new Promise((resolve, reject) => {
                        let settled = false;
                        const waiter = { filter, resolve: value => { settled = true; cancel(); resolve(value); } };
                        moduleWaiters.add(waiter);
                        const cancel = own(() => {
                            moduleWaiters.delete(waiter);
                            if (!settled) reject(new Error('Plugin stopped before module became available'));
                        });
                    });
                }
            }
        };
        return { context, dispose() {
            if (!active) return;
            active = false;
            controller.abort();
            for (const dispose of [...disposers].reverse()) try { dispose(); } catch (error) { log(id, error); }
        } };
    }
    async function reconcile(record) {
        if (record.info.enabled && record.info.renderer && !record.instance) {
            record.status = 'starting'; record.statusMessage = null; record.error = null; notify();
            let instance;
            try {
                await settingsReady;
                record.module ||= await import(record.info.renderer);
                if (typeof record.module.start !== 'function') throw new Error('Renderer entry point must export start(context)');
                if (record.module.settings) update(await native.request('settingsDefine', record.info.manifest.id, record.module.settings.definitions));
                if (!record.info.enabled) { record.status = 'stopped'; notify(); return; }
                instance = contextFor(record);
                record.instance = instance;
                if (record.module.settings) {
                    const binding = settingsAPI.bindPluginSettings(record.module.settings, {
                        ...instance.context.settings, signal: instance.context.signal,
                        log: error => log(record.info.manifest.id, error), react: renderingReact
                    });
                    record.settingsBinding = binding;
                    instance.context.cleanup(() => { binding.dispose(); record.settingsBinding = null; });
                }
                await Promise.race([Promise.resolve(record.module.start(instance.context)), new Promise(resolve =>
                    instance.context.signal.addEventListener('abort', resolve, { once: true }))]);
                record.status = 'running'; record.statusMessage = null; record.error = null;
            } catch (error) {
                if (!instance?.context.signal.aborted) {
                    instance?.dispose(); record.instance = null;
                    record.status = 'failed'; record.error = error.message; log(record.info.manifest.id, error);
                }
            }
            notify();
        } else if (!record.info.enabled && record.instance) {
            const instance = record.instance;
            record.status = 'stopping'; notify();
            instance.dispose();
            let timer;
            try { await Promise.race([Promise.resolve(record.module.stop?.()), new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error('stop() did not finish within 10 seconds')), 10000);
            })]); }
            catch (error) { record.error = error.message; log(record.info.manifest.id, error); }
            finally { clearTimeout(timer); record.instance = null; record.status = 'stopped'; notify(); }
        }
    }
    function update(next) {
        if (next.revision < snapshot.revision) return;
        snapshot = structuredClone(next);
        applyThemes();
        const present = new Set(snapshot.plugins.map(info => info.manifest.id));
        for (const [id, record] of records) if (!present.has(id)) {
            record.info = { ...record.info, enabled: false };
            record.instance?.dispose();
            records.delete(id);
            record.pending = record.pending.catch(error => log(id, error)).then(() => reconcile(record));
        }
        for (const info of snapshot.plugins) {
            let record = records.get(info.manifest.id);
            if (!record) records.set(info.manifest.id, record = { info, status: info.renderer ? 'stopped' : 'main-only', pending: Promise.resolve() });
            const previousSettings = record.info.settings;
            const changed = record.info.enabled !== info.enabled;
            record.info = info;
            record.settingsBinding?.refresh();
            if (!info.enabled) record.instance?.dispose();
            if (JSON.stringify(previousSettings) !== JSON.stringify(info.settings)) emitLocal('settings.changed', { id: info.manifest.id, settings: info.settings });
            if (changed || (!record.instance && info.enabled && record.status === 'stopped'))
                record.pending = record.pending.catch(error => log(info.manifest.id, error)).then(() => reconcile(record));
        }
        notify();
    }
    function applyThemes() {
        if (!document.documentElement) {
            document.addEventListener('DOMContentLoaded', applyThemes, { once: true });
            return;
        }
        const enabled = new Set();
        const ordered = [];
        for (const theme of snapshot.themes || []) {
            if (!theme.enabled || theme.error) continue;
            enabled.add(theme.id);
            let link = themeLinks.get(theme.id);
            if (!link) {
                link = document.createElement('link');
                link.rel = 'stylesheet'; link.dataset.bedrockTheme = theme.id;
                link.onload = () => { themeLoadErrors.delete(theme.id); notify(); };
                link.onerror = () => { themeLoadErrors.set(theme.id, 'Cannot load this theme. Check its CSS file and imports.'); notify(); };
                themeLinks.set(theme.id, link);
            }
            if (link.href !== theme.url) { themeLoadErrors.delete(theme.id); link.href = theme.url; }
            ordered.push(link);
        }
        for (const [id, link] of themeLinks) if (!enabled.has(id)) {
            link.remove(); themeLinks.delete(id); themeLoadErrors.delete(id);
        }
        const existing = [...document.querySelectorAll('link[data-bedrock-theme]')];
        if (ordered.some((link, index) => existing[index] !== link))
            for (const link of ordered) document.documentElement.append(link);
    }
    function list() {
        return [...records.values()].map(record => ({ ...record.info, rendererStatus: record.status,
            rendererMessage: record.statusMessage, error: record.error || record.info.error, restartReason: record.restartReason || record.info.restartReason }));
    }
    const taskStarts = new Map();
    let taskPanel, taskTimer;
    function updateTasks() {
        if (!document.body) { clearTimeout(taskTimer); taskTimer = setTimeout(updateTasks, 500); return; }
        const tasks = list().filter(plugin => plugin.enabled && !plugin.error &&
            ([plugin.mainStatus, plugin.rendererStatus].includes('starting') || plugin.statusMessage && plugin.mainStatus === 'running'));
        const now = Date.now();
        for (const id of taskStarts.keys()) if (!tasks.some(plugin => plugin.manifest.id === id)) taskStarts.delete(id);
        for (const plugin of tasks) if (!taskStarts.has(plugin.manifest.id)) taskStarts.set(plugin.manifest.id, now);
        clearTimeout(taskTimer);
        const visible = tasks.filter(plugin => now - taskStarts.get(plugin.manifest.id) >= 1500);
        taskPanel?.remove(); taskPanel = null;
        if (visible.length && !document.querySelector('.bedrock-plugin-page')) {
            taskPanel = document.createElement('aside');
            taskPanel.className = 'bedrock-tasks'; taskPanel.setAttribute('role', 'status');
            for (const plugin of visible) {
                const row = document.createElement('div'), name = document.createElement('strong'), status = document.createElement('div');
                name.textContent = plugin.manifest.name; status.textContent = displayStatus(plugin);
                status.className = 'bedrock-muted'; row.append(name, status); taskPanel.append(row);
            }
            document.body.append(taskPanel);
        }
        if (tasks.length) taskTimer = setTimeout(updateTasks, 500);
    }
    function displayStatus(plugin) {
        if (!plugin.enabled) return 'Disabled';
        const states = [plugin.mainStatus, plugin.rendererStatus];
        if (plugin.error || states.includes('failed')) return 'Couldn?t start';
        if (plugin.statusMessage && plugin.mainStatus === 'running') return plugin.statusMessage;
        if (states.includes('starting')) return plugin.rendererStatus === 'starting' && plugin.rendererMessage || plugin.statusMessage || 'Initializing?';
        if (states.includes('stopping')) return 'Stopping';
        return 'Enabled';
    }
    async function setEnabled(id, enabled) {
        update(await native.request('enable', id, enabled));
        await records.get(id)?.pending;
        return list();
    }

    const css = `
        .bedrock-tasks{position:fixed;right:20px;bottom:20px;z-index:10000;width:260px;padding:12px;border-radius:8px;background:var(--background-floating,#18191c);color:var(--text-normal,#dbdee1);box-shadow:0 4px 16px #0005;font:14px var(--font-primary,sans-serif);pointer-events:none}.bedrock-tasks>div+div{margin-top:10px}.bedrock-tasks strong{font-size:14px}.bedrock-tasks .bedrock-muted{font-size:12px;margin-top:3px}
        .bedrock-page{color:var(--text-normal,#dbdee1);font-family:var(--font-primary,sans-serif);max-width:760px}
        .bedrock-page h2{font-size:24px;margin:0 0 8px}.bedrock-page p{line-height:1.5}
        .bedrock-muted{color:var(--text-muted,#949ba4);font-size:14px}.bedrock-toolbar{display:flex;gap:10px;flex-wrap:wrap;margin:0 0 16px}
        .bedrock-page input[type=search]{flex:1;min-width:180px;height:32px;box-sizing:border-box;padding:5px 10px;border-radius:6px;border:1px solid var(--border-subtle,#41434a);background:var(--input-background,#1e1f22);color:inherit}
        .bedrock-button{min-height:30px;padding:5px 10px;border:0;border-radius:5px;background:var(--background-modifier-hover,#35373c);color:inherit;cursor:pointer}
        .bedrock-button:focus-visible,.bedrock-switch:focus-visible{outline:2px solid var(--blurple-50,#5865f2);outline-offset:3px}
        .bedrock-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,280px),1fr));gap:10px}
        .bedrock-card{border:1px solid var(--border-subtle,#41434a);border-radius:8px;padding:10px;background:var(--background-secondary,#2b2d31)}
        .bedrock-card-header{display:flex;align-items:center;justify-content:space-between;gap:12px}.bedrock-card h3{font-size:15px;margin:0;flex:1}.bedrock-icon{width:24px;height:24px;object-fit:contain;border-radius:5px}
        .bedrock-switch{width:42px;height:24px;border:0;border-radius:15px;background:var(--background-modifier-accent,#4e5058);padding:3px;cursor:pointer;flex-shrink:0}
        .bedrock-switch[aria-checked=true]{background:var(--status-positive,#23a559)}.bedrock-switch span{display:block;width:18px;height:18px;background:white;border-radius:50%;transition:transform .12s}
        .bedrock-switch[aria-checked=true] span{transform:translateX(18px)}.bedrock-switch:disabled{opacity:.5;cursor:default}
        .bedrock-error{color:var(--text-danger,#fa777c);overflow-wrap:anywhere}.bedrock-restart{color:var(--text-warning,#f0b232)}
        .bedrock-readme,.bedrock-readme *{user-select:text!important;-webkit-user-select:text!important}
        .bedrock-readme{line-height:1.6;overflow-wrap:anywhere}.bedrock-readme pre{white-space:pre-wrap;background:var(--background-tertiary,#1e1f22);padding:14px;border-radius:6px}
        .bedrock-readme code{font-family:var(--font-code,monospace)}.bedrock-readme a{color:var(--text-link,#00a8fc)}
        .bedrock-card p{margin:6px 0;font-size:13px}.bedrock-card-description{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}.bedrock-error{white-space:pre-wrap;user-select:text!important;-webkit-user-select:text!important}.bedrock-status{display:flex;align-items:center;gap:6px}.bedrock-spinner{width:10px;height:10px;border:2px solid var(--text-muted,#949ba4);border-right-color:transparent;border-radius:50%;animation:bedrock-spin .8s linear infinite;flex-shrink:0}@keyframes bedrock-spin{to{transform:rotate(360deg)}}@media(prefers-reduced-motion:reduce){.bedrock-spinner{animation:none}}.bedrock-name{padding:0;border:0;background:none;color:inherit;font:inherit;text-align:left;cursor:pointer}
        .bedrock-theme-website{color:var(--text-link,#00a8fc)}
        .bedrock-detail-header{display:flex;align-items:center;gap:12px;margin:16px 0 8px}.bedrock-detail-header h2{margin:0;font-size:20px;flex:1}
        .bedrock-tabs{display:flex;gap:24px;border-bottom:1px solid var(--border-subtle,#41434a);margin:18px 0 24px}
        .bedrock-tab{padding:8px 0;background:none;border:0;border-bottom:2px solid var(--blurple-50,#5865f2);color:inherit;font:inherit}
        .bedrock-tab{border-bottom-color:transparent;cursor:pointer}.bedrock-tab[aria-selected=true]{border-bottom-color:var(--blurple-50,#5865f2)}
        .bedrock-setting{padding:16px 0;border-bottom:1px solid var(--border-subtle,#41434a)}
        .bedrock-setting-header{display:flex;align-items:center;justify-content:space-between;gap:16px}
        .bedrock-setting label{font-weight:600}.bedrock-setting p{margin:6px 0;font-size:14px}
        .bedrock-setting input:not([type=range]),.bedrock-setting textarea,.bedrock-setting select{box-sizing:border-box;width:100%;margin-top:10px;padding:7px 10px;border:1px solid var(--border-subtle,#41434a);border-radius:5px;background:var(--input-background,#1e1f22);color:inherit;font:inherit;user-select:text;-webkit-user-select:text}
        .bedrock-setting textarea{min-height:80px;resize:vertical}.bedrock-setting input[type=range]{width:100%;margin:12px 0;accent-color:var(--blurple-50,#5865f2)}
        .bedrock-setting-footer{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-top:8px}
        .bedrock-setting-section{font-size:18px;margin:24px 0 0}.bedrock-restart-banner{display:flex;align-items:center;justify-content:space-between;gap:16px;margin:0 0 16px;padding:12px;border:1px solid var(--text-warning,#f0b232);border-radius:6px}
        .bedrock-readme h1{font-size:26px}.bedrock-readme h2{font-size:22px}.bedrock-readme h3{font-size:18px}
        .bedrock-readme :is(h1,h2,h3,h4,h5,h6){font-weight:600;line-height:1.3;margin:24px 0 12px}
        .bedrock-readme>:first-child{margin-top:0}.bedrock-readme p,.bedrock-readme ul{margin:12px 0}
        .bedrock-readme ul{padding-left:24px;list-style:disc}.bedrock-readme li{margin:4px 0}
        .bedrock-button:disabled{opacity:.5;cursor:default}.bedrock-name:focus-visible{outline:2px solid var(--blurple-50,#5865f2)}
        .bedrock-button[aria-busy=true],.bedrock-switch[aria-busy=true]{cursor:wait}
    `;
    function installStyles() {
        const style = document.createElement('style');
        style.dataset.bedrock = 'settings'; style.textContent = css;
        document.documentElement.append(style);
    }
    if (document.documentElement) installStyles();
    else document.addEventListener('DOMContentLoaded', installStyles, { once: true });

    function markdown(text, baseURL) {
        const h = React.createElement;
        function inline(text) {
            const tokens = text.split(/(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\))/g);
            return tokens.map((token, key) => {
                if (token.startsWith('`')) return h('code', { key }, token.slice(1, -1));
                if (token.startsWith('**')) return h('strong', { key }, token.slice(2, -2));
                const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token);
                if (link) {
                    try {
                        const url = new URL(link[2], baseURL);
                        if (['https:', 'http:', 'bedrock:'].includes(url.protocol))
                            return h('a', { key, href: url.href, target: '_blank', rel: 'noreferrer' }, link[1]);
                    } catch {}
                }
                return token;
            });
        }
        const blocks = []; const lines = text.replaceAll('\r', '').split('\n');
        for (let index = 0; index < lines.length;) {
            const line = lines[index++];
            if (!line.trim()) continue;
            if (line.startsWith('```')) {
                const code = [];
                while (index < lines.length && !lines[index].startsWith('```')) code.push(lines[index++]);
                index++; blocks.push(h('pre', { key: blocks.length }, h('code', null, code.join('\n'))));
            } else if (/^#{1,6} /.test(line)) {
                const level = line.indexOf(' '); blocks.push(h(`h${level}`, { key: blocks.length }, inline(line.slice(level + 1))));
            } else if (/^[-*] /.test(line)) {
                const items = [line.slice(2)];
                while (index < lines.length && /^[-*] /.test(lines[index])) items.push(lines[index++].slice(2));
                blocks.push(h('ul', { key: blocks.length }, items.map((item, key) => h('li', { key }, inline(item)))));
            } else {
                const paragraph = [line];
                while (index < lines.length && lines[index].trim() && !/^(#{1,6} |```|[-*] )/.test(lines[index])) paragraph.push(lines[index++]);
                blocks.push(h('p', { key: blocks.length }, inline(paragraph.join(' '))));
            }
        }
        return blocks;
    }
    // Unicode escapes keep these UI characters intact across source encodings.
    const backArrow = '\u2190'; // Left arrow.
    const metadataSeparator = '\u00b7'; // Middle dot.
    const ellipsis = '\u2026'; // Ellipsis.
    function SettingControl({ plugin, settingKey, definition }) {
        const h = React.createElement;
        const saved = Object.hasOwn(plugin.settings, settingKey) ? plugin.settings[settingKey] : definition.default;
        const [draft, setDraft] = React.useState(saved);
        const [busy, setBusy] = React.useState(false);
        const [error, setError] = React.useState('');
        React.useEffect(() => { setDraft(saved); }, [saved]);
        const id = `bedrock-setting-${settingKey}`;
        const descriptionId = `${id}-description`;
        const errorId = `${id}-error`;
        const local = records.get(plugin.manifest.id)?.module?.settings?._callbacks[settingKey];
        const save = async value => {
            try {
                const validation = settingsAPI.validateSetting({ ...definition, isValid: local?.isValid }, value);
                if (validation) { setError(validation); return; }
                setBusy(true); setError('');
                update(await native.request('settingsSet', plugin.manifest.id, settingKey, value));
            }
            catch (error) { setError(error.message); }
            finally { setBusy(false); }
        };
        const inputProps = { id, disabled: busy, 'aria-busy': busy, 'aria-describedby': `${descriptionId}${error ? ` ${errorId}` : ''}`, 'aria-invalid': !!error };
        const numeric = [settingsAPI.OptionType.NUMBER, settingsAPI.OptionType.SLIDER].includes(definition.type);
        const commit = input => {
            const value = numeric ? (input === '' ? NaN : Number(input)) : input;
            if (JSON.stringify(value) !== JSON.stringify(saved)) save(value);
        };
        let control;
        if (definition.type === settingsAPI.OptionType.BOOLEAN) {
            control = h('button', { ...inputProps, role: 'switch', className: 'bedrock-switch', 'aria-checked': saved,
                onClick: () => save(!saved) }, h('span'));
        } else if (definition.type === settingsAPI.OptionType.SELECT) {
            control = h('select', { ...inputProps, value: definition.options.findIndex(option => option.value === saved),
                onChange: event => save(definition.options[Number(event.target.value)].value) },
                definition.options.map((option, index) => h('option', { key: index, value: index }, option.label)));
        } else {
            control = h(definition.multiline && !numeric ? 'textarea' : 'input', {
                ...inputProps, type: numeric ? (definition.type === settingsAPI.OptionType.SLIDER ? 'range' : 'number') : 'text',
                value: draft, placeholder: definition.placeholder, min: definition.min, max: definition.max, step: definition.step ?? (numeric ? 'any' : undefined),
                onChange: event => { setDraft(event.target.value); setError(''); },
                onBlur: event => commit(event.currentTarget.value),
                onKeyDown: event => { if (event.key === 'Enter' && !definition.multiline) event.currentTarget.blur(); },
                onPointerUp: definition.type === settingsAPI.OptionType.SLIDER ? event => commit(event.currentTarget.value) : undefined,
                onKeyUp: definition.type === settingsAPI.OptionType.SLIDER ? event => commit(event.currentTarget.value) : undefined
            });
        }
        return h('div', { className: 'bedrock-setting' },
            h('div', { className: 'bedrock-setting-header' }, h('label', { htmlFor: id }, definition.label || settingKey),
                definition.type === settingsAPI.OptionType.BOOLEAN && control),
            h('p', { id: descriptionId, className: 'bedrock-muted' }, definition.description),
            definition.type !== settingsAPI.OptionType.BOOLEAN && control,
            error && h('p', { id: errorId, className: 'bedrock-error', role: 'alert' }, error),
            h('div', { className: 'bedrock-setting-footer' },
                h('span', { className: definition.restartNeeded ? 'bedrock-restart' : 'bedrock-muted' },
                    definition.restartNeeded ? 'Requires a restart.' : (numeric && definition.type === settingsAPI.OptionType.SLIDER ? String(draft) : '')),
                h('button', { className: 'bedrock-button', 'aria-busy': busy, disabled: busy || JSON.stringify(saved) === JSON.stringify(definition.default),
                    onClick: () => save(definition.default), 'aria-label': `Reset ${definition.label || settingKey}` }, 'Reset')));
    }
    function PluginSettings({ plugin }) {
        const h = React.createElement;
        const definitions = Object.entries(plugin.settingsDefinitions || {});
        if (!settingsAPI) return h('p', { className: 'bedrock-muted' }, 'Loading settings...');
        if (!definitions.length) return h('p', { className: 'bedrock-muted' },
            plugin.enabled ? 'This plugin has no settings.' : 'Enable this plugin to load its settings, if it provides any.');
        let section;
        return definitions.map(([key, definition]) => {
            const heading = definition.section && definition.section !== section;
            section = definition.section;
            return h(React.Fragment, { key }, heading && h('h3', { className: 'bedrock-setting-section' }, section),
                h(SettingControl, { plugin, settingKey: key, definition }));
        });
    }
    function PluginsPage() {
        React = renderingReact() || React;
        const h = React.createElement;
        const [, refresh] = React.useState(0);
        const [search, setSearch] = React.useState('');
        const [selected, select] = React.useState(null);
        const [tab, setTab] = React.useState('details');
        const [readme, setReadme] = React.useState(null);
        const page = React.useRef(null);
        const listScroll = React.useRef(0);
        const scrollContainer = () => {
            for (let node = page.current?.parentElement; node; node = node.parentElement)
                if (/(auto|scroll)/.test(getComputedStyle(node).overflowY)) return node;
            return document.scrollingElement;
        };
        const open = id => { listScroll.current = scrollContainer()?.scrollTop || 0; setError(''); setTab('details'); select(id); };
        React.useLayoutEffect(() => {
            const container = scrollContainer();
            if (container) container.scrollTop = selected ? 0 : listScroll.current;
        }, [selected]);
        const [busy, setBusy] = React.useState(null);
        const [error, setError] = React.useState('');
        React.useEffect(() => subscribe(() => refresh(value => value + 1)), []);
        React.useEffect(() => {
            let current = true;
            setReadme(null);
            if (selected) native.request('readme', selected).then(text => { if (current) setReadme(text); }).catch(error => { if (current) setError(error.message); });
            return () => { current = false; };
        }, [selected]);
        const run = async (key, operation) => {
            setBusy(key); setError('');
            try { await operation(); } catch (error) { setError(error.message); } finally { setBusy(null); }
        };
        const plugins = list();
        const restartNeeded = plugins.some(plugin => plugin.restartReason || plugin.restartSettings?.length);
        const restartBanner = restartNeeded && h('div', { className: 'bedrock-restart-banner' },
            h('span', { className: 'bedrock-restart' }, 'Some changes require a restart.'),
            h('button', { className: 'bedrock-button', disabled: !!busy, onClick: () => run('restart', () => native.request('restart')) }, 'Restart Discord'));
        const detail = plugins.find(plugin => plugin.manifest.id === selected);
        const toggle = plugin => h('button', { role: 'switch', 'aria-checked': plugin.enabled,
            'aria-label': `Enable ${plugin.manifest.name}`, className: 'bedrock-switch', disabled: !!busy,
            onClick: () => run(plugin.manifest.id, () => setEnabled(plugin.manifest.id, !plugin.enabled)) }, h('span'));
        if (detail) return h('section', { className: 'bedrock-page bedrock-plugin-page', ref: page },
            h('button', { className: 'bedrock-button', onClick: () => { setError(''); select(null); } }, `${backArrow} Back to plugins`),
            h('div', { className: 'bedrock-detail-header' }, h('h2', null, detail.manifest.name), toggle(detail)),
            h('p', { className: 'bedrock-muted' }, `v${detail.manifest.version} ${metadataSeparator} ${displayStatus(detail)} ${metadataSeparator} ${detail.manifest.id}`),
            detail.manifest.description && h('p', null, detail.manifest.description),
            restartBanner,
            error && h('p', { className: 'bedrock-error', role: 'alert' }, error),
            detail.error && h('div', null,
                h('p', { className: 'bedrock-error', role: 'alert' }, detail.error),
                h('div', { className: 'bedrock-toolbar' },
                    h('button', { className: 'bedrock-button', disabled: !!busy, onClick: () => run('retry', async () => {
                        await setEnabled(detail.manifest.id, false); await setEnabled(detail.manifest.id, true);
                    }) }, 'Retry'),
                    h('button', { className: 'bedrock-button', onClick: () => run('copy', () => navigator.clipboard.writeText(detail.error)) }, 'Copy error'))),
            detail.restartReason && h('p', { className: 'bedrock-restart' }, `Restart needed: ${detail.restartReason}`),
            h('div', { className: 'bedrock-tabs', role: 'tablist', 'aria-label': 'Plugin information' },
                ['details', 'settings'].map(name => h('button', { key: name, className: 'bedrock-tab', id: `bedrock-${name}-tab`, role: 'tab',
                    'aria-selected': tab === name, tabIndex: tab === name ? 0 : -1, 'aria-controls': `bedrock-${name}-panel`, onClick: () => setTab(name),
                    onKeyDown: event => {
                        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
                        event.preventDefault();
                        const next = event.key === 'Home' ? 'details' : event.key === 'End' ? 'settings' : tab === 'details' ? 'settings' : 'details';
                        setTab(next); document.getElementById(`bedrock-${next}-tab`).focus();
                    } }, name === 'details' ? 'Details' : 'Settings'))),
            tab === 'settings' ? h('div', { id: 'bedrock-settings-panel', role: 'tabpanel', 'aria-labelledby': 'bedrock-settings-tab' },
                h(PluginSettings, { key: selected, plugin: detail })) :
            h('div', { className: 'bedrock-readme', id: 'bedrock-details-panel', role: 'tabpanel', 'aria-labelledby': 'bedrock-details-tab' },
                readme ? markdown(readme, `bedrock://plugins/${selected}/${(detail.manifest.readme || '').replaceAll('\\', '/')}`)
                    : h('p', { className: 'bedrock-muted' }, readme === null && detail.manifest.readme ? `Loading documentation${ellipsis}` : 'No README provided.')));
        return h('div', { className: 'bedrock-page', ref: page },
            restartBanner,
            h('div', { className: 'bedrock-toolbar' },
                h('input', { type: 'search', placeholder: 'Search plugins', 'aria-label': 'Search plugins', value: search, onChange: event => setSearch(event.target.value) }),
                h('button', { className: 'bedrock-button', disabled: !!busy, onClick: () => run('folder', () => native.request('openFolder')) }, 'Open plugins folder'),
                h('button', { className: 'bedrock-button', disabled: !!busy, onClick: () => run('rescan', async () => update(await native.request('rescan'))) }, 'Refresh list')),
            error && h('p', { className: 'bedrock-error', role: 'alert' }, error),
            ...snapshot.errors.map((item, key) => h('p', { key: `error-${key}`, className: 'bedrock-error' }, `${item.folder}: ${item.error}`)),
            h('div', { className: 'bedrock-grid' }, plugins.filter(plugin =>
                `${plugin.manifest.name} ${plugin.manifest.id} ${plugin.manifest.description || ''}`.toLowerCase().includes(search.toLowerCase())
            ).map(plugin => h('article', { key: plugin.manifest.id, className: 'bedrock-card' },
                h('div', { className: 'bedrock-card-header' },
                    plugin.manifest.icon && h('img', { className: 'bedrock-icon', alt: '', src: `bedrock://plugins/${plugin.manifest.id}/${plugin.manifest.icon.replaceAll('\\', '/').split('/').map(encodeURIComponent).join('/')}` }),
                    h('h3', null, h('button', { className: 'bedrock-name', onClick: () => open(plugin.manifest.id) }, plugin.manifest.name)),
                    toggle(plugin)),
                h('p', { className: 'bedrock-card-description' }, plugin.manifest.description || 'No description provided.'),
                h('p', { className: 'bedrock-muted bedrock-status', role: 'status' },
                    plugin.enabled && !plugin.error && ([plugin.mainStatus, plugin.rendererStatus].includes('starting') || plugin.statusMessage && plugin.mainStatus === 'running') && h('span', { className: 'bedrock-spinner', 'aria-hidden': true }),
                    `v${plugin.manifest.version} ${metadataSeparator} ${displayStatus(plugin)}`),

                plugin.restartReason && h('p', { className: 'bedrock-restart' }, `Restart needed: ${plugin.restartReason}`),
                h('button', { className: 'bedrock-button', onClick: () => open(plugin.manifest.id) }, 'Open')))),
            plugins.length === 0 && h('p', { className: 'bedrock-muted' }, 'No plugins installed. Open the plugins folder, add a plugin folder, then choose Refresh plugins.'),
            plugins.length > 0 && !plugins.some(plugin => `${plugin.manifest.name} ${plugin.manifest.id} ${plugin.manifest.description || ''}`.toLowerCase().includes(search.toLowerCase())) && h('p', { className: 'bedrock-muted' }, 'No plugins match your search.'));

    }
    function ThemesPage() {
        React = renderingReact() || React;
        const h = React.createElement;
        const [, refresh] = React.useState(0);
        const [search, setSearch] = React.useState('');
        const [busy, setBusy] = React.useState(null);
        const [error, setError] = React.useState('');
        React.useEffect(() => subscribe(() => refresh(value => value + 1)), []);
        const run = async (id, operation) => {
            setBusy(id); setError('');
            try { await operation(); } catch (error) { setError(error.message); } finally { setBusy(null); }
        };
        const themes = snapshot.themes || [];
        const filtered = themes.filter(theme => `${theme.name} ${theme.id} ${theme.author || ''} ${theme.description || ''}`.toLowerCase().includes(search.toLowerCase()));
        return h('section', { className: 'bedrock-page' },
            h('div', { className: 'bedrock-toolbar' },
                h('input', { type: 'search', placeholder: 'Search themes', 'aria-label': 'Search themes', value: search, onChange: event => setSearch(event.target.value) }),
                h('button', { className: 'bedrock-button', disabled: !!busy, onClick: () => run('folder', () => native.request('openThemesFolder')) }, 'Open themes folder')),
            h('p', { className: 'bedrock-muted' }, 'Add CSS files to your themes folder. File changes apply automatically; no restart needed.'),
            error && h('p', { className: 'bedrock-error', role: 'alert' }, error),
            ...(snapshot.themeErrors || []).map((error, key) => h('p', { key, className: 'bedrock-error', role: 'alert' }, error)),
            h('div', { className: 'bedrock-grid' }, filtered.map(theme => h('article', { key: theme.id, className: 'bedrock-card' },
                h('div', { className: 'bedrock-card-header' }, h('h3', null, theme.name),
                    h('button', { className: 'bedrock-switch', role: 'switch', 'aria-label': `Enable ${theme.name}`, 'aria-checked': theme.enabled,
                        'aria-busy': busy === theme.id, disabled: !!busy,
                        onClick: () => run(theme.id, async () => update(await native.request('themesEnable', theme.id, !theme.enabled))) }, h('span'))),
                theme.description && h('p', { className: 'bedrock-card-description', title: theme.description }, theme.description),
                h('p', { className: 'bedrock-muted' }, [theme.author, theme.version && `v${theme.version}`, theme.id].filter(Boolean).join(` ${metadataSeparator} `)),
                theme.website && h('a', { className: 'bedrock-theme-website', href: theme.website, target: '_blank', rel: 'noreferrer',
                    onClick: event => { event.preventDefault(); run(`website-${theme.id}`, () => native.request('themeWebsite', theme.id)); } }, 'Website'),
                (theme.error || themeLoadErrors.get(theme.id)) && h('p', { className: 'bedrock-error', role: 'alert' }, theme.error || themeLoadErrors.get(theme.id))))),
            !themes.length && h('p', { className: 'bedrock-muted' }, 'No themes installed. Open the themes folder and add a CSS file.'),
            !!themes.length && !filtered.length && h('p', { className: 'bedrock-muted' }, 'No themes match your search.'));
    }
    function settingsLayout(builder) {
        const original = builder.buildLayout();
        if (builder.key !== '$Root' || !Array.isArray(original) || original.some(node => node?.key === 'bedrock_section')) return original;
        settingsDiagnostics.rootCalls++;
        inspectModules();
        React = renderingReact() || React;
        if (!React || !layoutTypes) {
            log('settings', `Missing ${[!React && 'React', !layoutTypes && 'layout types'].filter(Boolean).join(' and ')}; observed modules: ${loadedModules.size}; captured cache: ${Object.keys(webpackRequire?.c || {}).length}`);
            return original;
        }
        const T = layoutTypes;
        const node = (type, key, title, children) => ({ type, key, useTitle: () => title, buildLayout: () => children });
        const custom = { type: T.CUSTOM, key: 'bedrock_plugins_content', Component: PluginsPage, useSearchTerms: () => ['Bedrock', 'Plugins'] };
        const category = node(T.CATEGORY, 'bedrock_plugins_category', 'Plugins', [custom]);
        const panel = node(T.PANEL, 'bedrock_plugins_panel', 'Bedrock Plugins', [category]);
        const entry = node(T.SIDEBAR_ITEM, 'bedrock_plugins', 'Plugins', [panel]);
        entry.icon = () => React.createElement('svg', { width: 20, height: 20, viewBox: '0 0 20 20', fill: 'currentColor' },
            React.createElement('path', { d: 'M3 3h6v6H3zm8 0h6v6h-6zM3 11h6v6H3zm8 0h6v6h-6z' }));
        const themesContent = { type: T.CUSTOM, key: 'bedrock_themes_content', Component: ThemesPage, useSearchTerms: () => ['Bedrock', 'Themes', 'CSS'] };
        const themesCategory = node(T.CATEGORY, 'bedrock_themes_category', 'Themes', [themesContent]);
        const themesPanel = node(T.PANEL, 'bedrock_themes_panel', 'Bedrock Themes', [themesCategory]);
        const themesEntry = node(T.SIDEBAR_ITEM, 'bedrock_themes', 'Themes', [themesPanel]);
        themesEntry.icon = () => React.createElement('svg', { width: 20, height: 20, viewBox: '0 0 20 20', fill: 'currentColor' },
            React.createElement('path', { d: 'M10 2a8 8 0 1 0 0 16h1a3 3 0 0 0 0-6h-1a1 1 0 0 1 0-2h4a4 4 0 0 0 4-4c0-2-4-4-8-4ZM5 9a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3Zm4-3a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3Zm4 1a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3Z' }));
        const section = node(T.SECTION, 'bedrock_section', 'Bedrock', [entry, themesEntry]);
        const result = [...original];
        const billing = result.findIndex(item => item?.key === 'billing_section');
        result.splice(billing >= 0 ? billing : Math.min(2, result.length), 0, section);
        return result;
    }
    const wrappedFactories = new WeakSet();
    function attachRequire(require) {
        if (!require?.m || webpackRuntimes.has(require)) return;
        webpackRuntimes.add(require);
        webpackRequire ||= require;
        wrapFactories(require.m);
        inspectModules();
    }
    function wrapFactories(factories) {
        if (!factories) return;
        for (const id of Object.keys(factories)) {
            const original = factories[id];
            if (typeof original !== 'function' || wrappedFactories.has(original)) continue;
            let factory = original;
            const source = Function.prototype.toString.call(original);
            if (source.includes('.buildLayout()')) {
                // This call happens inside an unexported Discord component, so ordinary exported-method patches cannot reach it.
                const modified = source.replace(/\b([A-Za-z_$][\w$]*)\.buildLayout\(\)(?=\.map\()/g, 'globalThis.Bedrock._settingsLayout($1)');
                if (modified !== source) {
                    try {
                        try { factory = new Function(`return (${modified})`)(); }
                        catch (error) {
                            if (!(error instanceof SyntaxError)) throw error;
                            // Method shorthand, including numeric Webpack keys, is valid only inside an object literal.
                            factory = Object.values(new Function(`return ({${modified}})`)())[0];
                        }
                        settingsDiagnostics.patchedFactories++;
                    }
                    catch (error) { log('settings', error); }
                }
            }
            const wrapped = function (module, exports, require, ...rest) {
                attachRequire(require);
                try { return factory.call(this, module, exports, require, ...rest); }
                finally { if (module) loadedModules.add(module); inspectModules(); }
            };
            wrappedFactories.add(wrapped);
            factories[id] = wrapped;
        }
    }
    const wrappedChunks = new WeakSet();
    function interceptChunks(chunks) {
        if (!Array.isArray(chunks) || wrappedChunks.has(chunks)) return chunks;
        wrappedChunks.add(chunks);
        for (const chunk of chunks) wrapFactories(chunk[1]);
        const wrapPush = push => function (...items) {
            for (const chunk of items) wrapFactories(chunk[1]);
            return push.apply(this, items);
        };
        let wrappedPush = wrapPush(chunks.push);
        Object.defineProperty(chunks, 'push', { configurable: true, get: () => wrappedPush, set: value => {
            if (value === wrappedPush) return;
            wrappedPush = wrapPush(value);
            value.call(chunks, [[`bedrock_${Date.now()}`], {}, attachRequire]);
        } });
        return chunks;
    }
    globalThis.Bedrock = { plugins: { list, setEnabled, async rescan() { update(await native.request('rescan')); return list(); } },
        webpack: { find: findModule },
        debug: { status() {
            inspectModules();
            return { ...settingsDiagnostics, react: !!React, layoutTypes: layoutTypes ?
                Object.fromEntries(['SECTION', 'SIDEBAR_ITEM', 'PANEL', 'CATEGORY', 'CUSTOM'].map(key => [key, layoutTypes[key]])) : null,
                observedModules: loadedModules.size, runtimes: webpackRuntimes.size,
                cacheModules: [...webpackRuntimes].reduce((total, require) => total + Object.keys(require.c || {}).length, 0) };
        } }, _settingsLayout: settingsLayout };
    let chunks = interceptChunks(globalThis.webpackChunkdiscord_app);
    Object.defineProperty(globalThis, 'webpackChunkdiscord_app', { configurable: true,
        get: () => chunks, set: value => { chunks = interceptChunks(value); } });
    native.onUpdate(update);
    native.onEvent(event => emitLocal(event.name, { id: event.id, value: event.value }));
    update(configuration);
    console.info('[Bedrock] Renderer and settings integration installed.');
}

if (typeof process !== 'undefined' && process.versions.electron) {
    const { contextBridge, ipcRenderer } = require('electron');
    if (process.isMainFrame) {
        const configuration = ipcRenderer.sendSync('bedrock:config');
        if (configuration) {
            const bridge = {
                request: (operation, ...args) => ipcRenderer.invoke('bedrock:request', operation, ...args),
                onUpdate: callback => ipcRenderer.on('bedrock:update', (_, value) => callback(value)),
                onEvent: callback => ipcRenderer.on('bedrock:event', (_, value) => callback(value))
            };
            if (process.contextIsolated) {
                contextBridge.exposeInMainWorld('BedrockNative', bridge);
                contextBridge.executeInMainWorld({ func: installRenderer, args: [configuration] });
            } else {
                globalThis.BedrockNative = bridge;
                installRenderer(configuration);
            }
        }
    }
} else module.exports = { installRenderer };
