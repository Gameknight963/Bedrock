const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const output = path.join(__dirname, 'obj', 'modules');
fs.mkdirSync(output, { recursive: true });
esbuild.buildSync({
    entryPoints: [path.join(__dirname, 'renderer-compiler.cjs')],
    outfile: path.join(output, 'renderer-compiler.cjs'),
    bundle: true, platform: 'node', target: 'node24', minify: true,
    external: ['@babel/preset-typescript/package.json']
});
fs.copyFileSync(require.resolve('systemjs/dist/system.js'), path.join(output, 'system.js'));
const built = new Date();
fs.utimesSync(path.join(output, 'system.js'), built, built);
const executable = process.platform === 'win32' ? 'esbuild.exe' : 'bin/esbuild';
const binaryPackage = path.dirname(require.resolve(`@esbuild/${process.platform}-${process.arch}/package.json`));
const compilerBinary = path.join(output, path.basename(executable));
fs.copyFileSync(path.join(binaryPackage, executable), compilerBinary);
fs.utimesSync(compilerBinary, built, built);
const notices = [];
function licenses(directory) {
    for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
        const file = path.join(directory, item.name);
        if (item.isDirectory() && !item.name.startsWith('.')) licenses(file);
        else if (item.isFile() && /^licen[sc]e(?:\.|$)/i.test(item.name))
            notices.push(`${path.relative(path.join(__dirname, 'node_modules'), file)}\n\n${fs.readFileSync(file, 'utf8')}`);
    }
}
licenses(path.join(__dirname, 'node_modules'));
fs.writeFileSync(path.join(output, 'THIRD_PARTY_NOTICES.txt'), notices.join('\n\n--------------------\n\n'));
