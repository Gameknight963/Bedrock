const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const { getOrInitializeCascadedLoader } = require('internal/modules/esm/loader');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'Bedrock-internal-cache-'));
const entry = path.join(root, 'entry.mjs');
const helper = path.join(root, 'helper.mjs');
const prefix = pathToFileURL(root).href + '/';
function write(version) {
    fs.writeFileSync(helper, `export const value = ${version};`);
    fs.writeFileSync(entry, `import { value } from './helper.mjs'; export const result = value;`);
}
try {
    for (let version = 1; version <= 30; version++) {
        write(version);
        const module = require(entry);
        assert.equal(module.result, version);
        write(version + 1);
        assert.equal(require(entry).result, version);
        const loader = getOrInitializeCascadedLoader();
        for (const url of loader.loadCache.keys()) if (url.startsWith(prefix)) loader.loadCache.delete(url);
        for (const file of Object.keys(require.cache)) if (file === entry || file === helper) delete require.cache[file];
        assert.equal(require(entry).result, version + 1);
        assert.equal(module.result, version, 'old references retain old code');
        for (const url of loader.loadCache.keys()) if (url.startsWith(prefix)) loader.loadCache.delete(url);
        for (const file of Object.keys(require.cache)) if (file === entry || file === helper) delete require.cache[file];
    }
    console.log(`PASS: Internal Node cache deletion reloads entry and helper for 30 cycles (Node ${process.versions.node}).`);
} finally { fs.rmSync(root, { recursive: true, force: true }); }
