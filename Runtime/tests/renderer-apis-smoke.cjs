const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { app, BrowserWindow, session } = require('electron');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'Bedrock-renderer-apis-'));
app.setPath('userData', path.join(root, 'profile'));
const folder = path.join(root, 'plugins', 'fixture');
fs.mkdirSync(folder, { recursive: true });
fs.writeFileSync(path.join(folder, 'plugin.json'), JSON.stringify({ manifestVersion: 3,
    id: 'test.renderer-apis', name: 'Renderer API fixture', version: '1.0.0',
    entrypoints: { renderer: { runtime: 'javascript', path: 'renderer.js', requiresApi: '1.4.0' } } }));
fs.writeFileSync(path.join(folder, 'helper.js'), 'export const suffix = "-helper";');
fs.writeFileSync(path.join(folder, 'renderer.js'), `
    import { suffix } from './helper.js';
    export const settings = Bedrock.definePluginSettings({ text: { type: Bedrock.OptionType.STRING, default: 'patched' } });
    export const patches = [{ id: 'early-value', find: 'EARLY_SOURCE_FIXTURE',
        replacement: { match: "'original value'", replace: '$self.value()' } }];
    export function value() { return settings.store.text + suffix; }
    export async function start(ctx) {
        ctx.contextMenus.patch('user-context', (children, props) => {
            children.push(ctx.contextMenus.item({ id: 'copy-url', label: 'Copy User URL',
                action: () => { globalThis.fixtureSelectedUser = props.user.id; } }));
        });
        ctx.messages.beforeSend(async event => {
            await Promise.resolve();
            if (event.message.content === 'cancel') event.cancel();
            else if (event.message.content === 'fail') throw new Error('Fixture send failure');
            else event.message.content += '-sent';
        });
        ctx.messages.beforeEdit(event => { event.message.content += '-edited'; });
        await ctx.webpack.waitFor(value => value?.fixtureBooted === true);
        globalThis.fixturePluginReady = true;
    }
`);
require(path.resolve(__dirname, '../bootstrap.cjs')).install({ root, allowURL: url => url.origin === 'https://renderer-api.test' });
const fixture = `
    globalThis.webpackChunkdiscord_app = [];
    const modules = {};
    function require(id) {
        if (modules[id]) return modules[id].exports;
        const module = modules[id] = { id, exports: {} };
        require.m[id](module, module.exports, require);
        return module.exports;
    }
    require.m = {}; require.c = modules;
    const chunks = webpackChunkdiscord_app;
    chunks.push = function (chunk) { Object.assign(require.m, chunk[1]); if (chunk[2]) return chunk[2](require); };
    chunks.push([['fixture'], {
        react(module) { module.exports = globalThis.React; },
        actions(module) {
            function sendMessage(channelId, message, extra) { return Promise.resolve({ content: message.content, extra }); }
            function editMessage(channelId, messageId, message) { return Promise.resolve(message.content); }
            function openContextMenu(event, render) { globalThis.menuRoot.render(render()); }
            Object.defineProperties(module.exports, {
                sendMessage: { enumerable: true, get: () => sendMessage },
                editMessage: { enumerable: true, get: () => editMessage },
                openContextMenu: { enumerable: true, get: () => openContextMenu }
            });
        },
        entry(module, exports, require) {
            const marker = 'EARLY_SOURCE_FIXTURE';
            globalThis.fixtureStartupValue = 'original value';
            const React = require('react');
            const h = React.createElement;
            function Item(props) { return h('button', { onClick: props.action }, props.label); }
            function Menu(props) { return h('div', { role: 'menu' }, props.children); }
            function UserMenu(props) { return h(Menu, { navId: 'user-context', children: [
                h(Item, { key: 'original', id: 'original', label: 'Original command', action() {} }),
                h('input', { key: 'control', type: 'range', 'aria-label': 'Volume' })
            ] }); }
            globalThis.menuRoot = ReactDOM.createRoot(document.getElementById('root'));
            globalThis.fixtureActions = require('actions');
            globalThis.fixtureOpen = () => fixtureActions.openContextMenu({}, () => h(UserMenu, { user: { id: 'fixture-user' } }));
            module.exports = { fixtureBooted: true };
        }
    }, require => require('entry')]);
`;
let window;
const evaluate = source => window.webContents.executeJavaScript(source);
async function waitFor(source) {
    for (let index = 0; index < 200; index++) {
        if (await evaluate(source)) return;
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error(`Timed out: ${source}`);
}
app.whenReady().then(async () => {
    try {
        session.defaultSession.protocol.handle('https', request => {
            const file = new URL(request.url).pathname;
            const body = file === '/react.js' ? fs.readFileSync(path.join(__dirname, 'obj/node_modules/react/umd/react.development.js')) :
                file === '/react-dom.js' ? fs.readFileSync(path.join(__dirname, 'obj/node_modules/react-dom/umd/react-dom.development.js')) :
                file === '/fixture.js' ? fixture : '<!doctype html><body><div id="root"></div><script src="/react.js"></script><script src="/react-dom.js"></script><script src="/fixture.js"></script></body>';
            return new Response(body, { headers: { 'Content-Type': file === '/' ? 'text/html' : 'text/javascript' } });
        });
        window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } });
        window.webContents.on('console-message', event => { if (event.message?.includes('[Bedrock:')) console.log(event.message); });
        await window.loadURL('https://renderer-api.test');
        await waitFor('globalThis.fixturePluginReady === true');
        assert.equal(await evaluate('fixtureStartupValue'), 'patched-helper', 'source patches and settings are ready before the startup factory');
        assert.equal(await evaluate('Bedrock.plugins.list()[0].sourcePatches[0].state'), 'applied');
        await evaluate('fixtureOpen()');
        await waitFor(`document.querySelectorAll('[role=menu] button').length === 2`);
        assert.equal(await evaluate(`document.querySelector('[role=menu] input').getAttribute('aria-label')`), 'Volume');
        await evaluate(`[...document.querySelectorAll('button')].find(button => button.textContent === 'Copy User URL').click()`);
        assert.equal(await evaluate('fixtureSelectedUser'), 'fixture-user');
        assert.equal(await evaluate(`(() => {
            const element = document.querySelector('[role=menu]');
            const key = Object.keys(element).find(key => key.startsWith('__reactFiber$'));
            for (let fiber = element[key]; fiber; fiber = fiber.return)
                if (fiber.memoizedProps?.navId) return fiber.memoizedProps.children.at(-1).props.id;
        })()`), 'copy-url', 'Native Menus can read the patched React menu props');
        assert.deepEqual(await evaluate(`fixtureActions.sendMessage('channel', {content:'hello'}, {unchanged:true})`),
            { content: 'hello-sent', extra: { unchanged: true } });
        assert.equal(await evaluate(`fixtureActions.editMessage('channel', 'message', {content:'hello'})`), 'hello-edited');
        assert.equal(await evaluate(`fixtureActions.sendMessage('channel', {content:'cancel'}).then(() => false, error => error.name)`), 'BedrockMessageCancelledError');
        assert.equal(await evaluate(`fixtureActions.sendMessage('channel', {content:'fail'}).then(() => false, error => error.message.includes('Fixture send failure'))`), true);
        console.log('PASS: early source patches, settings handoff, async message hooks, cancellation, and Discord menu elements');
        await evaluate(`Bedrock.plugins.setEnabled('test.renderer-apis', false)`);
        await waitFor(`!!Bedrock.plugins.list()[0].restartReason`);
        assert.equal(await evaluate('Bedrock._sourcePlugin("test.renderer-apis").value()'), 'patched-helper');
        assert.equal(await evaluate('Bedrock.plugins.list()[0].rendererStatus'), 'restart-pending');
        await BedrockMain.remove('test.renderer-apis');
        assert.equal(BedrockMain.pendingChanges().some(change => change.id === 'test.renderer-apis'), true);
        assert.equal(await evaluate('Bedrock._sourcePlugin("test.renderer-apis").value()'), 'patched-helper');
        console.log('PASS: applied source patches request restart and retain helpers until restart');
        app.exit(0);
    } catch (error) {
        console.error(error.stack);
        if (window) console.error(await evaluate('JSON.stringify(Bedrock?.plugins.list())').catch(() => 'Renderer unavailable'));
        app.exit(1);
    }
});
