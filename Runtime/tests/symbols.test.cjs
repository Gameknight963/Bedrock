const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { prepareReference, waitForReference } = require('../symbols.cjs');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');

test('verified reference cache is reused without network access', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'Bedrock-symbol-cache-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const folder = path.join(root, 'electron', '42.11.10', 'win32-x64');
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'electron.exe'), 'reference image');
    fs.writeFileSync(path.join(folder, 'electron.exe.sym'), 'reference symbols');
    fs.writeFileSync(path.join(folder, 'reference.json'), JSON.stringify({ version: '42.11.10', image: hash('reference image'), symbols: hash('reference symbols') }));
    const original = global.fetch;
    global.fetch = () => { throw new Error('A cache hit must not download anything'); };
    t.after(() => { global.fetch = original; });
    const result = await prepareReference('42.11.10', root, () => assert.fail('Unexpected download log'));
    assert.equal(result.image, path.join(folder, 'electron.exe'));
    assert.equal(result.symbols, path.join(folder, 'electron.exe.sym'));
});

test('download checksum failures leave no partial reference or download directory', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'Bedrock-symbol-checksum-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const version = '42.11.10';
    const original = global.fetch;
    global.fetch = async url => new Response(url.endsWith('SHASUMS256.txt') ?
        `${hash('expected')}  electron-v${version}-win32-x64.zip\n${hash('expected')}  electron-v${version}-win32-x64-symbols.zip\n` : 'wrong archive');
    t.after(() => { global.fetch = original; });
    await assert.rejects(prepareReference(version, root, () => {}), /checksum differs/);
    assert.deepEqual(fs.readdirSync(path.join(root, 'electron', version)), []);
});

test('cancelling a plugin stops its reference wait without cancelling shared preparation', async () => {
    let complete;
    const pending = new Promise(resolve => { complete = resolve; });
    const abort = new AbortController();
    const waiting = waitForReference(pending, abort.signal);
    abort.abort(new Error('Plugin disabled'));
    await assert.rejects(waiting, /Plugin disabled/);
    complete({ image: 'image', symbols: 'symbols' });
    assert.deepEqual(await pending, { image: 'image', symbols: 'symbols' });
});

test('unsupported Electron version strings fail before accessing the network', async () => {
    await assert.rejects(prepareReference('../42.11.10', os.tmpdir(), () => {}), /release version/);
});
