const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { discover, writeJson } = require('../storage.cjs');
const { createPluginManager } = require('../plugins.cjs');

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'Bedrock-tests-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return root;
}
function plugin(root, id, source, overrides = {}, folder = id) {
    const directory = path.join(root, 'plugins', folder);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'main.js'), source);
    writeJson(path.join(directory, 'plugin.json'), { manifestVersion: 2,
        id, name: id, version: '1.0.0', entrypoints: { main: { runtime: 'javascript', path: 'main.js', requiresApi: '1.0.0' } }, ...overrides });
    return directory;
}
const quiet = { log() {} };

test('refresh unloads removed plugins and retains their saved settings', async t => {
    const root = fixture(t);
    globalThis.bedrockRemoved = { method: () => 1, stopped: false };
    t.after(() => { delete globalThis.bedrockRemoved; });
    const directory = plugin(root, 'test.removed', `export function start(ctx) {
        ctx.patches.after(globalThis.bedrockRemoved, 'method', () => 2);
        ctx.settings.set('keep', 42);
    } export function stop() { globalThis.bedrockRemoved.stopped = true; }`);
    const manager = createPluginManager(root, quiet);
    manager.scan();
    assert.equal(globalThis.bedrockRemoved.method(), 2);
    fs.rmSync(directory, { recursive: true });
    await manager.refresh();
    assert.deepEqual(manager.list(), []);
    assert.equal(globalThis.bedrockRemoved.method(), 1);
    assert.equal(globalThis.bedrockRemoved.stopped, true);
    assert.equal(manager.settings('test.removed').get('keep'), 42);
});

test('disabled packages are inspected without executing; state and settings survive a new manager', async t => {
    const root = fixture(t);
    const marker = path.join(root, 'executed');
    const directory = plugin(root, 'test.disabled', `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)}, 'yes'); export function start(ctx) { ctx.settings.set('answer', 42); }`);
    writeJson(path.join(directory, 'package.json'), { type: 'module' });
    writeJson(path.join(root, 'settings.json'), { plugins: { 'test.disabled': { enabled: false } } });
    const manager = createPluginManager(root, quiet);
    manager.scan();
    assert.equal(fs.existsSync(marker), false);
    await manager.setEnabled('test.disabled', true);
    assert.equal(fs.existsSync(marker), true);
    assert.equal(manager.settings('test.disabled').get('answer'), 42);
    await manager.setEnabled('test.disabled', false);
    const reopened = createPluginManager(root, quiet);
    reopened.scan();
    assert.equal(reopened.list()[0].enabled, false);
    assert.equal(reopened.settings('test.disabled').get('answer'), 42);
});

test('patches compose across plugins and cleanup is safe in either order, including a throwing stop', async t => {
    const root = fixture(t);
    globalThis.bedrockTestTarget = { method: value => value + 1, calls: 0 };
    t.after(() => { delete globalThis.bedrockTestTarget; });
    const original = globalThis.bedrockTestTarget.method;
    plugin(root, 'test.first', `export function start(ctx) { ctx.patches.after(globalThis.bedrockTestTarget, 'method', (_args, value) => value * 2); ctx.events.on('test.event', () => globalThis.bedrockTestTarget.calls++); } export function stop() { throw new Error('intentional stop failure'); }`);
    plugin(root, 'test.second', `export function start(ctx) { ctx.patches.before(globalThis.bedrockTestTarget, 'method', args => args[0]++); }`);
    const manager = createPluginManager(root, quiet); manager.scan();
    assert.equal(globalThis.bedrockTestTarget.method(1), 6);
    manager.events.emit('plugin.event', { name: 'test.event', value: null });
    assert.equal(globalThis.bedrockTestTarget.calls, 1);
    await manager.setEnabled('test.first', false);
    assert.equal(globalThis.bedrockTestTarget.method(1), 3);
    manager.events.emit('plugin.event', { name: 'test.event', value: null });
    assert.equal(globalThis.bedrockTestTarget.calls, 1);
    await manager.setEnabled('test.second', false);
    assert.equal(globalThis.bedrockTestTarget.method, original);
    await manager.setEnabled('test.first', true);
    assert.equal(globalThis.bedrockTestTarget.method(1), 4);
    await manager.stopAll();
    assert.equal(globalThis.bedrockTestTarget.method, original);
});

test('startup failures release resources and do not stop other plugins; pending startup can be disabled', async t => {
    const root = fixture(t);
    globalThis.bedrockTestTarget = { method: () => 1 };
    t.after(() => { delete globalThis.bedrockTestTarget; });
    plugin(root, 'test.bad', `export function start(ctx) { ctx.patches.after(globalThis.bedrockTestTarget, 'method', () => 2); throw new Error('bad start'); }`);
    plugin(root, 'test.pending', `export function start(ctx) { ctx.patches.after(globalThis.bedrockTestTarget, 'method', () => 3); return new Promise(() => {}); }`);
    const manager = createPluginManager(root, quiet); manager.scan();
    assert.equal(manager.list().find(item => item.manifest.id === 'test.bad').mainStatus, 'failed');
    assert.equal(globalThis.bedrockTestTarget.method(), 3);
    await manager.setEnabled('test.pending', false);
    assert.equal(globalThis.bedrockTestTarget.method(), 1);
});

test('duplicates, traversal, unsupported runtimes and invalid settings are reported without loading', t => {
    const root = fixture(t);
    fs.writeFileSync(path.join(root, 'outside.js'), '');
    plugin(root, 'test.duplicate', '', {}, 'copy-one');
    plugin(root, 'test.duplicate', '', {}, 'copy-two');
    plugin(root, 'test.escape', '', { entrypoints: { main: { runtime: 'javascript', path: '../../outside.js', requiresApi: '1.0.0' } } });
    plugin(root, 'test.future', '', { entrypoints: { main: { runtime: 'dotnet', path: 'main.js' } } });
    const discovered = discover(root);
    assert.equal(discovered.plugins.size, 0);
    assert.equal(discovered.errors.length, 3);
});

test('rescan discovers additions and explicit nested entry points resolve relative imports', async t => {
    const root = fixture(t);
    const manager = createPluginManager(root, quiet); manager.scan();
    const directory = plugin(root, 'test.nested', '', { entrypoints: { main: { runtime: 'javascript', path: 'main/entry.mjs', requiresApi: '1.0.0' } } });
    fs.mkdirSync(path.join(directory, 'main'));
    fs.writeFileSync(path.join(directory, 'main', 'helper.mjs'), 'export const answer = 123;');
    fs.writeFileSync(path.join(directory, 'main', 'entry.mjs'), `import { answer } from './helper.mjs'; export function start(ctx) { ctx.settings.set('answer', answer); }`);
    manager.scan();
    assert.equal(manager.settings('test.nested').get('answer'), 123);
    assert.throws(() => manager.settings('test.nested').set('bad', undefined));
    assert.throws(() => manager.settings('test.nested').set('__proto__', {}));
    await manager.stopAll();
});

test('incompatible manifests are rejected before executing either entry point', t => {
    const root = fixture(t);
    const marker = path.join(root, 'executed');
    const source = `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'yes');`;
    plugin(root, 'test.newer', source, { entrypoints: { main: { runtime: 'javascript', path: 'main.js', requiresApi: '1.0.1' } } });
    plugin(root, 'test.major', source, { entrypoints: { main: { runtime: 'javascript', path: 'main.js', requiresApi: '2.0.0' } } });
    plugin(root, 'test.short', source, { entrypoints: { main: 'main.js' } });
    plugin(root, 'test.missing', source, { entrypoints: { main: { runtime: 'javascript', path: 'main.js' } } });
    plugin(root, 'test.old', source, { manifestVersion: 1, apiVersion: 1 });
    plugin(root, 'test.toplevel', source, { apiVersion: 1 });
    plugin(root, 'test.renderer', source, { entrypoints: {
        main: { runtime: 'javascript', path: 'main.js', requiresApi: '1.0.0' },
        renderer: { runtime: 'javascript', path: 'main.js', requiresApi: '1.1.0' }
    } });
    const manager = createPluginManager(root, quiet);
    manager.scan();
    assert.equal(manager.errors().length, 7);
    assert.equal(manager.list().length, 0);
    assert.equal(fs.existsSync(marker), false);
});


test('initialization status is visible while pending, clears on success, and ignores stopped contexts', async t => {
    const root = fixture(t);
    plugin(root, 'test.status', `exports.start = ctx => {
        globalThis.bedrockStatusContext = ctx;
        ctx.reportStatus('Preparing resources');
        return new Promise(resolve => { globalThis.bedrockStatusFinish = resolve; });
    };`);
    t.after(() => { delete globalThis.bedrockStatusContext; delete globalThis.bedrockStatusFinish; });
    const manager = createPluginManager(root, quiet);
    manager.scan();
    assert.equal(manager.list()[0].mainStatus, 'starting');
    assert.equal(manager.list()[0].statusMessage, 'Preparing resources');
    globalThis.bedrockStatusFinish();
    await manager.records.get('test.status').startPromise;
    assert.equal(manager.list()[0].mainStatus, 'running');
    assert.equal(manager.list()[0].statusMessage, null);
    await manager.setEnabled('test.status', false);
    globalThis.bedrockStatusContext.reportStatus('Late work');
    assert.equal(manager.list()[0].statusMessage, null);
});
