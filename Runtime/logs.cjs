const fs = require('node:fs');
const path = require('node:path');
const { format } = require('node:util');

function createLogFeed(root) {
    const directory = path.join(root, 'logs');
    const latest = path.join(directory, 'latest.log');
    let fileOptions = {};
    let reportedFailure = false;
    let sessionPrepared = false;
    const originalError = console.error.bind(console);
    const configureFile = options => {
        fileOptions = options;
        if (!options.enabled) return;
        try {
            fs.mkdirSync(directory, { recursive: true });
            if (!sessionPrepared) {
                if (fs.existsSync(latest)) {
                    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
                    fs.renameSync(latest, path.join(directory, `${stamp}-${process.pid}.log`));
                }
                sessionPrepared = true;
            }
            const archives = fs.readdirSync(directory).filter(name => /^\d{4}-.*\.log$/.test(name)).sort().reverse();
            for (const name of archives.slice(10)) fs.unlinkSync(path.join(directory, name));
        } catch (error) { originalError('[Bedrock:logs] Cannot prepare log files.', error); }
    };

    const listeners = new Set();
    const publish = entry => {
        if (fileOptions.enabled && (entry.bedrock || fileOptions.discord)) {
            try { fs.appendFileSync(latest, `${new Date().toISOString()} [${entry.level}] ${entry.text}\n`, 'utf8'); }
            catch (error) {
                if (!reportedFailure) { reportedFailure = true; originalError('[Bedrock:logs] Cannot write log file.', error); }
            }
        }
        for (const listener of listeners) {
            try { listener(entry); } catch { /* A broken log sink must not interrupt the caller. */ }
        }
    };
    for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
        const original = console[level];
        console[level] = (...args) => {
            const text = format(...args);
            publish({ level, text, bedrock: /^\[Bedrock(?:[:\]])/.test(text) });
            if (!listeners.size) original.apply(console, args);
        };
    }
    return {
        publish,
        configureFile,
        subscribe(callback) {
            if (typeof callback !== 'function') throw new TypeError('Expected a log callback');
            listeners.add(callback);
            return () => listeners.delete(callback);
        }
    };
}

module.exports = { createLogFeed };
