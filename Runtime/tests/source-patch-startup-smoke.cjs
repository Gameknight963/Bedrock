const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { app, BrowserWindow, session } = require('electron');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'Bedrock-source-startup-'));
app.setPath('userData', path.join(root, 'profile'));
const folder = path.join(root, 'plugins', 'fixture');
fs.mkdirSync(folder, { recursive: true });
fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify({ plugins: { 'test.source-startup': { enabled: true } } }));
fs.writeFileSync(path.join(folder, 'plugin.json'), JSON.stringify({ manifestVersion: 3,
    id: 'test.source-startup', name: 'Startup fixture', version: '1.0.0',
    entrypoints: { renderer: { runtime: 'javascript', path: 'renderer.js', requiresApi: '1.5.0' } } }));
fs.writeFileSync(path.join(folder, 'renderer.js'), `
    export const patches = [{ find: 'startup-marker', replacement: { match: 'ORIGINAL', replace: 'PATCHED' } }];
    export function start() { globalThis.fixtureStarted = true; }
`);
require('../bootstrap.cjs').install({ root, allowURL: url => url.origin === 'https://startup.test' });
const fixture = `
    globalThis.webpackChunkdiscord_app = [];
    const cache = {};
    function require(id) {
        if (cache[id]) return cache[id].exports;
        const module = cache[id] = { id, exports: {} };
        require.m[id](module, module.exports, require);
        return module.exports;
    }
    require.c = cache;
    require.m = {
        subject(module) { const marker = 'startup-marker'; module.exports = 'ORIGINAL'; },
        entry(module, exports, require) { globalThis.fixtureValue = require('subject'); }
    };
    const queued = [];
    require.O = function (result, dependencies, callback) {
        if (dependencies) { queued.push(callback); return result; }
        for (const run of queued.splice(0)) result = run();
        return result;
    };
    require.O.j = () => true;
    const chunks = webpackChunkdiscord_app;
    chunks.push = function (chunk) {
        Object.assign(require.m, chunk[1]);
        if (chunk[2]) chunk[2](require);
        return require.O();
    };
    require.O(undefined, ['vendor'], () => require('entry'));
    globalThis.fixtureSchedulerProperty = require.O.j();
    require.O();
    globalThis.fixtureScheduleAfterStartup = () => {
        require.O(undefined, ['later'], () => 42);
        return require.O();
    };
`;
app.whenReady().then(async () => {
    try {
        const isolated = session.fromPartition('source-startup-fixture');
        await isolated.protocol.handle('https', () => new Response('<!doctype html><script>' + fixture + '</script>', { headers: { 'content-type': 'text/html' } }));
        const window = new BrowserWindow({ show: false, webPreferences: { session: isolated } });
        const evaluate = source => window.webContents.executeJavaScript(source);
        await window.loadURL('https://startup.test');
        for (let index = 0; index < 200; index++) {
            if (await evaluate('globalThis.fixtureStarted && globalThis.fixtureValue')) break;
            await new Promise(resolve => setTimeout(resolve, 20));
        }
        assert.equal(await evaluate('globalThis.fixtureValue'), 'PATCHED');
        assert.equal(await evaluate('globalThis.fixtureSchedulerProperty'), true);
        assert.equal(await evaluate('globalThis.fixtureScheduleAfterStartup()'), 42);
        const plugin = await evaluate('Bedrock.plugins.list().find(plugin => plugin.manifest.id === "test.source-startup")');
        assert.equal(plugin.rendererStatus, 'running');
        assert.equal(plugin.restartReason, null);
        assert.equal(BedrockMain.restartRequests().length, 0);
        console.log('PASS: the initial Webpack startup queue waits for plugin patches, preserves scheduler properties and starts without a restart warning.');
        app.exit(0);
    } catch (error) { console.error(error); app.exit(1); }
});
