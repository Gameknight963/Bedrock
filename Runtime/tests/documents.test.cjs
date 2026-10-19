const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { packageDocuments } = require('../storage.cjs');

test('package documents preserve full license and notice text, including Unicode', t => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'Bedrock-documents-'));
    t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
    assert.deepEqual(packageDocuments(folder), { license: '', notices: '' });
    fs.writeFileSync(path.join(folder, 'LICENSE'), 'Copyright © Example\n<license>\n');
    fs.writeFileSync(path.join(folder, 'NOTICE'), 'Original authors\n');
    assert.deepEqual(packageDocuments(folder), { license: 'Copyright © Example\n<license>\n', notices: 'Original authors\n' });
    fs.writeFileSync(path.join(folder, 'THIRD_PARTY_NOTICES.md'), '# Dependency\nIts license.\n');
    assert.equal(packageDocuments(folder).notices, 'NOTICE\n\nOriginal authors\n\n\nTHIRD_PARTY_NOTICES.md\n\n# Dependency\nIts license.\n');
});
