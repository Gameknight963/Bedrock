const test = require('node:test');
const assert = require('node:assert/strict');
const { unloadPlugin, createUnloadContext } = require('../lifecycle.mjs');

test('unload awaits cleanup and accepts restart requests only through its context', async () => {
    const reasons = [];
    const ctx = createUnloadContext({id:'test.unload'}, {}, reason => reasons.push(reason));
    assert.equal((await unloadPlugin(async () => {}, ctx)).requiresRestart, false);
    assert.equal((await unloadPlugin(ctx => ctx.requireRestart('Pending finalizers'), ctx)).reason, 'Pending finalizers');
    assert.deepEqual(reasons, ['Pending finalizers']);
    assert.match((await unloadPlugin(() => ({requiresRestart:true}), ctx)).reason, /must return nothing/);
    assert.match((await unloadPlugin(() => { throw new Error('failed'); }, ctx)).reason, /failed/);
    assert.match((await unloadPlugin(() => { throw null; }, ctx)).reason, /null/);
});

test('unload timeout requests restart instead of proceeding with live work', async () => {
    const reasons = [];
    const result = await unloadPlugin(() => new Promise(() => {}), {requireRestart: reason => reasons.push(reason)}, 5);
    assert.equal(result.requiresRestart, true);
    assert.match(result.reason, /did not finish/);
    assert.deepEqual(reasons, [result.reason]);
});
