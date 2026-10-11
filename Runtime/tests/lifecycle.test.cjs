const test = require('node:test');
const assert = require('node:assert/strict');
const { unloadPlugin } = require('../lifecycle.mjs');

test('unload awaits asynchronous cleanup and accepts restart outcomes', async () => {
    assert.deepEqual(await unloadPlugin(async () => {}), { requiresRestart: false });
    assert.equal((await unloadPlugin(() => ({ requiresRestart: true, reason: 'Pending finalizers' }))).reason, 'Pending finalizers');
    assert.equal((await unloadPlugin(() => 'invalid')).requiresRestart, true);
    assert.match((await unloadPlugin(() => { throw new Error('failed'); })).reason, /failed/);
    assert.match((await unloadPlugin(() => { throw null; })).reason, /null/);
});

test('unload timeout defers removal instead of proceeding with live work', async () => {
    const result = await unloadPlugin(() => new Promise(() => {}), 5);
    assert.equal(result.requiresRestart, true);
    assert.match(result.reason, /did not finish/);
});
