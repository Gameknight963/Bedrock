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
    writeJson(path.join(directory, 'plugin.json'), { manifestVersion: 3,
        id, name: id, version: '1.0.0', entrypoints: { main: { runtime: 'javascript', path: 'main.js', requiresApi: '1.0.0' } }, ...overrides });
    return directory;
}
const quiet = { log() {} };

test('replacement and reinstall reload main helpers, dynamic imports and module state', async t => {
    const root = fixture(t);
    const source = `import { value } from './helper.js';
        let starts = 0;
        export async function start(ctx) {
            const lazy = await import('./lazy.js');
            ctx.settings.set('loaded', { value, lazy: lazy.value, starts: ++starts, url: import.meta.url });
        }`;
    const folder = plugin(root, 'test.reload', source);
    fs.writeFileSync(path.join(folder, 'helper.js'), 'export const value = 1;');
    fs.writeFileSync(path.join(folder, 'lazy.js'), 'export const value = 1;');
    const manifest = JSON.parse(fs.readFileSync(path.join(folder, 'plugin.json'), 'utf8'));
    const manager = createPluginManager(root, quiet);
    t.after(() => manager.close());
    manager.scan();
    await manager.records.get(manifest.id).startPromise;
    for (let version = 2; version <= 4; version++) {
        if (version === 4) await manager.remove(manifest.id);
        const staged = path.join(root, 'staged');
        fs.mkdirSync(staged);
        writeJson(path.join(staged, 'plugin.json'), { ...manifest, version: `${version}.0.0` });
        fs.writeFileSync(path.join(staged, 'main.js'), source);
        fs.writeFileSync(path.join(staged, 'helper.js'), `export const value = ${version};`);
        fs.writeFileSync(path.join(staged, 'lazy.js'), `export const value = ${version};`);
        await manager.installPackage(staged, manifest.id);
        await manager.records.get(manifest.id).startPromise;
        const result = manager.settings(manifest.id).get('loaded');
        assert.equal(result.value, version);
        assert.equal(result.lazy, version);
        assert.equal(result.starts, 1);
        assert.equal(result.url, require('node:url').pathToFileURL(path.join(folder, 'main.js')).href);
        assert.equal(manager.list()[0].restartReason, null);
    }
    await manager.stopAll();
});

test('unload runs once on removal, after stopping, including an already disabled plugin', async t => {
    const root = fixture(t);
    globalThis.bedrockUnloadEvents = [];
    t.after(() => { delete globalThis.bedrockUnloadEvents; });
    const directory = plugin(root, 'test.unload', `export function start() { globalThis.bedrockUnloadEvents.push('start'); }
        export function stop() { globalThis.bedrockUnloadEvents.push('stop'); }
        export async function unload() { await Promise.resolve(); globalThis.bedrockUnloadEvents.push('unload'); }`);
    const manager = createPluginManager(root, quiet);
    manager.scan();
    await manager.setEnabled('test.unload', false);
    assert.deepEqual(globalThis.bedrockUnloadEvents, ['start', 'stop']);
    await manager.remove('test.unload');
    assert.deepEqual(globalThis.bedrockUnloadEvents, ['start', 'stop', 'unload']);
    assert.equal(fs.existsSync(directory), false);
});

test('restart-required unloading preserves files until startup, without needing the plugin to run again', async t => {
    const root = fixture(t);
    const directory = plugin(root, 'test.restart-unload', `export function start(ctx) { ctx.settings.set('saved', 42); }
        export function unload(ctx) { ctx.requireRestart('Native finalizers remain registered'); }`);
    const manager = createPluginManager(root, quiet);
    manager.scan();
    await manager.remove('test.restart-unload');
    assert.equal(fs.existsSync(directory), true);
    assert.deepEqual(manager.list(), []);
    assert.equal(manager.pendingChanges()[0].reason, 'Native finalizers remain registered');
    await manager.refresh();
    assert.deepEqual(manager.list(), []);
    const reopened = createPluginManager(root, quiet);
    assert.equal(fs.existsSync(directory), false);
    assert.equal(reopened.settings('test.restart-unload').get('saved'), 42);
});

test('failed unloading and failed stopping defer removal; unsafe unload is not called after a stop failure', async t => {
    const root = fixture(t);
    globalThis.bedrockUnsafeUnload = false;
    t.after(() => { delete globalThis.bedrockUnsafeUnload; });
    const first = plugin(root, 'test.unload-failure', `export function start() {} export function unload() { throw new Error('dispose failed'); }`);
    const second = plugin(root, 'test.stop-failure', `export function start() {} export function stop() { throw new Error('work is still running'); }
        export function unload() { globalThis.bedrockUnsafeUnload = true; }`);
    const manager = createPluginManager(root, quiet);
    manager.scan();
    await manager.remove('test.unload-failure');
    await manager.remove('test.stop-failure');
    assert.equal(fs.existsSync(first), true);
    assert.equal(fs.existsSync(second), true);
    assert.equal(globalThis.bedrockUnsafeUnload, false);
    assert.equal(manager.pendingChanges().length, 2);
});

test('renderer unloading can defer package removal and updating', async t => {
    const root = fixture(t);
    const directory = plugin(root, 'test.renderer-unload', `export function start() {}`);
    const calls = [];
    const manager = createPluginManager(root, { ...quiet, unloadRenderer(id) { calls.push(id); return { requiresRestart: true, reason: 'Renderer needs restart' }; } });
    manager.scan();
    const staged = path.join(root, 'staged');
    fs.mkdirSync(staged);
    writeJson(path.join(staged, 'plugin.json'), { ...manager.list()[0].manifest, version: '1.1.0' });
    fs.writeFileSync(path.join(staged, 'main.js'), 'export function start() {}');
    await manager.installPackage(staged, 'test.renderer-unload');
    assert.equal(fs.existsSync(directory), true);
    assert.equal(manager.pendingChanges()[0].action, 'update');
    assert.equal(manager.pendingChanges()[0].reason, 'Renderer needs restart');
    assert.deepEqual(calls, ['test.renderer-unload']);
});

test('removing a plugin stops it, deletes its actual folder and retains settings by default', async t => {
    const root = fixture(t);
    const directory = plugin(root, 'test.uninstall', `export function start(ctx) {
        ctx.settings.set('keep', 42);
        ctx.cleanup(() => globalThis.bedrockUninstallCleaned = true);
    }`, {}, 'different-folder');
    t.after(() => { delete globalThis.bedrockUninstallCleaned; });
    const manager = createPluginManager(root, quiet);
    manager.scan();
    await manager.remove('test.uninstall');
    assert.equal(globalThis.bedrockUninstallCleaned, true);
    assert.equal(fs.existsSync(directory), false);
    assert.deepEqual(manager.list(), []);
    assert.equal(manager.settings('test.uninstall').get('keep'), 42);
    await manager.refresh();
    assert.deepEqual(manager.list(), []);
    await assert.rejects(manager.remove('test.unknown'), /Unknown plugin/);
});

test('removing with settings deletion clears disk and cached values but preserves other plugin data', async t => {
    const root = fixture(t);
    plugin(root, 'test.clear', `export function start(ctx) { ctx.settings.set('saved', true); }`);
    const manager = createPluginManager(root, quiet);
    manager.scan();
    const data = path.join(root, 'data', 'test.clear');
    fs.writeFileSync(path.join(data, 'other.txt'), 'Keep');
    await manager.remove('test.clear', true);
    assert.equal(fs.existsSync(path.join(data, 'settings.json')), false);
    assert.equal(fs.readFileSync(path.join(data, 'other.txt'), 'utf8'), 'Keep');
    assert.deepEqual(manager.settings('test.clear').all(), {});
});

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
    plugin(root, 'test.future', '', { entrypoints: { main: { runtime: 'dotnet-wasm', path: 'main.js' } } });
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
    plugin(root, 'test.newer', source, { entrypoints: { main: { runtime: 'javascript', path: 'main.js', requiresApi: '1.5.2' } } });
    plugin(root, 'test.major', source, { entrypoints: { main: { runtime: 'javascript', path: 'main.js', requiresApi: '2.0.0' } } });
    plugin(root, 'test.short', source, { entrypoints: { main: 'main.js' } });
    plugin(root, 'test.missing', source, { entrypoints: { main: { runtime: 'javascript', path: 'main.js' } } });
    plugin(root, 'test.old', source, { manifestVersion: 2 });
    plugin(root, 'test.toplevel', source, { apiVersion: 1 });
    plugin(root, 'test.renderer', source, { entrypoints: {
        main: { runtime: 'javascript', path: 'main.js', requiresApi: '1.0.0' },
        renderer: { runtime: 'javascript', path: 'main.js', requiresApi: '1.6.0' }
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


test('activation restart requests survive removal and reinstallation until process restart', async t => {
    const root = fixture(t);
    const folder = plugin(root, 'test.restart-session', `export function start(ctx) {
        ctx.cleanup(() => ctx.requireRestart('Restore window options'));
    }`);
    const manager = createPluginManager(root, quiet);
    t.after(() => manager.close());
    manager.scan();
    await manager.remove('test.restart-session');
    assert.deepEqual(manager.restartRequests(), [{id:'test.restart-session',name:'test.restart-session',reason:'Restore window options'}]);
    assert.deepEqual(manager.pendingChanges(), []);
    assert.equal(fs.existsSync(folder), false);
    const staged = plugin(root, 'test.restart-session', 'export function start() {}', {version:'2.0.0'}, 'staged');
    await manager.installPackage(staged, 'test.restart-session');
    assert.equal(manager.restartRequests().length, 1);
    await manager.stopAll();
    manager.close();
    const next = createPluginManager(root, quiet);
    t.after(() => next.close());
    assert.deepEqual(next.restartRequests(), []);
});

test('refresh preserves unload restart requests and prevents loading another copy', async t => {
    const root = fixture(t);
    const folder = plugin(root, 'test.refresh-restart', `export function start() {} export function unload(ctx) {
        ctx.log.info('Final cleanup'); ctx.requireRestart('Native callbacks remain registered');
    }`);
    const manager = createPluginManager(root, quiet);
    t.after(() => manager.close());
    manager.scan();
    fs.rmSync(folder, {recursive:true});
    await manager.refresh();
    assert.equal(manager.restartRequests()[0].reason, 'Native callbacks remain registered');
    const staged = plugin(root, 'test.refresh-restart', 'export function start() {}', {version:'2.0.0'}, 'staged');
    await assert.rejects(manager.installPackage(staged, 'test.refresh-restart'), /Restart Discord/);
});


test('live updates preserve restart requests from the previous version', async t => {
    const root = fixture(t);
    plugin(root, 'test.update-restart', `export function start(ctx) { ctx.requireRestart('Process option changed'); }`);
    const manager = createPluginManager(root, quiet);
    t.after(() => manager.close());
    manager.scan();
    const staged = plugin(root, 'test.update-restart', 'export function start() {}', {version:'2.0.0'}, 'staged');
    await manager.installPackage(staged, 'test.update-restart');
    assert.equal(manager.list()[0].manifest.version, '2.0.0');
    assert.equal(manager.restartRequests()[0].reason, 'Process option changed');
    await manager.stopAll();
});


test('enabling during removal waits until removal finishes without restarting the plugin', async t => {
    const root = fixture(t);
    let enterUnload;
    const entered = new Promise(resolve => { enterUnload = resolve; });
    let finishUnload;
    const gate = new Promise(resolve => { finishUnload = resolve; });
    const events = [];
    plugin(root, 'test.removal-race', `export function start(ctx) { ctx.testEvents.push('start'); }
        export function stop() {}
        export async function unload() { await globalThis.bedrockRemovalGate(); }`);
    globalThis.bedrockRemovalGate = () => { enterUnload(); return gate; };
    t.after(() => { delete globalThis.bedrockRemovalGate; });
    const manager = createPluginManager(root, { ...quiet, context: () => ({ testEvents: events }) });
    t.after(() => manager.close());
    manager.scan();
    const removal = manager.remove('test.removal-race');
    await entered;
    const enabling = manager.setEnabled('test.removal-race', true);
    const rejected = assert.rejects(enabling, /Unknown plugin/);
    finishUnload();
    await removal;
    await rejected;
    assert.deepEqual(events, ['start']);
    assert.equal(manager.list().length, 0);
});


test('recovery mode skips startup and refresh without changing saved enable states', async t => {
    const root = fixture(t);
    plugin(root, 'test.recovery', `export function start(ctx) { ctx.settings.set('ran', true); }`);
    const saved = { plugins: { 'test.recovery': { enabled: true } } };
    writeJson(path.join(root, 'settings.json'), saved);
    const manager = createPluginManager(root, { ...quiet, skipPlugins: true });
    t.after(() => manager.close());
    manager.scan();
    await manager.refresh();
    assert.equal(manager.list()[0].enabled, false);
    assert.equal(manager.records.get('test.recovery').module, undefined);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'settings.json'), 'utf8')), saved);
    await manager.setEnabled('test.recovery', true);
    assert.equal(manager.settings('test.recovery').get('ran'), true);
    await manager.setEnabled('test.recovery', false);
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'settings.json'), 'utf8')).plugins['test.recovery'].enabled, false);
});


test('a later successful activation cannot erase an earlier cleanup failure', async t => {
    const root = fixture(t);
    globalThis.bedrockStopHistory = { calls: 0, unloaded: false };
    t.after(() => { delete globalThis.bedrockStopHistory; });
    const directory = plugin(root, 'test.stop-history', `export function start() {}
        export function stop() { if (++globalThis.bedrockStopHistory.calls === 1) throw new Error('original cleanup failure'); }
        export function unload() { globalThis.bedrockStopHistory.unloaded = true; }`);
    const manager = createPluginManager(root, quiet);
    t.after(() => manager.close());
    manager.scan();
    await manager.setEnabled('test.stop-history', false);
    await manager.setEnabled('test.stop-history', true);
    await manager.remove('test.stop-history');
    assert.equal(globalThis.bedrockStopHistory.unloaded, false);
    assert.equal(fs.existsSync(directory), true);
    assert.match(manager.pendingChanges()[0].reason, /original cleanup failure/);
});
