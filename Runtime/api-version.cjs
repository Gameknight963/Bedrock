const JAVASCRIPT_API_VERSION = '1.0.0';

function parseVersion(value) {
    if (typeof value !== 'string') return null;
    const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(value);
    if (!match) return null;
    const prerelease = match[4]?.split('.') || [];
    if (prerelease.some(part => /^\d+$/.test(part) && part.length > 1 && part[0] === '0')) return null;
    return { core: match.slice(1, 4).map(BigInt), prerelease };
}

function compareVersions(left, right) {
    for (let i = 0; i < 3; i++) {
        if (left.core[i] !== right.core[i]) return left.core[i] < right.core[i] ? -1 : 1;
    }
    if (!left.prerelease.length || !right.prerelease.length)
        return left.prerelease.length ? -1 : right.prerelease.length ? 1 : 0;
    for (let i = 0; i < Math.max(left.prerelease.length, right.prerelease.length); i++) {
        const a = left.prerelease[i], b = right.prerelease[i];
        if (a === b) continue;
        if (a === undefined || b === undefined) return a === undefined ? -1 : 1;
        const numericA = /^\d+$/.test(a), numericB = /^\d+$/.test(b);
        if (numericA && numericB) return BigInt(a) < BigInt(b) ? -1 : 1;
        if (numericA !== numericB) return numericA ? -1 : 1;
        return a < b ? -1 : 1;
    }
    return 0;
}

function supportsApi(required, available = JAVASCRIPT_API_VERSION) {
    const requirement = parseVersion(required), host = parseVersion(available);
    return Boolean(requirement && host && requirement.core[0] === host.core[0] && compareVersions(requirement, host) <= 0);
}

module.exports = { JAVASCRIPT_API_VERSION, parseVersion, supportsApi };
