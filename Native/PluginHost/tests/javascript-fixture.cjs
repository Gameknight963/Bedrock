const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createPluginManager } = require('../../../Runtime/plugins.cjs');
const { createJsSession, rendererJsRequest } = require('../../../Runtime/javascript.cjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'Bedrock-js-fixture-'));
const repo = path.resolve(__dirname, '../../..');
const configuration = process.env.BEDROCK_TEST_CONFIGURATION || 'Release';
const logs = [];
let window, manager, pendingPrepared = false;
app.setPath('userData', path.join(root, 'profile'));
const wait = async predicate => {
    for (let i = 0; i < 150; i++) {
        if (logs.some(line => line.level === 'error')) throw new Error(JSON.stringify(logs));
        if (predicate()) return;
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('Timed out: ' + JSON.stringify(logs));
};
app.whenReady().then(async () => {
    window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } });
    await window.loadURL('data:text/html,<title>Fixture</title><p>Native JavaScript interop</p>');
    manager = createPluginManager(root, {
        nativeDirectory: path.join(repo, 'Native/PluginHost/bin/x64', configuration),
        nativeTargets(environment) {
            if (environment === 'main') return [{ pid: process.pid, creationTime: 0 }];
            return app.getAppMetrics().filter(metric => environment === 'gpu' ? metric.type === 'GPU' : metric.pid === window.webContents.getOSProcessId());
        },
        async nativeJavaScript(target, identity, op, message) {
            assert.equal(target.pid, window.webContents.getOSProcessId());
            const result = await window.webContents.executeJavaScript(`(${rendererJsRequest})(${createJsSession},
                ${JSON.stringify(identity)}, ${JSON.stringify(op)}, ${JSON.stringify(message)})`);
            if (op === 'prepare' && message.body.includes('/* pending */')) {
                pendingPrepared = true;
                await new Promise(resolve => setTimeout(resolve, 300));
            }
            return result;
        },
        log(level, id, args) { const text = args.join(' '); logs.push({ level, id, text }); console.log(id + ': ' + text); }
    });
    for (const environment of ['main', 'renderer', 'gpu']) {
        const folder = path.join(root, 'plugins', environment);
        fs.mkdirSync(folder, { recursive: true });
        fs.copyFileSync(path.join(__dirname, 'bin/x64', configuration, 'javascript-fixture.dll'), path.join(folder, 'plugin.dll'));
        fs.writeFileSync(path.join(folder, 'plugin.json'), JSON.stringify({ manifestVersion: 2,
            id: 'test.' + environment, name: environment, version: '1.0.0',
            entrypoints: { [environment]: { runtime: 'native', path: 'plugin.dll' } } }));
    }
    manager.scan();
    await wait(() => ['main', 'renderer', 'gpu'].every(environment => logs.some(line => line.id === 'test.' + environment && line.text === 'JavaScript fixture passed.')));
    manager.settings('test.renderer').set('pending', true);
    await wait(() => pendingPrepared);
    await manager.setEnabled('test.renderer', false);
    assert.equal(logs.filter(line => line.text === 'Pending callback cancelled.').length, 1);
    const cancelledIndex = logs.findIndex(line => line.text === 'Pending callback cancelled.');
    assert(logs.slice(cancelledIndex + 1).some(line => line.id === 'test.renderer' && line.text === 'JavaScript fixture stopped.'));
    await manager.setEnabled('test.renderer', true);
    await wait(() => logs.filter(line => line.id === 'test.renderer' && line.text === 'JavaScript fixture passed.').length === 2);
    await manager.stopAll();
    console.log('PASS: native main, sandboxed renderer, GPU capability checks, values, handles, callbacks, timeout and shutdown.');
    app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
