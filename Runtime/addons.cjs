const path = require('node:path');
const { createRequire } = require('node:module');
const { fileURLToPath } = require('node:url');

function createAddonLoader(options = {}) {
    const files = new Map();
    const objects = new WeakMap();
    let bridge;
    const native = () => bridge ||= options.bridge || require(path.join(options.directory || path.join(__dirname, 'native', `${process.platform}-${process.arch}`), 'addons.node'));
    function load(request, from) {
        if (request instanceof URL) request = fileURLToPath(request);
        const nodeRequire = from ? createRequire(from) : require;
        const filename = nodeRequire.resolve(request);
        if (path.extname(filename).toLowerCase() !== '.node') return nodeRequire(request);
        let entry = files.get(filename);
        if (entry?.disposing) throw new Error('The addon is being disposed.');
        if (!entry) {
            if (require.cache[filename]) throw new Error(`Addon was already loaded through ordinary require(): ${filename}`);
            const api = native();
            const object = nodeRequire(filename);
            if (!object || !['object', 'function'].includes(typeof object)) throw new Error('A managed addon must export an object or function.');
            if (objects.has(object)) throw new Error('Different addons cannot share the same exports object.');
            entry = { filename, object, handle: api.capture(filename), users: 0, disposing: false };
            files.set(filename, entry);
            objects.set(object, entry);
        }
        entry.users++;
        return entry.object;
    }
    function unload(object) {
        const entry = objects.get(object);
        if (!entry || entry.users === 0) throw new Error('This object has no outstanding Bedrock.require() acquisition.');
        if (entry.disposing) throw new Error('The addon is being disposed.');
        if (entry.users > 1) { entry.users--; return; }
        entry.disposing = true;
        try {
            const result = object.dispose?.();
            if (result && typeof result.then === 'function') {
                Promise.resolve(result).catch(() => {});
                throw new Error('Addon dispose() must be synchronous.');
            }
            native().release(entry.handle);
            const cached = require.cache[entry.filename];
            for (const module of Object.values(require.cache))
                module.children = module.children.filter(child => child !== cached);
            delete require.cache[entry.filename];
            files.delete(entry.filename);
            objects.delete(object);
            entry.users = 0;
        } finally { entry.disposing = false; }
    }
    // Installed plugins may still use the previous name.
    return { require: load, unloadAddon: unload, unrequire: unload };
}

module.exports = { createAddonLoader };
