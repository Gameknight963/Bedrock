const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { app, BrowserWindow } = require('electron');
const { createAddonLoader } = require('../addons.cjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'Bedrock-addons-'));
const report = path.join(__dirname, 'obj/addons-result.json');
fs.writeFileSync(report, JSON.stringify({ passed: false }));
const collection = path.resolve(process.env.BEDROCK_PLUGINS_ROOT || path.join(__dirname, '../../../bedrock-plugins'));
const bridge = require('../../Native/Addons/bin/x64/Debug/addons.node');
const loader = createAddonLoader({ bridge });
const consoleFile = path.join(root, 'console.node');
const windowFile = path.join(root, 'window.node');
const copy = (plugin, name, target) => fs.copyFileSync(path.join(collection, `.artifacts/packages/${plugin}/native/win32-x64/${name}.node`), target);
process.on('uncaughtException', error => { console.error(error); process.exitCode = 1; app.quit(); });
process.on('exit', () => { fs.rmSync(root, { recursive: true, force: true }); });
async function collect() {
    for (let index = 0; index < 5; index++) { global.gc(); await new Promise(resolve => setImmediate(resolve)); }
}
app.whenReady().then(async () => {
    try {
        assert.equal(loader.require('node:fs'), fs);
        copy('console', 'console', consoleFile);
        let first = loader.require(new URL(`file:///${consoleFile.replaceAll('\\', '/')}`));
        let second = loader.require('./console.node', path.join(root, 'entry.js'));
        assert.equal(first, second);
        first.show(); first.hide(); first.filter(true); first.filter(false); first.write('Addon smoke test\n');
        assert.throws(() => fs.unlinkSync(consoleFile), { code: 'EPERM' });
        loader.unrequire(first);
        second.hide();
        assert.throws(() => fs.unlinkSync(consoleFile), { code: 'EPERM' });
        loader.unrequire(second);
        assert.throws(() => loader.unrequire(second), /no outstanding/);
        first = null; second = null;
        fs.unlinkSync(consoleFile);
        await collect();
        for (let index = 0; index < 20; index++) {
            copy('console', 'console', consoleFile);
            let addon = loader.require(consoleFile);
            addon.hide(); addon.filter(true); addon.filter(false);
            loader.unrequire(addon); addon = null;
            fs.unlinkSync(consoleFile);
        }
        const window = new BrowserWindow({ show: false, frame: false, transparent: true, webPreferences: { sandbox: true } });
        await window.loadURL('data:text/html,<title>Addon fixture</title>');
        const handle = window.getNativeWindowHandle();
        for (let index = 0; index < 10; index++) {
            copy('window-customization', 'window', windowFile);
            let addon = loader.require(windowFile);
            const original = addon.getStyle(handle);
            let customization = addon.customize(handle, { nativeTitlebar: true, resizableFrame: true });
            customization.maximize(); customization.restore();
            if (index % 2 === 0) customization.dispose();
            loader.unrequire(addon);
            // Keep disposed JS objects alive until after native unloading to exercise finalizer removal.
            globalThis.fixtureDisposedWindow = customization;
            customization = null; addon = null;
            fs.unlinkSync(windowFile);
            await collect();
            assert.equal(bridge.capture(process.execPath) !== 0n, true);
            assert.equal(await window.webContents.executeJavaScript('1 + 2'), 3);
            copy('window-customization', 'window', windowFile);
            addon = loader.require(windowFile);
            const controlledStyles = 0x00C00000 | 0x00080000 | 0x00040000;
            assert.equal(addon.getStyle(handle) & controlledStyles, original & controlledStyles);
            loader.unrequire(addon); addon = null; fs.unlinkSync(windowFile);
        }
        globalThis.fixtureDisposedWindow = null;
        await collect();
        window.destroy();
        fs.writeFileSync(report, JSON.stringify({ passed: true }));
        console.log('PASS: Cached acquisitions, Console allocation/filtering, final release, reloads, window subclass/finalizer cleanup, deletion, GC and renderer operation.');
        app.quit();
    } catch (error) {
        fs.writeFileSync(report, JSON.stringify({ passed: false, error: error.stack }));
        console.error(error.stack);
        process.exitCode = 1;
        for (const window of BrowserWindow.getAllWindows()) window.destroy();
        app.quit();
    }
});
