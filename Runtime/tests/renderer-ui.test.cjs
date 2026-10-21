const test = require('node:test');
const assert = require('node:assert/strict');

test('shared color picker capture composes with plugin hooks and guards stale callbacks', async () => {
    const { createRendererUi } = await import('../renderer-ui.mjs');
    const { createSourcePatches } = await import('../source-patches.mjs');
    const React = {
        useSyncExternalStore: (_subscribe, snapshot) => snapshot(), useState: value => [value, () => {}], useEffect() {},
        createElement: (type, props) => ({ type, props })
    };
    for (const reverse of [false, true]) {
        const errors = [], ui = createRendererUi({ react: () => React, report: (id, error) => errors.push([id, error.message]) });
        let pluginPicker;
        const plugin = { capture(component) { pluginPicker = component; }, patches: [{ find: '.Qp04hK}),focusProps:', replacement: {
            match: /(?=function ([A-Za-z_$][\w$]*)\([A-Za-z_$][\w$]*\)\{let\{onChange:[A-Za-z_$][\w$]*,onClose:[A-Za-z_$][\w$]*,[^}]+?showEyeDropper:)/,
            replace: '$self.capture($1);'
        } }] };
        const source = createSourcePatches();
        for (const [id, namespace] of reverse ? [['plugin', plugin], ['$ui', ui]] : [['$ui', ui], ['plugin', plugin]]) source.register(id, namespace);
        const previous = globalThis.Bedrock;
        globalThis.Bedrock = { _rendererUi: ui, _sourcePlugin: id => source.namespace(id) };
        try {
            const factory = function(module) {
                const marker = '.Qp04hK}),focusProps:';
                function picker(e){let{onChange:n,onClose:c,color:r,showEyeDropper:d}=e;return r;}
                module.exports = picker;
            };
            const module = {}; source.apply('native-picker', factory)(module);
            assert.equal(pluginPicker, module.exports);
            const abort = new AbortController(), ctx = ui.context('test.picker', value => value, abort.signal);
            let selected;
            const props = { color: 0x313338, suggestedColors: ['#112233'], onChange: color => { selected = color; } };
            const element = ctx.components.ColorPicker(props);
            assert.equal(element.type, module.exports); assert.equal(element.props.color, 0x313338); assert.equal(element.props.showEyeDropper, false);
            element.props.onChange(0xabcdef); assert.equal(selected, 0xabcdef);
            element.props.onChange(-1); assert.match(errors[0][1], /invalid color: -1/);
            assert.throws(() => ctx.components.ColorPicker({ ...props, color: 'not a color' }), /Invalid ColorPicker color: "not a color"/);
            assert.throws(() => ctx.components.ColorPicker({ ...props, suggestedColors: ['bad'] }), /suggestedColors: \["bad"\]/);
            abort.abort(); element.props.onChange(0); assert.equal(selected, 0xabcdef);
            assert.equal(ctx.components.ColorPicker(props), null);
        } finally { globalThis.Bedrock = previous; }
    }
});

async function fixture() {
    const { createRendererUi } = await import('../renderer-ui.mjs');
    const errors = [], disposers = [];
    const api = createRendererUi({ react: () => null, report: (id, error) => errors.push({ id, error }) });
    const controller = new AbortController();
    const ctx = api.context('test.ui', callback => { disposers.push(callback); return callback; }, controller.signal);
    return { api, ctx, errors, dispose() { controller.abort(); for (const dispose of disposers.splice(0).reverse()) dispose(); } };
}

test('local commands register before or after discovery and unload from every picker list', async () => {
    const f = await fixture();
    let calls = 0;
    const dispose = f.ctx.commands.register({ name: 'example', description: 'Example command', execute() { calls++; return { content: 'never sent' }; } });
    const original = { name: 'shrug', id: '-1' };
    const first = [original], second = [];
    assert.equal(f.api.bindCommands(first), first);
    f.api.bindCommands(second); f.api.bindCommands(first);
    assert.equal(first.length, 2); assert.equal(second.length, 1);
    const command = first[1];
    assert.equal(command, second[0]); assert.equal(command.inputType, 0);
    assert.equal(await command.execute([], { channel: { id: 'channel' } }), undefined);
    assert.equal(calls, 1);
    const later = f.ctx.commands.register({ name: 'later', description: 'Later command', execute() {} });
    assert.equal(first.length, 3); later(); assert.equal(first.length, 2);
    dispose();
    assert.deepEqual(first, [original]); assert.deepEqual(second, []);
    await command.execute([], {}); assert.equal(calls, 1, 'stale picker entries cannot execute an unloaded plugin');
    f.dispose();
});

test('command options preserve false and zero values, and validate names, choices and ordering', async () => {
    const f = await fixture();
    let received;
    f.ctx.commands.register({ name: 'values', description: 'Typed values', options: [
        { name: 'count', description: 'Count', type: 'integer', required: true, choices: [{ name: 'None', value: 0 }] },
        { name: 'enabled', description: 'Enabled', type: 'boolean' },
        { name: 'text', description: 'Text', type: 'string' }
    ], execute(values, context) { received = { ...values, channel: context.channelId, signal: context.signal }; } });
    const list = []; f.api.bindCommands(list);
    await list[0].execute([{ name: 'count', value: 0 }, { name: 'enabled', value: false }, { name: 'text', value: '' }], { channel: { id: 'channel' } });
    assert.equal(received.count, 0); assert.equal(received.enabled, false); assert.equal(received.text, ''); assert.equal(received.channel, 'channel');
    assert.equal(received.signal.aborted, false);
    await list[0].execute([{ name: 'count', value: '0' }, { name: 'enabled', value: 'false' }], { channel: { id: 'channel' } });
    assert.equal(received.count, 0); assert.equal(received.enabled, false);
    assert.throws(() => f.ctx.commands.register({ name: 'values', description: 'Duplicate', execute() {} }), /already registered/);
    assert.throws(() => f.ctx.commands.register({ name: 'Invalid Name', description: 'Bad', execute() {} }), /lowercase name/);
    assert.throws(() => f.ctx.commands.register({ name: 'bad-options', description: 'Bad', options: [
        { name: 'optional', description: 'Optional', type: 'string' }, { name: 'required', description: 'Required', type: 'string', required: true }
    ], execute() {} }), /precede optional/);
    assert.throws(() => f.ctx.commands.register({ name: 'bad-choice', description: 'Bad', options: [
        { name: 'value', description: 'Value', type: 'integer', choices: [{ name: 'Bad', value: 1.5 }] }
    ], execute() {} }), /match the option type/);
    f.dispose(); assert.equal(received.signal.aborted, true);
});

test('built-in name collisions do not replace Discord commands', async () => {
    const f = await fixture();
    f.ctx.commands.register({ name: 'shrug', description: 'Conflict', execute() {} });
    const builtin = { name: 'shrug', id: '-1' }, list = [builtin];
    f.api.bindCommands(list);
    assert.deepEqual(list, [builtin]); assert.match(f.errors[0].error.message, /already used by Discord/);
    assert.throws(() => f.ctx.commands.register({ name: 'shrug', description: 'Conflict', execute() {} }), /already registered/);
    f.dispose(); assert.deepEqual(list, [builtin]);
});

test('UI source adapters capture the command list and composer array without changing original controls', async () => {
    const { createRendererUi } = await import('../renderer-ui.mjs');
    const { createSourcePatches } = await import('../source-patches.mjs');
    const ui = createRendererUi({ react: () => null });
    const source = createSourcePatches(); source.register('$ui', ui);
    const previous = globalThis.Bedrock;
    const lists = [], buttonCalls = [];
    globalThis.Bedrock = { _rendererUi: {
        bindCommands(list) { lists.push(list); return ui.bindCommands(list); },
        chatButtons(buttons, props) { buttonCalls.push({ buttons, props }); }
    } };
    try {
        const command = function (module) {
            const $commands = [{ name: 'tableflip' }, { name: 'ordinary' }];
            module.exports = $commands.filter(command => !["tableflip","unflip"].includes(command.name));
        };
        const module = {}; source.apply('commands', command)(module);
        assert.equal(lists.length, 1); assert.equal(module.exports[0].name, 'ordinary');
        const composer = function (module) {
            module.exports = function (props) {
                const $buttons = []; $buttons.push("sticker");
                return 0===$buttons.length ? null : ({ children:$buttons });
            };
        };
        const next = {}; source.apply('composer', composer)(next);
        const props = { channel: { id: 'channel' } };
        assert.deepEqual(next.exports(props), { children: ['sticker'] });
        assert.equal(buttonCalls.length, 1); assert.equal(buttonCalls[0].props, props);
    } finally { globalThis.Bedrock = previous; }
});

test('component registrations validate ownership and can be removed before React loads', async () => {
    const f = await fixture();
    const dispose = f.ctx.addAccessory('example', () => null);
    assert.throws(() => f.ctx.addAccessory('example', () => null), /already registered/);
    f.ctx.chatBar.addButton('example', () => null, { order: -1 });
    assert.equal(f.api.diagnostics().accessories, 1); assert.equal(f.api.diagnostics().chatButtons, 1);
    dispose(); assert.equal(f.api.diagnostics().accessories, 0);
    assert.throws(() => f.ctx.react, /not available yet/);
    f.dispose(); assert.equal(f.api.diagnostics().chatButtons, 0);
});

test('message toolbar adapter preserves native controls and captures the instance button type', async () => {
    const { createRendererUi } = await import('../renderer-ui.mjs');
    const { createSourcePatches } = await import('../source-patches.mjs');
    const ui = createRendererUi({ react: () => null });
    const source = createSourcePatches(); source.register('$ui', ui);
    const previous = globalThis.Bedrock;
    let received;
    globalThis.Bedrock = { _rendererUi: { messageButtons(children, props, component) { received = { children, props, component }; return children; } } };
    try {
        const factory = function (module) {
            const jsx = { jsx: (type, props) => ({ type, props }) }, intl = { Lv7LxN: 'Message actions', string: ({ id }) => id };
            function NativeButton() {}
            module.exports = function Toolbar(props) {
                const a = props.hidden ? null : (0,jsx.jsx)(NativeButton,{label:'Reply'}), b = null;
                return (0,jsx.jsx)('div',{label:intl.string({id:intl.Lv7LxN}),children:[a,b]});
            };
        };
        const module = {}; source.apply('toolbar', factory)(module);
        const props = { message: { id: 'message' }, channel: { id: 'channel' }, hidden: true };
        assert.deepEqual(module.exports(props).props.children, [null, null]);
        assert.equal(received.props, props);
        assert.equal(received.component.name, 'NativeButton');
    } finally { globalThis.Bedrock = previous; }
});

test('message button registrations validate IDs and order and dispose by owner', async () => {
    const f = await fixture();
    f.ctx.addMessageButton('translate', () => null);
    assert.equal(f.api.diagnostics().messageButtons, 1);
    assert.throws(() => f.ctx.addMessageButton('translate', () => null), /already registered/);
    assert.throws(() => f.ctx.addMessageButton('invalid', () => null, { order: NaN }), /finite/);
    f.dispose(); assert.equal(f.api.diagnostics().messageButtons, 0);
});

test('message right-click handlers preserve events, report failures and reject stale actions', async () => {
    const { createRendererUi } = await import('../renderer-ui.mjs');
    const errors = [], controller = new AbortController();
    const React = { Component: class {}, useSyncExternalStore() {}, createElement: (type, props, ...children) => ({ type, props: { ...props, ...(children.length ? { children: children[0] } : {}) } }) };
    const ui = createRendererUi({ react: () => React, report: (id, error) => errors.push({ id, error }) });
    const ctx = ui.context('test.right-click', dispose => dispose, controller.signal);
    const propsFor = () => {
        const slots = ui.messageButtons([], { message: { id: 'message' } }, function NativeButton() {})[0];
        const boundary = slots.type(slots.props)[0];
        const element = boundary.props.children;
        return element.type(element.props).props;
    };
    let calls = 0, received, disabled = false;
    const dispose = ctx.addMessageButton('action', () => ({ label: 'Action', icon() {}, onClick() {}, disabled,
        onContextMenu(event) { calls++; received = event; event.preventDefault(); event.stopPropagation(); } }));
    const event = { prevented: false, stopped: false, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; } };
    const saved = propsFor().onContextMenu;
    saved(event);
    assert.equal(received, event); assert.equal(event.prevented, true); assert.equal(event.stopped, true);
    disabled = true; propsFor().onContextMenu(event); assert.equal(calls, 1);
    dispose(); saved(event); assert.equal(calls, 1);
    let remove = ctx.addMessageButton('async-error', () => ({ label: 'Error', icon() {}, onClick() {}, async onContextMenu() { throw new Error('right-click failed'); } }));
    propsFor().onContextMenu(event); await Promise.resolve(); await Promise.resolve();
    assert.equal(errors[0].id, 'test.right-click'); assert.match(errors[0].error.message, /right-click failed/);
    remove();
    remove = ctx.addMessageButton('invalid', () => ({ label: 'Invalid', icon() {}, onClick() {}, onContextMenu: 42 }));
    assert.throws(propsFor, /must be a function/); remove();
    ctx.addMessageButton('aborted', () => ({ label: 'Aborted', icon() {}, onClick() {}, onContextMenu() { calls++; } }));
    const aborted = propsFor().onContextMenu; controller.abort(); aborted(event); assert.equal(calls, 1);
});
