const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { discover } = require('../storage.cjs');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');

test('native startup failures include plugin diagnostics and do not reuse old logs', async () => {
    const child = new EventEmitter();
    child.unref = () => {};
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    let attempts = 0;
    child.stdin = new Writable({ write(bytes, encoding, done) {
        const command = JSON.parse(bytes.toString());
        if (attempts++ === 0) {
            child.stdout.write(JSON.stringify({ event: 'log', level: 3,
                message: 'BlurInstall failed: ERROR_REVISION_MISMATCH (1306).' }) + '\n');
            child.stdout.write(JSON.stringify({ event: 'log', level: 3,
                message: 'SkCanvas::clipRect: no matching machine-code signature.' }) + '\n');
        }
        child.stdout.write(JSON.stringify({ event: 'reply', id: command.id, result: 1 }) + '\n');
        done();
    } });
    const sandbox = { module: { exports: {} }, __dirname: path.resolve(__dirname, '..'),
        setTimeout, clearTimeout, setInterval, clearInterval, Buffer, process,
        require(name) { return name === 'node:child_process' ? { spawn: () => child } : name === './symbols.cjs' ? require('../symbols.cjs') : require(name); } };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../native.cjs'), 'utf8') +
        '\nmodule.exports = connectHost;', sandbox);
    const host = sandbox.module.exports({ pid: 123 }, { environment: 'gpu', path: 'plugin.dll' },
        { registerSettings() {}, log() {} }, {});
    child.stdout.write('{"event":"ready","definitions":{}}\n');
    await host.ready;
    await assert.rejects(host.request('start'), error =>
        error.message.includes('ERROR_REVISION_MISMATCH (1306)') && error.message.includes('SkCanvas::clipRect'));
    await assert.rejects(host.request('start'), error =>
        error.message.includes('without logging a reason') && !error.message.includes('clipRect'));
    host.close(); child.stdout.end(); child.stderr.end();
});

test('native manifests select DLL entry points and obtain API requirements from the DLL', {
    skip: process.platform !== 'win32' || process.arch !== 'x64'
}, t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'Bedrock-native-manifest-'));
    t.after(() => fs.rmSync(root, { recursive: true }));
    const add = (id, entry, environment = 'gpu') => {
        const folder = path.join(root, 'plugins', id);
        fs.mkdirSync(folder, { recursive: true });
        fs.writeFileSync(path.join(folder, 'plugin.dll'), 'discovery does not execute this file');
        fs.writeFileSync(path.join(folder, 'plugin.json'), JSON.stringify({ manifestVersion: 2,
            id, name: id, version: '1.0.0', entrypoints: { [environment]: entry } }));
    };
    add('test.gpu', { runtime: 'native', path: 'plugin.dll' });
    add('test.main', { runtime: 'native', path: 'plugin.dll' }, 'main');
    add('test.renderer', { runtime: 'native', path: 'plugin.dll' }, 'renderer');
    add('test.requirement', { runtime: 'native', path: 'plugin.dll', requiresApi: '1.0.0' });
    add('test.extension', { runtime: 'native', path: 'plugin.js' });
    add('test.gpujs', { runtime: 'javascript', path: 'plugin.dll', requiresApi: '1.0.0' });
    const result = discover(root);
    assert.deepEqual([...result.plugins.keys()].sort(), ['test.gpu', 'test.main', 'test.renderer']);
    assert.equal(result.errors.length, 3);
    assert(result.errors.some(error => error.error.includes('DLL descriptor')));
    assert(result.errors.some(error => error.error.includes('end in .dll')));
    assert(result.errors.some(error => error.error.includes('GPU entry points')));
});
