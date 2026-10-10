const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const output = path.resolve(process.argv.at(-1));
fs.mkdirSync(output, { recursive: true });
const configuration = process.env.BEDROCK_TEST_CONFIGURATION || 'Release';
assert(['Debug', 'Release'].includes(configuration));
const packageRoot = path.resolve(__dirname, `../../../Launcher/bin/x64/${configuration}`);
const { createPluginManager } = require('../../../Runtime/plugins.cjs');
const data = path.join(output, 'data');
const folder = path.join(data, 'plugins', 'backdrop-blur-fix');
fs.mkdirSync(folder, { recursive: true });
fs.cpSync(path.join(packageRoot, 'BedrockData/plugins/backdrop-blur-fix'), folder, { recursive: true });
assert(!app.commandLine.hasSwitch('disable-gpu-sandbox'), 'Test must retain the GPU sandbox');
app.setPath('userData', path.join(output, 'fixture-profile'));
app.whenReady().then(async () => {
    const window = new BrowserWindow({ width: 400, height: 240, show: false, frame: false, transparent: true,
        webPreferences: { backgroundThrottling: false } });
    await window.loadURL('data:text/html,' + encodeURIComponent(`<style>html,body{margin:0;background:transparent} .bar{position:absolute;left:65px;top:90px;width:10px;height:80px;background:white} .marker{position:absolute;left:35px;top:35px;width:15px;height:15px;background:white} .foreground{position:absolute;left:100px;top:30px;width:40px;height:40px;background:rgba(255,0,0,0.3)} .blur{position:absolute;left:30px;top:30px;width:340px;height:180px;border-radius:55px;backdrop-filter:blur(8px)}</style><div class="bar"></div><div class="marker"></div><div class="blur"><div class="foreground"></div></div>`));
    const capture = async name => {
        await new Promise(resolve => setTimeout(resolve, 400));
        const image = await window.webContents.capturePage();
        fs.writeFileSync(path.join(output, name+'.png'), image.toPNG());
        return image.toBitmap();
    };
    const original = await capture('native-before');
    const gpu = app.getAppMetrics().find(metric => metric.type === 'GPU');
    if (!gpu) throw new Error('No GPU process');
    let installed = 0;
    let failure;
    const manager = createPluginManager(data, {
        nativeDirectory: path.join(packageRoot, 'Runtime/native/win32-x64'),
        symbolCacheDirectory: process.env.BEDROCK_TEST_SYMBOL_CACHE || path.join(output, 'cache', 'symbols'),
        nativeTargets: environment => environment === 'gpu' ? app.getAppMetrics().filter(metric => metric.type === 'GPU') : [],
        log(level, id, args) {
            const message = args.join(' ');
            console.log(message);
            if (message === 'Native blur hook installed.') installed++;
            if (level === 'error') failure = new Error(message);
        }
    });
    manager.scan();
    assert.equal(manager.errors().length, 0, 'Plugin discovery failed');
    assert(manager.records.has('bedrock.backdrop-blur-fix'), 'Blur plugin was not discovered');
    manager.settings('bedrock.backdrop-blur-fix').set('allowGpuInjection', true);
    for (let attempt = 0; !installed && !failure && attempt < 1800; attempt++)
        await new Promise(resolve => setTimeout(resolve, 100));
    if (failure) throw failure;
    assert(installed, 'Plugin did not install the native hook');
    await window.webContents.executeJavaScript('document.querySelector(".blur").style.transform="translateX(0.01px)"');
    const patched = await capture('native-after');
    console.log('Pixels changed:', !original.equals(patched), 'GPU:', gpu.pid);
    await window.webContents.executeJavaScript('document.querySelector(".blur").style.opacity="0.5"');
    const half = await capture('native-half');
    const alpha = image => image[(130 * 400 + 70) * 4 + 3];
    assert(alpha(patched) > 0 && alpha(patched) < alpha(original), 'Blur did not replace the sharp bar');
    assert(Math.abs(alpha(half) - (alpha(original) + alpha(patched)) / 2) <= 2, 'Half-opacity interpolation failed');
    assert.equal(patched[(42 * 400 + 42) * 4 + 3], 255, 'Rounded corner erased the marker');
    await window.webContents.executeJavaScript('document.querySelector(".blur").style.opacity="0"');
    const zero = await capture('native-zero');
    process.kill(gpu.pid);
    for (let attempt = 0; installed < 2 && !failure && attempt < 100; attempt++)
        await new Promise(resolve => setTimeout(resolve, 100));
    if (failure) throw failure;
    assert(installed >= 2, 'Plugin did not hook the replacement GPU process');
    console.log('GPU restart recovered:', installed >= 2);
    await manager.setEnabled('bedrock.backdrop-blur-fix', false);
    const restoredZero = await capture('native-restored-zero');
    assert(zero.equals(restoredZero), 'Zero-opacity patch changed the backdrop');
    console.log('Zero opacity identical:', zero.equals(restoredZero));
    await window.webContents.executeJavaScript('document.querySelector(".blur").style.opacity="1";document.querySelector(".blur").style.transform="none"');
    const restored = await capture('native-restored');
    assert(restored.equals(original), 'Disabling the plugin did not restore the original image');
    console.log('Restored original:', restored.equals(original));
    await manager.setEnabled('bedrock.backdrop-blur-fix', true);
    for (let attempt = 0; installed < 3 && !failure && attempt < 100; attempt++)
        await new Promise(resolve => setTimeout(resolve, 100));
    if (failure) throw failure;
    assert(installed >= 3, 'Re-enabling did not reuse the mapped DLL');
    await window.webContents.executeJavaScript('document.querySelector(".blur").style.transform="translateX(0.01px)"');
    assert(alpha(await capture('native-reenabled')) < alpha(original), 'Re-enabled hook did not change rendering');
    manager.settings('bedrock.backdrop-blur-fix').set('allowGpuInjection', false);
    await new Promise(resolve => setTimeout(resolve, 300));
    await window.webContents.executeJavaScript('document.querySelector(".blur").style.transform="none"');
    assert((await capture('native-setting-disabled')).equals(original), 'Setting did not restore original rendering');
    manager.settings('bedrock.backdrop-blur-fix').set('allowGpuInjection', true);
    for (let attempt = 0; installed < 4 && !failure && attempt < 100; attempt++)
        await new Promise(resolve => setTimeout(resolve, 100));
    if (failure) throw failure;
    assert(installed >= 4, 'Setting did not re-enable the hook');
    await window.webContents.executeJavaScript('document.querySelector(".blur").style.transform="translateX(0.01px)"');
    assert(alpha(await capture('native-setting-enabled')) < alpha(original), 'Setting did not restore replacement compositing');
    await manager.stopAll();
    console.log('Re-enabled mapped DLL successfully.');

    app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
