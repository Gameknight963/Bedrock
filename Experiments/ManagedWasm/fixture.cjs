const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const os = require('node:os');
const experiment = __dirname;
const output = path.join(experiment, 'obj');
const framework = path.join(experiment, 'Host/bin/Release/net10.0/publish/wwwroot');
fs.mkdirSync(output, { recursive: true });
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'Bedrock-wasm-fixture-')));
const requested = new Map();
const contentTypes = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.json': 'application/json', '.dll': 'application/octet-stream' };
const server = http.createServer((request, response) => {
    const relative = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    requested.set(relative, (requested.get(relative) || 0) + 1);
    if (relative === '/') {
        response.setHeader('Content-Type', 'text/html');
        response.end('<p id="output">Waiting for C#</p><script type="module" src="/main.mjs"></script>'); return;
    }
    let file;
    if (relative === '/main.mjs') file = path.join(experiment, 'main.mjs');
    else if (relative === '/plugins/IndependentPlugin.dll') file = path.join(experiment, 'Plugin/bin/Release/net10.0/IndependentPlugin.dll');
    else if (relative === '/plugins/SecondPlugin.dll') file = path.join(output, 'second-plugin/SecondPlugin.dll');
    else if (relative.startsWith('/_framework/')) {
        file = path.resolve(framework, '.' + relative);
        if (!file.startsWith(framework + path.sep)) file = null;
    }
    if (!file || !fs.existsSync(file)) { response.writeHead(404); response.end(); return; }
    response.setHeader('Content-Type', contentTypes[path.extname(file)] || 'application/octet-stream');
    fs.createReadStream(file).pipe(response);
});
app.whenReady().then(async () => {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    window.webContents.on('console-message', event => console.log(event.message));
    await window.loadURL(`http://127.0.0.1:${server.address().port}`);
    for (let attempt = 0; attempt < 600; attempt++) {
        const result = await window.webContents.executeJavaScript('globalThis.fixtureResult');
        if (result) {
            result.nativeRuntimeDownloads = [...requested].filter(([url]) => /\/dotnet\.native\..*\.wasm$/.test(url)).reduce((total, [, count]) => total + count, 0);
            result.pluginDllBytes = fs.statSync(path.join(experiment, 'Plugin/bin/Release/net10.0/IndependentPlugin.dll')).size;
            if (result.passed && result.nativeRuntimeDownloads !== 1) {
                result.passed = false; result.error = 'Expected exactly one native WASM runtime download.';
            }
            fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(result, null, 2));
            console.log(JSON.stringify(result, null, 2));
            server.close(); app.exit(result.passed ? 0 : 1); return;
        }
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('WASM fixture timed out.');
}).catch(error => { console.error(error); server.close(); app.exit(1); });
