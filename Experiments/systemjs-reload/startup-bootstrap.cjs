const fs = require('node:fs');
const path = require('node:path');
const { fileURLToPath, pathToFileURL } = require('node:url');
const babel = require('@babel/core');
const { System } = require('systemjs');
exports.prepare = async () => {
    const loader = new System.constructor();
    loader.instantiate = async url => {
        const filename = fileURLToPath(url);
        const code = babel.transformSync(fs.readFileSync(filename, 'utf8'), {
            filename, babelrc: false, configFile: false, plugins: ['@babel/plugin-transform-modules-systemjs']
        }).code;
        new Function('System', code)(loader);
        return loader.getRegister();
    };
    const module = await loader.import(pathToFileURL(path.join(__dirname, 'startup-plugin.mjs')).href);
    module.start(require('electron').app);
    globalThis.prepared = true;
    return { prepared: true, appReady: require('electron').app.isReady() };
};
