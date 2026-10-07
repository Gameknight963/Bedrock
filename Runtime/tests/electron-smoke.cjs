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
fs.writeFileSync(path.join(directory, 'main.js'), `
    const { definePluginSettings, OptionType } = Bedrock;
    export const settings = definePluginSettings({
        feature: { type: OptionType.BOOLEAN, label: 'Test feature', description: 'Apply immediately.', default: true,
            onChange: value => { globalThis.fixtureMainFeature = value; } },
        title: { type: OptionType.STRING, label: 'Main setting', description: 'Declared by the main entry point.', default: 'Example',
            isValid: value => value.length > 0 || 'Title cannot be empty.' }
    });
    export function start(ctx) { ctx.windows.beforeCreate(options => { options.width = 580; }); ctx.events.on('hello', event => ctx.settings.set('event', event.value)); }
`);
fs.writeFileSync(path.join(directory, 'helper.js'), `export const color = '#00ff00';`);
fs.writeFileSync(path.join(directory, 'renderer.js'), `
    import { color } from './helper.js';
    const { definePluginSettings, OptionType } = Bedrock;
    export const settings = definePluginSettings({
        feature: { type: OptionType.BOOLEAN, label: 'Test feature', description: 'Apply immediately.', default: true,
            onChange: value => { globalThis.fixtureRendererFeature = value; } },
        message: { type: OptionType.STRING, label: 'Message', description: 'Enter a message.', default: 'Hello', section: 'Content',
            isValid: value => value.trim().length > 0 || 'Message cannot be empty.' },
        count: { type: OptionType.NUMBER, label: 'Count', description: 'Choose a count.', default: 2, min: 0, max: 10, step: 1 },
        mode: { type: OptionType.SELECT, label: 'Mode', description: 'Choose a mode.', default: false,
            options: [{ label: 'Off', value: false }, { label: 'On', value: true }] },
        volume: { type: OptionType.SLIDER, label: 'Volume', description: 'Change after restarting.', default: 50, min: 0, max: 100, step: 5, restartNeeded: true }
    });
    export async function start(ctx) {
        globalThis.fixtureSettings = settings;
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

fs.cpSync(path.join(__dirname, '../../Examples/example'), path.join(root, 'plugins', 'shipped-example'), { recursive: true });

require('../bootstrap.cjs').install({ root, allowURL: url => url.origin === 'https://bedrock.test', restart: () => { globalThis.fixtureRestartRequested = true; return true; } });
globalThis.BedrockMain.scan();
const themesDirectory = globalThis.BedrockMain.themes.directory;
fs.mkdirSync(path.join(themesDirectory, 'assets'));
fs.writeFileSync(path.join(themesDirectory, 'assets', 'import.css'), ':root { --theme-import: imported; }');
fs.writeFileSync(path.join(themesDirectory, 'live.theme.css'), '/**\n * @name Live theme\n * @website https://example.com/theme\n */\n@import "./assets/import.css"; :root { --live-theme: red; }');
globalThis.BedrockMain.themes.scan();
require('electron').protocol.registerSchemesAsPrivileged([{ scheme: 'fixtureextra', privileges: { standard: true, secure: true } }]);
const { BrowserWindow, session } = require('electron');
let window;
let mirror;
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
    const ThemesComponent = section.buildLayout()[1].buildLayout()[0].buildLayout()[0].buildLayout()[0].Component;
    globalThis.fixtureRoot = ReactDOM.createRoot(document.getElementById('root'));
    fixtureRoot.render(React.createElement(Component));
    globalThis.fixtureShowThemes = () => fixtureRoot.render(React.createElement(ThemesComponent));
    globalThis.fixtureShowPlugins = () => fixtureRoot.render(React.createElement(Component));
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
        await waitFor(`globalThis.Bedrock?.plugins.list().find(plugin => plugin.manifest.id === 'test.example')?.rendererStatus === 'running' && document.querySelector('[role=switch][aria-label="Enable Example plugin"]')`);
        assert.equal(await evaluate('globalThis.originalPreload'), true, 'existing Discord preload must be preserved');
        await waitFor(`Bedrock.plugins.list().find(plugin => plugin.manifest.id === 'bedrock.example')?.rendererStatus === 'running'`);
        assert.deepEqual(await evaluate(`Object.keys(Bedrock.plugins.list().find(plugin => plugin.manifest.id === 'bedrock.example').settingsDefinitions)`), ['accent', 'color']);
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
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'Example plugin');
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
        await evaluate(`document.querySelector('#bedrock-settings-tab').click()`);
        await waitFor(`document.querySelectorAll('.bedrock-setting').length === 6`);
        assert.equal(await evaluate(`getComputedStyle(document.querySelector('#bedrock-settings-panel')).paddingLeft`), '0px');
        assert.equal(await evaluate(`getComputedStyle(document.querySelector('#bedrock-details-tab')).paddingLeft`), '0px');
        assert.equal(await evaluate(`getComputedStyle(document.querySelector('[aria-label="Reset Test feature"]')).cursor`), 'default');
        assert.equal(await evaluate(`document.querySelector('#bedrock-setting-title').value`), 'Example', 'main definitions render in the same settings page');
        assert.equal(await evaluate(`document.querySelector('#bedrock-setting-count').value`), '2');
        assert.equal(await evaluate(`document.querySelector('#bedrock-setting-volume').type`), 'range');
        await evaluate(`document.querySelector('#bedrock-setting-feature').click()`);
        await waitFor(`globalThis.fixtureRendererFeature === false && document.querySelector('#bedrock-setting-feature').getAttribute('aria-checked') === 'false'`);
        assert.equal(globalThis.fixtureMainFeature, false, 'one owner notifies main and renderer callbacks');
        assert.equal(globalThis.BedrockMain.settings('test.example').get('feature'), false);
        await evaluate(`(() => {
            const element = document.createElement('div'); element.id = 'settings-hook-test'; document.body.append(element);
            const Component = () => React.createElement('span', { id: 'settings-hook-value' }, String(fixtureSettings.use(['feature']).feature));
            globalThis.settingsHookRoot = ReactDOM.createRoot(element);
            settingsHookRoot.render(React.createElement(Component));
        })()`);
        await waitFor(`document.querySelector('#settings-hook-value')?.textContent === 'false'`);
        mirror = new BrowserWindow({ show: false });
        await mirror.loadURL('https://bedrock.test/');
        globalThis.BedrockMain.records.get('test.example').module.settings.store.feature = true;
        await globalThis.BedrockMain.records.get('test.example').module.settings.flush();
        await waitFor(`globalThis.fixtureRendererFeature === true && document.querySelector('#settings-hook-value').textContent === 'true'`);
        const mirrorDeadline = Date.now() + 10000;
        while (!await mirror.webContents.executeJavaScript(`globalThis.fixtureSettings?.store.feature === true`)) {
            if (Date.now() > mirrorDeadline) throw new Error('Second window did not synchronize settings');
            await new Promise(resolve => setTimeout(resolve, 50));
        }
        await mirror.webContents.executeJavaScript(`globalThis.fixtureSettings.set('feature', false)`);
        await waitFor(`globalThis.fixtureRendererFeature === false && document.querySelector('#settings-hook-value').textContent === 'false'`);
        assert.equal(globalThis.fixtureMainFeature, false);
        await evaluate(`settingsHookRoot.unmount(); document.querySelector('#settings-hook-test').remove()`);
        mirror.destroy(); mirror = null;
        await evaluate(`(() => {
            const input = document.querySelector('#bedrock-setting-message');
            input.focus(); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '');
            input.dispatchEvent(new Event('input', { bubbles: true }));
        })()`);
        await evaluate(`document.querySelector('#bedrock-setting-message').dispatchEvent(new FocusEvent('focusout', { bubbles: true }))`);
        await waitFor(`document.querySelector('#bedrock-setting-message-error')?.textContent === 'Message cannot be empty.'`);
        assert.equal(globalThis.BedrockMain.settings('test.example').get('message', 'Hello'), 'Hello');
        await evaluate(`(() => {
            const input = document.querySelector('#bedrock-setting-message');
            input.focus(); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'Updated');
            input.dispatchEvent(new Event('input', { bubbles: true }));
        })()`);
        await evaluate(`document.querySelector('#bedrock-setting-message').dispatchEvent(new FocusEvent('focusout', { bubbles: true }))`);
        await waitFor(`globalThis.fixtureSettings.store.message === 'Updated'`);
        await evaluate(`(() => {
            const input = document.querySelector('#bedrock-setting-mode');
            input.value = '1'; input.dispatchEvent(new Event('change', { bubbles: true }));
        })()`);
        await waitFor(`globalThis.fixtureSettings.store.mode === true`);
        await evaluate(`(() => {
            const input = document.querySelector('#bedrock-setting-count');
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '4');
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
        })()`);
        await waitFor(`globalThis.fixtureSettings.store.count === 4`);
        await evaluate(`(() => {
            const input = document.querySelector('#bedrock-setting-volume');
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '65');
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
        })()`);
        await waitFor(`globalThis.fixtureSettings.store.volume === 65`);
        await evaluate(`globalThis.fixtureSettings.store.volume = 75; globalThis.fixtureSettings.flush()`);
        await waitFor(`document.querySelector('.bedrock-restart-banner button')`);
        assert.equal(globalThis.BedrockMain.settings('test.example').get('volume'), 75);
        await evaluate(`document.querySelector('.bedrock-restart-banner button').click()`);
        assert.equal(globalThis.fixtureRestartRequested, true);
        await evaluate(`globalThis.fixtureSettings.reset('volume')`);
        await waitFor(`globalThis.Bedrock.plugins.list().find(plugin => plugin.manifest.id === 'test.example').restartSettings.length === 0`);
        await assert.rejects(evaluate(`globalThis.BedrockNative.request('settingsSet', 'test.example', 'count', 20)`));
        await assert.rejects(evaluate(`globalThis.BedrockNative.request('settingsSet', 'test.example', 'title', '')`));
        assert.equal(globalThis.BedrockMain.settings('test.example').get('count', 2), 4);
        assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'data/test.example/settings.json'), 'utf8')).message, 'Updated');
        await evaluate(`document.querySelector('#bedrock-details-tab').click()`);
        await waitFor(`document.querySelector('.bedrock-readme h1')`);
        await evaluate(`document.querySelector('[role=switch][aria-label="Enable Example plugin"]').click()`);
        await waitFor(`globalThis.Bedrock.plugins.list().find(plugin => plugin.manifest.id === 'test.example').rendererStatus === 'stopped'`);
        assert.equal(await evaluate(`document.querySelector('.bedrock-readme h1').textContent`), 'Example documentation');
        await evaluate(`document.querySelector('[role=switch][aria-label="Enable Example plugin"]').click()`);
        await waitFor(`globalThis.Bedrock.plugins.list().find(plugin => plugin.manifest.id === 'test.example').rendererStatus === 'running'`);
        await new Promise(resolve => setTimeout(resolve, 150));
        fs.writeFileSync(path.join(__dirname, 'obj/plugin-details.png'), (await window.webContents.capturePage()).toPNG());
        await evaluate(`[...document.querySelectorAll('button')].find(button => button.textContent === '\\u2190 Back to plugins').click()`);
        await waitFor(`document.querySelector('input[type=search]')`);
        assert.equal(await evaluate(`document.querySelector('input[type=search]').value`), 'Example plugin');
        assert.equal(await evaluate(`document.querySelectorAll('.bedrock-card').length`), 1);
        assert.equal(await evaluate(`document.querySelector('.bedrock-page').parentElement.scrollTop`), await evaluate('globalThis.savedPluginScroll'));
        window.setSize(900, 700);
        await waitFor(`getComputedStyle(document.querySelector('.bedrock-grid')).gridTemplateColumns.split(' ').length === 2`);
        assert.equal(await evaluate(`(() => {
            const grid = document.querySelector('.bedrock-grid');
            const card = grid.querySelector('.bedrock-card');
            return Math.abs(card.getBoundingClientRect().width * 2 + 14 - grid.getBoundingClientRect().width) < 1;
        })()`), true, 'a single card keeps the width of one column');
        window.setSize(580, 600);
        await waitFor(`getComputedStyle(document.querySelector('.bedrock-grid')).gridTemplateColumns.split(' ').length === 1`);

        assert.equal(await evaluate(`(async () => (await fetch('bedrock://plugins/test.example/../outside')).status)()`), 404);
        fs.rmSync(directory, { recursive: true });
        await evaluate(`Bedrock.plugins.rescan()`);
        await waitFor(`!Bedrock.plugins.list().some(plugin => plugin.manifest.id === 'test.example') && fixtureMethod() === 1 && document.querySelector('[data-bedrock-plugin="test.example"]') === null`);
        assert.equal(globalThis.BedrockMain.records.has('test.example'), false);
        await evaluate(`fixtureShowThemes()`);
        await waitFor(`document.querySelector('[aria-label="Search themes"]') && document.querySelector('[aria-label="Enable Live theme"]')`);
        assert.equal(await evaluate(`document.querySelector('.bedrock-theme-website').href`), 'https://example.com/theme');
        assert.equal(await evaluate(`getComputedStyle(document.documentElement).getPropertyValue('--live-theme').trim()`), '');
        await evaluate(`document.querySelector('[aria-label="Enable Live theme"]').click()`);
        await waitFor(`getComputedStyle(document.documentElement).getPropertyValue('--live-theme').trim() === 'red'`);
        await waitFor(`getComputedStyle(document.documentElement).getPropertyValue('--theme-import').trim() === 'imported'`);
        fs.writeFileSync(path.join(themesDirectory, 'assets', 'import.css'), ':root { --theme-import: updated; }');
        await waitFor(`getComputedStyle(document.documentElement).getPropertyValue('--theme-import').trim() === 'updated'`);
        fs.writeFileSync(path.join(themesDirectory, 'live.theme.css'), '/**\n * @name Live theme\n */\n:root { --live-theme: green; }');
        await waitFor(`getComputedStyle(document.documentElement).getPropertyValue('--live-theme').trim() === 'green'`);
        fs.writeFileSync(path.join(themesDirectory, 'new.css'), ':root { --new-theme: yes; }');
        await waitFor(`document.querySelector('[aria-label="Enable new"]')`);
        await evaluate(`document.querySelector('[aria-label="Enable Live theme"]').click()`);
        await waitFor(`getComputedStyle(document.documentElement).getPropertyValue('--live-theme').trim() === ''`);
        await evaluate(`document.querySelector('[aria-label="Enable Live theme"]').click()`);
        await waitFor(`getComputedStyle(document.documentElement).getPropertyValue('--live-theme').trim() === 'green'`);
        fs.unlinkSync(path.join(themesDirectory, 'live.theme.css'));
        await waitFor(`document.querySelector('[aria-label="Enable Live theme"]') === null && document.querySelector('[data-bedrock-theme="live.theme.css"]') === null`);
        assert.equal(await evaluate(`(async () => (await fetch('bedrock://themes/%2e%2e/settings.json')).status)()`), 404);
        await window.loadURL('https://unrelated.test/');
        assert.equal(await evaluate(`globalThis.Bedrock === undefined && globalThis.BedrockNative === undefined`), true, 'bridge must not appear on unrelated origins');
        console.log('PASS: Real Electron preload, settings controls, validation, restart requests, persistence, React settings subscriptions, synchronization across main and two windows, live cleanup/re-enable, safe Markdown and origin checks.');
        await globalThis.BedrockMain.stopAll();
        globalThis.BedrockMain.themes.close();
        window.destroy();
        fs.rmSync(root, { recursive: true, force: true });
        app.exit(0);
    } catch (error) {
        console.error(error.stack, failures.join('\n'));
        mirror?.destroy();
        window?.destroy();
        fs.rmSync(root, { recursive: true, force: true });
        app.exit(1);
    }
});
