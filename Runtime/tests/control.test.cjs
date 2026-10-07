const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter, once } = require('node:events');
const net = require('node:net');
const { startControl } = require('../control.cjs');

test('local control accepts fragmented quit commands and rejects other commands', { timeout: 5000 }, async t => {
    const app = new EventEmitter();
    app.whenReady = () => Promise.resolve();
    let quits = 0;
    app.quit = () => { quits++; app.emit('requested-quit'); };
    const server = startControl(app);
    const sockets = [];
    t.after(() => { for (const socket of sockets) socket.destroy(); server.close(); });
    await once(server, 'listening');
    const connect = async () => {
        const socket = net.connect(`\\\\.\\pipe\\Bedrock-${process.pid}`);
        sockets.push(socket);
        await once(socket, 'connect');
        return socket;
    };
    const invalid = await connect();
    const invalidClosed = once(invalid, 'close');
    invalid.write('execute\n');
    await invalidClosed;
    assert.equal(quits, 0);
    const valid = await connect();
    const requested = once(app, 'requested-quit');
    valid.write('qu');
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(quits, 0);
    valid.end('it\n');
    await requested;
    assert.equal(quits, 1);
    const closed = once(server, 'close');
    app.emit('will-quit');
    await closed;
});
