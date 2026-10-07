const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createThemeManager } = require('../themes.cjs');

test('themes are discovered disabled, metadata is read, and enabled state survives reopening', t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'Bedrock-themes-'));
    const manager = createThemeManager(root);
    t.after(() => { manager.close(); fs.rmSync(root, { recursive: true, force: true }); });
    fs.writeFileSync(path.join(manager.directory, 'sample.theme.css'), '/**\n * @name My theme\n * @author Example Author\n * @description A sample theme.\n * @website https://example.com/theme\n */\nbody { color: red; }');
    manager.scan();
    assert.equal(manager.list()[0].name, 'My theme');
    assert.equal(manager.list()[0].author, 'Example Author');
    assert.equal(manager.list()[0].website, 'https://example.com/theme');
    assert.equal(manager.list()[0].enabled, false);
    assert.throws(() => manager.setEnabled('../missing.css', true), /Unknown theme/);
    manager.setEnabled('sample.theme.css', true);
    manager.close();
    const reopened = createThemeManager(root);
    t.after(() => reopened.close());
    reopened.scan();
    assert.equal(reopened.list()[0].enabled, true);
});

test('watcher discovers additions, reloads edits and removes deleted themes', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'Bedrock-theme-watch-'));
    const manager = createThemeManager(root);
    t.after(() => { manager.close(); fs.rmSync(root, { recursive: true, force: true }); });
    const waitFor = async predicate => {
        const deadline = Date.now() + 5000;
        while (!predicate()) {
            if (Date.now() > deadline) throw new Error('Theme watcher did not update');
            await new Promise(resolve => setTimeout(resolve, 30));
        }
    };
    manager.scan();
    const file = path.join(manager.directory, 'live.css');
    fs.writeFileSync(file, 'body { color: red; }');
    await waitFor(() => manager.list().length === 1);
    const url = manager.list()[0].url;
    fs.writeFileSync(file, 'body { color: green; }');
    await waitFor(() => manager.list()[0].url !== url);
    fs.unlinkSync(file);
    await waitFor(() => manager.list().length === 0);
});
