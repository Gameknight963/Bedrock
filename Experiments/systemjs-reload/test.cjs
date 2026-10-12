const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { fileURLToPath, pathToFileURL } = require('node:url');
const { app, BrowserWindow, protocol } = require('electron');
const babel = require('@babel/core');
const { System } = require('systemjs');
const { createAddonLoader } = require('../../Runtime/addons.cjs');
const { createMainLoader } = require('./commonjs-main.cjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'Bedrock-systemjs-'));
const syncRoot = path.join(root, 'sync-main');
fs.mkdirSync(syncRoot);
const report = { passed: false, cases: [] };
const runs = path.join(__dirname, 'runs');
fs.mkdirSync(runs, { recursive: true });
fs.writeFileSync(path.join(runs, 'result.json'), JSON.stringify(report));
let window;

function compile(source, filename) {
    return babel.transformSync(source, {
        filename, babelrc: false, configFile: false,
        plugins: ['@babel/plugin-transform-modules-systemjs', '@babel/plugin-transform-dynamic-import']
    }).code;
}

function write(version, directory = root, synchronous = false) {
    fs.writeFileSync(path.join(directory, 'helper.mjs'), `
        export let value = ${version}; export function increment() { value++; }
        export const shared = { value: ${version} };
    `);
    fs.writeFileSync(path.join(directory, 'cycle.mjs'), `
        import { getValue } from './entry.mjs'; export function circular() { return getValue(); }
    `);
    fs.writeFileSync(path.join(directory, 'lazy.mjs'), `export const lazy = ${version};`);
    fs.writeFileSync(path.join(directory, 'await.mjs'), synchronous ? `export const ready = ${version};` : `export const ready = await Promise.resolve(${version});`);
    fs.writeFileSync(path.join(directory, 'reexport.mjs'), `export { shared, value } from './helper.mjs';`);
    fs.writeFileSync(path.join(directory, 'entry.mjs'), `
        import { value, increment, shared } from './helper.mjs';
        import { circular } from './cycle.mjs'; import { ready } from './await.mjs';
        export { shared as reexported } from './reexport.mjs';
        export function getValue() { return value; }
        export class Example { getValue() { return value; } }
        export const object = { version: ${version} };
        export function test() { return { value, circular: circular(), ready, url: import.meta.url }; }
        export function update() { increment(); }
        export async function dynamic(name = 'lazy.mjs') { return (await import('./' + name)).lazy; }
        export function start() { globalThis.reloadListener = () => value; }
        export function stop() { delete globalThis.reloadListener; }
        export function unload() { globalThis.unloadCount = (globalThis.unloadCount || 0) + 1; }
    `);
}

function createNodeLoader() {
    const loader = new System.constructor();
    const resolve = loader.resolve.bind(loader);
    loader.resolve = (id, parent) => id === 'electron' || id.startsWith('node:') ? `host:${id}` : resolve(id, parent);
    loader.instantiate = async url => {
        const filename = fileURLToPath(url);
        new Function('System', compile(fs.readFileSync(filename, 'utf8'), filename))(loader);
        return loader.getRegister();
    };
    for (const id of ['node:fs', 'node:url', 'node:path', 'electron']) {
        const host = require(id);
        loader.set(`host:${id}`, { ...host, default: host });
    }
    return loader;
}

function invalidate(loader, prefix) {
    for (const [id] of loader.entries()) if (id.startsWith(prefix)) assert.equal(typeof loader.delete(id), 'function');
}

app.whenReady().then(async () => {
    try {
        const prefix = pathToFileURL(root).href + '/';
        const entry = `${prefix}entry.mjs`;
        const loader = createNodeLoader();
        const synchronous = createMainLoader(syncRoot);
        write(1);
        const first = await loader.import(entry);
        write(2);
        assert.equal((await loader.import(entry)).test().value, 1, 'registry cache persists until explicitly invalidated');
        invalidate(loader, prefix);
        assert.equal((await loader.import(entry)).test().value, 2, 'deleting registry entries rereads helpers');
        assert.equal(first.test().value, 1, 'existing references remain usable');
        invalidate(loader, prefix);
        report.cases.push('Supported registry deletion reloads the same URLs and leaves existing JS references alive');

        protocol.handle('https', request => {
            const name = new URL(request.url).pathname.slice(1);
            if (name === 'system.js') return new Response(fs.readFileSync(require.resolve('systemjs/dist/system.js')), { headers: { 'content-type': 'text/javascript' } });
            if (name.endsWith('.mjs') && !name.includes('/') && fs.existsSync(path.join(root, name)))
                return new Response(compile(fs.readFileSync(path.join(root, name), 'utf8'), path.join(root, name)), { headers: {
                    'content-type': 'text/javascript', 'cache-control': 'no-store'
                } });
            return new Response('<!doctype html><body><script src="/system.js"></script>SystemJS fixture</body>', { headers: {
                'content-type': 'text/html', 'content-security-policy': "script-src 'self'; object-src 'none'"
            } });
        });
        window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } });
        await window.loadURL('https://modules.test/');
        const evaluate = source => window.webContents.executeJavaScript(source);
        await evaluate('globalThis.fixture = 123;');
        for (let version = 1; version <= 30; version++) {
            write(version);
            write(version, syncRoot, true);
            const sync = synchronous.require('./entry.mjs');
            assert.equal(synchronous.require('./entry.mjs'), sync);
            assert.equal(sync.test().value, version); assert.equal(sync.test().circular, version);
            assert.equal(sync.test().url, pathToFileURL(path.join(syncRoot, 'entry.mjs')).href);
            assert.equal(new sync.Example().getValue(), version);
            assert.equal(await sync.dynamic(), version);
            sync.update(); assert.equal(sync.test().value, version + 1);
            sync.start(); sync.stop(); sync.unload(); synchronous.invalidate();
            const main = await loader.import(entry);
            assert.equal(await loader.import(entry), main);
            assert.equal(main.test().value, version); assert.equal(main.test().circular, version);
            assert.equal(main.test().ready, version); assert.equal(main.test().url, entry);
            const instance = new main.Example();
            assert.equal(instance.getValue(), version); assert.equal(main.object.version, version);
            assert.equal(await main.dynamic(), version);
            const helper = loader.get(`${prefix}helper.mjs`);
            const reexport = loader.get(`${prefix}reexport.mjs`);
            assert.equal(helper.shared, reexport.shared); assert.equal(main.reexported, helper.shared);
            assert.notEqual(helper, reexport, 'module namespaces identify modules despite identical exported objects');
            main.update(); assert.equal(main.test().value, version + 1); assert.equal(reexport.value, version + 1);
            main.start(); assert.equal(globalThis.reloadListener(), version + 1);
            main.stop(); main.unload(); assert.equal(globalThis.reloadListener, undefined);
            invalidate(loader, prefix);
            assert.equal([...loader.entries()].filter(([id]) => id.startsWith(prefix)).length, 0);

            await evaluate(`System.import('/entry.mjs').then(module => { globalThis.plugin = module; plugin.start(); })`);
            const renderer = await evaluate('plugin.test()');
            assert.equal(renderer.value, version); assert.equal(renderer.circular, version); assert.equal(renderer.ready, version);
            assert.equal(renderer.url, 'https://modules.test/entry.mjs');
            assert.equal(await evaluate('plugin.dynamic()'), version);
            assert.equal(await evaluate('new plugin.Example().getValue()'), version);
            assert.equal(await evaluate('System.get("https://modules.test/helper.mjs").shared === plugin.reexported'), true);
            await evaluate('plugin.update()'); assert.equal((await evaluate('plugin.test()')).value, version + 1);
            await evaluate(`plugin.stop(); plugin.unload(); delete globalThis.plugin;
                for (const [id] of System.entries()) if (id.startsWith('https://modules.test/')) System.delete(id);
                void 0;`);
            assert.equal(await evaluate('globalThis.reloadListener === undefined'), true);
            assert.equal(await evaluate('globalThis.fixture'), 123, 'same page and JS globals survive replacement');
        }
        assert.equal(globalThis.unloadCount, 60); assert.equal(await evaluate('globalThis.unloadCount'), 30);
        report.cases.push('30 replacements in main and renderer: live bindings, circular functions, classes, objects, top-level await, computed dynamic imports, import.meta.url, reexports, lifecycle and persistent page globals');
        report.cases.push('30 synchronous main replacements using public Node load hooks and CommonJS cache invalidation');

        fs.writeFileSync(path.join(root, 'broken.mjs'), 'export const value = ;');
        await assert.rejects(loader.import(`${prefix}broken.mjs`));
        loader.delete(`${prefix}broken.mjs`);
        fs.writeFileSync(path.join(root, 'broken.mjs'), 'export const value = 7;');
        assert.equal((await loader.import(`${prefix}broken.mjs`)).value, 7);
        await evaluate(`System.import('/broken.mjs').then(module => { globalThis.repaired = module.value; })`);
        assert.equal(await evaluate('globalThis.repaired'), 7);
        report.cases.push('Syntax failure can be invalidated and retried');

        globalThis.Bedrock = createAddonLoader({ directory: path.join(__dirname, '../../Native/Addons/bin/x64/Debug') });
        const addon = path.join(syncRoot, 'console.node');
        fs.copyFileSync(path.join(__dirname, '../../../bedrock-plugins/.artifacts/packages/console/native/win32-x64/console.node'), addon);
        fs.writeFileSync(path.join(syncRoot, 'native.mjs'), `import fs from 'node:fs'; import { app } from 'electron';
            let addon; export function start() { addon ||= Bedrock.require(new URL('./console.node', import.meta.url)); addon.hide(); }
            export function stop() { addon.hide(); }
            export function unload() { Bedrock.unrequire(addon); addon = undefined; }
            export function check() { return fs.existsSync(new URL('./console.node', import.meta.url)) && app.isReady(); }
        `);
        const native = synchronous.require('./native.mjs');
        assert.equal(native.check(), true); native.start(); native.stop();
        assert.throws(() => fs.unlinkSync(addon), { code: 'EPERM' });
        native.unload(); synchronous.invalidate(); fs.unlinkSync(addon);
        report.cases.push('Host Node/Electron imports and explicit managed native addon disposal followed by immediate file deletion');

        write(100);
        const independent = createNodeLoader();
        const one = await loader.import(entry);
        const two = await independent.import(entry);
        assert.notEqual(one, two); one.update(); assert.equal(two.test().value, 100);
        invalidate(loader, prefix); assert.equal(two.test().value, 100);
        report.cases.push('Independent registries isolate module state and invalidation');
        fs.writeFileSync(path.join(root, 'tdz-a.mjs'), "import { b } from './tdz-b.mjs'; export const a = b;");
        fs.writeFileSync(path.join(root, 'tdz-b.mjs'), "import { a } from './tdz-a.mjs'; export const b = a;");
        await assert.rejects(import(`${prefix}tdz-a.mjs`), ReferenceError);
        try { report.systemjsEarlyCycleValue = String((await independent.import(`${prefix}tdz-a.mjs`)).a); }
        catch (error) { report.systemjsEarlyCycleError = error.name; }
        fs.copyFileSync(path.join(root, 'tdz-a.mjs'), path.join(syncRoot, 'tdz-a.mjs'));
        fs.copyFileSync(path.join(root, 'tdz-b.mjs'), path.join(syncRoot, 'tdz-b.mjs'));
        try { report.commonjsEarlyCycleValue = String(synchronous.require('./tdz-a.mjs').a); }
        catch (error) { report.commonjsEarlyCycleError = error.name; }
        synchronous.close();
        report.systemjsImportIsAsync = true;
        report.commonjsMainIsSynchronous = true;
        report.passed = true; report.electron = process.versions.electron; report.node = process.versions.node;
        console.log(JSON.stringify(report, null, 2));
    } catch (error) { report.error = error.stack; process.exitCode = 1; console.error(error.stack); }
    finally {
        fs.writeFileSync(path.join(runs, 'result.json'), JSON.stringify(report, null, 2));
        window?.destroy(); fs.rmSync(root, { recursive: true, force: true }); app.quit();
    }
});
