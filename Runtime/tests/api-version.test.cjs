const test = require('node:test');
const assert = require('node:assert/strict');
const { supportsApi, parseVersion } = require('../api-version.cjs');

test('API requirements accept older versions in the same major and reject newer patches', () => {
    for (const version of ['1.0.0', '1.2.9', '1.3.1', '1.3.2', '1.3.2+build.5'])
        assert.equal(supportsApi(version, '1.3.2'), true, version);
    for (const version of ['0.9.0', '2.0.0', '1.3.3', '1.4.0', '1.10.0'])
        assert.equal(supportsApi(version, '1.3.2'), false, version);
    assert.equal(supportsApi('1.9.0', '1.10.0'), true);
});

test('API versions validate semantic syntax and compare prereleases', () => {
    for (const version of [undefined, 1, '1', '^1.0.0', '01.0.0', '1.0.0-01', '1.0.0+'])
        assert.equal(parseVersion(version), null);
    assert.equal(supportsApi('1.0.0-alpha.2', '1.0.0-alpha.10'), true);
    assert.equal(supportsApi('1.0.0', '1.0.0-rc.1'), false);
    assert.equal(supportsApi('1.0.0-rc.1', '1.0.0'), true);
});
