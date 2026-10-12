const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const runs = path.join(__dirname, 'runs');
const synchronous = process.argv.includes('--sync');
fs.mkdirSync(runs, { recursive: true });
const electron = path.resolve(__dirname, '../../Runtime/tests/obj/node_modules/electron/dist/electron.exe');
const child = spawn(electron, ['--inspect-brk=127.0.0.1:0', path.join(__dirname, 'startup-fixture.cjs')], { windowsHide: true });
let socket;
let output = '', errors = '', sequence = 0;
const commands = new Map();
let pausedResolve;
const paused = new Promise(resolve => { pausedResolve = resolve; });
const exited = new Promise(resolve => child.once('exit', code => resolve(code)));
child.stdout.on('data', bytes => { output += bytes; });
let endpointResolve;
const endpoint = new Promise(resolve => { endpointResolve = resolve; });
child.stderr.on('data', bytes => {
    errors += bytes;
    const match = errors.match(/ws:\/\/127\.0\.0\.1:\d+\/[^\s]+/);
    if (match) endpointResolve(match[0]);
});
const timeout = (promise, message, milliseconds = 5000) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), milliseconds);
    promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
});
function command(method, params = {}) {
    const id = ++sequence;
    const result = new Promise((resolve, reject) => commands.set(id, { resolve, reject }));
    socket.send(JSON.stringify({ id, method, params }));
    return timeout(result, `${method} timed out`);
}
(async () => {
    const report = { passed: false };
    try {
        socket = new WebSocket(await timeout(endpoint, 'Inspector endpoint not available'));
        socket.addEventListener('message', event => {
            const response = JSON.parse(event.data);
            if (response.method === 'Debugger.paused') pausedResolve(response.params);
            const pending = commands.get(response.id);
            if (pending) { commands.delete(response.id); response.error ? pending.reject(new Error(response.error.message)) : pending.resolve(response.result); }
        });
        await timeout(new Promise(resolve => socket.addEventListener('open', resolve, { once: true })), 'Inspector connection failed');
        await command('Runtime.enable'); await command('Debugger.enable');
        await command('Runtime.runIfWaitingForDebugger');
        const frame = (await timeout(paused, 'Entry pause not received')).callFrames[0].callFrameId;
        const prepared = await command('Debugger.evaluateOnCallFrame', {
            callFrameId: frame, expression: `process.getBuiltinModule('module').createRequire(${JSON.stringify(path.join(__dirname, synchronous ? 'startup-sync-bootstrap.cjs' : 'startup-bootstrap.cjs'))})(${JSON.stringify(path.join(__dirname, synchronous ? 'startup-sync-bootstrap.cjs' : 'startup-bootstrap.cjs'))}).prepare()`,
            returnByValue: synchronous
        });
        if (prepared.exceptionDetails) throw new Error(prepared.exceptionDetails.exception?.description || prepared.exceptionDetails.text);
        if (!synchronous) assert.equal(prepared.result.subtype, 'promise');
        const awaited = synchronous ? prepared : await command('Runtime.awaitPromise', { promiseObjectId: prepared.result.objectId, returnByValue: true });
        if (awaited.exceptionDetails) throw new Error(awaited.exceptionDetails.exception?.description || awaited.exceptionDetails.text);
        assert.equal(awaited.result.value.prepared, true);
        assert.equal(awaited.result.value.appReady, false);
        await command('Debugger.resume'); socket.close();
        assert.equal(await timeout(exited, 'Fixture did not exit'), 0);
        assert.match(output, /PASS:/);
        report.passed = true; report.preparedBeforeAppReady = true;
        console.log(output.trim());
    } catch (error) { report.error = error.message; process.exitCode = 1; console.error(error.message); }
    finally {
        socket?.close();
        if (child.exitCode === null) child.kill();
        const name = synchronous ? 'startup-sync' : 'startup';
        fs.writeFileSync(path.join(runs, `${name}-result.json`), JSON.stringify(report, null, 2));
        fs.writeFileSync(path.join(runs, `${name}-stdout.log`), output);
        fs.writeFileSync(path.join(runs, `${name}-stderr.log`), errors);
    }
})();
