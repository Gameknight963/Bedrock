const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { inflateRaw, crc32 } = require('node:zlib');
const { promisify, isDeepStrictEqual } = require('node:util');
const { discover, readJson, writeJson } = require('./storage.cjs');
const { parseVersion } = require('./api-version.cjs');
const inflate = promisify(inflateRaw);
const repository = 'bedrock-client/bedrock-plugins';
const releasePrefix = `https://github.com/${repository}/releases/download/`;

async function download(url, maximum, fetcher) {
    const response = await fetcher(url, { headers: { 'User-Agent': 'Bedrock', Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(120000) });
    if (!response.ok) throw new Error(response.status === 404 ? 'No published plugin collection was found.' : `Download failed: HTTP ${response.status}`);
    let size = 0;
    const chunks = [];
    for await (const chunk of response.body) {
        size += chunk.length;
        if (size > maximum) throw new Error('Download exceeds the size limit.');
        chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
}

function validateCatalog(catalog) {
    if (catalog?.catalogVersion !== 1 || !Array.isArray(catalog.plugins)) throw new Error('Unsupported plugin catalog.');
    const ids = new Set();
    for (const entry of catalog.plugins) {
        const { manifest, package: archive } = entry;
        if (manifest?.manifestVersion !== 2 || typeof manifest.id !== 'string' || !/^[a-z0-9][a-z0-9._-]*$/.test(manifest.id) ||
            manifest.id.includes('..') || !parseVersion(manifest.version) || typeof manifest.name !== 'string' ||
            ids.has(manifest.id) || typeof entry.readme !== 'string' || !archive || !/^[a-f0-9]{64}$/.test(archive.sha256) ||
            !Number.isSafeInteger(archive.size) || archive.size <= 0 || archive.size > 64 * 1024 * 1024 ||
            typeof archive.url !== 'string' || !archive.url.startsWith(releasePrefix)) throw new Error('Invalid plugin catalog entry.');
        const url = new URL(archive.url);
        if (url.search || url.hash || url.pathname.split('/').length !== 7 ||
            decodeURIComponent(url.pathname.split('/').at(-1)) !== `${manifest.id}-${manifest.version}.zip`)
            throw new Error('Package URL does not match its plugin.');
        ids.add(manifest.id);
    }
    return catalog;
}

async function extractPackage(bytes, destination) {
    let end = bytes.length - 22;
    while (end >= Math.max(0, bytes.length - 65557) && bytes.readUInt32LE(end) !== 0x06054b50) end--;
    if (end < 0 || bytes.readUInt32LE(end) !== 0x06054b50) throw new Error('Invalid ZIP archive.');
    const count = bytes.readUInt16LE(end + 10), centralSize = bytes.readUInt32LE(end + 12);
    let offset = bytes.readUInt32LE(end + 16);
    if (bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6) || count !== bytes.readUInt16LE(end + 8) ||
        count === 65535 || offset + centralSize !== end || end + 22 + bytes.readUInt16LE(end + 20) !== bytes.length)
        throw new Error('Unsupported ZIP archive layout.');
    const centralStart = offset;
    const names = new Set();
    let total = 0, packageRoot;
    for (let index = 0; index < count; index++) {
        if (offset + 46 > end || bytes.readUInt32LE(offset) !== 0x02014b50) throw new Error('Invalid ZIP directory.');
        const flags = bytes.readUInt16LE(offset + 8), method = bytes.readUInt16LE(offset + 10);
        const checksum = bytes.readUInt32LE(offset + 16), compressed = bytes.readUInt32LE(offset + 20), size = bytes.readUInt32LE(offset + 24);
        const length = bytes.readUInt16LE(offset + 28), extra = bytes.readUInt16LE(offset + 30), comment = bytes.readUInt16LE(offset + 32);
        const attributes = bytes.readUInt32LE(offset + 38), local = bytes.readUInt32LE(offset + 42);
        if (offset + 46 + length + extra + comment > end) throw new Error('Invalid ZIP filename.');
        const nameBytes = bytes.subarray(offset + 46, offset + 46 + length);
        const name = new TextDecoder('utf-8', { fatal: true }).decode(nameBytes);
        const parts = name.split('/');
        if (parts.length < 2 || parts.some(part => !part || part === '.' || part === '..' || /[\\:\x00-\x1f<>"|?*]/.test(part) || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)) ||
            names.has(name.toLowerCase()) || (packageRoot && packageRoot !== parts[0]) || ((attributes >>> 16) & 0xf000) === 0xa000)
            throw new Error('ZIP contains an unsafe or duplicate path.');
        names.add(name.toLowerCase()); packageRoot = parts[0]; total += size;
        if (total > 256 * 1024 * 1024 || flags & 1 || ![0, 8].includes(method) || local + 30 > centralStart || bytes.readUInt32LE(local) !== 0x04034b50)
            throw new Error('Unsupported or oversized ZIP entry.');
        const localNameLength = bytes.readUInt16LE(local + 26);
        const data = local + 30 + localNameLength + bytes.readUInt16LE(local + 28);
        if (data + compressed > centralStart || bytes.readUInt16LE(local + 8) !== method ||
            !bytes.subarray(local + 30, local + 30 + localNameLength).equals(nameBytes)) throw new Error('ZIP entry headers disagree.');
        const input = bytes.subarray(data, data + compressed);
        const output = method === 8 ? await inflate(input, { maxOutputLength: Math.max(1, size) }) : input;
        if (output.length !== size || crc32(output) !== checksum) throw new Error('ZIP entry checksum failed.');
        const target = path.join(destination, ...parts);
        await fs.promises.mkdir(path.dirname(target), { recursive: true });
        await fs.promises.writeFile(target, output, { flag: 'wx' });
        offset += 46 + length + extra + comment;
    }
    if (!packageRoot || offset !== end) throw new Error('ZIP has no plugin or an invalid directory.');
    return path.join(destination, packageRoot);
}

function createCollection(root, manager, options = {}) {
    const fetcher = options.fetch || globalThis.fetch;
    const cache = path.join(root, 'cache', 'collection.json');
    let current;
    try { current = readJson(cache, null); if (current) validateCatalog(current.catalog); } catch { current = null; }
    let loading;
    const installing = new Map();
    async function load(force = false) {
        if (!force && current && Date.now() - current.fetchedAt < 3600000) return { ...current.catalog, cached: false };
        if (loading) return loading;
        loading = (async () => {
            try {
                const release = JSON.parse((await download(`https://api.github.com/repos/${repository}/releases/latest`, 2 * 1024 * 1024, fetcher)).toString('utf8'));
                const asset = release.assets?.find(asset => asset.name === 'catalog.json');
                if (!asset?.browser_download_url?.startsWith(releasePrefix)) throw new Error('The latest release has no plugin catalog.');
                const catalog = validateCatalog(JSON.parse((await download(asset.browser_download_url, 8 * 1024 * 1024, fetcher)).toString('utf8')));
                current = { fetchedAt: Date.now(), catalog };
                writeJson(cache, current);
                return { ...catalog, cached: false };
            } catch (error) {
                if (current) return { ...current.catalog, cached: true, warning: `Showing the saved collection. ${error.message}` };
                throw error;
            } finally { loading = null; }
        })();
        return loading;
    }
    function install(id, restoreEnabled) {
        if (installing.has(id)) return installing.get(id);
        const work = (async () => {
            const catalog = await load();
            const entry = catalog.plugins.find(entry => entry.manifest.id === id);
            if (!entry) throw new Error('This plugin is not in the official collection.');
            const bytes = await download(entry.package.url, entry.package.size, fetcher);
            if (bytes.length !== entry.package.size || crypto.createHash('sha256').update(bytes).digest('hex') !== entry.package.sha256)
                throw new Error('Plugin download does not match the published checksum.');
            const cacheDirectory = path.join(root, 'cache');
            await fs.promises.mkdir(cacheDirectory, { recursive: true });
            const temporary = await fs.promises.mkdtemp(path.join(cacheDirectory, 'install-'));
            try {
                const plugins = path.join(temporary, 'plugins');
                const folder = await extractPackage(bytes, plugins);
                const found = discover(temporary);
                const plugin = found.plugins.get(id);
                if (found.errors.length || found.plugins.size !== 1 || !plugin || !isDeepStrictEqual(plugin.manifest, entry.manifest))
                    throw new Error(`Plugin package failed validation: ${found.errors.map(error => error.error).join('; ') || 'manifest does not match the catalog'}`);
                await manager.installPackage(folder, id, restoreEnabled);
            } finally { await fs.promises.rm(temporary, { recursive: true, force: true }); }
        })().finally(() => installing.delete(id));
        installing.set(id, work);
        return work;
    }
    return { load, install };
}
module.exports = { createCollection, validateCatalog, extractPackage };
