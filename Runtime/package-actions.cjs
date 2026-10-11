const fs = require('node:fs');
const path = require('node:path');
const { readJson, writeJson } = require('./storage.cjs');

const locked = error => ['EPERM', 'EACCES', 'EBUSY'].includes(error.code);
function createPackageActions(root, configuration, log) {
    const cache = path.join(root, 'cache');
    const file = path.join(cache, 'plugin-actions.json');
    const actions = readJson(file, []);
    if (!Array.isArray(actions)) throw new Error('Invalid pending plugin actions.');
    const child = (parent, name) => {
        if (typeof name !== 'string' || !name || name === '.' || name === '..' || /[\\/:]/.test(name) || /[. ]$/.test(name))
            throw new Error('Invalid pending plugin folder.');
        const target = path.join(parent, name);
        if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) throw new Error('Pending plugin folders cannot be links.');
        return target;
    };
    function save() { writeJson(file, actions); }
    function apply() {
        for (const action of [...actions]) {
            try {
                if (!/^[a-z0-9][a-z0-9._-]*$/.test(action.id) || action.id.includes('..')) throw new Error('Invalid pending plugin id.');
                const folder = child(action.action === 'cleanup' ? cache : path.join(root, 'plugins'), action.folder);
                if (action.action === 'cleanup') {
                    if (!/^(removed-plugin|previous-plugin|pending-update)-[a-zA-Z0-9]+$/.test(action.folder)) throw new Error('Invalid discarded plugin folder.');
                    fs.rmSync(folder, { recursive: true, force: true });
                } else if (action.action === 'remove') {
                    fs.rmSync(folder, { recursive: true, force: true });
                    if (action.deleteSettings) fs.rmSync(path.join(root, 'data', action.id, 'settings.json'), { force: true });
                    delete configuration.plugins[action.id];
                } else if (action.action === 'update') {
                    if (!/^pending-update-[a-zA-Z0-9]+$/.test(action.staged)) throw new Error('Invalid pending update folder.');
                    const staged = child(cache, action.staged);
                    const packageFolder = child(staged, 'plugin');
                    const backup = path.join(staged, 'previous');
                    let moved = false;
                    if (fs.existsSync(folder)) { fs.renameSync(folder, backup); moved = true; }
                    try { fs.renameSync(packageFolder, folder); }
                    catch (error) { if (moved) fs.renameSync(backup, folder); throw error; }
                    configuration.plugins[action.id] = { ...(configuration.plugins[action.id] || {}), enabled: action.enabled };
                    try { fs.rmSync(staged, { recursive: true, force: true }); }
                    catch (error) { cleanup(action.id, action.staged); log('warn', action.id, [`Previous plugin files could not be deleted: ${error.message}`]); }
                } else throw new Error('Unknown pending plugin action.');
                actions.splice(actions.indexOf(action), 1);
                writeJson(path.join(root, 'settings.json'), configuration);
            } catch (error) {
                action.error = `Could not finish plugin ${action.action}: ${error.message}`;
                log('error', action.id, [action.error]);
            }
        }
        if (fs.existsSync(file) || actions.length) save();
    }
    function cleanup(id, folder) {
        if (!actions.some(action => action.action === 'cleanup' && action.folder === folder)) actions.push({ id, folder, action: 'cleanup' });
        save();
    }
    function remove(id, folder, deleteSettings, reason) {
        child(path.join(root, 'plugins'), folder);
        actions.push({ id, folder, action: 'remove', deleteSettings, reason });
        save();
    }
    function update(id, folder, source, enabled, reason) {
        child(path.join(root, 'plugins'), folder);
        fs.mkdirSync(cache, { recursive: true });
        const staged = fs.mkdtempSync(path.join(cache, 'pending-update-'));
        fs.renameSync(source, path.join(staged, 'plugin'));
        const action = { id, folder, action: 'update', staged: path.basename(staged), enabled, reason };
        actions.push(action);
        try { save(); }
        catch (error) {
            actions.pop(); fs.renameSync(path.join(staged, 'plugin'), source);
            fs.rmSync(staged, { recursive: true }); throw error;
        }
    }
    function setEnabled(id, enabled) {
        const action = actions.find(action => action.id === id && action.action === 'update');
        if (action) { action.enabled = enabled; save(); }
    }
    return { apply, remove, update, cleanup, setEnabled, has: id => actions.some(action => action.id === id && action.action !== 'cleanup'), list: () => actions.filter(action => action.action !== 'cleanup').map(({ id, action, error, reason }) => ({ id, action, error, reason })) };
}
module.exports = { createPackageActions, locked };
