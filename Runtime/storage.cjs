const fs = require('node:fs');
const path = require('node:path');
const { JAVASCRIPT_API_VERSION, parseVersion, supportsApi } = require('./api-version.cjs');

function readJson(file, fallback) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (error) {
        if (error.code === 'ENOENT') return structuredClone(fallback);
        throw new Error(`Cannot read ${file}: ${error.message}`);
    }
}

function writeJson(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n');
    fs.renameSync(temporary, file);
}

function packagePath(folder, relative) {
    if (typeof relative !== 'string' || !relative || path.isAbsolute(relative))
        throw new Error('Package paths must be nonempty relative paths');
    const root = fs.realpathSync(folder);
    const resolved = fs.realpathSync(path.resolve(root, relative));
    const inside = path.relative(root, resolved);
    if (!inside || inside.startsWith('..' + path.sep) || inside === '..' || path.isAbsolute(inside))
        throw new Error(`Path leaves plugin folder: ${relative}`);
    if (!fs.statSync(resolved).isFile()) throw new Error(`Not a file: ${relative}`);
    return resolved;
}

function discover(root) {
    const plugins = new Map();
    const errors = [];
    const duplicateIds = new Set();
    const directory = path.join(root, 'plugins');
    fs.mkdirSync(directory, { recursive: true });
    fs.mkdirSync(path.join(root, 'data'), { recursive: true });
    for (const item of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (!item.isDirectory()) continue;
        const folder = path.join(directory, item.name);
        if (!fs.existsSync(path.join(folder, 'plugin.json'))) continue;
        try {
            const manifest = readJson(path.join(folder, 'plugin.json'), null);
            if (!manifest || manifest.manifestVersion !== 3)
                throw new Error('manifestVersion must be 3');
            if (Object.hasOwn(manifest, 'apiVersion'))
                throw new Error('Declare requiresApi on each entry point instead of apiVersion');
            if (typeof manifest.id !== 'string' || !/^[a-z0-9][a-z0-9._-]*$/.test(manifest.id) || manifest.id.includes('..') || manifest.id.endsWith('.') ||
                ['__proto__', 'constructor', 'prototype'].includes(manifest.id) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/.test(manifest.id))
                throw new Error('Invalid plugin id');
            if (typeof manifest.name !== 'string' || !manifest.name.trim() ||
                typeof manifest.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.test(manifest.version))
                throw new Error('A name and semantic version are required');
            if (!manifest.entrypoints || typeof manifest.entrypoints !== 'object' || Array.isArray(manifest.entrypoints))
                throw new Error('entrypoints must declare main, renderer and/or gpu');
            const entries = {};
            for (const [environment, entry] of Object.entries(manifest.entrypoints)) {
                if (!['main', 'renderer', 'gpu'].includes(environment)) throw new Error(`Unknown environment: ${environment}`);
                if (!entry || typeof entry !== 'object' || Array.isArray(entry))
                    throw new Error(`${environment} must declare runtime, path and requiresApi`);
                const definition = entry;
                if (!['javascript', 'native', 'dotnet-wasm', 'dotnet'].includes(definition.runtime)) throw new Error(`Unsupported runtime for ${environment}`);
                if (['dotnet-wasm', 'dotnet'].includes(definition.runtime)) {
                    if (definition.runtime === 'dotnet-wasm' && environment !== 'renderer') throw new Error('Managed WASM plugins run in the renderer');
                    if (definition.runtime === 'dotnet' && (environment !== 'main' || process.platform !== 'win32' || process.arch !== 'x64')) throw new Error('Desktop .NET plugins currently run in the Windows x64 main process');
                    if (typeof definition.path !== 'string' || path.extname(definition.path).toLowerCase() !== '.dll') throw new Error('Managed entry points must end in .dll');
                    if (Object.hasOwn(definition, 'requiresApi')) throw new Error('Managed API requirements belong in the assembly attribute');
                    entries[environment] = packagePath(folder, definition.path);
                    continue;
                }
                if (definition.runtime === 'native') {
                    if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Native plugins currently require Windows x64');
                    if (typeof definition.path !== 'string' || path.extname(definition.path).toLowerCase() !== '.dll')
                        throw new Error('Native entry points must end in .dll');
                    if (Object.hasOwn(definition, 'requiresApi')) throw new Error('Native API requirements belong in the DLL descriptor');
                    entries[environment] = packagePath(folder, definition.path);
                    continue;
                }
                if (environment === 'gpu') throw new Error('GPU entry points require the native runtime');
                if (!parseVersion(definition.requiresApi))
                    throw new Error(`${environment}.requiresApi must be a semantic version`);
                if (!supportsApi(definition.requiresApi))
                    throw new Error(`${environment} requires JavaScript API ${definition.requiresApi}; Bedrock provides ${JAVASCRIPT_API_VERSION}`);
                if (typeof definition.path !== 'string') throw new Error(`${environment}.path must be text`);
                if (path.extname(definition.path || '') !== '.js' && path.extname(definition.path || '') !== '.mjs')
                    throw new Error('JavaScript entry points must end in .js or .mjs');
                entries[environment] = packagePath(folder, definition.path);
            }
            if (!Object.keys(entries).length) throw new Error('At least one entry point is required');
            if (manifest.readme) packagePath(folder, manifest.readme);
            if (manifest.icon) packagePath(folder, manifest.icon);
            if (plugins.has(manifest.id) || duplicateIds.has(manifest.id)) {
                duplicateIds.add(manifest.id);
                plugins.delete(manifest.id);
                throw new Error(`Duplicate plugin id: ${manifest.id}; neither copy will run`);
            }
            plugins.set(manifest.id, { manifest, folder, entries });
        } catch (error) { errors.push({ folder: item.name, error: error.message }); }
    }
    return { plugins, errors };
}

function packageDocuments(folder) {
    const read = file => {
        try { return fs.readFileSync(packagePath(folder, file), 'utf8'); }
        catch (error) { if (error.code === 'ENOENT') return ''; throw error; }
    };
    const license = read('LICENSE') || read('LICENSE.md') || read('LICENSE.txt');
    const notices = ['NOTICE', 'NOTICE.md', 'THIRD_PARTY_NOTICES.md']
        .map(file => ({ file, text: read(file) })).filter(document => document.text);
    return { license, notices: notices.map(document => notices.length > 1 ? `${document.file}\n\n${document.text}` : document.text).join('\n\n') };
}

module.exports = { readJson, writeJson, packagePath, packageDocuments, discover };
