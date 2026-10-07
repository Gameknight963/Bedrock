const path = require('node:path');
const { EventEmitter } = require('node:events');
const { discover, readJson, writeJson } = require('./storage.cjs');
const { createContext, createPatcher } = require('./context.cjs');
const { definePluginSettings, OptionType, normalizeDefinitions, validateSetting, bindPluginSettings } = require('./settings.mjs');

function createPluginManager(root, options = {}) {
    const configurationPath = path.join(root, 'settings.json');
    const configuration = readJson(configurationPath, { plugins: {} });
    if (!configuration.plugins || typeof configuration.plugins !== 'object' || Array.isArray(configuration.plugins))
        throw new Error('Bedrock settings.json: plugins must be an object');
    const records = new Map();
    const events = new EventEmitter();
    events.setMaxListeners(0);
    const patch = createPatcher();
    const log = options.log || ((level, id, args) => console[level](`[Bedrock:${id}]`, ...args));
    let discoveryErrors = [];
    const settingsStores = new Map();
    const definitions = new Map();
    const restartBaselines = new Map();

    function registerSettings(id, schema) {
        if (!records.has(id)) throw new Error('Unknown plugin');
        const incoming = normalizeDefinitions(schema);
        const existing = definitions.get(id) || {};
        for (const [key, definition] of Object.entries(incoming)) {
            if (existing[key] && JSON.stringify(existing[key]) !== JSON.stringify(definition))
                throw new Error(`Main and renderer definitions disagree for ${key}`);
        }
        const store = settings(id);
        for (const [key, definition] of Object.entries(incoming)) {
            if (validateSetting(definition, store.get(key, definition.default)))
                throw new Error(`Saved setting ${key} is incompatible with its definition`);
            const baselineKey = `${id}/${key}`;
            if (!restartBaselines.has(baselineKey)) restartBaselines.set(baselineKey, store.get(key, definition.default));
        }
        definitions.set(id, { ...existing, ...incoming });
        notify();
    }

    function restartSettings(id) {
        const store = settings(id);
        return Object.entries(definitions.get(id) || {}).filter(([key, definition]) => definition.restartNeeded &&
            JSON.stringify(store.get(key, definition.default)) !== JSON.stringify(restartBaselines.get(`${id}/${key}`))).map(([key]) => key);
    }

    function settings(id) {
        if (!settingsStores.has(id)) {
            const file = path.join(root, 'data', id, 'settings.json');
            const values = readJson(file, {});
            if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error(`Invalid settings for ${id}`);
            settingsStores.set(id, { file, values });
        }
        const store = settingsStores.get(id);
        return {
            get(key, fallback) { return Object.hasOwn(store.values, key) ? structuredClone(store.values[key]) : fallback; },
            set(key, value) {
                if (typeof key !== 'string' || ['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('Invalid settings key');
                const serialized = JSON.stringify(value);
                if (serialized === undefined) throw new Error('Settings must be JSON values');
                const definition = definitions.get(id)?.[key];
                const error = definition && validateSetting(definition, value);
                if (error) throw new Error(error);
                const record = records.get(id);
                if (record?.settingsBinding && Object.hasOwn(record.module.settings.definitions, key))
                    record.settingsBinding.validate(key, value);
                const next = { ...store.values, [key]: JSON.parse(serialized) };
                writeJson(store.file, next);
                store.values = next;
                events.emit('settings.changed', { id, key, value: store.values[key] });
            },
            delete(key) {
                if (typeof key !== 'string' || ['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('Invalid settings key');
                const next = { ...store.values };
                delete next[key]; writeJson(store.file, next); store.values = next;
                events.emit('settings.changed', { id, key, deleted: true });
            },
            all() { return structuredClone(store.values); }
        };
    }

    const enabled = id => configuration.plugins[id]?.enabled !== false;
    const notify = () => options.changed?.(list());
    function list() {
        return [...records.values()].map(record => ({
            manifest: record.manifest, enabled: enabled(record.manifest.id),
            mainStatus: record.status, error: record.error || null,
            restartReason: record.restartReason || null,
            settingsDefinitions: definitions.get(record.manifest.id) || {},
            restartSettings: restartSettings(record.manifest.id),
            renderer: record.manifest.entrypoints.renderer ? `bedrock://plugins/${record.manifest.id}/${(typeof record.manifest.entrypoints.renderer === 'string' ? record.manifest.entrypoints.renderer : record.manifest.entrypoints.renderer.path).replaceAll('\\', '/').split('/').map(encodeURIComponent).join('/')}` : null,
            settings: settings(record.manifest.id).all()
        }));
    }

    function start(record) {
        if (!record.entries.main || record.instance || !enabled(record.manifest.id)) return;
        record.status = 'starting';
        record.error = null;
        let owned;
        try {
            record.module ||= require(record.entries.main);
            if (typeof record.module.start !== 'function') throw new Error('Main entry point must export start(context)');
            const services = {
                log, settings: settings(record.manifest.id), patch,
                subscribe(name, callback) {
                    if (['settings.changed', 'window.created'].includes(name)) {
                        events.on(name, callback); return () => events.off(name, callback);
                    }
                    const listener = event => { if (event.name === name) callback({ id: event.id, value: event.value }); };
                    events.on('plugin.event', listener); return () => events.off('plugin.event', listener);
                },
                emit(name, value) { events.emit('plugin.event', { id: record.manifest.id, name, value }); },
                requireRestart(reason) { record.restartReason = reason; notify(); }
            };
            owned = createContext(record.manifest, services);
            services.extra = options.context?.(record, owned.own) || {};
            Object.assign(owned.context, services.extra);
            record.instance = owned;
            if (record.module.settings) {
                registerSettings(record.manifest.id, record.module.settings.definitions);
                const binding = bindPluginSettings(record.module.settings, {
                    ...services.settings, signal: owned.context.signal, log: error => log('error', record.manifest.id, [error])
                });
                record.settingsBinding = binding;
                const listener = event => { if (event.id === record.manifest.id) binding.refresh(); };
                events.on('settings.changed', listener);
                owned.own(() => { events.off('settings.changed', listener); binding.dispose(); record.settingsBinding = null; });
            }
            const completion = record.module.start(owned.context);
            if (completion && typeof completion.then === 'function') {
                record.startPromise = Promise.race([Promise.resolve(completion), new Promise(resolve =>
                    owned.context.signal.addEventListener('abort', resolve, { once: true }))]).then(() => {
                    if (record.instance === owned) record.status = 'running';
                    notify();
                }).catch(error => {
                    if (record.instance === owned) { owned.dispose(); record.instance = null; record.status = 'failed'; record.error = error.message; }
                    log('error', record.manifest.id, [error]); notify();
                });
            } else record.status = 'running';
        } catch (error) {
            owned?.dispose(); record.instance = null; record.status = 'failed'; record.error = error.message;
            log('error', record.manifest.id, [error]);
        }
    }

    async function stop(record) {
        const instance = record.instance;
        if (!instance) return;
        record.status = 'stopping';
        instance.dispose();
        try {
            await record.startPromise;
            let timer;
            try {
                await Promise.race([Promise.resolve(record.module.stop?.()), new Promise((_, reject) => {
                    timer = setTimeout(() => reject(new Error('stop() did not finish within 10 seconds')), 10000);
                })]);
            } finally { clearTimeout(timer); }
        } catch (error) { record.error = error.message; log('error', record.manifest.id, [error]); }
        finally { instance.dispose(); record.instance = null; record.startPromise = null; record.status = 'stopped'; }
    }

    function scan() {
        const discovered = discover(root);
        discoveryErrors = discovered.errors;
        for (const error of discoveryErrors) log('error', 'loader', [`${error.folder}: ${error.error}`]);
        for (const [id, plugin] of discovered.plugins) {
            if (records.has(id)) continue;
            const record = { ...plugin, status: plugin.entries.main ? 'stopped' : 'renderer-only' };
            try { settings(id); } catch (error) { discoveryErrors.push({ folder: id, error: error.message }); continue; }
            records.set(id, record);
            start(record);
        }
        notify();
        return list();
    }

    const transitions = new Map();
    function setEnabled(id, value) {
        const work = (transitions.get(id) || Promise.resolve()).catch(() => {}).then(async () => {
            const record = records.get(id);
            if (!record) throw new Error(`Unknown plugin: ${id}`);
            configuration.plugins[id] = { ...(configuration.plugins[id] || {}), enabled: !!value };
            writeJson(configurationPath, configuration);
            if (value) start(record); else await stop(record);
            notify();
            return list();
        });
        transitions.set(id, work);
        return work;
    }
    return { root, records, events, settings, list, scan, setEnabled, registerSettings, definePluginSettings, OptionType, errors: () => discoveryErrors,
        stopAll: () => Promise.all([...records.values()].map(stop)) };
}

module.exports = { createPluginManager };
