const test = require('node:test');
const assert = require('node:assert/strict');

async function fixture(source = 'r.e("lazy").then(r.bind(r,"entry"))') {
    const { createChunkLoader } = await import('../webpack-chunks.mjs');
    const originals = new WeakMap(), calls = [], controller = new AbortController();
    const loader = createChunkLoader({ original: factory => originals.get(factory) || factory });
    const wrapped = () => { throw new Error('Marker factory must not execute'); };
    originals.set(wrapped, new Function(`/* fixture-marker */ return ${source};`));
    const runtime = id => { calls.push(`execute:${id}`); };
    runtime.m = { marker: wrapped };
    runtime.e = async id => { calls.push(`load:${id}`); runtime.m.entry = () => {}; };
    loader.register(runtime);
    return { loader, runtime, calls, controller, load: options => loader.load(options || { find: 'fixture-marker' }, controller.signal) };
}

test('chunk loading reads original factories, follows only the selected instruction and executes its entry', async () => {
    const f = await fixture('Promise.all([r.e(123), r.e("other"), r.e(123)]).then(r.bind(r,"entry"))');
    await f.load();
    assert.deepEqual(f.calls, ['load:123', 'load:other', 'execute:entry']);
    await f.load({ find: ['fixture-marker', 'other'] });
    assert.equal(f.calls.at(-1), 'execute:entry');
});

test('custom chunk matcher chooses a later instruction and supports an already registered entry', async () => {
    const f = await fixture('r.e("first").then(r.bind(r,"unused")); /* selected */ Promise.resolve().then(r.bind(r,"entry"))');
    f.runtime.m.entry = () => {};
    await f.load({ find: 'fixture-marker', match: /selected \*\/ Promise\.resolve\(\)().then\(r.bind\(r,("entry")\)\)/ });
    assert.deepEqual(f.calls, ['execute:entry']);
});

test('errors distinguish markers, ambiguous factories, instructions, chunk downloads, entry modules and execution', async () => {
    const f = await fixture();
    await assert.rejects(f.load({ find: 'absent' }), /No Discord module/);
    f.runtime.m.duplicate = f.runtime.m.marker;
    await assert.rejects(f.load(), /matches 2/); delete f.runtime.m.duplicate;
    await assert.rejects(f.load({ find: 'fixture-marker', match: /absent/ }), /No recognized/);
    f.runtime.e = async () => { throw new Error('network failed'); };
    await assert.rejects(f.load(), /Could not load chunks.*network failed/);
    f.runtime.e = async () => {};
    await assert.rejects(f.load(), /did not provide.*entry/);
    const { createChunkLoader } = await import('../webpack-chunks.mjs');
    const loader = createChunkLoader();
    const runtime = () => { throw new Error('initialization failed'); };
    runtime.m = { marker() { /* marker */ return r.e('chunk').then(r.bind(r, 'entry')); }, entry() {} }; runtime.e = async () => {};
    loader.register(runtime);
    await assert.rejects(loader.load({ find: '/* marker */' }, new AbortController().signal), /entry module entry failed.*initialization failed/);
});

test('cancellation rejects promptly and never executes a late entry module', async () => {
    const f = await fixture(); let finish;
    f.runtime.e = () => new Promise(resolve => { finish = () => { f.runtime.m.entry = () => {}; resolve(); }; });
    const loading = f.load();
    f.controller.abort(); await assert.rejects(loading, { name: 'AbortError' });
    finish(); await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(f.calls, []);
    await assert.rejects(f.load(), { name: 'AbortError' });
});

test('requests made before runtime capture wait and can be canceled', async () => {
    const { createChunkLoader } = await import('../webpack-chunks.mjs');
    const loader = createChunkLoader();
    const controller = new AbortController();
    const canceled = loader.load({ find: 'marker' }, controller.signal);
    controller.abort(); await assert.rejects(canceled, { name: 'AbortError' });
    const loaded = loader.load({ find: '/* marker */' }, new AbortController().signal);
    const runtime = () => {};
    runtime.m = { marker() { /* marker */ return Promise.resolve().then(r.bind(r, 'entry')); }, entry() {} };
    loader.register(runtime); await loaded;
});

test('invalid options and matcher captures reject without executing code', async () => {
    const f = await fixture();
    for (const find of ['', [], [''], null]) await assert.rejects(f.load({ find }), /nonempty/);
    await assert.rejects(f.load({ find: 'fixture-marker', match: 'text' }), /regular expression/);
    await assert.rejects(f.load({ find: 'fixture-marker', match: /(fixture)-(marker)/ }), /invalid module or chunk ID/);
});
