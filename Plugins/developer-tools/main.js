import net from 'node:net';

export async function start(ctx) {
    const sockets = new Set();
    const windows = () => ctx.windows.all().filter(window => !window.isDestroyed() && !window.webContents.isDestroyed());
    async function dispatch(request) {
        if (request.operation === 'status') return { processId: process.pid, windows: windows().map(window => ({
            id: window.id, title: window.getTitle(), url: window.webContents.getURL()
        })) };
        const candidates = windows().filter(window => request.windowId ? window.id === request.windowId : /^https:/.test(window.webContents.getURL()));
        if (candidates.length !== 1) throw new Error(candidates.length ? 'Multiple windows; specify windowId.' : 'No matching window. Open Discord and use status to list windows.');
        const window = candidates[0];
        if (request.operation === 'screenshot') return { mimeType: 'image/png', data: (await window.webContents.capturePage()).toPNG().toString('base64') };
        if (!['inspect', 'styles'].includes(request.operation)) throw new Error('Unknown inspection operation');
        if (typeof request.selector !== 'string' || !request.selector.length || request.selector.length > 2048) throw new Error('Provide a CSS selector up to 2048 characters.');
        const parameters = JSON.stringify({ selector: request.selector, limit: request.limit, properties: request.properties });
        // Only fixed inspector methods run; the request is serialized as data, not JavaScript source.
        return window.webContents.executeJavaScript(`(() => {
            if (!window.BedrockInspector) throw new Error('MCP Bridge renderer is not ready or enabled in this window.');
            return window.BedrockInspector.${request.operation}(${parameters});
        })()`);
    }
    const server = net.createServer(socket => {
        sockets.add(socket);
        socket.setEncoding('utf8');
        socket.setTimeout(10000, () => socket.destroy());
        socket.on('error', () => {});
        socket.once('close', () => sockets.delete(socket));
        let buffer = '', handled = false;
        socket.on('data', async chunk => {
            if (handled) return;
            buffer += chunk;
            if (buffer.length > 32768) { socket.destroy(); return; }
            if (!buffer.includes('\n')) return;
            handled = true;
            try {
                const request = JSON.parse(buffer.slice(0, buffer.indexOf('\n')));
                if (!request || typeof request !== 'object') throw new Error('Expected an inspection request');
                const result = await dispatch(request);
                if (!ctx.signal.aborted && !socket.destroyed) socket.end(JSON.stringify({ result }) + '\n');
            } catch (error) {
                if (!ctx.signal.aborted && !socket.destroyed) socket.end(JSON.stringify({ error: error.message }) + '\n');
            }
        });
    });
    ctx.cleanup(() => { for (const socket of sockets) socket.destroy(); server.close(); });
    server.on('error', error => ctx.log.error(error.message));
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(`\\\\.\\pipe\\Bedrock-Dev-${process.pid}`, () => {
            server.removeListener('error', reject);
            if (ctx.signal.aborted) { server.close(); reject(new Error('MCP Bridge was disabled')); }
            else resolve();
        });
    });
    server.unref();
    ctx.log.info('MCP inspection bridge ready.');
}
