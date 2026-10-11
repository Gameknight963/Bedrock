const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { archive } = require('./collection-fixture.cjs');
const { createCollection, extractPackage, validateCatalog } = require('../collection.cjs');
const { createPluginManager } = require('../plugins.cjs');
const { writeJson } = require('../storage.cjs');

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'Bedrock-collection-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const manifest = { manifestVersion: 2, id: 'test.download', name: 'Downloaded', version: '1.0.0',
        entrypoints: { main: { runtime: 'javascript', path: 'main.js', requiresApi: '1.0.0' } }, readme: 'README.md', license: 'MIT' };
    const bytes = archive([['package/plugin.json', JSON.stringify(manifest)], ['package/main.js', 'export function start(ctx) { ctx.settings.set("ran", true); }'], ['package/README.md', '# Downloaded'], ['package/LICENSE', 'MIT']]);
    const entry = { manifest, readme: '# Downloaded', package: { url: 'https://github.com/bedrock-client/bedrock-plugins/releases/download/collection-2026-10-10-1/test.download-1.0.0.zip', size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') } };
    const catalog = { catalogVersion: 1, plugins: [entry] };
    const requested = [];
    let offline = false;
    const fetch = async url => {
        requested.push(url);
        if (offline) throw new Error('Offline');
        if (url.endsWith('/latest')) return Response.json({ assets: [{ name: 'catalog.json', browser_download_url: 'https://github.com/bedrock-client/bedrock-plugins/releases/download/collection-2026-10-10-1/catalog.json' }] });
        return url.endsWith('/catalog.json') ? Response.json(catalog) : new Response(bytes);
    };
    return { root, manifest, bytes, catalog, requested, fetch, offline() { offline = true; } };
}

test('browsing fetches only the catalog, reuses cache and falls back offline', async t => {
    const data = fixture(t);
    const collection = createCollection(data.root, {}, { fetch: data.fetch });
    assert.equal((await collection.load()).plugins.length, 1);
    assert.equal(data.requested.length, 2);
    await collection.load();
    assert.equal(data.requested.length, 2);
    data.offline();
    const offline = await createCollection(data.root, {}, { fetch: data.fetch }).load(true);
    assert.equal(offline.cached, true);
    assert.match(offline.warning, /Offline/);
});

test('download verifies and installs a plugin, then enables it', async t => {
    const data = fixture(t);
    const manager = createPluginManager(data.root, { log() {} });
    manager.scan();
    const collection = createCollection(data.root, manager, { fetch: data.fetch });
    await collection.install(data.manifest.id);
    assert.equal(manager.list()[0].manifest.id, data.manifest.id);
    assert.equal(manager.list()[0].enabled, true);
    assert.equal(manager.settings(data.manifest.id).get('ran'), true);
    assert.equal(fs.existsSync(path.join(data.root, 'plugins', data.manifest.id, 'LICENSE')), true);
    assert.deepEqual(fs.readdirSync(path.join(data.root, 'cache')).filter(name => name.startsWith('install-')), []);
    await manager.stopAll();
});

test('checksum mismatch cannot install files or execute plugin code', async t => {
    const data = fixture(t);
    data.catalog.plugins[0].package.sha256 = '0'.repeat(64);
    const collection = createCollection(data.root, { installPackage() { assert.fail('Must not install'); } }, { fetch: data.fetch });
    await assert.rejects(collection.install(data.manifest.id), /checksum/);
    assert.equal(fs.existsSync(path.join(data.root, 'plugins')), false);
});

test('ZIP extraction rejects traversal, alternate streams, multiple roots, duplicates and corrupt contents', async t => {
    const data = fixture(t);
    const invalid = [
        [['package/../outside', 'bad']], [['package/C:outside', 'bad']], [['package/a\\b', 'bad']],
        [['one/a', 'a'], ['two/b', 'b']], [['package/a', 'a'], ['package/A', 'b']]
    ];
    for (const entries of invalid) await assert.rejects(extractPackage(archive(entries), path.join(data.root, crypto.randomUUID())), /unsafe|duplicate/);
    const corrupt = archive([['package/a', 'test']]);
    corrupt[30 + 'package/a'.length] ^= 1;
    await assert.rejects(extractPackage(corrupt, path.join(data.root, 'corrupt')), /checksum/);
    await assert.rejects(extractPackage(Buffer.alloc(2), data.root), /Invalid ZIP/);
    assert.equal(fs.existsSync(path.join(data.root, 'outside')), false);
});

test('catalog rejects mismatched package URLs and duplicate IDs', t => {
    const data = fixture(t);
    const mismatch = structuredClone(data.catalog);
    mismatch.plugins[0].package.url = 'https://example.com/test.zip';
    assert.throws(() => validateCatalog(mismatch), /Invalid/);
    data.catalog.plugins.push(data.catalog.plugins[0]);
    assert.throws(() => validateCatalog(data.catalog), /Invalid/);
});

test('updating preserves settings and enable state but waits for restart before executing new code', async t => {
    const data = fixture(t);
    const manager = createPluginManager(data.root, { log() {} });
    manager.scan();
    const collection = createCollection(data.root, manager, { fetch: data.fetch });
    await collection.install(data.manifest.id);
    manager.settings(data.manifest.id).set('saved', 42);
    const staged = path.join(data.root, 'staged');
    fs.mkdirSync(staged);
    writeJson(path.join(staged, 'plugin.json'), { ...data.manifest, version: '1.1.0' });
    fs.writeFileSync(path.join(staged, 'main.js'), 'export function start(ctx) { ctx.settings.set("newCode", true); }');
    fs.writeFileSync(path.join(staged, 'README.md'), '# New');
    await manager.installPackage(staged, data.manifest.id);
    assert.equal(manager.list()[0].manifest.version, '1.1.0');
    assert.equal(manager.list()[0].enabled, true);
    assert.match(manager.list()[0].restartReason, /Restart/);
    assert.equal(manager.settings(data.manifest.id).get('saved'), 42);
    assert.equal(manager.settings(data.manifest.id).get('newCode'), undefined);
    await manager.setEnabled(data.manifest.id, true);
    assert.equal(manager.settings(data.manifest.id).get('newCode'), undefined);
    const script = `const { createPluginManager } = require(${JSON.stringify(require.resolve('../plugins.cjs'))});
        const manager = createPluginManager(process.argv[1], { log() {} }); manager.scan();
        console.log(JSON.stringify({ ran: manager.settings('test.download').get('newCode'), saved: manager.settings('test.download').get('saved'), restart: manager.list()[0].restartReason }));`;
    const reopened = JSON.parse(execFileSync(process.execPath, ['-e', script, data.root], { encoding: 'utf8' }));
    assert.deepEqual(reopened, { ran: true, saved: 42, restart: null });
});


test('failed replacement restores the previous files and enable state', async t => {
    const data = fixture(t);
    const manager = createPluginManager(data.root, { log() {} });
    manager.scan();
    await createCollection(data.root, manager, { fetch: data.fetch }).install(data.manifest.id);
    const staged = path.join(data.root, 'staged');
    fs.mkdirSync(staged);
    writeJson(path.join(staged, 'plugin.json'), { ...data.manifest, version: '1.1.0' });
    const rename = fs.renameSync;
    t.mock.method(fs, 'renameSync', (source, target) => {
        if (source === staged) throw new Error('File is locked');
        return rename(source, target);
    });
    await assert.rejects(manager.installPackage(staged, data.manifest.id), /File is locked/);
    assert.equal(manager.list()[0].manifest.version, '1.0.0');
    assert.equal(manager.list()[0].enabled, true);
    assert.equal(fs.existsSync(path.join(data.root, 'plugins', data.manifest.id, 'main.js')), true);
    await manager.stopAll();
});
