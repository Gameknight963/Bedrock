function createContext(manifest, services) {
    let active = true;
    const controller = new AbortController();
    const disposers = new Set();
    const own = cleanup => {
        if (!active) { cleanup(); throw new Error('Plugin context has stopped'); }
        let done = false;
        const dispose = () => {
            if (done) return;
            done = true;
            disposers.delete(dispose);
            cleanup();
        };
        disposers.add(dispose);
        return dispose;
    };
    const context = {
        id: manifest.id,
        signal: controller.signal,
        manifest: structuredClone(manifest),
        log: Object.fromEntries(['info', 'warn', 'error'].map(level => [level, (...args) => services.log(level, manifest.id, args)])),
        settings: services.settings,
        reportStatus(message) { if (active) services.reportStatus?.(String(message)); },
        events: {
            emit: (name, value) => services.emit(name, value),
            on(name, callback) {
                const guarded = (...args) => {
                    if (!active) return;
                    try { Promise.resolve(callback(...args)).catch(error => context.log.error(error)); }
                    catch (error) { context.log.error(error); }
                };
                return own(services.subscribe(name, guarded));
            }
        },
        patches: Object.fromEntries(['before', 'after', 'instead'].map(kind => [kind, (object, method, callback) =>
            own(services.patch(kind, object, method, callback))])),
        cleanup: own,
        requireRestart: reason => services.requireRestart(String(reason)),
        ...(services.extra || {})
    };
    return {
        context,
        dispose() {
            if (!active) return;
            active = false;
            controller.abort();
            for (const dispose of [...disposers].reverse()) {
                try { dispose(); } catch (error) { context.log.error(error); }
            }
        },
        own
    };
}

function createPatcher() {
    const objects = new WeakMap();
    return function patch(kind, object, method, callback) {
        if (!object || typeof object[method] !== 'function' || typeof callback !== 'function')
            throw new Error('A patch requires an object method and a callback');
        let methods = objects.get(object);
        if (!methods) { methods = new Map(); objects.set(object, methods); }
        let slot = methods.get(method);
        if (!slot) {
            const descriptor = Object.getOwnPropertyDescriptor(object, method);
            slot = { original: object[method], descriptor, patches: [] };
            slot.wrapper = function (...args) {
                const hooks = [...slot.patches];
                for (const hook of hooks.filter(hook => hook.kind === 'before')) hook.callback(args, this);
                let invoke = (...nextArgs) => slot.original.apply(this, nextArgs);
                for (const hook of hooks.filter(hook => hook.kind === 'instead').reverse()) {
                    const next = invoke;
                    invoke = (...nextArgs) => hook.callback(nextArgs, next, this);
                }
                let result = invoke(...args);
                for (const hook of hooks.filter(hook => hook.kind === 'after')) {
                    const replacement = hook.callback(args, result, this);
                    if (replacement !== undefined) result = replacement;
                }
                return result;
            };
            Object.defineProperty(object, method, { configurable: true, enumerable: descriptor?.enumerable ?? true, writable: true, value: slot.wrapper });
            methods.set(method, slot);
        }
        const hook = { kind, callback };
        slot.patches.push(hook);
        return () => {
            const index = slot.patches.indexOf(hook);
            if (index >= 0) slot.patches.splice(index, 1);
            if (!slot.patches.length) {
                if (object[method] === slot.wrapper) {
                    if (slot.descriptor) Object.defineProperty(object, method, slot.descriptor);
                    else delete object[method];
                }
                methods.delete(method);
            }
        };
    };
}

module.exports = { createContext, createPatcher };
