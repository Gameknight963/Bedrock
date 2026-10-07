const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { app } = require('electron');
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

require('../bootstrap.cjs').install({ root, allowURL: url => url.origin === 'https://bedrock.test' });
globalThis.BedrockMain.scan();
require('electron').protocol.registerSchemesAsPrivileged([{ scheme: 'fixtureextra', privileges: { standard: true, secure: true } }]);
const { BrowserWindow, session } = require('electron');
let window;
const failures = [];
const html = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' 'unsafe-eval'; style-src 'self' 'unsafe-inline'"><style>*{user-select:none}</style></head><body style="background:#313338;padding:16px"><div id="root"></div><script src="/react-unused.js"></script><script src="/remember-unused.js"></script><script src="/react.js"></script><script src="/react-dom.js"></script><script src="/fixture.js"></script></body></html>`;
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
        await waitFor(`globalThis.Bedrock?.plugins.list()[0]?.rendererStatus === 'running' && document.querySelector('[role=switch]')`);
        assert.equal(await evaluate('globalThis.originalPreload'), true, 'existing Discord preload must be preserved');
        assert.deepEqual(await evaluate('globalThis.fixtureLayout'), ['user_section', 'bedrock_section', 'billing_section']);
        assert.equal(await evaluate('globalThis.fixtureMethod()'), 11);
        assert.equal(await evaluate('globalThis.Bedrock.plugins.list()[0].restartReason'), null, 'startup window options should already be applied');
        await new Promise(resolve => setTimeout(resolve, 150));
        fs.writeFileSync(path.join(__dirname, 'obj/settings.png'), (await window.webContents.capturePage()).toPNG());
        assert.equal(await evaluate(`globalThis.Bedrock.webpack.find(value => value?.fixtureLate)?.fixtureLate`), true);
        assert.equal(globalThis.BedrockMain.settings('test.example').get('event'), 'cross-process');
        await evaluate(`globalThis.Bedrock.plugins.setEnabled('test.pending', false)`);
        assert.equal(await evaluate(`globalThis.Bedrock.plugins.list().find(plugin => plugin.manifest.id === 'test.pending').rendererStatus`), 'stopped');
        assert.equal(await evaluate(`globalThis.fixturePendingStopped === true && document.querySelector('[data-bedrock-plugin="test.pending"]') === null`), true);
        await evaluate(`document.querySelector('[role=switch]').click()`);
        await waitFor(`globalThis.Bedrock.plugins.list()[0].rendererStatus === 'stopped'`);
        assert.equal(await evaluate('globalThis.fixtureMethod()'), 1);
        assert.equal(await evaluate(`document.querySelector('[data-bedrock-plugin]') === null`), true);
        assert.equal(await evaluate('globalThis.fixtureStops'), 1);
        await evaluate(`document.querySelector('[role=switch]').click()`);
        await waitFor(`globalThis.Bedrock.plugins.list()[0].rendererStatus === 'running'`);
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
        await evaluate(`document.querySelector('[role=switch]').click()`);
        await waitFor(`globalThis.Bedrock.plugins.list()[0].rendererStatus === 'stopped'`);
        assert.equal(await evaluate(`document.querySelector('.bedrock-readme h1').textContent`), 'Example documentation');
        await evaluate(`document.querySelector('[role=switch]').click()`);
        await waitFor(`globalThis.Bedrock.plugins.list()[0].rendererStatus === 'running'`);
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
