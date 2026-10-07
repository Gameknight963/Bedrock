const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { app } = require('electron');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { writeJson } = require('../storage.cjs');
const root = globalThis.BedrockMain?.root || fs.mkdtempSync(path.join(os.tmpdir(), 'Bedrock-electron-'));
const directory = path.join(root, 'plugins', 'example');
fs.mkdirSync(directory, { recursive: true });
writeJson(path.join(directory, 'plugin.json'), {
    manifestVersion: 1, apiVersion: 1, id: 'test.example', name: 'Example plugin', version: '1.0.0',
    description: 'Tests styles, patches, settings and immediate enable/disable.',
    entrypoints: { main: 'main.js', renderer: 'renderer.js' }, readme: 'README.md'
});
writeJson(path.join(directory, 'package.json'), { type: 'module' });
fs.writeFileSync(path.join(directory, 'main.js'), `export function start(ctx) { ctx.windows.beforeCreate(options => { options.width = 580; }); ctx.events.on('hello', event => ctx.settings.set('event', event.value)); }`);
fs.writeFileSync(path.join(directory, 'helper.js'), `export const color = '#00ff00';`);
fs.writeFileSync(path.join(directory, 'renderer.js'), `
    import { color } from './helper.js';
    export async function start(ctx) {
        await ctx.webpack.waitFor(value => value?.fixtureLate);
        globalThis.fixtureStarts = (globalThis.fixtureStarts || 0) + 1;
        ctx.styles.add('body { --fixture-color: ' + color + '; }');
        ctx.patches.after(globalThis, 'fixtureMethod', (_args, result) => result + 10);
        await ctx.settings.set('renderer', 42);
        await ctx.events.emit('hello', 'cross-process');
    }
    export function stop() { globalThis.fixtureStops = (globalThis.fixtureStops || 0) + 1; }
`);
fs.writeFileSync(path.join(directory, 'README.md'), '# Example documentation\n\n**Bold** and `code`.\n\n- First\n- Second\n\n<script>globalThis.badReadme = true</script>\n\n[Bad link](javascript:alert(1))\n');
const pendingDirectory = path.join(root, 'plugins', 'pending');
fs.mkdirSync(pendingDirectory);
writeJson(path.join(pendingDirectory, 'plugin.json'), { manifestVersion: 1, apiVersion: 1,
    id: 'test.pending', name: 'Pending plugin', version: '1.0.0', entrypoints: { renderer: 'renderer.js' } });
fs.writeFileSync(path.join(pendingDirectory, 'renderer.js'), `export async function start(ctx) {
    ctx.styles.add(':root { --pending-plugin: true; }');
    await ctx.webpack.waitFor(value => value?.neverAvailable);
} export function stop() { globalThis.fixturePendingStopped = true; }`);

const selectableDirectory = path.join(root, 'plugins', 'selectable-settings');
fs.cpSync(path.join(__dirname, '../../Plugins/selectable-settings'), selectableDirectory, { recursive: true });

fs.cpSync(path.join(__dirname, '../../Plugins/developer-tools'), path.join(root, 'plugins', 'developer-tools'), { recursive: true });

require('../bootstrap.cjs').install({ root, allowURL: url => url.origin === 'https://bedrock.test' });
globalThis.BedrockMain.scan();
require('electron').protocol.registerSchemesAsPrivileged([{ scheme: 'fixtureextra', privileges: { standard: true, secure: true } }]);
const { BrowserWindow, session } = require('electron');
let window;
const failures = [];
const html = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' 'unsafe-eval'; style-src 'self' 'unsafe-inline'"><style>*{user-select:none}</style></head><body style="background:#313338;padding:16px"><p id="outside-settings">Outside settings</p><div class="standardSidebarView_fixture"><p id="legacy-settings-label">Legacy settings</p></div><div role="dialog"><nav class="breadcrumbsNav_fixture">Settings breadcrumb</nav><div class="contentBody_fixture"><p id="settings-label">Settings description</p><div id="root"></div></div></div><div role="dialog"><nav class="breadcrumbsNav_fixture">Unrelated breadcrumb</nav><p id="other-dialog-label">Other dialog</p></div><script src="/react-unused.js"></script><script src="/remember-unused.js"></script><script src="/react.js"></script><script src="/react-dom.js"></script><script src="/fixture.js"></script></body></html>`;
const fixture = `
    globalThis.fixtureMethod = () => 1;
    globalThis.webpackChunkdiscord_app = [];
    const modules = {};
    function require(id) {
        if (modules[id]) return modules[id].exports;
        const module = modules[id] = { id, exports: {} };
        require.m[id](module, module.exports, require);
        return module.exports;
    }
    require.m = {
        unusedReact: function(module) { module.exports = globalThis.UnusedReact; },
        react: function(module) { module.exports = globalThis.React; },
        types: function(module) { module.exports = { SECTION: 1, SIDEBAR_ITEM: 2, PANEL: 3, CATEGORY: 5, CUSTOM: 19 }; },
        12345(module) { module.exports = builder => builder.buildLayout().map(node => node); }
    };
    require.c = { foreign: { exports: { unrelated: true } } };
    const chunks = globalThis.webpackChunkdiscord_app;
    function push(parent, chunk) {
        Object.assign(require.m, chunk[1]);
        if (chunk[2]) chunk[2](require);
        return parent(chunk);
    }
    chunks.push = push.bind(null, chunks.push.bind(chunks));
    require('unusedReact'); require('react'); require('types');
    const builder = { key: '$Root', buildLayout: () => [{ key: 'user_section' }, { key: 'billing_section' }] };
    const layout = require('12345')(builder);
    const section = layout.find(node => node.key === 'bedrock_section');
    if (!section) throw new Error('Bedrock sidebar section missing');
    const Component = section.buildLayout()[0].buildLayout()[0].buildLayout()[0].buildLayout()[0].Component;
    ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(Component));
    globalThis.fixtureLayout = layout.map(node => node.key);
    chunks.push([['test-late'], { late: function(module) { module.exports = { fixtureLate: true }; } }]);
    require('late');
`;
async function evaluate(script) { return window.webContents.executeJavaScript(script); }
async function waitFor(script) {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
        if (await evaluate(script)) return;
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`Timed out: ${script}\n${failures.join('\n')}`);
}
function bridgeRequest(request) {
    return new Promise((resolve, reject) => {
        const socket = net.connect(`\\\\.\\pipe\\Bedrock-Dev-${process.pid}`);
        socket.setEncoding('utf8');
        socket.setTimeout(5000, () => socket.destroy(new Error('Inspection timeout')));
        socket.on('error', reject);
        let buffer = '';
        socket.on('data', chunk => {
            buffer += chunk;
            if (buffer.includes('\n')) {
                socket.destroy();
                const response = JSON.parse(buffer.split('\n')[0]);
                if (response.error) reject(new Error(response.error)); else resolve(response.result);
            }
        });
        socket.on('connect', () => socket.write(JSON.stringify(request) + '\n'));
    });
}

async function mcpSmoke() {
    const child = spawn('dotnet', [path.join(__dirname, '../../MCP/bin/Debug/net10.0/Bedrock.Mcp.dll')], { windowsHide: true });
    const pending = new Map();
    const errors = [];
    let buffer = '', nextId = 0;
    child.stdout.setEncoding('utf8');
    child.stderr.on('data', chunk => errors.push(chunk.toString()));
    child.on('error', error => { for (const handler of pending.values()) handler.reject(error); });
    child.stdout.on('data', chunk => {
        buffer += chunk;
        while (buffer.includes('\n')) {
            const index = buffer.indexOf('\n');
            const response = JSON.parse(buffer.slice(0, index));
            buffer = buffer.slice(index + 1);
            const handler = pending.get(response.id);
            if (handler) {
                clearTimeout(handler.timer); pending.delete(response.id);
                if (response.error) handler.reject(new Error(JSON.stringify(response.error))); else handler.resolve(response.result);
            }
        }
    });
    const request = (method, params) => new Promise((resolve, reject) => {
        const id = ++nextId;
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`MCP timeout: ${method} ${errors.join('')}`)); }, 10000);
        pending.set(id, { resolve, reject, timer });
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
    try {
        const initialized = await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'Bedrock test', version: '1.0' } });
        assert.equal(initialized.serverInfo.name, 'Bedrock');
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
        const tools = await request('tools/list', {});
        assert.deepEqual(tools.tools.map(tool => tool.name).sort(), ['get_styles', 'inspect_element', 'screenshot', 'status']);
        const status = await request('tools/call', { name: 'status', arguments: {} });
        assert.equal(JSON.parse(status.content[0].text).instances.some(instance => instance.processId === process.pid), true);
        const inspected = await request('tools/call', { name: 'inspect_element', arguments: { selector: '#settings-label', processId: process.pid, windowId: window.id } });
        assert.equal(JSON.parse(inspected.content[0].text).elements[0].id, 'settings-label');
        const styles = await request('tools/call', { name: 'get_styles', arguments: { selector: '#settings-label', processId: process.pid, windowId: window.id, properties: ['user-select'] } });
        assert.equal(JSON.parse(styles.content[0].text).elements[0].ancestors[0].computed['user-select'], 'text');
        const image = await request('tools/call', { name: 'screenshot', arguments: { processId: process.pid, windowId: window.id } });
        assert.equal(image.content[0].type, 'image');
        assert.equal(image.content[0].mimeType, 'image/png');
        assert.equal(Buffer.from(image.content[0].data, 'base64').subarray(1, 4).toString(), 'PNG');
        const bad = await request('tools/call', { name: 'inspect_element', arguments: { selector: '[', processId: process.pid, windowId: window.id } });
        assert.equal(bad.isError, true);
        const exited = new Promise(resolve => child.once('exit', resolve));
        child.stdin.end();
        const timeout = setTimeout(() => child.kill(), 5000);
        try { assert.equal(await exited, 0); } finally { clearTimeout(timeout); }
        console.log('PASS: C# MCP to named pipe to real Electron DOM, CSS, screenshots and error responses.');
    } finally {
        for (const handler of pending.values()) clearTimeout(handler.timer);
        if (child.exitCode === null) child.kill();
    }
}

app.whenReady().then(async () => {
    try {
        session.defaultSession.protocol.handle('https', request => {
            const url = new URL(request.url);
            let body; let type;
            if (['/react.js', '/react-unused.js'].includes(url.pathname)) { body = fs.readFileSync(path.join(__dirname, 'obj/node_modules/react/umd/react.development.js')); type = 'text/javascript'; }
            else if (url.pathname === '/remember-unused.js') { body = 'globalThis.UnusedReact = globalThis.React;'; type = 'text/javascript'; }
            else if (url.pathname === '/react-dom.js') { body = fs.readFileSync(path.join(__dirname, 'obj/node_modules/react-dom/umd/react-dom.development.js')); type = 'text/javascript'; }
            else if (url.pathname === '/fixture.js') { body = fixture; type = 'text/javascript'; }
            else { body = html; type = 'text/html'; }
            return new Response(body, { headers: { 'Content-Type': type } });
        });
        const originalPreload = path.join(root, 'original.cjs');
        fs.writeFileSync(originalPreload, `require('electron').contextBridge.exposeInMainWorld('originalPreload', true);`);
        window = new BrowserWindow({ show: false, webPreferences: { preload: originalPreload, sandbox: true, contextIsolation: true } });
        window.webContents.on('console-message', (_, ...args) => { failures.push(args.map(value => typeof value === 'object' ? JSON.stringify(value) : String(value)).join(' ')); });
        window.webContents.on('preload-error', (_, file, error) => failures.push(`${file}: ${error.stack}`));
        assert.equal(window.getSize()[0], 580, 'main plugin must intercept window creation options');
        await window.loadURL('https://bedrock.test/');
        await waitFor(`globalThis.Bedrock?.plugins.list().find(plugin => plugin.manifest.id === 'test.example')?.rendererStatus === 'running' && document.querySelector('[role=switch][aria-label="Enable Example plugin"]')`);
        assert.equal(await evaluate('globalThis.originalPreload'), true, 'existing Discord preload must be preserved');
        await waitFor(`globalThis.Bedrock.plugins.list().find(plugin => plugin.manifest.id === 'bedrock.selectable-settings')?.rendererStatus === 'running'`);
        assert.equal(await evaluate(`getComputedStyle(document.querySelector('#settings-label')).userSelect`), 'text');
        assert.equal(await evaluate(`getComputedStyle(document.querySelector('#outside-settings')).userSelect`), 'none');
        assert.equal(await evaluate(`getComputedStyle(document.querySelector('#legacy-settings-label')).userSelect`), 'text');
        assert.equal(await evaluate(`getComputedStyle(document.querySelector('#other-dialog-label')).userSelect`), 'none');
        await evaluate(`globalThis.Bedrock.plugins.setEnabled('bedrock.selectable-settings', false)`);
        assert.equal(await evaluate(`getComputedStyle(document.querySelector('#settings-label')).userSelect`), 'none');
        assert.equal(await evaluate(`getComputedStyle(document.querySelector('#legacy-settings-label')).userSelect`), 'none');
        await evaluate(`globalThis.Bedrock.plugins.setEnabled('bedrock.selectable-settings', true)`);
        assert.equal(await evaluate(`getComputedStyle(document.querySelector('#settings-label')).userSelect`), 'text');

        assert.deepEqual(await evaluate('globalThis.fixtureLayout'), ['user_section', 'bedrock_section', 'billing_section']);
        assert.equal(await evaluate('globalThis.fixtureMethod()'), 11);
        assert.equal(await evaluate(`globalThis.Bedrock.plugins.list().find(plugin => plugin.manifest.id === 'test.example').restartReason`), null, 'startup window options should already be applied');
        await new Promise(resolve => setTimeout(resolve, 150));
        fs.writeFileSync(path.join(__dirname, 'obj/settings.png'), (await window.webContents.capturePage()).toPNG());
        assert.equal(await evaluate(`globalThis.Bedrock.webpack.find(value => value?.fixtureLate)?.fixtureLate`), true);
        assert.equal(globalThis.BedrockMain.settings('test.example').get('event'), 'cross-process');
        await waitFor(`globalThis.Bedrock.plugins.list().find(plugin => plugin.manifest.id === 'bedrock.developer-tools')?.rendererStatus === 'running'`);
        const inspected = await bridgeRequest({ operation: 'inspect', selector: '#settings-label', windowId: window.id });
        assert.equal(inspected.elements[0].text, 'Settings description');
        assert.equal(inspected.elements[0].ancestors.some(node => node.classes.includes('contentBody_fixture')), true);
        const selection = await bridgeRequest({ operation: 'styles', selector: '#settings-label', windowId: window.id, properties: ['user-select'] });
        assert.equal(selection.elements[0].ancestors[0].computed['user-select'], 'text');
        assert.equal(selection.elements[0].ancestors[0].matchingRules.some(rule => rule.declarations['user-select']?.value === 'text'), true);
        await assert.rejects(bridgeRequest({ operation: 'inspect', selector: '[', windowId: window.id }));
        if (process.argv.includes('--bedrock-mcp-smoke')) await mcpSmoke();
        await globalThis.BedrockMain.setEnabled('bedrock.developer-tools', false);
        await waitFor(`globalThis.BedrockInspector === undefined`);
        await assert.rejects(bridgeRequest({ operation: 'status' }));
        await globalThis.BedrockMain.setEnabled('bedrock.developer-tools', true);
        await waitFor(`globalThis.BedrockInspector !== undefined`);
        assert.equal((await bridgeRequest({ operation: 'status' })).processId, process.pid);
        await evaluate(`globalThis.Bedrock.plugins.setEnabled('test.pending', false)`);
        assert.equal(await evaluate(`globalThis.Bedrock.plugins.list().find(plugin => plugin.manifest.id === 'test.pending').rendererStatus`), 'stopped');
        assert.equal(await evaluate(`globalThis.fixturePendingStopped === true && document.querySelector('[data-bedrock-plugin="test.pending"]') === null`), true);
        await evaluate(`document.querySelector('[role=switch][aria-label="Enable Example plugin"]').click()`);
        await waitFor(`globalThis.Bedrock.plugins.list().find(plugin => plugin.manifest.id === 'test.example').rendererStatus === 'stopped'`);
        assert.equal(await evaluate('globalThis.fixtureMethod()'), 1);
        assert.equal(await evaluate(`document.querySelector('[data-bedrock-plugin="test.example"]') === null`), true);
        assert.equal(await evaluate('globalThis.fixtureStops'), 1);
        await evaluate(`document.querySelector('[role=switch][aria-label="Enable Example plugin"]').click()`);
        await waitFor(`globalThis.Bedrock.plugins.list().find(plugin => plugin.manifest.id === 'test.example').rendererStatus === 'running'`);
        assert.equal(await evaluate('globalThis.fixtureStarts'), 2);
        assert.equal(await evaluate('globalThis.fixtureMethod()'), 11);
        await evaluate(`(() => {
            const input = document.querySelector('input[type=search]');
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'Example');
            input.dispatchEvent(new Event('input', { bubbles: true }));
        })()`);
        await waitFor(`document.querySelectorAll('.bedrock-card').length === 1`);
        await evaluate(`(() => {
            const container = document.querySelector('.bedrock-page').parentElement;
            container.style.height = '160px'; container.style.overflowY = 'auto';
            container.scrollTop = 60;
            globalThis.savedPluginScroll = container.scrollTop;
        })()`);
        assert.equal(await evaluate('globalThis.savedPluginScroll > 0'), true);
        await evaluate(`[...document.querySelectorAll('button')].find(button => button.textContent === 'Open').click()`);
        await waitFor(`document.querySelector('.bedrock-readme strong')`);
        assert.equal(await evaluate(`document.querySelector('.bedrock-readme h1').textContent`), 'Example documentation');
        assert.equal(await evaluate(`getComputedStyle(document.querySelector('.bedrock-readme strong')).userSelect`), 'text');
        assert.equal(await evaluate(`globalThis.badReadme === undefined && document.querySelector('.bedrock-readme a[href^="javascript:"]') === null`), true);
        assert.equal(await evaluate(`document.querySelector('.bedrock-grid') === null && document.querySelector('[role=tab][aria-selected=true]').textContent === 'Details'`), true);
        await evaluate(`document.querySelector('[role=switch][aria-label="Enable Example plugin"]').click()`);
        await waitFor(`globalThis.Bedrock.plugins.list().find(plugin => plugin.manifest.id === 'test.example').rendererStatus === 'stopped'`);
        assert.equal(await evaluate(`document.querySelector('.bedrock-readme h1').textContent`), 'Example documentation');
        await evaluate(`document.querySelector('[role=switch][aria-label="Enable Example plugin"]').click()`);
        await waitFor(`globalThis.Bedrock.plugins.list().find(plugin => plugin.manifest.id === 'test.example').rendererStatus === 'running'`);
        await new Promise(resolve => setTimeout(resolve, 150));
        fs.writeFileSync(path.join(__dirname, 'obj/plugin-details.png'), (await window.webContents.capturePage()).toPNG());
        await evaluate(`[...document.querySelectorAll('button')].find(button => button.textContent === '\\u2190 Back to plugins').click()`);
        await waitFor(`document.querySelector('input[type=search]')`);
        assert.equal(await evaluate(`document.querySelector('input[type=search]').value`), 'Example');
        assert.equal(await evaluate(`document.querySelectorAll('.bedrock-card').length`), 1);
        assert.equal(await evaluate(`document.querySelector('.bedrock-page').parentElement.scrollTop`), await evaluate('globalThis.savedPluginScroll'));
        window.setSize(900, 700);
        await waitFor(`getComputedStyle(document.querySelector('.bedrock-grid')).gridTemplateColumns.split(' ').length === 2`);
        window.setSize(580, 600);
        await waitFor(`getComputedStyle(document.querySelector('.bedrock-grid')).gridTemplateColumns.split(' ').length === 1`);

        assert.equal(await evaluate(`(async () => (await fetch('bedrock://plugins/test.example/../outside')).status)()`), 404);
        await window.loadURL('https://unrelated.test/');
        assert.equal(await evaluate(`globalThis.Bedrock === undefined && globalThis.BedrockNative === undefined`), true, 'bridge must not appear on unrelated origins');
        console.log('PASS: Real Electron preload, existing preload, early window hook, settings layout, React UI switches, live cleanup/re-enable, relative ESM imports, IPC settings/events, safe Markdown and origin checks.');
        await globalThis.BedrockMain.stopAll();
        window.destroy();
        fs.rmSync(root, { recursive: true, force: true });
        app.exit(0);
    } catch (error) {
        console.error(error.stack, failures.join('\n'));
        window?.destroy();
        fs.rmSync(root, { recursive: true, force: true });
        app.exit(1);
    }
});
