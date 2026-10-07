const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createPluginManager } = require('../plugins.cjs');

test('transparency applies frameless alpha options when the plugin is enabled and removes its hook', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'Bedrock-transparency-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.cpSync(path.join(__dirname, '../../Plugins/transparency'), path.join(root, 'plugins', 'transparency'), { recursive: true });
    const previousBedrock = global.Bedrock;
    const hooks = new Set();
    const manager = createPluginManager(root, {
        log() {},
        context(_record, own) {
            return { windows: { beforeCreate(callback) {
                hooks.add(callback);
                return own(() => hooks.delete(callback));
            } } };
        }
    });
    global.Bedrock = { definePluginSettings: manager.definePluginSettings, OptionType: manager.OptionType };
    t.after(async () => { await manager.stopAll(); global.Bedrock = previousBedrock; });
    manager.scan();
    assert.equal(hooks.size, 1);
    await manager.setEnabled('bedrock.transparency', false);
    assert.equal(hooks.size, 0);
    await manager.setEnabled('bedrock.transparency', true);
    const options = { frame: true, backgroundColor: '#123456', resizable: true, webPreferences: { sandbox: true } };
    for (const hook of hooks) hook(options);
    assert.deepEqual(options, { frame: false, transparent: true, backgroundColor: '#00000000', resizable: true, webPreferences: { sandbox: true } });
    await manager.setEnabled('bedrock.transparency', false);
    assert.equal(hooks.size, 0);
});
