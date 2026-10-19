const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { app, BrowserWindow, session } = require('electron');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'Bedrock-renderer-ui-'));
app.setPath('userData', path.join(root, 'profile'));
const folder = path.join(root, 'plugins', 'fixture');
fs.mkdirSync(folder, { recursive: true });
fs.writeFileSync(path.join(folder, 'plugin.json'), JSON.stringify({ manifestVersion: 3,
    id: 'test.renderer-ui', name: 'Renderer UI fixture', version: '1.0.0',
    entrypoints: { renderer: { runtime: 'javascript', path: 'renderer.js', requiresApi: '1.5.0' } } }));
fs.writeFileSync(path.join(folder, 'renderer.js'), `
    export function start(ctx) {
        function Accessory(props) {
            const [count, setCount] = ctx.react.useState(0);
            ctx.react.useEffect(() => () => { globalThis.fixtureUnmounts++; }, []);
            return ctx.react.createElement('button', { 'data-accessory': true, onClick: () => setCount(count + 1) }, props.message.id + ':' + count);
        }
        ctx.messages.addAccessory('counter', Accessory);
        ctx.messages.addButton('translate', props => props.message.content ? {
            label: 'Fixture translate', icon: () => ctx.react.createElement('span', null, 'T'),
            async onClick() { await Promise.resolve(); globalThis.fixtureTranslated = props.message.id; }
        } : null);
        ctx.chatBar.addButton('action', props => ctx.chatBar.button({ label: 'Fixture action', icon: '+', disabled: props.disabled,
            onClick: () => { globalThis.fixtureButtonChannel = props.channel.id; } }));
        ctx.notifications.show({ title: '<img src=x>', body: 'Literal text', timeout: 0,
            actions: [{ label: 'Fixture notification action', onClick: () => { globalThis.fixtureNotificationClicked = true; } }] });
        ctx.notifications.show({ title: 'Expires', timeout: 40 });
        ctx.commands.register({ name: 'fixture-local', description: 'Local command', options: [
            { name: 'count', description: 'Count', type: 'integer', required: true }
        ], async execute(values, context) {
            await Promise.resolve(); globalThis.fixtureCommandCall = { count: values.count, channelId: context.channelId };
        } });
        ctx.commands.register({ name: 'fixture-send', description: 'Explicit send', async execute(values, context) {
            await ctx.messages.send(context.channelId, { content: 'Explicit message' });
        } });
        ctx.commands.register({ name: 'fixture-error', description: 'Error command', execute() { throw new Error('Fixture command error'); } });
        globalThis.fixtureAddAccessory = () => ctx.messages.addAccessory('later', () => ctx.react.createElement('span', { 'data-later': true }, 'Later'), { order: -1 });
        globalThis.fixtureAddBroken = () => ctx.messages.addAccessory('broken', () => { throw new Error('Fixture render error'); });
        globalThis.fixtureToast = options => ctx.notifications.show(options);
    }
    export function stop() { globalThis.fixtureStops++; }
`);
require(path.resolve(__dirname, '../bootstrap.cjs')).install({ root, allowURL: url => url.origin === 'https://renderer-ui.test' });
const fixture = `
    globalThis.fixtureUnmounts = 0; globalThis.fixtureStops = 0; globalThis.fixtureSends = [];
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
        actions(module) { module.exports = {
            sendMessage(channelId, message) { fixtureSends.push({ channelId, content: message.content }); }, editMessage() {}
        }; },
        accessories(module, exports, require) {
            const React = require('react');
            module.exports = class MessageAccessories extends React.Component {
                renderSuppressConfirmModal() { return null; }
                render() { return React.createElement('section', { 'data-message': this.props.message.id }, this.renderSuppressConfirmModal()); }
            };
        },
        composer(module, exports, require) {
            const React = require('react');
            module.exports = function Composer(props) {
                const buttons = []; buttons.push(React.createElement('button', { key: 'sticker' }, "sticker"));
                return 0===buttons.length ? null : React.createElement('div', { className: 'fixture-composer', children:buttons });
            };
        },
        toolbar(module, exports, require) {
            const React = require('react'), ui = { jsx: (type, props) => React.createElement(type, props) }, intl = { Lv7LxN: 'Message actions' };
            function NativeButton(props) { return React.createElement('button', { title: props.label, onClick: props.onClick, disabled: props.disabled }, React.createElement(props.icon)); }
            module.exports = function Toolbar(props) {
                const a = (0,ui.jsx)(NativeButton,{label:'Native reply',icon:()=>React.createElement('span',null,'R')}), b = null;
                return (0,ui.jsx)('div',{title:intl.Lv7LxN,children:[a,b]});
            };
        },
        commands(module) {
            const builtins = [{ name: 'shrug', id: '-1' }];
            const textCommands = builtins.filter(command => ["tableflip","unflip"].includes(command.name));
            module.exports = builtins;
        },
        entry(module, exports, require) {
            require('actions');
            const React = require('react'), Accessories = require('accessories'), Composer = require('composer'), Toolbar = require('toolbar');
            globalThis.fixtureCommands = require('commands');
            globalThis.fixtureRoot = ReactDOM.createRoot(document.getElementById('root'));
            fixtureRoot.render(React.createElement('main', {},
                React.createElement(Accessories, { message: { id: 'message' }, channel: { id: 'channel' } }),
                React.createElement(Toolbar, { message: { id: 'message', content: 'Hello' }, channel: { id: 'channel' } }),
                React.createElement(Toolbar, { message: { id: 'empty', content: '' }, channel: { id: 'channel' } }),
                React.createElement(Composer, { channel: { id: 'channel' }, disabled: false })));
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
        await window.loadURL('https://renderer-ui.test');
        await waitFor(`document.querySelector('[data-accessory]') && document.querySelector('[aria-label="Fixture action"]') && fixtureCommands.length === 4`);
        assert.equal(await evaluate(`document.querySelector('[data-accessory]').textContent`), 'message:0');
        await evaluate(`document.querySelector('[data-accessory]').click()`);
        await waitFor(`document.querySelector('[data-accessory]').textContent === 'message:1'`);
        await evaluate(`document.querySelector('[aria-label="Fixture action"]').click()`);
        assert.equal(await evaluate('fixtureButtonChannel'), 'channel');
        await waitFor(`document.querySelector('[title="Fixture translate"]')`);
        assert.equal(await evaluate(`document.querySelectorAll('[title="Fixture translate"]').length`), 1);
        assert.equal(await evaluate(`document.querySelectorAll('[title="Native reply"]').length`), 2);
        await evaluate(`document.querySelector('[title="Fixture translate"]').click()`);
        await waitFor(`fixtureTranslated === 'message'`);
        assert.equal(await evaluate(`document.querySelector('.fixture-composer').lastElementChild.textContent`), 'sticker');
        await evaluate('globalThis.fixtureDisposeLater = fixtureAddAccessory(); void 0');
        await waitFor(`!!document.querySelector('[data-later]')`);
        assert.equal(await evaluate(`document.querySelector('[data-message]').firstElementChild.textContent`), 'Later');
        assert.equal(await evaluate(`document.querySelector('[data-accessory]').textContent`), 'message:1', 'registration changes preserve sibling component state');
        await evaluate('fixtureDisposeLater(); fixtureAddBroken(); void 0');
        await waitFor(`!document.querySelector('[data-later]')`);
        assert.equal(await evaluate(`!!document.querySelector('[data-accessory]')`), true, 'failed accessory does not remove healthy siblings');
        console.log('PASS: accessory state, dynamic updates, error boundaries, composer button placement and actions');
        assert.equal(await evaluate(`document.querySelector('.bedrock-notification-title').textContent`), '<img src=x>');
        assert.equal(await evaluate(`document.querySelectorAll('.bedrock-notifications img').length`), 0);
        await waitFor(`![...document.querySelectorAll('.bedrock-notification-title')].some(element => element.textContent === 'Expires')`);
        await evaluate(`document.querySelector('.bedrock-notification-actions button').click()`);
        assert.equal(await evaluate('fixtureNotificationClicked'), true);
        await evaluate(`document.querySelector('.bedrock-notification-close').click()`);
        assert.equal(await evaluate(`document.querySelectorAll('.bedrock-notification').length`), 0);
        await evaluate(`globalThis.fixtureDismiss = fixtureToast({title:'Manual close', timeout:0}); void 0`);
        assert.equal(await evaluate(`document.querySelectorAll('.bedrock-notification').length`), 1);
        await evaluate('fixtureDismiss.close()');
        assert.equal(await evaluate(`document.querySelectorAll('.bedrock-notification').length`), 0);
        await evaluate(`fixtureCommands.find(command => command.name === 'fixture-local').execute([{name:'count',value:0}], {channel:{id:'channel'}})`);
        assert.deepEqual(await evaluate('fixtureCommandCall'), { count: 0, channelId: 'channel' });
        assert.equal(await evaluate('fixtureSends.length'), 0, 'local commands do not send their result');
        await evaluate(`fixtureCommands.find(command => command.name === 'fixture-send').execute([], {channel:{id:'channel'}})`);
        assert.deepEqual(await evaluate('fixtureSends'), [{ channelId: 'channel', content: 'Explicit message' }]);
        await evaluate(`fixtureCommands.find(command => command.name === 'fixture-error').execute([], {channel:{id:'channel'}})`);
        assert.equal(await evaluate(`document.querySelector('[role=alert] .bedrock-notification-body').textContent`), 'Fixture command error');
        console.log('PASS: local slash command execution, explicit sending, literal notification text, actions, expiry and command errors');
        await evaluate(`globalThis.fixtureStale = fixtureCommands.find(command => command.name === 'fixture-local'); Bedrock.plugins.setEnabled('test.renderer-ui', false)`);
        await waitFor(`!document.querySelector('[data-accessory]') && !document.querySelector('[aria-label="Fixture action"]') && fixtureUnmounts === 1`);
        assert.equal(await evaluate(`document.querySelector('[title="Fixture translate"]')`), null);
        assert.equal(await evaluate(`document.querySelectorAll('.bedrock-notification').length`), 0);
        assert.equal(await evaluate('fixtureCommands.length'), 1); assert.equal(await evaluate('fixtureStops'), 1);
        assert.equal(await evaluate(`!!Bedrock.plugins.list()[0].restartReason`), false);
        await evaluate(`fixtureCommandCall = null; fixtureStale.execute([], {channel:{id:'channel'}})`);
        assert.equal(await evaluate('fixtureCommandCall'), null);
        await evaluate(`Bedrock.plugins.setEnabled('test.renderer-ui', true)`);
        await waitFor(`!!document.querySelector('[data-accessory]') && fixtureCommands.length === 4`);
        assert.equal(await evaluate(`document.querySelector('[data-accessory]').textContent`), 'message:0');
        assert.equal(await evaluate(`Bedrock.debug.status().rendererUi.patches.every(patch => patch.state === 'applied')`), true);
        console.log('PASS: disabling removes UI, notifications and commands without restart; re-enabling starts fresh');
        app.exit(0);
    } catch (error) {
        console.error(error.stack);
        if (window) console.error(await evaluate('JSON.stringify(Bedrock?.debug.status())').catch(() => 'Renderer unavailable'));
        app.exit(1);
    }
});
