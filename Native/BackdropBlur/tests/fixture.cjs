const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const output = path.resolve(process.argv.at(-1));
fs.mkdirSync(output, { recursive: true });
const configuration = process.env.BEDROCK_TEST_CONFIGURATION || 'Release';
assert(['Debug', 'Release'].includes(configuration));
const pluginPath = path.resolve(__dirname, `../../../Launcher/bin/x64/${configuration}/BedrockData/plugins/backdrop-blur/main.js`);
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
    globalThis.Bedrock = {
        OptionType: { BOOLEAN: 'boolean' },
        definePluginSettings: () => ({ store: { allowGpuInjection: true }, subscribe: () => () => {} })
    };
    const plugin = await import(require('node:url').pathToFileURL(pluginPath));
    const abort = new AbortController();
    const cleanup = [];
    let installed = 0;
    let failure;
    plugin.start({ signal: abort.signal, cleanup: dispose => { cleanup.push(dispose); return dispose; },
        requireRestart: reason => { throw new Error(reason); },
        log: { info: message => { console.log(message); if (message.startsWith('Native blur hook installed')) installed++; }, warn: console.warn,
            error: message => { failure = new Error(message); } } });
    for (let attempt = 0; !installed && !failure && attempt < 100; attempt++)
        await new Promise(resolve => setTimeout(resolve, 100));
    if (failure) throw failure;
    assert(installed, 'Plugin did not install the native hook');
    await window.webContents.executeJavaScript('document.querySelector(".blur").style.transform="translateX(0.01px)"');
    const patched = await capture('native-after');
    console.log('Pixels changed:', !original.equals(patched), 'GPU:', gpu.pid);
    const { stdout } = await require('node:util').promisify(require('node:child_process').execFile)(
        path.join(path.dirname(pluginPath), 'native/win32-x64/blur-controller.exe'),
        ['--pid', String(gpu.pid), '--status'], { windowsHide: true });
    console.log('Fixture counters:', stdout.trim());
    assert(Number(/bypass=(\d+)/.exec(stdout)[1]) > 0, 'Fixture did not exercise bypass geometry');
    assert(Number(/replaced=(\d+)/.exec(stdout)[1]) > 0, 'Bypass layers were not replaced');

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
    abort.abort();
    for (const dispose of cleanup.reverse()) dispose();
    await plugin.stop();
    const restoredZero = await capture('native-restored-zero');
    assert(zero.equals(restoredZero), 'Zero-opacity patch changed the backdrop');
    console.log('Zero opacity identical:', zero.equals(restoredZero));
    await window.webContents.executeJavaScript('document.querySelector(".blur").style.opacity="1";document.querySelector(".blur").style.transform="none"');
    const restored = await capture('native-restored');
    assert(restored.equals(original), 'Disabling the plugin did not restore the original image');
    console.log('Restored original:', restored.equals(original));
    app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
