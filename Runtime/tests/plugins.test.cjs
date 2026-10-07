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
    writeJson(path.join(directory, 'plugin.json'), { manifestVersion: 1, apiVersion: 1,
        id, name: id, version: '1.0.0', entrypoints: { main: 'main.js' }, ...overrides });
    return directory;
}
const quiet = { log() {} };

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
    plugin(root, 'test.escape', '', { entrypoints: { main: '../../outside.js' } });
    plugin(root, 'test.future', '', { entrypoints: { main: { runtime: 'dotnet', path: 'main.js' } } });
    const discovered = discover(root);
    assert.equal(discovered.plugins.size, 0);
    assert.equal(discovered.errors.length, 3);
});

test('rescan discovers additions and explicit nested entry points resolve relative imports', async t => {
    const root = fixture(t);
    const manager = createPluginManager(root, quiet); manager.scan();
    const directory = plugin(root, 'test.nested', '', { entrypoints: { main: { runtime: 'javascript', path: 'main/entry.mjs' } } });
    fs.mkdirSync(path.join(directory, 'main'));
    fs.writeFileSync(path.join(directory, 'main', 'helper.mjs'), 'export const answer = 123;');
    fs.writeFileSync(path.join(directory, 'main', 'entry.mjs'), `import { answer } from './helper.mjs'; export function start(ctx) { ctx.settings.set('answer', answer); }`);
    manager.scan();
    assert.equal(manager.settings('test.nested').get('answer'), 123);
    assert.throws(() => manager.settings('test.nested').set('bad', undefined));
    assert.throws(() => manager.settings('test.nested').set('__proto__', {}));
    await manager.stopAll();
});
