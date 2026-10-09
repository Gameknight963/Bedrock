const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { discover } = require('../storage.cjs');

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
