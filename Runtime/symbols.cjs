const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);
const preparations = new Map();

async function digest(file) {
    const hash = crypto.createHash('sha256');
    for await (const bytes of fs.createReadStream(file)) hash.update(bytes);
    return hash.digest('hex');
}

async function download(url, file, expected, maximum) {
    const response = await fetch(url, { signal: AbortSignal.timeout(180000) });
    if (!response.ok || !response.body) throw new Error(`Electron reference download failed: HTTP ${response.status} for ${path.basename(file)}.`);
    let size = 0;
    const limit = new Transform({ transform(bytes, encoding, callback) {
        size += bytes.length;
        callback(size > maximum ? new Error('Electron reference download exceeds its size limit.') : null, bytes);
    } });
    await pipeline(Readable.fromWeb(response.body), limit, fs.createWriteStream(file, { flags: 'wx' }));
    if (await digest(file) !== expected) throw new Error(`Electron reference checksum differs for ${path.basename(file)}.`);
}

async function extract(archive, member, destination, maximum) {
    const quote = value => "'" + value.replaceAll("'", "''") + "'";
    const script = `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem;
$zip=[IO.Compression.ZipFile]::OpenRead(${quote(archive)});
try {
    $entries=@($zip.Entries | Where-Object { $_.Name -eq ${quote(member)} });
    if ($entries.Count -ne 1 -or $entries[0].Length -le 0 -or $entries[0].Length -gt ${maximum}) { throw 'Invalid reference archive member.' }
    $inputStream=$entries[0].Open(); $outputStream=[IO.File]::Create(${quote(destination)});
    try { $inputStream.CopyTo($outputStream) } finally { $outputStream.Dispose(); $inputStream.Dispose() }
} finally { $zip.Dispose() }`;
    const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    await run(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
        { windowsHide: true, timeout: 180000, maxBuffer: 8192 });
}

async function prepare(version, cache, log) {
    if (!/^\d+\.\d+\.\d+$/.test(version || '')) throw new Error('Cannot determine a supported Electron release version for symbol resolution.');
    const folder = path.join(cache, 'electron', version, 'win32-x64');
    const image = path.join(folder, 'electron.exe'), symbols = path.join(folder, 'electron.exe.sym');
    try {
        const metadata = JSON.parse(await fs.promises.readFile(path.join(folder, 'reference.json'), 'utf8'));
        if (metadata.version === version && metadata.image === await digest(image) && metadata.symbols === await digest(symbols))
            return { image, symbols };
    } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
    await fs.promises.mkdir(path.dirname(folder), { recursive: true });
    const temporary = await fs.promises.mkdtemp(path.join(path.dirname(folder), 'download-'));
    try {
        log('info', [`Downloading Electron ${version} reference binary and symbols.`]);
        const base = `https://github.com/electron/electron/releases/download/v${version}/`;
        const response = await fetch(base + 'SHASUMS256.txt', { signal: AbortSignal.timeout(30000) });
        if (!response.ok) throw new Error(`Cannot obtain Electron ${version} checksums: HTTP ${response.status}.`);
        const manifest = await response.text();
        if (manifest.length > 1024 * 1024) throw new Error('Electron checksum manifest exceeds one MiB.');
        const checksums = new Map(manifest.split(/\r?\n/).map(line => line.trim().split(/\s+\*?/)).filter(parts => parts.length === 2).map(([hash, name]) => [name, hash]));
        const archives = [`electron-v${version}-win32-x64.zip`, `electron-v${version}-win32-x64-symbols.zip`];
        for (const name of archives) {
            const checksum = checksums.get(name);
            if (!/^[a-f0-9]{64}$/.test(checksum || '')) throw new Error(`Electron release checksum is missing for ${name}.`);
        }
        const downloaded = await Promise.allSettled(archives.map(name =>
            download(base + name, path.join(temporary, name), checksums.get(name), 512 * 1024 * 1024)));
        for (const result of downloaded) if (result.status === 'rejected') throw result.reason;
        const extracted = await Promise.allSettled([
            extract(path.join(temporary, archives[0]), 'electron.exe', path.join(temporary, 'electron.exe'), 512 * 1024 * 1024),
            extract(path.join(temporary, archives[1]), 'electron.exe.sym', path.join(temporary, 'electron.exe.sym'), 2 * 1024 * 1024 * 1024)
        ]);
        for (const result of extracted) if (result.status === 'rejected') throw result.reason;
        const metadata = { version, image: await digest(path.join(temporary, 'electron.exe')), symbols: await digest(path.join(temporary, 'electron.exe.sym')) };
        await fs.promises.mkdir(folder, { recursive: true });
        for (const name of ['electron.exe', 'electron.exe.sym']) await fs.promises.rename(path.join(temporary, name), path.join(folder, name));
        await fs.promises.writeFile(path.join(folder, 'reference.json'), JSON.stringify(metadata) + '\n');
        log('info', [`Electron ${version} reference files are cached.`]);
        return { image, symbols };
    } finally {
        // Only this invocation's mkdtemp directory is removed; never a caller-supplied path.
        await fs.promises.rm(temporary, { recursive: true, force: true });
    }
}

function prepareReference(version, cache, log) {
    const key = path.resolve(cache) + ':' + version;
    if (!preparations.has(key)) {
        const pending = prepare(version, cache, log).catch(error => { preparations.delete(key); throw error; });
        preparations.set(key, pending);
    }
    return preparations.get(key);
}

function waitForReference(pending, signal) {
    if (signal.aborted) return Promise.reject(signal.reason || new Error('Native startup was cancelled.'));
    return new Promise((resolve, reject) => {
        const abort = () => reject(signal.reason || new Error('Native startup was cancelled.'));
        signal.addEventListener('abort', abort, { once: true });
        pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    });
}

module.exports = { prepareReference, waitForReference };

if (require.main === module) {
    const { createInterface } = require('node:readline');
    const [operation, file, filter = ''] = process.argv.slice(2);
    if (operation !== 'list' || !file) {
        console.error('Usage: node symbols.cjs list electron.exe.sym [name-filter]');
        process.exitCode = 1;
    } else {
        const input = fs.createReadStream(file);
        input.on('error', error => { console.error(error.message); process.exitCode = 1; });
        const lines = createInterface({ input, crlfDelay: Infinity });
        lines.on('line', line => {
            const match = /^FUNC (?:m )?[0-9a-f]+ [0-9a-f]+ [0-9a-f]+ (.+?)\r*$/.exec(line);
            if (match && match[1].includes(filter)) console.log(match[1]);
        });
    }
}
