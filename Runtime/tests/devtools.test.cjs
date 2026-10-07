const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createContext } = require('../context.cjs');
const Module = require('node:module');
const { definePluginSettings, OptionType, bindPluginSettings } = require('../settings.mjs');

test('DevTools plugin enables new windows, requires restart for locked windows, and disposes shortcuts', async t => {
    const previousBedrock = global.Bedrock;
    global.Bedrock = { definePluginSettings, OptionType };
    const originalLoad = Module._load;
    let ready = false;
    const switches = new Map();
    Module._load = function (name, ...args) {
        if (name === 'electron') return { app: {
            isReady: () => ready,
            commandLine: {
                appendSwitch: (name, value) => switches.set(name, value),
                hasSwitch: name => switches.has(name)
            }
        } };
        return originalLoad.call(this, name, ...args);
    };
    t.after(() => { Module._load = originalLoad; global.Bedrock = previousBedrock; });
    const { start, settings } = await import('../../Plugins/devtools/main.js');
    let remoteDebugging = false;
    const binding = bindPluginSettings(settings, {
        get: () => remoteDebugging, signal: new AbortController().signal, log() {}
    });
    t.after(() => binding.dispose());
    assert.equal(settings.definitions.remoteDebugging.default, false);
    assert.equal(settings.definitions.remoteDebugging.restartNeeded, true);
    const contents = new EventEmitter();
    let opened = false;
    let enabled = false;
    let url = 'https://discord.com/channels/@me';
    let reason;
    let beforeCreate;
    let onCreated;
    Object.assign(contents, {
        isDestroyed: () => false, getURL: () => url,
        getLastWebPreferences: () => ({ devTools: enabled }),
        isDevToolsOpened: () => opened,
        openDevTools: options => { assert.equal(options?.mode, undefined, 'allow docking and retain the preferred dock position'); opened = true; },
        closeDevTools: () => { opened = false; }
    });
    const owned = createContext({ id: 'test.devtools' }, {
        log() {}, requireRestart: value => { reason = value; }, extra: { windows: {
            beforeCreate: callback => { beforeCreate = callback; },
            onCreated: callback => { onCreated = callback; }, all: () => [{ webContents: contents }]
        } }
    });
    start(owned.context);
    assert.equal(switches.size, 0, 'ordinary DevTools leave remote debugging off');
    const options = { webPreferences: { devTools: false } };
    beforeCreate(options);
    assert.equal(options.webPreferences.devTools, true);
    let prevented = false;
    const event = { preventDefault() { prevented = true; } };
    const shortcut = { type: 'keyDown', key: 'I', control: true, shift: true };
    contents.emit('before-input-event', event, shortcut);
    assert.match(reason, /Restart Discord/);
    assert.equal(opened, false);
    enabled = true;
    onCreated({ webContents: contents });
    assert.equal(contents.listenerCount('before-input-event'), 1, 'existing windows are not attached twice');
    url = ''; contents.emit('before-input-event', event, shortcut);
    url = 'https://unrelated.test/'; contents.emit('before-input-event', event, shortcut);
    assert.equal(opened, false);
    url = 'https://discord.com/channels/@me';
    contents.emit('before-input-event', event, shortcut);
    assert.equal(opened, true);
    assert.equal(prevented, true);
    contents.emit('before-input-event', event, { type: 'keyDown', key: 'F12' });
    assert.equal(opened, false);
    contents.emit('before-input-event', event, { ...shortcut, isAutoRepeat: true });
    assert.equal(opened, false);
    contents.emit('before-input-event', event, shortcut);
    owned.dispose();
    assert.equal(opened, false);
    assert.equal(contents.listenerCount('before-input-event'), 0);

    const createOwned = () => createContext({ id: 'test.devtools' }, {
        log() {}, requireRestart: value => { reason = value; }, extra: { windows: {
            beforeCreate() {}, onCreated() {}, all: () => []
        } }
    });
    remoteDebugging = true;
    const early = createOwned();
    start(early.context);
    assert.equal(switches.get('remote-debugging-port'), '9222');
    reason = undefined;
    early.dispose();
    assert.match(reason, /close the remote debugging port/);
    switches.clear();
    ready = true;
    reason = undefined;
    const late = createOwned();
    start(late.context);
    assert.equal(switches.size, 0, 'live enabling waits for a restart');
    assert.match(reason, /enable remote debugging/);
    late.dispose();
    remoteDebugging = false;
    switches.set('remote-debugging-port', '9222');
    reason = undefined;
    const disabled = createOwned();
    start(disabled.context);
    assert.match(reason, /close the remote debugging port/);
    disabled.dispose();
});
