const fs = require('node:fs');
const path = require('node:path');
const { readJson, writeJson } = require('./storage.cjs');

function createThemeManager(root, changed) {
    const directory = path.join(root, 'themes');
    const configurationPath = path.join(root, 'themes.json');
    const configuration = readJson(configurationPath, {});
    if (!configuration || typeof configuration !== 'object' || Array.isArray(configuration)) throw new Error('Bedrock themes.json must be an object');
    fs.mkdirSync(directory, { recursive: true });
    let themes = [];
    let errors = [];
    let revision = 0;
    let timer;
    let closed = false;
    function scan() {
        if (closed) return;
        revision++;
        const next = [];
        errors = [];
        try {
            for (const item of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
                if (!item.isFile() || path.extname(item.name).toLowerCase() !== '.css') continue;
                const theme = { id: item.name, name: item.name.replace(/(?:\.theme)?\.css$/i, ''), enabled: configuration[item.name] === true,
                    url: `bedrock://themes/${encodeURIComponent(item.name)}?v=${revision}`, error: null };
                try {
                    const css = fs.readFileSync(path.join(directory, item.name), 'utf8');
                    const comment = /^\s*\/\*([\s\S]*?)\*\//.exec(css)?.[1] || '';
                    for (const field of ['name', 'description', 'author', 'version', 'website']) {
                        const value = new RegExp(`^\\s*\\*?\\s*@${field}\\s+(.+)$`, 'm').exec(comment)?.[1]?.trim();
                        if (value) theme[field] = value;
                    }
                    if (theme.website) {
                        try {
                            const website = new URL(theme.website);
                            if (!['http:', 'https:'].includes(website.protocol)) delete theme.website;
                            else theme.website = website.href;
                        } catch { delete theme.website; }
                    }
                } catch (error) { theme.error = error.message; }
                next.push(theme);
            }
            themes = next;
        } catch (error) { errors.push(error.message); }
        changed?.();
        return list();
    }
    function list() { return structuredClone(themes); }
    function setEnabled(id, enabled) {
        if (!themes.some(theme => theme.id === id)) throw new Error('Unknown theme');
        if (typeof enabled !== 'boolean') throw new Error('Theme enabled state must be boolean');
        const next = { ...configuration, [id]: enabled };
        writeJson(configurationPath, next);
        Object.assign(configuration, next);
        themes = themes.map(theme => theme.id === id ? { ...theme, enabled } : theme);
        changed?.();
    }
    const watcher = fs.watch(directory, { recursive: true }, () => {
        clearTimeout(timer);
        timer = setTimeout(scan, 100);
        timer.unref();
    });
    watcher.unref();
    watcher.on('error', error => { errors = [error.message]; changed?.(); });
    return { directory, list, scan, setEnabled, errors: () => [...errors], close() {
        closed = true; clearTimeout(timer); watcher.close();
    } };
}

module.exports = { createThemeManager };
