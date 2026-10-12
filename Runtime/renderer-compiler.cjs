const babel = require('@babel/core');
const modules = require('@babel/plugin-transform-modules-systemjs');
const dynamicImport = require('@babel/plugin-transform-dynamic-import');

exports.compile = (source, filename) => babel.transformSync(source, {
    filename, babelrc: false, configFile: false, sourceMaps: 'inline',
    plugins: [modules, dynamicImport]
}).code;
