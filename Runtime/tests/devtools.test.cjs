const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createContext } = require('../context.cjs');

test('DevTools plugin enables new windows, requires restart for locked windows, and disposes shortcuts', async () => {
    const { start } = await import('../../Plugins/devtools/main.js');
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
});
