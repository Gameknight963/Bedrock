const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { app, BrowserWindow, protocol } = require('electron');
let version = 1;
let requests = 0;
const results = [];
let window;
app.whenReady().then(async () => {
    try {
        protocol.handle('https', request => {
            const pathname = new URL(request.url).pathname;
            if (pathname.endsWith('.mjs')) requests++;
            const source = pathname === '/entry.mjs' ? `import { value } from './helper.mjs'; export function read() { return value; }`
                : pathname === '/helper.mjs' ? `export const value = ${version};`
                : '<!doctype html><body>Module cache fixture</body>';
            return new Response(source, { headers: {
                'content-type': pathname.endsWith('.mjs') ? 'text/javascript' : 'text/html',
                'cache-control': 'no-store', 'content-security-policy': "script-src 'self' 'unsafe-eval'"
            } });
        });
        window = new BrowserWindow({ show: false, webPreferences: {
            sandbox: true, contextIsolation: true, preload: path.join(__dirname, 'preload.cjs')
        } });
        await window.loadURL('https://cache.test/');
        const evaluate = source => window.webContents.executeJavaScript(source);
        const read = () => evaluate(`import('/entry.mjs').then(module => module.read())`);
        assert.equal(await read(), 1);
        const initialRequests = requests;
        version = 2;
        await evaluate('globalThis.fixturePageMarker = 123');
        window.webContents.debugger.attach('1.3');
        const cases = [
            ['Cache-Control: no-store', async () => {}],
            ['session.clearCache', () => window.webContents.session.clearCache()],
            ['session.clearCodeCaches', () => window.webContents.session.clearCodeCaches({ urls: ['https://cache.test/entry.mjs', 'https://cache.test/helper.mjs'] })],
            ['webFrame.clearCache', () => evaluate('fixture.clearResourceCache()')],
            ['Network.clearBrowserCache', () => window.webContents.debugger.sendCommand('Network.clearBrowserCache')],
            ['Network.setCacheDisabled', () => window.webContents.debugger.sendCommand('Network.setCacheDisabled', { cacheDisabled: true })]
        ];
        for (const [name, invalidate] of cases) {
            await invalidate();
            const value = await read();
            results.push({ operation: name, value, refetched: requests !== initialRequests });
            assert.equal(value, 1);
            assert.equal(requests, initialRequests);
        }
        window.webContents.debugger.detach();
        const isolated = await window.webContents.executeJavaScriptInIsolatedWorld(1001, [{ code:
            `import('https://cache.test/entry.mjs').then(module => ({value: module.read(), sameDOM: document.body.textContent === 'Module cache fixture'}))`
        }]);
        assert.equal(isolated.value, 2);
        assert.equal(isolated.sameDOM, true);
        assert.equal(await window.webContents.executeJavaScriptInIsolatedWorld(1001, [{ code: 'globalThis.fixturePageMarker' }]), undefined);
        assert.equal(await read(), 1);
        version = 3;
        const sameWorld = await window.webContents.executeJavaScriptInIsolatedWorld(1001, [{ code: `import('https://cache.test/entry.mjs').then(module => module.read())` }]);
        const newWorld = await window.webContents.executeJavaScriptInIsolatedWorld(1002, [{ code: `import('https://cache.test/entry.mjs').then(module => module.read())` }]);
        assert.equal(sameWorld, 2); assert.equal(newWorld, 3);
        results.push({ operation: 'New isolated world', value: newWorld, sameDOM: true, clearsMainWorld: false });
        const processId = window.webContents.getOSProcessId();
        await window.loadURL('https://cache.test/');
        assert.equal(await read(), 3);
        assert.equal(await evaluate('globalThis.fixturePageMarker'), undefined);
        results.push({ operation: 'New document', value: 3, resetsPageGlobals: true,
            sameRendererProcess: window.webContents.getOSProcessId() === processId });
        console.log(JSON.stringify({ electron: process.versions.electron, chromium: process.versions.chrome, results }, null, 2));
        fs.writeFileSync(path.join(__dirname, 'runs/result.json'), JSON.stringify({ passed: true, results }, null, 2));
    } catch (error) {
        console.error(error.stack);
        fs.writeFileSync(path.join(__dirname, 'runs/result.json'), JSON.stringify({ passed: false, error: error.stack }));
        process.exitCode = 1;
    } finally { window?.destroy(); app.quit(); }
});
