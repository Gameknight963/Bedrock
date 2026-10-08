const { format } = require('node:util');

function createLogFeed() {
    const listeners = new Set();
    const publish = entry => {
        for (const listener of listeners) {
            try { listener(entry); } catch { /* A broken log sink must not interrupt the caller. */ }
        }
    };
    for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
        const original = console[level];
        console[level] = (...args) => {
            const text = format(...args);
            if (listeners.size) publish({ level, text, bedrock: /^\[Bedrock(?:[:\]])/.test(text) });
            else original.apply(console, args);
        };
    }
    return {
        publish,
        subscribe(callback) {
            if (typeof callback !== 'function') throw new TypeError('Expected a log callback');
            listeners.add(callback);
            return () => listeners.delete(callback);
        }
    };
}

module.exports = { createLogFeed };
