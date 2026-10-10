const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { createJsSession, createJsTransport, rendererJsRequest } = require('../javascript.cjs');
const text = value => ({ type: 4, value: Buffer.from(value).toString('hex') });
const evaluate = (session, body, args = []) => session.prepare(body, args)();

test('native JS values preserve primitives, NULs and BigInts without awaiting promises', () => {
    const session = createJsSession();
    for (const [source, expected] of [
        ['', { type: 0 }], ['return null', { type: 1 }], ['return true', { type: 2, value: true }],
        ['return 1 + 2', { type: 3, value: 3 }], ['return NaN', { type: 3, value: 'NaN' }],
        ['return -0', { type: 3, value: '-0' }], ['return Infinity', { type: 3, value: 'Infinity' }],
        ['return -Infinity', { type: 3, value: '-Infinity' }],
        ['return "a\\0b"', text('a\0b')], ['return 123456789012345678901234567890n',
            { type: 5, value: Buffer.from('123456789012345678901234567890').toString('hex') }]
    ]) assert.deepEqual(evaluate(session, source), expected);
    for (const source of ['return {}', 'return () => 3', 'return Promise.resolve(3)', 'return Symbol("test")']) {
        const reference = evaluate(session, source);
        assert.equal(reference.type, 6);
        assert.equal(evaluate(session, 'return args[0] === args[1]', [reference, reference]).value, true);
        assert(session.release(reference.value));
        assert.throws(() => evaluate(session, 'return args[0]', [reference]), error => session.error(error).code === 3);
    }
});

test('prepared native requests pin references and closing a session rejects late work', () => {
    const session = createJsSession();
    const object = evaluate(session, 'return { value: 42 }');
    const execute = session.prepare('return args[0].value', [object]);
    session.release(object.value);
    assert.equal(execute().value, 42);
    session.close();
    assert.throws(execute, error => session.error(error).code === 6);
    assert.throws(() => session.prepare('', []), error => session.error(error).code === 6);
    const other = createJsSession();
    assert.throws(() => evaluate(other, 'return args[0]', [text('x').value]), error => other.error(error).code === 4);
    assert.throws(() => evaluate(other, 'return args[0]', [{ type: 4, value: 'ff' }]), error => other.error(error).code === 4);
    assert.throws(() => evaluate(other, 'return args[0]', [{ type: 5, value: Buffer.from('0xff').toString('hex') }]), error => other.error(error).code === 4);
    const spoof = new Error('ordinary exception'); spoof.code = 3;
    assert.equal(other.error(spoof).code, 1);
});

test('native JS async transport cancels queued work and reports thrown values', async () => {
    const bridge = createJsTransport('main', {}, {});
    let replies = 0;
    globalThis.bedrockCancelledTest = 0;
    bridge.execute({ id: '1', body: 'globalThis.bedrockCancelledTest++; return 3', arguments: [] }, () => replies++);
    bridge.cancel('1');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(globalThis.bedrockCancelledTest, 0);
    assert.equal(replies, 0);
    const result = await new Promise(resolve => bridge.execute({ id: '2', body: 'throw new Error("fixture")', arguments: [] }, resolve));
    assert.equal(result.code, 1); assert.match(result.message, /fixture/);
    const unreadable = createJsSession().error({ get stack() { throw 0; }, get code() { throw 0; }, toString() { throw 0; } });
    assert.equal(unreadable.code, 1); assert.match(unreadable.message, /unreadable/);
    bridge.close(); delete globalThis.bedrockCancelledTest;
});

test('renderer transport uses page globals, preserves identity and returns preparation errors', async () => {
    const page = vm.createContext({ TextEncoder, TextDecoder, pageValue: 42 });
    const options = { nativeJavaScript(target, identity, op, message) {
        return Promise.resolve(vm.runInContext(`(${rendererJsRequest})(${createJsSession}, ${JSON.stringify(identity)},
            ${JSON.stringify(op)}, ${JSON.stringify(message)})`, page));
    } };
    const bridge = createJsTransport('renderer', {}, options);
    const execute = (id, body, arguments_ = []) => new Promise(resolve => bridge.execute({ id, body, arguments: arguments_ }, resolve));
    assert.equal((await execute('1', 'return pageValue')).value.value, 42);
    const object = (await execute('2', 'return { foo: 5 }')).value;
    assert.equal((await execute('3', 'return args[0].foo', [object])).value.value, 5);
    bridge.release(object.value);
    assert.equal((await execute('4', 'return args[0]', [object])).code, 3);
    const promise = (await execute('5', 'return Promise.resolve(42)')).value;
    assert.equal(promise.type, 6);
    bridge.close();
});

test('renderer cancellation suppresses late results and releases returned handles', async () => {
    const page = vm.createContext({ TextEncoder, TextDecoder });
    let finish, releases = 0, replies = 0;
    const options = { async nativeJavaScript(target, identity, op, message) {
        const result = vm.runInContext(`(${rendererJsRequest})(${createJsSession}, ${JSON.stringify(identity)},
            ${JSON.stringify(op)}, ${JSON.stringify(message)})`, page);
        if (op === 'execute') await new Promise(resolve => { finish = resolve; });
        if (op === 'release') releases++;
        return result;
    } };
    const bridge = createJsTransport('renderer', {}, options);
    bridge.execute({ id: '1', body: 'return {}', arguments: [] }, () => replies++);
    while (!finish) await new Promise(resolve => setImmediate(resolve));
    bridge.cancel('1'); finish();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(replies, 0); assert.equal(releases, 1);
    bridge.close();
});

test('renderer navigation cannot reuse a handle from the previous document', async () => {
    let page = vm.createContext({ TextEncoder, TextDecoder });
    const bridge = createJsTransport('renderer', {}, { nativeJavaScript(target, identity, op, message) {
        return Promise.resolve(vm.runInContext(`(${rendererJsRequest})(${createJsSession}, ${JSON.stringify(identity)},
            ${JSON.stringify(op)}, ${JSON.stringify(message)})`, page));
    } });
    const execute = (id, body, arguments_ = []) => new Promise(resolve => bridge.execute({ id, body, arguments: arguments_ }, resolve));
    const old = (await execute('1', 'return {}')).value;
    page = vm.createContext({ TextEncoder, TextDecoder });
    const current = (await execute('2', 'return {}')).value;
    assert.notEqual(old.value, current.value);
    assert.equal((await execute('3', 'return args[0]', [old])).code, 3);
    bridge.close();
});
