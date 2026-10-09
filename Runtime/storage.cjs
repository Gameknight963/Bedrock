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
            if (!manifest || manifest.manifestVersion !== 2)
                throw new Error('manifestVersion must be 2');
            if (Object.hasOwn(manifest, 'apiVersion'))
                throw new Error('Declare requiresApi on each entry point instead of apiVersion');
            if (typeof manifest.id !== 'string' || !/^[a-z0-9][a-z0-9._-]*$/.test(manifest.id) || manifest.id.includes('..') || manifest.id.endsWith('.') ||
                ['__proto__', 'constructor', 'prototype'].includes(manifest.id) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/.test(manifest.id))
                throw new Error('Invalid plugin id');
            if (typeof manifest.name !== 'string' || !manifest.name.trim() ||
                typeof manifest.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.test(manifest.version))
                throw new Error('A name and semantic version are required');
            if (!manifest.entrypoints || typeof manifest.entrypoints !== 'object' || Array.isArray(manifest.entrypoints))
                throw new Error('entrypoints must declare main and/or renderer');
            const entries = {};
            for (const [environment, entry] of Object.entries(manifest.entrypoints)) {
                if (!['main', 'renderer'].includes(environment)) throw new Error(`Unknown environment: ${environment}`);
                if (!entry || typeof entry !== 'object' || Array.isArray(entry))
                    throw new Error(`${environment} must declare runtime, path and requiresApi`);
                const definition = entry;
                if (!definition || definition.runtime !== 'javascript') throw new Error(`Unsupported runtime for ${environment}`);
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

module.exports = { readJson, writeJson, packagePath, discover };
