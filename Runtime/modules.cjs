const fs = require('node:fs');
const path = require('node:path');
const { createRequire, registerHooks } = require('node:module');
const { fileURLToPath, pathToFileURL } = require('node:url');
const { execFileSync } = require('node:child_process');
const assets = fs.existsSync(path.join(__dirname, 'modules')) ? path.join(__dirname, 'modules') : path.join(__dirname, 'obj', 'modules');
let rendererCompiler;

function compileRenderer(source, filename) {
    rendererCompiler ||= require(path.join(assets, 'renderer-compiler.cjs'));
    return rendererCompiler.compile(source, filename);
}

function createModuleLoader(directory) {
    const prefix = pathToFileURL(path.resolve(directory)).href + '/';
    const hook = registerHooks({ load(url, context, nextLoad) {
        if (!url.startsWith(prefix) || !/\.[cm]?js$/.test(new URL(url).pathname)) return nextLoad(url, context);
        const filename = fileURLToPath(url);
        const source = execFileSync(path.join(assets, process.platform === 'win32' ? 'esbuild.exe' : 'esbuild'), [
            '--format=cjs', '--target=es2022', '--sourcemap=inline', '--supported:dynamic-import=false',
            `--sourcefile=${filename}`, `--define:import.meta.url=${JSON.stringify(url)}`
        ], { input: fs.readFileSync(filename, 'utf8'), encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
        return { format: 'commonjs', source, shortCircuit: true };
    } });
    return {
        load(filename) { return createRequire(filename)(filename); },
        invalidate(folder) {
            const scope = pathToFileURL(path.resolve(folder)).href + '/';
            const files = new Set(Object.keys(require.cache).filter(file =>
                pathToFileURL(file).href.startsWith(scope) && path.extname(file).toLowerCase() !== '.node'));
            for (const module of Object.values(require.cache))
                module.children = module.children.filter(child => !files.has(child.filename));
            for (const file of files) delete require.cache[file];
        },
        close() { hook.deregister(); }
    };
}

module.exports = { createModuleLoader, compileRenderer, assets };
