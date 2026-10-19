const test = require('node:test');
const assert = require('node:assert/strict');

test('source patches compose transactionally and failures retain the last valid factory', async () => {
    const { createSourcePatches } = await import('../source-patches.mjs');
    const reports = [];
    const api = createSourcePatches({ report: (id, patches) => reports.push({ id, patches }) });
    api.register('first', { patches: [{ id: 'value', find: 'marker', replacement: { match: '1', replace: '2' } }] });
    api.register('bad', { patches: [{ find: 'marker', replacement: [{ match: '2', replace: '3' }, { match: 'missing', replace: '4' }] }] });
    api.register('last', { patches: [{ find: 'marker', replacement: { match: /value:(\d+)/, replace: 'value:$1+5' } }] });
    const factory = api.apply('42', function (module) { module.exports = { marker: true, value:1 }; });
    const module = {}; factory(module);
    assert.equal(module.exports.value, 7);
    assert.equal(reports.find(report => report.id === 'bad' && report.patches[0].state === 'failed').patches[0].error,
        'bad, patch-1, module 42: Replacement did not match.');
});

test('invalid generated code fails open and shorthand factories compile', async () => {
    const { createSourcePatches } = await import('../source-patches.mjs');
    const api = createSourcePatches();
    api.register('syntax', { patches: [{ find: 'marker', replacement: { match: 'true', replace: ')' } }] });
    const original = { 123(module) { module.exports = { marker: true }; } }[123];
    assert.equal(api.apply('123', original), original);
    const good = createSourcePatches();
    good.register('valid', { patches: [{ find: 'marker', replacement: { match: 'true', replace: 'false' } }] });
    const module = {}; good.apply('123', original)(module); assert.equal(module.exports.marker, false);
});

test('late registration and disabling applied patches require restart and retain namespaces', async () => {
    const { createSourcePatches } = await import('../source-patches.mjs');
    const restarts = [];
    const api = createSourcePatches({ restart: (id, reason) => restarts.push({ id, reason }) });
    const original = function (module) { module.exports = 'marker'; };
    api.executed('early', original);
    const namespace = { patches: [{ find: 'marker', replacement: { match: 'marker', replace: 'changed' } }] };
    api.register('late', namespace);
    assert.equal(restarts.length, 1);
    assert.equal(api.disable('late'), true);
    assert.equal(api.namespace('late'), namespace);
    assert.equal(api.holdsActivation('late'), false);
    const count = restarts.length; api.disable('late'); assert.equal(restarts.length, count);
});

test('applied patches retain helpers and continue patching lazy modules until restart', async () => {
    const { createSourcePatches } = await import('../source-patches.mjs');
    const restarts = [];
    const api = createSourcePatches({ restart: id => restarts.push(id) });
    const namespace = { value: () => 7, patches: [{ find: 'marker', all: true,
        replacement: { match: '1', replace: '$self.value()' } }] };
    api.register('helpers', namespace);
    const original = function (module) { const marker = true; module.exports = 1; };
    const previous = globalThis.Bedrock;
    globalThis.Bedrock = { _sourcePlugin: id => api.namespace(id) };
    try {
        const first = {}; api.apply('first', original)(first);
        assert.equal(first.exports, 7);
        assert.equal(api.holdsActivation('helpers'), true);
        api.forget('helpers');
        assert.equal(api.namespace('helpers'), namespace);
        assert.equal(api.disable('helpers'), true);
        api.disable('helpers');
        assert.deepEqual(restarts, ['helpers']);
        const lazy = {}; api.apply('lazy', original)(lazy);
        assert.equal(lazy.exports, 7);
    } finally { globalThis.Bedrock = previous; }
});

test('waiting source patches can be disabled without modifying future factories', async () => {
    const { createSourcePatches } = await import('../source-patches.mjs');
    const api = createSourcePatches();
    api.register('waiting', { patches: [{ find: 'marker', replacement: { match: '1', replace: '2' } }] });
    assert.equal(api.disable('waiting'), false);
    assert.equal(api.holdsActivation('waiting'), false);
    const original = function (module) { const marker = true; module.exports = 1; };
    assert.equal(api.apply('later', original), original);
    api.forget('waiting');
    assert.equal(api.namespace('waiting'), undefined);
});
