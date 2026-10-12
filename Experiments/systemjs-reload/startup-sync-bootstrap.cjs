const path = require('node:path');
const { createModuleLoader } = require('../../Runtime/modules.cjs');
exports.prepare = () => {
    const loader = createModuleLoader(__dirname);
    loader.load(path.join(__dirname, 'startup-sync-plugin.mjs')).start(require('electron').app);
    globalThis.prepared = true;
    return { prepared: true, appReady: require('electron').app.isReady() };
};
