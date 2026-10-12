const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const esbuild = require('esbuild');

async function compile(entry, renderer = false) {
    const result = await esbuild.build({
        entryPoints: [entry], bundle: true, write: false, format: 'iife', globalName: 'Plugin',
        platform: renderer ? 'browser' : 'node', target: 'es2022', external: renderer ? [] : ['electron'], logLevel: 'silent',
        plugins: [{ name: 'original-module-urls', setup(build) {
            build.onLoad({ filter: /\.[cm]?js$/ }, async args => {
                const url = renderer ? `https://reload.test/${path.basename(args.path)}` : pathToFileURL(args.path).href;
                const source = await esbuild.transform(fs.readFileSync(args.path, 'utf8'), {
                    loader: 'js', format: 'esm', define: { 'import.meta.url': JSON.stringify(url) }
                });
                return { contents: source.code, resolveDir: path.dirname(args.path), loader: 'js' };
            });
        } }]
    });
    return `${result.outputFiles[0].text}\nreturn Plugin;`;
}

module.exports = { compile };
