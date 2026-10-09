const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { writeJson } = require('../storage.cjs');
const { createPluginManager } = require('../plugins.cjs');
const { definePluginSettings, OptionType, bindPluginSettings } = require('../settings.mjs');

test('definitions validate defaults, choices and numeric ranges', () => {
    assert.throws(() => definePluginSettings({ bad: { type: OptionType.BOOLEAN, description: '', default: 1 } }));
    assert.throws(() => definePluginSettings({ bad: { type: OptionType.SELECT, description: '', default: 'missing', options: [{ label: 'One', value: 'one' }] } }));
    assert.throws(() => definePluginSettings({ bad: { type: OptionType.SLIDER, description: '', default: 2, min: 0, max: 4, step: 3 } }));
    assert.throws(() => definePluginSettings(JSON.parse('{"__proto__":{"type":"boolean","description":"","default":true}}')));
});

test('store writes serialize, roll back failures, and stop callbacks and queued work when disposed', async () => {
    const values = {};
    const controller = new AbortController();
    const changed = [];
    const settings = definePluginSettings({ value: { type: OptionType.NUMBER, description: '', default: 0, onChange: value => changed.push(value) } });
    let binding;
    binding = bindPluginSettings(settings, {
        get: (key, fallback) => values[key] ?? fallback,
        async set(key, value) {
            await new Promise(resolve => setImmediate(resolve));
            if (value === 3) throw new Error('Write failed');
            values[key] = value; binding.refresh();
        },
        signal: controller.signal, log() {}
    });
    settings.store.value = 1;
    settings.store.value = 2;
    assert.equal(settings.store.value, 2);
    await settings.flush();
    assert.equal('value' in settings.store, true);
    assert.deepEqual(JSON.parse(JSON.stringify(settings.store)), { value: 2 });
    assert.deepEqual(changed, [1, 2]);
    await assert.rejects(settings.set('value', 3), /Write failed/);
    assert.equal(settings.store.value, 2);
    const late = settings.set('value', 4);
    controller.abort(); binding.dispose();
    await assert.rejects(late, /stopped/);
    assert.equal(values.value, 2);
    values.value = 5; binding.refresh();
    assert.deepEqual(changed, [1, 2]);
});

test('main owns definitions, persistence and validation; callbacks bind again after enabling', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'Bedrock-settings-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const folder = path.join(root, 'plugins', 'settings');
    fs.mkdirSync(folder, { recursive: true });
    writeJson(path.join(folder, 'plugin.json'), { manifestVersion: 2,
        id: 'test.settings', name: 'Settings', version: '1.0.0', entrypoints: { main: { runtime: 'javascript', path: 'main.js', requiresApi: '1.0.0' } } });
    const apiPath = JSON.stringify(path.join(__dirname, '../settings.mjs'));
    fs.writeFileSync(path.join(folder, 'main.js'), `
        const { definePluginSettings, OptionType } = require(${apiPath});
        exports.changes = [];
        exports.settings = definePluginSettings({
            enabled: { type: OptionType.BOOLEAN, description: 'Feature', default: true, restartNeeded: true,
                onChange: value => exports.changes.push(value) },
            name: { type: OptionType.STRING, description: 'Name', default: 'Example', isValid: value => value.length > 0 || 'Name cannot be empty' }
        });
        exports.start = ctx => { exports.current = exports.settings.store.enabled; };
    `);
    const manager = createPluginManager(root, { log() {} }); manager.scan();
    const module = manager.records.get('test.settings').module;
    assert.equal(module.current, true);
    assert.equal(fs.existsSync(path.join(root, 'data/test.settings/settings.json')), false, 'defaults need not be saved');
    assert.equal(manager.list()[0].settingsDefinitions.enabled.restartNeeded, true);
    manager.settings('test.settings').set('enabled', false);
    assert.deepEqual(module.changes, [false]);
    assert.deepEqual(manager.list()[0].restartSettings, ['enabled']);
    assert.throws(() => manager.settings('test.settings').set('enabled', 'false'));
    assert.throws(() => manager.settings('test.settings').set('name', ''), /cannot be empty/);
    assert.equal(manager.settings('test.settings').get('name', 'Example'), 'Example');
    await module.settings.reset('enabled');
    assert.deepEqual(manager.list()[0].restartSettings, []);
    await manager.setEnabled('test.settings', false);
    manager.settings('test.settings').set('enabled', false);
    assert.deepEqual(module.changes, [false, true]);
    await manager.setEnabled('test.settings', true);
    assert.equal(module.current, false);
    await module.settings.set('enabled', true);
    assert.deepEqual(module.changes, [false, true, true]);
    assert.throws(() => manager.registerSettings('test.settings', { enabled: { type: 'boolean', description: 'Different', default: true } }), /disagree/);
    await manager.stopAll();
    const reopened = createPluginManager(root, { log() {} }); reopened.scan();
    assert.equal(reopened.settings('test.settings').get('enabled'), true);
    assert.deepEqual(reopened.list()[0].restartSettings, []);
    await reopened.stopAll();
});
