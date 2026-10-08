export const OptionType = Object.freeze({
    BOOLEAN: 'boolean', STRING: 'string', NUMBER: 'number', SELECT: 'select', SLIDER: 'slider'
});

const bindings = new WeakMap();
const reserved = new Set(['__proto__', 'constructor', 'prototype']);
const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);

export function validateSetting(definition, value) {
    if (definition.type === OptionType.BOOLEAN && typeof value !== 'boolean') return 'Choose on or off.';
    if (definition.type === OptionType.STRING && typeof value !== 'string') return 'Enter text.';
    if ([OptionType.NUMBER, OptionType.SLIDER].includes(definition.type)) {
        if (typeof value !== 'number' || !Number.isFinite(value)) return 'Enter a finite number.';
        if (definition.min !== undefined && value < definition.min) return `Minimum: ${definition.min}.`;
        if (definition.max !== undefined && value > definition.max) return `Maximum: ${definition.max}.`;
        if (definition.step !== undefined) {
            const steps = (value - (definition.min ?? 0)) / definition.step;
            if (Math.abs(steps - Math.round(steps)) > 1e-8) return `Use increments of ${definition.step}.`;
        }
    }
    if (definition.type === OptionType.SELECT && !definition.options.some(option => equal(option.value, value)))
        return 'Choose one of the available options.';
    if (definition.isValid) {
        const result = definition.isValid(value);
        if (result !== true) return typeof result === 'string' ? result : 'Invalid value.';
    }
    return null;
}

export function normalizeDefinitions(definitions) {
    if (!definitions || typeof definitions !== 'object' || Array.isArray(definitions)) throw new Error('Settings definitions must be an object');
    const result = {};
    for (const [key, source] of Object.entries(definitions)) {
        if (!key || reserved.has(key)) throw new Error(`Invalid settings key: ${key}`);
        if (!source || !Object.values(OptionType).includes(source.type)) throw new Error(`Unsupported setting type: ${key}`);
        const definition = { type: source.type, default: structuredClone(source.default) };
        for (const field of ['description', 'label', 'placeholder', 'section']) {
            if (source[field] === undefined) continue;
            if (typeof source[field] !== 'string') throw new Error(`${key}.${field} must be text`);
            definition[field] = source[field];
        }
        for (const field of ['restartNeeded', 'multiline']) {
            if (source[field] === undefined) continue;
            if (typeof source[field] !== 'boolean') throw new Error(`${key}.${field} must be boolean`);
            definition[field] = source[field];
        }
        for (const field of ['min', 'max', 'step']) {
            if (source[field] === undefined) continue;
            if (!Number.isFinite(source[field]) || (field === 'step' && source[field] <= 0)) throw new Error(`Invalid ${key}.${field}`);
            definition[field] = source[field];
        }
        if (definition.min !== undefined && definition.max !== undefined && definition.min > definition.max)
            throw new Error(`Invalid range for ${key}`);
        if (source.type === OptionType.SLIDER && (definition.min === undefined || definition.max === undefined))
            throw new Error(`Slider ${key} needs min and max`);
        if (source.type === OptionType.SELECT) {
            if (!Array.isArray(source.options) || !source.options.length) throw new Error(`Select ${key} needs options`);
            definition.options = source.options.map(option => {
                if (!option || typeof option.label !== 'string' || !['string', 'number', 'boolean'].includes(typeof option.value) ||
                    (typeof option.value === 'number' && !Number.isFinite(option.value))) throw new Error(`Invalid option for ${key}`);
                return { label: option.label, value: option.value };
            });
            if (new Set(definition.options.map(option => JSON.stringify(option.value))).size !== definition.options.length)
                throw new Error(`Duplicate options for ${key}`);
        }
        const error = validateSetting(definition, definition.default);
        if (error) throw new Error(`Invalid default for ${key}: ${error}`);
        result[key] = definition;
    }
    return result;
}

export function definePluginSettings(definitions) {
    const schema = normalizeDefinitions(definitions);
    const callbacks = {};
    for (const [key, definition] of Object.entries(definitions)) {
        for (const field of ['onChange', 'isValid'])
            if (definition[field] !== undefined && typeof definition[field] !== 'function') throw new Error(`${key}.${field} must be a function`);
        callbacks[key] = { onChange: definition.onChange, isValid: definition.isValid };
        const error = validateSetting({ ...schema[key], isValid: definition.isValid }, schema[key].default);
        if (error) throw new Error(`Invalid default for ${key}: ${error}`);
        if (schema[key].options) {
            for (const option of schema[key].options) Object.freeze(option);
            Object.freeze(schema[key].options);
        }
        Object.freeze(schema[key]);
    }
    const binding = () => {
        const value = bindings.get(settings);
        if (!value) throw new Error('Settings are available after Bedrock loads the plugin');
        return value;
    };
    const settings = {
        definitions: Object.freeze(schema),
        store: new Proxy({}, {
            get: (_, key) => Object.hasOwn(schema, key) ? binding().get(key) : undefined,
            has: (_, key) => Object.hasOwn(schema, key),
            set(_, key, value) { binding().set(key, value).catch(binding().log); return true; },
            ownKeys: () => Object.keys(schema),
            getOwnPropertyDescriptor: (_, key) => Object.hasOwn(schema, key) ? { enumerable: true, configurable: true } : undefined
        }),
        set: (key, value) => binding().set(key, value),
        reset: key => binding().set(key, structuredClone(schema[key]?.default)),
        flush: () => binding().flush(),
        subscribe: callback => binding().subscribe(callback),
        use(keys = Object.keys(schema)) { return binding().use(keys); }
    };
    Object.defineProperty(settings, '_callbacks', { value: callbacks });
    return settings;
}

export function bindPluginSettings(settings, services) {
    if (!settings?._callbacks || !settings.definitions) throw new Error('Export settings created by definePluginSettings()');
    if (bindings.has(settings)) throw new Error('Settings are already bound to another plugin');
    let active = true;
    let queue = Promise.resolve();
    const pending = new Map();
    const subscribers = new Set();
    const schema = settings.definitions;
    const get = key => {
        if (!Object.hasOwn(schema, key)) throw new Error(`Unknown setting: ${String(key)}`);
        const value = pending.has(key) ? pending.get(key) : services.get(key, schema[key].default);
        return structuredClone(value);
    };
    let previous = Object.fromEntries(Object.keys(schema).map(key => [key, get(key)]));
    const binding = {
        get, log: services.log,
        validate(key, value) {
            if (!Object.hasOwn(schema, key)) throw new Error(`Unknown setting: ${key}`);
            const error = validateSetting({ ...schema[key], isValid: settings._callbacks[key].isValid }, value);
            if (error) throw new Error(error);
        },
        set(key, value) {
            if (!active || services.signal.aborted) throw new Error('Plugin context has stopped');
            binding.validate(key, value);
            const copy = structuredClone(value);
            pending.set(key, copy);
            const operation = queue.catch(() => {}).then(async () => {
                if (!active || services.signal.aborted) throw new Error('Plugin context has stopped');
                await services.set(key, copy);
            }).finally(() => { if (pending.get(key) === copy) pending.delete(key); });
            queue = operation;
            return operation;
        },
        flush: () => queue,
        subscribe(callback) {
            if (!active) throw new Error('Plugin context has stopped');
            if (typeof callback !== 'function') throw new Error('Expected a settings callback');
            subscribers.add(callback);
            return () => subscribers.delete(callback);
        },
        use(keys) {
            const React = services.react?.();
            if (!React) throw new Error('settings.use() is only available inside a renderer React component');
            const [, refresh] = React.useState(0);
            React.useEffect(() => binding.subscribe(() => refresh(value => value + 1)), []);
            return Object.fromEntries(keys.map(key => [key, get(key)]));
        },
        refresh() {
            if (!active || services.signal.aborted) return;
            for (const key of Object.keys(schema)) {
                const value = services.get(key, schema[key].default);
                if (equal(previous[key], value)) continue;
                previous[key] = structuredClone(value);
                try { Promise.resolve(settings._callbacks[key].onChange?.(structuredClone(value))).catch(services.log); }
                catch (error) { services.log(error); }
                for (const callback of subscribers) {
                    try { callback(key, structuredClone(value)); } catch (error) { services.log(error); }
                }
            }
        },
        dispose() {
            if (!active) return;
            active = false; subscribers.clear(); bindings.delete(settings);
        }
    };
    bindings.set(settings, binding);
    return binding;
}
