const fs = require('node:fs');
const path = require('node:path');
const { createRequire, registerHooks } = require('node:module');
const { fileURLToPath, pathToFileURL } = require('node:url');
const esbuild = require('esbuild');

exports.createMainLoader = root => {
    const prefix = pathToFileURL(path.resolve(root)).href + '/';
    const nodeRequire = createRequire(path.join(root, 'loader.cjs'));
    const hook = registerHooks({ load(url, context, nextLoad) {
        if (!url.startsWith(prefix) || !/\.[cm]?js$/.test(new URL(url).pathname)) return nextLoad(url, context);
        const source = esbuild.transformSync(fs.readFileSync(fileURLToPath(url), 'utf8'), {
            format: 'cjs', sourcefile: fileURLToPath(url), target: 'es2022',
            supported: { 'dynamic-import': false }, define: { 'import.meta.url': JSON.stringify(url) }
        }).code;
        return { format: 'commonjs', source, shortCircuit: true };
    } });
    return {
        require: request => nodeRequire(request),
        invalidate() {
            const removed = new Set(Object.keys(require.cache).filter(file =>
                pathToFileURL(file).href.startsWith(prefix) && /\.[cm]?js$/.test(file)));
            for (const module of Object.values(require.cache)) module.children = module.children.filter(child => !removed.has(child.filename));
            for (const file of removed) delete require.cache[file];
        },
        close() { this.invalidate(); hook.deregister(); }
    };
};
