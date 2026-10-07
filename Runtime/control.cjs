const net = require('node:net');

function startControl(app, pid = process.pid) {
    const server = net.createServer(socket => {
        socket.setTimeout(1000, () => socket.destroy());
        let command = '';
        socket.on('error', () => {});
        socket.on('data', chunk => {
            command += chunk.toString('utf8');
            if (command === 'quit\n') {
                socket.end();
                app.whenReady().then(() => app.quit()).catch(console.error);
            } else if (command.length > 5 || command.includes('\n')) socket.destroy();
        });
    });
    server.on('error', error => console.error('[Bedrock:control]', error.message));
    server.listen(`\\\\.\\pipe\\Bedrock-${pid}`);
    server.unref();
    app.once('will-quit', () => server.close());
    return server;
}

module.exports = { startControl };
