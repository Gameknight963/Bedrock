const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createPackageActions } = require('../package-actions.cjs');
const { writeJson, readJson } = require('../storage.cjs');

for (const phase of ['before swap', 'old moved', 'new installed', 'backup deleted']) {
    test(`pending updates recover after interruption: ${phase}`, t => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'Bedrock-update-recovery-'));
        t.after(() => fs.rmSync(root, { recursive: true, force: true }));
        const folder = path.join(root, 'plugins', 'test.update');
        fs.mkdirSync(path.join(root, 'plugins'), { recursive: true });
        const staged = path.join(root, 'cache', 'pending-update-abc');
        const packageFolder = path.join(staged, 'plugin');
        const backup = path.join(staged, 'previous');
        const put = (directory, version) => {
            fs.mkdirSync(directory, { recursive: true });
            fs.writeFileSync(path.join(directory, 'version'), version);
        };
        if (phase === 'before swap') { put(folder, 'old'); put(packageFolder, 'new'); }
        if (phase === 'old moved') { put(backup, 'old'); put(packageFolder, 'new'); }
        if (phase === 'new installed') { put(backup, 'old'); put(folder, 'new'); }
        if (phase === 'backup deleted') put(folder, 'new');
        writeJson(path.join(root, 'cache', 'plugin-actions.json'), [{
            id: 'test.update', folder: 'test.update', action: 'update', staged: 'pending-update-abc', enabled: true
        }]);
        const configuration = { plugins: {} };
        const actions = createPackageActions(root, configuration, () => {});
        actions.apply();
        assert.equal(fs.readFileSync(path.join(folder, 'version'), 'utf8'), 'new');
        assert.equal(actions.has('test.update'), false);
        assert.deepEqual(actions.list(), []);
        assert.equal(readJson(path.join(root, 'settings.json')).plugins['test.update'].enabled, true);
        assert.equal(fs.existsSync(staged), false);
        const restarted = createPackageActions(root, configuration, () => {});
        restarted.apply();
        assert.deepEqual(restarted.list(), []);
    });
}
