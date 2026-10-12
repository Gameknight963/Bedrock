const { createRequire } = require('node:module');
function createAddonLoader(probe, fromFile) {
    const nodeRequire = createRequire(fromFile);
    const files = new Map();
    const objects = new WeakMap();
    function acquire(request) {
        const filename = nodeRequire.resolve(request);
        if (!filename.endsWith('.node')) throw new Error('This experiment handles only native addons');
        let entry = files.get(filename);
        if (!entry) {
            if (require.cache[filename]) throw new Error('Addon was already loaded outside this wrapper');
            const object = nodeRequire(filename);
            if (!object || !['object', 'function'].includes(typeof object)) throw new Error('Addon exports must be an object');
            entry = { filename, object, users: 0 };
            files.set(filename, entry);
            objects.set(object, entry);
        }
        entry.users++;
        return entry.object;
    }
    function release(object) {
        const entry = objects.get(object);
        if (!entry || entry.users === 0) throw new Error('Addon is not acquired');
        if (entry.users > 1) { entry.users--; return; }
        const result = object.dispose?.();
        if (result && typeof result.then === 'function') throw new Error('Async disposal is not supported by this experiment');
        const error = probe.operation('free', entry.filename);
        if (error) throw new Error(`FreeLibrary failed (${error})`);
        const cached = require.cache[entry.filename];
        for (const module of Object.values(require.cache))
            module.children = module.children.filter(child => child !== cached);
        delete require.cache[entry.filename];
        files.delete(entry.filename);
        objects.delete(object);
        entry.users = 0;
    }
    return { require: acquire, unrequire: release };
}
module.exports = { createAddonLoader };
