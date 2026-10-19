const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { app, BrowserWindow, session } = require('electron');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'Bedrock-settings-ui-'));
app.setPath('userData', path.join(root, 'profile'));
const folder = path.join(root, 'plugins', 'fixture');
fs.mkdirSync(folder, { recursive: true });
fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify({ plugins: { 'test.settings-ui': { enabled: false } } }));
fs.writeFileSync(path.join(folder, 'plugin.json'), JSON.stringify({ manifestVersion: 3,
    id: 'test.settings-ui', name: 'Settings fixture', version: '1.0.0',
    entrypoints: { renderer: { runtime: 'javascript', path: 'renderer.js', requiresApi: '1.10.0' } } }));
fs.writeFileSync(path.join(folder, 'renderer.js'), `
    export const settings = Bedrock.definePluginSettings({ count: { type: Bedrock.OptionType.NUMBER,
        label: 'Count', default: 0, onChange() { globalThis.fixtureChanges++; } } });
    export const patches = [{ find: 'SETTINGS_INACTIVE_PATCH', replacement: { match: 'ORIGINAL', replace: 'PATCHED' } }];
    export function Settings({ ctx }) {
        const React = ctx.react;
        const { count } = settings.use(['count']);
        const [failed, setFailed] = React.useState(false);
        React.useEffect(() => {
            globalThis.fixtureMounts++;
            ctx.styles.add('.fixture-settings-style { color: red; }');
            ctx.signal.addEventListener('abort', () => globalThis.fixtureAborts++, { once: true });
            return () => { globalThis.fixtureUnmounts++; };
        }, [ctx]);
        if (failed) throw new Error('Fixture settings failed');
        return React.createElement('section', { 'data-custom-settings': true },
            React.createElement('output', null, count),
            React.createElement('button', { id: 'fixture-increment', onClick: () => settings.set('count', count + 1) }, 'Increment'),
            React.createElement('button', { id: 'fixture-fail', onClick: () => setFailed(true) }, 'Fail'));
    }
    export function start(ctx) { globalThis.fixtureStarts++; }
    export function stop() { globalThis.fixtureStops++; }
    export function unload() { globalThis.fixtureUnloads++; }
`);
require('../bootstrap.cjs').install({ root, allowURL: url => url.origin === 'https://settings.test' });
const fixture = `
    for (const name of ['Starts', 'Stops', 'Unloads', 'Changes', 'Mounts', 'Unmounts', 'Aborts']) globalThis['fixture' + name] = 0;
    globalThis.webpackChunkdiscord_app = [];
    const modules = {};
    function require(id) {
        if (modules[id]) return modules[id].exports;
        const module = modules[id] = { id, exports: {} };
        require.m[id](module, module.exports, require);
        return module.exports;
    }
    require.m = {}; require.c = modules;
    webpackChunkdiscord_app.push = function (chunk) { Object.assign(require.m, chunk[1]); if (chunk[2]) return chunk[2](require); };
    webpackChunkdiscord_app.push([['fixture'], {
        react(module) { module.exports = React; },
        types(module) { module.exports = { SECTION: 1, SIDEBAR_ITEM: 2, PANEL: 3, CATEGORY: 5, CUSTOM: 19 }; },
        subject(module) { const marker = 'SETTINGS_INACTIVE_PATCH'; module.exports = 'ORIGINAL'; },
        entry(module, exports, require) {
            require('react'); require('types');
            const section = Bedrock._settingsLayout({ key: '$Root', buildLayout: () => [] }).find(node => node.key === 'bedrock_section');
            const Page = section.buildLayout()[0].buildLayout()[0].buildLayout()[0].buildLayout()[0].Component;
            globalThis.fixtureRoot = ReactDOM.createRoot(document.getElementById('root'));
            fixtureRoot.render(React.createElement(Page));
        }
    }, require => require('entry')]);
`;
app.whenReady().then(async () => {
    try {
        const isolated = session.fromPartition('settings-ui-fixture');
        await isolated.protocol.handle('https', request => {
            const filename = new URL(request.url).pathname;
            if (filename === '/react.js') return new Response(fs.readFileSync(path.join(__dirname, 'obj/node_modules/react/umd/react.development.js')), { headers: { 'content-type': 'text/javascript' } });
            if (filename === '/react-dom.js') return new Response(fs.readFileSync(path.join(__dirname, 'obj/node_modules/react-dom/umd/react-dom.development.js')), { headers: { 'content-type': 'text/javascript' } });
            return new Response('<!doctype html><div id="root"></div><script src="/react.js"></script><script src="/react-dom.js"></script><script>' + fixture + '</script>', { headers: { 'content-type': 'text/html' } });
        });
        const window = new BrowserWindow({ show: false, webPreferences: { session: isolated } });
        const evaluate = source => window.webContents.executeJavaScript(source);
        async function wait(source) {
            for (let index = 0; index < 200; index++) {
                if (await evaluate(source)) return;
                await new Promise(resolve => setTimeout(resolve, 20));
            }
            throw new Error('Timed out: ' + source);
        }
        await window.loadURL('https://settings.test');
        await wait('document.querySelector(".bedrock-name")');
        await evaluate('document.querySelector(".bedrock-name").click();void 0');
        await wait('document.getElementById("bedrock-settings-tab")');
        await evaluate('document.getElementById("bedrock-settings-tab").click();void 0');
        await wait('document.getElementById("fixture-increment")');
        assert.equal(await evaluate('fixtureStarts'), 0);
        assert.deepEqual(await evaluate('Bedrock.plugins.list()[0].sourcePatches'), []);
        await evaluate('document.getElementById("fixture-increment").click();void 0');
        await wait('document.querySelector("[data-custom-settings] output").textContent==="1"');
        assert.equal(await evaluate('fixtureChanges'), 0);
        assert.equal(await evaluate('document.querySelector("input[type=number]").value'), '1');
        await evaluate('Bedrock.plugins.setEnabled("test.settings-ui",true)');
        await wait('fixtureStarts===1');
        await evaluate('document.getElementById("fixture-increment").click();void 0');
        await wait('fixtureChanges===1');
        await evaluate('Bedrock.plugins.setEnabled("test.settings-ui",false)');
        await wait('fixtureStops===1');
        await evaluate('document.getElementById("fixture-increment").click();void 0');
        await wait('document.querySelector("[data-custom-settings] output").textContent==="3"');
        assert.equal(await evaluate('fixtureChanges'), 1);
        await evaluate('document.getElementById("bedrock-details-tab").click();void 0');
        await wait('fixtureAborts===1&&fixtureUnmounts===1');
        assert.equal(await evaluate('[...document.querySelectorAll("style")].some(style=>style.textContent.includes("fixture-settings-style"))'), false);
        await evaluate('document.getElementById("bedrock-settings-tab").click();void 0');
        await wait('fixtureMounts===2');
        await evaluate('document.getElementById("fixture-fail").click();void 0');
        await wait('document.getElementById("bedrock-settings-panel").textContent.includes("Fixture settings failed")');
        assert.equal(await evaluate('fixtureStarts'), 1);
        await BedrockMain.remove('test.settings-ui', false);
        await wait('fixtureAborts===2&&fixtureUnloads===1&&!document.querySelector("[data-custom-settings]")');
        const values = JSON.parse(fs.readFileSync(path.join(root, 'data/test.settings-ui/settings.json')));
        assert.equal(values.count, 3);
        console.log('PASS: disabled custom and ordinary settings, no passive source patches or start(), activation-only change callbacks, live enable/disable, UI cleanup, error isolation and unloading an inspected plugin.');
        app.exit(0);
    } catch (error) { console.error(error); app.exit(1); }
});
