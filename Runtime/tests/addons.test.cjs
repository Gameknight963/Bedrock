const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { pathToFileURL } = require('node:url');
const { createAddonLoader } = require('../addons.cjs');

function fixture(t, object) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'Bedrock-addon-test-'));
    const filename = path.join(root, 'addon.node');
    fs.writeFileSync(filename, '');
    const previous = Module._extensions['.node'];
    Module._extensions['.node'] = (module, file) => file === filename ? module.exports = object : previous(module, file);
    t.after(() => { Module._extensions['.node'] = previous; delete require.cache[filename]; fs.rmSync(root, { recursive: true, force: true }); });
    let released = 0;
    const loader = createAddonLoader({ bridge: { capture: () => 1n, release(handle) { assert.equal(handle, 1n); released++; } } });
    return { root, filename, loader, released: () => released };
}

test('cached acquisitions share exports and dispose on final release', t => {
    let disposed = 0;
    const object = { dispose() { disposed++; } };
    const data = fixture(t, object);
    const first = data.loader.require(pathToFileURL(data.filename));
    const second = data.loader.require('./addon.node', pathToFileURL(path.join(data.root, 'entry.js')));
    assert.equal(first, second);
    data.loader.unloadAddon(first);
    assert.equal(disposed, 0);
    assert.equal(data.released(), 0);
    assert.equal(require.cache[data.filename].exports, object);
    data.loader.unloadAddon(second);
    assert.equal(disposed, 1);
    assert.equal(data.released(), 1);
    assert.equal(require.cache[data.filename], undefined);
    assert.throws(() => data.loader.unloadAddon(second), /no outstanding/);
    assert.equal(data.loader.require('node:fs'), fs);
});

test('disposal failures preserve the acquisition and prevent native unloading', t => {
    const object = { dispose() { throw new Error('still busy'); } };
    const data = fixture(t, object);
    const addon = data.loader.require(data.filename);
    assert.throws(() => data.loader.unloadAddon(addon), /still busy/);
    assert.equal(data.released(), 0);
    assert.equal(require.cache[data.filename].exports, object);
    object.dispose = () => {};
    data.loader.unloadAddon(addon);
    assert.equal(data.released(), 1);
});

test('reentrant acquisition and asynchronous dispose do not free the DLL', t => {
    const object = {};
    const data = fixture(t, object);
    const addon = data.loader.require(data.filename);
    object.dispose = () => data.loader.require(data.filename);
    assert.throws(() => data.loader.unloadAddon(addon), /being disposed/);
    object.dispose = () => Promise.reject(new Error('asynchronous failure'));
    assert.throws(() => data.loader.unloadAddon(addon), /synchronous/);
    assert.equal(data.released(), 0);
    object.dispose = () => {};
    data.loader.unloadAddon(addon);
});

test('addons loaded outside the wrapper cannot be claimed as managed acquisitions', t => {
    const data = fixture(t, {});
    const object = require(data.filename);
    assert.throws(() => data.loader.require(data.filename), /ordinary require/);
    assert.throws(() => data.loader.unloadAddon(object), /no outstanding/);
    assert.equal(data.released(), 0);
});
