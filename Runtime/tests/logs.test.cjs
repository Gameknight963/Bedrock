const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createLogFeed } = require('../logs.cjs');

test('file logging is configured by its caller and rotates once per session', t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'Bedrock-logs-'));
    const directory = path.join(root, 'logs');
    const latest = path.join(directory, 'latest.log');
    fs.mkdirSync(directory);
    fs.writeFileSync(latest, 'previous session');
    const original = {};
    for (const level of ['log', 'info', 'warn', 'error', 'debug']) original[level] = console[level];
    t.after(() => {
        Object.assign(console, original);
        fs.rmSync(root, { recursive: true, force: true });
    });
    const feed = createLogFeed(root);
    feed.publish({ level: 'info', text: 'before configuration', bedrock: true });
    assert.equal(fs.readFileSync(latest, 'utf8'), 'previous session');
    feed.configureFile({ enabled: true, discord: false });
    feed.publish({ level: 'info', text: 'first entry', bedrock: true });
    feed.configureFile({ enabled: false });
    feed.configureFile({ enabled: true, discord: false });
    feed.publish({ level: 'info', text: 'second entry', bedrock: true });
    feed.publish({ level: 'info', text: 'Discord entry', bedrock: false });
    const archives = fs.readdirSync(directory).filter(name => name !== 'latest.log');
    assert.equal(archives.length, 1);
    assert.equal(fs.readFileSync(path.join(directory, archives[0]), 'utf8'), 'previous session');
    const saved = fs.readFileSync(latest, 'utf8');
    assert.match(saved, /first entry/);
    assert.match(saved, /second entry/);
    assert.doesNotMatch(saved, /Discord entry/);
});
