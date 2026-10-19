const test = require('node:test');
const assert = require('node:assert/strict');

async function fixture() {
    const { createRendererApis } = await import('../renderer-apis.mjs');
    const errors = [], disposers = [];
    const React = {
        isValidElement: value => value?.element === true,
        createElement: (type, props) => ({ element: true, type, key: props?.key ?? null, props }),
        cloneElement: (node, props) => ({ ...node, props: { ...node.props, ...props } }),
        memo: (type, compare) => ({ $$typeof: Symbol.for('react.memo'), type, compare }),
        forwardRef: render => ({ $$typeof: Symbol.for('react.forward_ref'), render })
    };
    const api = createRendererApis({ react: () => React, report: (id, error) => errors.push({ id, error }) });
    const context = id => api.context(id, callback => { disposers.push(callback); return callback; }, new AbortController().signal);
    return { api, context, React, errors, dispose() { for (const callback of disposers.splice(0).reverse()) callback(); } };
}

test('message hooks await in registration order and intercept getter exports', async () => {
    const f = await fixture();
    const order = [], sent = [];
    const actions = {};
    Object.defineProperties(actions, {
        sendMessage: { get: () => function (...args) { sent.push(args); return args[1].content; } },
        editMessage: { get: () => (...args) => { sent.push(args); return args[2].content; } }
    });
    const namespace = f.api.observe({ default: actions });
    f.context('first').messages.beforeSend(async event => {
        await Promise.resolve(); order.push('first'); event.message.content += ' one';
    });
    f.context('second').messages.beforeSend(event => { order.push('second'); event.message.content += ' two'; });
    f.context('edit').messages.beforeEdit(event => {
        assert.equal(event.channelId, 'channel'); assert.equal(event.messageId, 'message');
        event.message.content = 'edited';
    });
    const draft = { content: 'original', tts: true };
    assert.equal(await namespace.default.sendMessage('channel', draft, { extra: true }), 'original one two');
    assert.deepEqual(order, ['first', 'second']);
    assert.equal(draft.content, 'original');
    assert.equal(sent[0][1].tts, true); assert.deepEqual(sent[0][2], { extra: true });
    assert.equal(await namespace.default.editMessage('channel', 'message', draft), 'edited');
    f.dispose();
    assert.equal(namespace.default.sendMessage('channel', draft), 'original', 'unhooked calls preserve synchronous return values');
});

test('cancellation and failed hooks cannot send partially transformed content', async () => {
    const f = await fixture();
    let sends = 0;
    const actions = f.api.observe({ sendMessage() { sends++; }, editMessage() {} });
    const stop = f.context('cancel').messages.beforeSend(event => { event.message.content = 'changed'; event.cancel(); });
    await assert.rejects(actions.sendMessage('channel', { content: 'original' }), { name: 'BedrockMessageCancelledError' });
    assert.equal(sends, 0); stop();
    f.context('broken').messages.beforeSend(() => { throw new Error('bad transform'); });
    await assert.rejects(actions.sendMessage('channel', { content: 'original' }), /broken: send hook failed: bad transform/);
    assert.equal(sends, 0); assert.equal(f.errors[0].id, 'broken');
});

test('disabling during an async hook discards its late changes', async () => {
    const f = await fixture();
    let finish;
    const pause = new Promise(resolve => { finish = resolve; });
    const actions = f.api.observe({ sendMessage: (_, message) => message.content, editMessage() {} });
    f.context('waiting').messages.beforeSend(async event => { await pause; event.message.content = 'late'; event.cancel(); });
    const result = actions.sendMessage('channel', { content: 'original' });
    f.dispose(); finish();
    assert.equal(await result, 'original');
});

test('menu patches preserve original elements, user context, and item component identity', async () => {
    const f = await fixture();
    function Item() {} function Menu() {}
    const original = f.React.createElement(Item, { id: 'original', label: 'Original', action() {} });
    const originalChildren = Object.freeze([original]);
    function UserMenu(props) { return f.React.createElement(Menu, { navId: 'user-context', children: originalChildren }); }
    const ctx = f.context('links');
    ctx.contextMenus.patch('user-context', (children, props) => {
        assert.equal(props.user.id, 'user');
        children.push(ctx.contextMenus.item({ id: 'copy-url', label: 'Copy User URL', action() {} }));
    });
    const actions = f.api.observe({ openContextMenu: (_, render) => render(), closeContextMenu() {} });
    const element = actions.openContextMenu({}, () => f.React.createElement(UserMenu, { user: { id: 'user' } }));
    const rendered = element.type(element.props);
    assert.equal(rendered.props.children.length, 2);
    assert.equal(rendered.props.children[1].type, Item);
    assert.equal(rendered.props.children[1].props.label, 'Copy User URL');
    assert.equal(originalChildren.length, 1);
    f.dispose();
    const unchanged = actions.openContextMenu({}, () => f.React.createElement(UserMenu, {}));
    assert.equal(unchanged.type, UserMenu);
});

test('failed menu patches roll back individually and lazy menus retain custom controls', async () => {
    const f = await fixture();
    function Item() {} function Menu() {} function Control() {}
    const children = [f.React.createElement(Item, { id: 'one', label: 'One', action() {} }),
        f.React.createElement(Control, { id: 'volume', control() {} })];
    f.context('broken').contextMenus.patch('voice-context', draft => { draft.pop(); throw new Error('failed'); });
    f.context('working').contextMenus.patch('voice-context', draft => draft.push(f.React.createElement(Item, { id: 'two', label: 'Two', action() {} })));
    const actions = f.api.observe({ openContextMenuLazy: async (_, load) => (await load())() });
    const rendered = await actions.openContextMenuLazy({}, async () => () => f.React.createElement(Menu, { navId: 'voice-context', children }));
    assert.equal(rendered.props.children.length, 3);
    assert.equal(rendered.props.children[1].type, Control);
    assert.equal(f.errors[0].id, 'broken');
});

test('unrelated exports and frozen data properties keep their identity', async () => {
    const f = await fixture();
    const unrelated = { createElement() {}, hooks: {} };
    assert.equal(f.api.observe(unrelated), unrelated);
    const actions = Object.freeze({ sendMessage() {}, editMessage() {} });
    assert.equal(f.api.observe(actions).sendMessage, actions.sendMessage);
});

test('explicit sending supplies Discord defaults, runs message hooks and rejects stopped contexts', async () => {
    const { createRendererApis } = await import('../renderer-apis.mjs');
    const controller = new AbortController();
    const api = createRendererApis({ react: () => null });
    const ctx = api.context('sender', callback => callback, controller.signal);
    await assert.rejects(ctx.messages.send('channel', { content: 'text' }), /have not loaded/);
    const sent = [];
    api.observe({ sendMessage(...args) { sent.push(args); }, editMessage() {} });
    ctx.messages.beforeSend(event => { event.message.content += '!'; });
    await ctx.messages.send('channel', { content: 'text' });
    assert.deepEqual(sent[0], ['channel', { content: 'text!', invalidEmojis: [], validNonShortcutEmojis: [], tts: false }, undefined, {}]);
    controller.abort();
    await assert.rejects(ctx.messages.send('channel', { content: 'text' }), /has stopped/);
    assert.equal(sent.length, 1);
});

test('disabling an explicit sender during another plugin hook prevents the late send', async () => {
    const { createRendererApis } = await import('../renderer-apis.mjs');
    const api = createRendererApis({ react: () => null });
    const sender = new AbortController();
    const sending = api.context('sender', callback => callback, sender.signal);
    const modifying = api.context('modifier', callback => callback, new AbortController().signal);
    let finish, calls = 0;
    api.observe({ sendMessage() { calls++; }, editMessage() {} });
    modifying.messages.beforeSend(() => new Promise(resolve => { finish = resolve; }));
    const result = sending.messages.send('channel', { content: 'text' });
    sender.abort(); finish();
    await assert.rejects(result, /has stopped/);
    assert.equal(calls, 0);
});
