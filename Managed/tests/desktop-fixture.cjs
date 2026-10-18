const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const root = path.resolve(__dirname, '../..');
const { createPluginManager } = require(path.join(process.env.BEDROCK_TEST_RUNTIME || path.join(root, 'Launcher/bin/x64/Debug/Runtime'), 'plugins.cjs'));
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'bedrock-desktop-test-'));
const output = path.join(root, 'Examples/dotnet-desktop/bin/Debug/net10.0-windows');
const logs = [];
const manager = createPluginManager(data, { log: (level, id, args) => logs.push(args.join(' ')) });
const keepAlive = setInterval(() => {}, 1000);
const wait = async condition => {
    for (let count = 0; count < 200; count++) {
        if (condition()) return;
        const failed = manager.list().find(plugin => plugin.mainStatus === 'failed');
        if (failed) throw new Error(failed.error);
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('Desktop fixture timed out: ' + JSON.stringify({ plugins: manager.list(), logs }));
};
async function run() {
    const folder = path.join(data, 'plugins/example');
    fs.mkdirSync(folder, { recursive: true });
    fs.cpSync(output, folder, { recursive: true });
    manager.scan();
    await wait(() => manager.list()[0]?.mainStatus === 'running');
    assert(logs.includes('UI thread: STA'));
    assert(logs.includes('Example setting: True'));
    assert.equal(manager.list()[0].settingsDefinitions.example.type, 'boolean');
    manager.settings('example.desktop').set('example', false);
    await wait(() => logs.includes('Setting changed: False'));
    await manager.setEnabled('example.desktop', false);
    assert.equal(logs.filter(line => line === 'Example stopped').length, 1);
    await manager.setEnabled('example.desktop', true);
    await wait(() => manager.list()[0]?.mainStatus === 'running');
    assert(logs.includes('Example setting: False'));
    await manager.remove('example.desktop');
    assert.equal(logs.filter(line => line === 'Example unloaded').length, 2);
    assert.equal(manager.list().length, 0);
    assert.equal(manager.pendingChanges().length, 0);
    assert(!fs.existsSync(folder));
    fs.mkdirSync(folder);
    fs.cpSync(output, folder, { recursive: true });
    await manager.refresh();
    await wait(() => manager.list()[0]?.mainStatus === 'running');
    assert.equal(manager.list()[0].settings.example, false);
    await manager.remove('example.desktop');
    const future = path.join(data, 'plugins/future');
    fs.mkdirSync(future);
    fs.copyFileSync(path.join(root, 'Managed/tests/DesktopFuture/bin/Debug/net10.0-windows/DesktopFuture.dll'), path.join(future, 'DesktopFuture.dll'));
    fs.writeFileSync(path.join(future, 'plugin.json'), JSON.stringify({ manifestVersion: 3, id: 'test.future', name: 'Future', version: '1.0.0', entrypoints: { main: { runtime: 'dotnet', path: 'DesktopFuture.dll' } } }));
    manager.scan();
    for (let count = 0; count < 200 && manager.list()[0]?.mainStatus !== 'failed'; count++) await new Promise(resolve => setTimeout(resolve, 50));
    assert.match(manager.list()[0].error, /requires desktop managed API 1\.0\.1/);
    assert(!manager.list()[0].error.includes('Incompatible plugin code was executed'));
    await manager.remove('test.future');
    console.log('PASS: desktop CLR, settings, events, STA UI, disable/re-enable, unload, reinstall and API rejection');
}
run().then(() => { clearInterval(keepAlive); manager.close(); process.versions.electron && require('electron').app.exit(0); })
    .catch(error => { console.error(error); clearInterval(keepAlive); manager.close(); process.exitCode = 1; process.versions.electron && require('electron').app.exit(1); });
