const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow, protocol } = require('electron');
const { compile } = require('./compiler.cjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'Bedrock-reload-'));
const entry = path.join(root, 'entry.mjs');
const helper = path.join(root, 'helper.mjs');
const report = {};
let window;

function write(version) {
    fs.writeFileSync(helper, `export const version = ${version}; export let calls = 0; export function tick() { return ++calls; }`);
    fs.writeFileSync(path.join(root, 'lazy.mjs'), `export const lazy = ${version};`);
    fs.writeFileSync(path.join(root, 'cycle.mjs'), `import { read } from './entry.mjs'; export function cycle() { return read(); }`);
    fs.writeFileSync(entry, `
        import { version, tick } from './helper.mjs';
        import { cycle } from './cycle.mjs';
        export function read() { return version; }
        export function start() {
            globalThis.reloadEffects = (globalThis.reloadEffects || 0) + 1;
            globalThis.reloadHandler = () => version;
        }
        export function stop() { delete globalThis.reloadHandler; }
        export function unload() { globalThis.reloadEffects--; }
        export function test() { return { version, tick: tick(), cycle: cycle(), url: import.meta.url,
            dom: typeof document === 'object' ? document.body.tagName : null }; }
        export async function dynamic() { return (await import('./lazy.mjs')).lazy; }
    `);
}

app.whenReady().then(async () => {
    try {
        try { require('internal/modules/esm/loader'); report.internalLoaderAccessible = true; }
        catch (error) { report.internalLoaderAccessible = false; report.internalLoaderError = error.code; }
        protocol.handle('https', request => {
            const name = new URL(request.url).pathname.slice(1);
            if (['entry.mjs', 'helper.mjs', 'cycle.mjs', 'lazy.mjs'].includes(name))
                return new Response(fs.readFileSync(path.join(root, name)), { headers: { 'content-type': 'text/javascript', 'cache-control': 'no-store' } });
            return new Response('<!doctype html><body>Reload fixture</body>', {
                headers: { 'content-type': 'text/html', 'content-security-policy': "script-src 'self' 'unsafe-eval'" }
            });
        });
        window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } });
        await window.loadURL('https://reload.test/');
        const evaluate = source => window.webContents.executeJavaScript(source);
        write(1);
        const cached = await import(pathToFileURL(entry).href);
        assert.equal(cached.read(), 1);
        assert.equal(await evaluate(`import('/entry.mjs').then(module => module.read())`), 1);
        write(2);
        assert.equal((await import(pathToFileURL(entry).href)).read(), 1);
        // A new entry URL still reuses its unchanged helper URL.
        assert.equal((await import(`${pathToFileURL(entry).href}?revision=2`)).read(), 1);
        report.nodeCacheReproduced = true;
        assert.equal(await evaluate(`import('/entry.mjs').then(module => module.read())`), 1);
        assert.equal(await evaluate(`import('/entry.mjs?revision=2').then(module => module.read())`), 1);
        report.rendererCacheReproduced = true;
        for (let version = 1; version <= 30; version++) {
            write(version);
            let main = new Function('require', await compile(entry))(createRequire(entry));
            main.start();
            const state = main.test();
            assert.equal(state.version, version); assert.equal(state.tick, 1); assert.equal(state.cycle, version);
            assert.equal(state.url, pathToFileURL(entry).href); assert.equal(state.dom, null);
            assert.equal(await main.dynamic(), version);
            assert.equal(globalThis.reloadHandler(), version);
            main.stop(); main.unload(); main = null;
            assert.equal(globalThis.reloadEffects, 0); assert.equal(globalThis.reloadHandler, undefined);
            const source = await compile(entry, true);
            await evaluate(`globalThis.plugin = new Function(${JSON.stringify(source)})(); plugin.start();`);
            const renderer = await evaluate('plugin.test()');
            assert.equal(renderer.version, version); assert.equal(renderer.tick, 1); assert.equal(renderer.cycle, version);
            assert.equal(renderer.url, 'https://reload.test/entry.mjs'); assert.equal(renderer.dom, 'BODY');
            assert.equal(await evaluate('plugin.dynamic()'), version);
            await evaluate('plugin.stop(); plugin.unload(); delete globalThis.plugin;');
            assert.equal(await evaluate('globalThis.reloadEffects'), 0);
            assert.equal(await evaluate('globalThis.reloadHandler === undefined'), true);
        }
        report.freshMainAndRendererLoads = 30;
        report.dependenciesCyclesDynamicImportsAndLifecycle = true;
        const nodeEntry = path.join(root, 'node.mjs');
        fs.writeFileSync(nodeEntry, `import fs from 'node:fs'; import { app } from 'electron';
            export function check() { return fs.existsSync(new URL('./entry.mjs', import.meta.url)) && app.isReady(); }`);
        assert.equal(new Function('require', await compile(nodeEntry))(createRequire(nodeEntry)).check(), true);
        report.nodeAndElectronImports = true;
        fs.writeFileSync(path.join(root, 'await.mjs'), 'export const value = await Promise.resolve(3);');
        await assert.rejects(compile(path.join(root, 'await.mjs')), /Top-level await/);
        report.topLevelAwaitUnsupported = true;
        report.electron = process.versions.electron;
        report.node = process.versions.node;
        report.passed = true;
        console.log('PASS: 30 replacements in main and renderer, helpers, state reset, cycles, dynamic imports, original URLs, DOM and lifecycle cleanup.');
    } catch (error) { report.error = error.stack; process.exitCode = 1; console.error(error); }
    finally {
        fs.mkdirSync(path.join(__dirname, 'runs'), { recursive: true });
        fs.writeFileSync(path.join(__dirname, 'runs/result.json'), JSON.stringify(report, null, 2));
        window?.destroy();
        fs.rmSync(root, { recursive: true, force: true });
        app.quit();
    }
});
