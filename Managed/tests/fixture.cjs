const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const electron = require('electron');
const root = path.resolve(__dirname, '../..');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'bedrock-managed-test-'));
const runtime = path.join(work, 'Runtime');
const data = path.join(work, 'BedrockData');
fs.cpSync(process.env.BEDROCK_TEST_RUNTIME || path.join(root, 'Runtime'), runtime, { recursive: true, filter: file => !file.includes(`${path.sep}tests`) && !file.includes(`${path.sep}obj`) });
if (!fs.existsSync(path.join(runtime, 'dotnet/_framework')))
    fs.cpSync(path.join(root, 'Managed/Host/bin/Release/net10.0/publish/wwwroot'), path.join(runtime, 'dotnet'), { recursive: true });
fs.cpSync(path.join(root, 'Examples/dotnet/bin/Release/net10.0'), path.join(data, 'plugins/example'), { recursive: true });
fs.cpSync(path.join(root, 'Examples/dotnet/bin/Release/net10.0'), path.join(data, 'plugins/second'), { recursive: true });
const secondManifest = path.join(data, 'plugins/second/plugin.json');
const second = JSON.parse(fs.readFileSync(secondManifest));
second.id = 'bedrock.managed-second';
fs.writeFileSync(secondManifest, JSON.stringify(second));
const incompatibleFolder = path.join(data, 'plugins/incompatible');
fs.mkdirSync(incompatibleFolder);
fs.copyFileSync(path.join(root, 'Managed/tests/Incompatible/bin/Release/net10.0/Incompatible.dll'), path.join(incompatibleFolder, 'Incompatible.dll'));
fs.writeFileSync(path.join(incompatibleFolder, 'plugin.json'), JSON.stringify({ manifestVersion: 2,
    id: 'bedrock.incompatible', name: 'Incompatible', version: '1.0.0', entrypoints: { renderer: { runtime: 'dotnet', path: 'Incompatible.dll' } } }));
let runtimeDownloads = 0;
const readFile = fs.readFileSync;
fs.readFileSync = function (file, ...args) {
    if (typeof file === 'string' && /dotnet\.native\..*\.wasm$/.test(file)) runtimeDownloads++;
    return readFile.call(this, file, ...args);
};
electron.app.setPath('userData', path.join(work, 'profile'));
require(path.join(runtime, 'bootstrap.cjs')).install({ root: data, allowURL: url => url.hostname === '127.0.0.1' });
const server = http.createServer((request, response) => { response.setHeader('Content-Type', 'text/html'); response.end('<html><body><article class="bedrock-card">Example</article></body></html>'); });
const pause = () => new Promise(resolve => setTimeout(resolve, 50));
async function wait(window, condition) {
    for (let count = 0; count < 600; count++) {
        const result = await window.webContents.executeJavaScript(`(() => { ${condition} })()`);
        if (result === true) return;
        if (typeof result === 'string') throw new Error(result);
        await pause();
    }
    throw new Error('Managed test timed out');
}
electron.app.whenReady().then(async () => {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const { BrowserWindow } = require('electron');
    const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    window.webContents.on('console-message', event => console.log(event.message));
    await window.loadURL(`http://127.0.0.1:${server.address().port}`);
    const running = `const plugin = globalThis.Bedrock?.plugins.list().find(plugin => plugin.manifest.id === 'bedrock.managed-example'); if (plugin?.rendererStatus === 'failed') return plugin.error; return plugin?.rendererStatus === 'running';`;
    await wait(window, running);
    const product = await window.webContents.executeJavaScript(`(async () => { const api = await import('bedrock://api/dotnet.mjs'); const exports = await api.getPluginExports('bedrock.managed-example'); return exports.ExamplePlugin.Multiply(6, 7); })()`);
    if (product !== 42) throw new Error('Managed JSExport returned the wrong result');
    await wait(window, `const plugin = Bedrock.plugins.list().find(plugin => plugin.manifest.id === 'bedrock.managed-second'); if (plugin?.rendererStatus === 'failed') return plugin.error; return plugin?.rendererStatus === 'running';`);
    await wait(window, `const plugin = Bedrock.plugins.list().find(plugin => plugin.manifest.id === 'bedrock.incompatible'); return plugin?.rendererStatus === 'failed' && plugin.error.includes('1.0.1');`);
    await window.webContents.executeJavaScript(`Bedrock.plugins.setEnabled('bedrock.managed-second', false)`);
    await wait(window, `return getComputedStyle(document.querySelector('.bedrock-card')).borderTopColor === 'rgb(88, 101, 242)';`);
    await window.webContents.executeJavaScript(`BedrockNative.request('settingsSet', 'bedrock.managed-example', 'accent', false)`);
    await wait(window, `return getComputedStyle(document.querySelector('.bedrock-card')).borderTopColor !== 'rgb(88, 101, 242)';`);
    await window.webContents.executeJavaScript(`Bedrock.plugins.setEnabled('bedrock.managed-example', false)`);
    await wait(window, `return document.querySelectorAll('style[data-bedrock-plugin]').length === 0;`);
    await window.webContents.executeJavaScript(`Bedrock.plugins.setEnabled('bedrock.managed-example', true)`);
    await wait(window, running);
    await window.webContents.executeJavaScript(`BedrockNative.request('settingsSet', 'bedrock.managed-example', 'accent', true)`);
    await wait(window, `return getComputedStyle(document.querySelector('.bedrock-card')).borderTopColor === 'rgb(88, 101, 242)';`);
    if (runtimeDownloads !== 1) throw new Error(`Expected one shared runtime download, got ${runtimeDownloads}`);
    console.log('PASS: shared runtime, API rejection, managed loader, JS interop, settings, cleanup and re-enable');
    server.close(); electron.app.exit(0);
}).catch(error => { console.error(error); server.close(); electron.app.exit(1); });
