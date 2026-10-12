const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const electron = process.versions.electron ? require('electron') : null;
const app = electron?.app || null;
const { createAddonLoader } = require('./wrapper.cjs');
const mode = process.argv.at(-1);
const root = path.join(__dirname, 'runs', mode);
fs.mkdirSync(root, {recursive: true});
const report = path.join(root,'result.txt');
fs.writeFileSync(report,'');
const log = text => fs.appendFileSync(report,text+'\n');
process.on('uncaughtException', error => { log(error.stack); if(app) app.exit(2); else process.exit(2); });
process.on('unhandledRejection', error => {throw error;});
process.on('exit', code => log(`JS exit handler: ${code}`));
const probe = require('./probe.node');
const loader = createAddonLoader(probe,__filename);
const file = path.join(root,'fixture.node');
const install = variant => fs.copyFileSync(path.join(__dirname,`fixture-${variant}.node`),file);
const disposeCount = () => Number(process.env.BEDROCK_TEST_DISPOSE || 0);
process.env.BEDROCK_TEST_DISPOSE = '0';
process.env.BEDROCK_TEST_CLEANUP = '0';
process.env.BEDROCK_TEST_FINALIZER = '0';
log(`versions: ${JSON.stringify(process.versions)}`);
async function collect() {
    for(let i=0;i<8;i++) {global.gc(); await new Promise(resolve=>setImmediate(resolve));}
}
async function run() {
    install(mode==='unsafe-cleanup' ? 'unsafe-cleanup' : mode==='unsafe-finalizer' ? 'unsafe-finalizer' : 'v1');
    if(mode==='unmanaged') {
        const addon=require(file);
        assert.throws(()=>loader.require(file),/outside this wrapper/);
        assert.equal(addon.invoke(),1);
        log('unmanaged cached addon rejected and remains usable');
        return;
    }
    let first=loader.require(file);
    if(mode==='unwrapped-after') {
        const untracked=require(file);
        assert.equal(untracked,first);
        loader.unrequire(first);first=null;fs.unlinkSync(file);
        log('calling export retained by an unwrapped require');
        untracked.invoke();
        throw new Error('Expected stale native call to fail');
    }
    if(mode==='unsafe-cleanup' || mode==='unsafe-finalizer') {
        globalThis.retainedResource=first.resource;
        loader.unrequire(first);first=null;fs.unlinkSync(file);
        log('DLL deleted despite fixture leaving a registered native callback');
        if(mode==='unsafe-finalizer') {
            globalThis.retainedResource=null;
            log('collecting object with dangling finalizer');
            await collect();
        }
        return;
    }
    let second=loader.require(path.join(root,'.','fixture.node'));
    assert.equal(first,second);
    assert.throws(()=>fs.unlinkSync(file),{code:'EPERM'});
    loader.unrequire(first);
    assert.equal(disposeCount(),0);
    assert.equal(probe.operation('mapped',file),1);
    assert.equal(second.invoke(),1);
    log('first release preserves DLL and remaining user');
    first=null;
    if(mode==='dispose-failure') {
        second.failNextDispose();
        assert.throws(()=>loader.unrequire(second),/Fixture disposal failed/);
        assert.equal(probe.operation('mapped',file),1);
        assert.equal(second.invoke(),1);
        assert.equal(disposeCount(),0);
        log('disposal failure preserves acquisition, cache and mapped DLL');
    }
    loader.unrequire(second);
    assert.equal(disposeCount(),1);
    assert.equal(probe.operation('mapped',file),0);
    assert.equal(require.cache[file],undefined);
    assert.throws(()=>loader.unrequire(second),/not acquired/);
    second=null;fs.unlinkSync(file);
    await collect();
    assert.equal(Number(process.env.BEDROCK_TEST_FINALIZER),0);
    log('final release disposes exactly once, unloads and allows immediate deletion; GC passed');
    install('v2');
    let updated=loader.require(file);
    assert.equal(updated.invoke(),2);
    loader.unrequire(updated);updated=null;fs.unlinkSync(file);
    await collect();
    log('replacement binary at identical path returns new version');
    if(mode==='wrapped-stress') {
        const memoryBefore=process.memoryUsage();
        for(let i=0;i<300;i++) {
            install(i%2 ? 'v1':'v2');
            let a=loader.require(file),b=loader.require(file);
            assert.equal(a.invoke(),i%2 ? 1:2);
            loader.unrequire(a);a=null;
            assert.equal(b.invoke(),i%2 ? 1:2);
            loader.unrequire(b);b=null;
            fs.unlinkSync(file);
            if(i%10===0) await collect();
        }
        await collect();
        assert.equal(disposeCount(),302);
        log('300 cached two-user load/use/dispose/unload/delete cycles passed');
        log(`memory before: ${JSON.stringify(memoryBefore)}; after: ${JSON.stringify(process.memoryUsage())}`);
    }
    assert.equal(Number(process.env.BEDROCK_TEST_CLEANUP),0);
    const jsFile=path.join(root,'ordinary.cjs');fs.writeFileSync(jsFile,'module.exports = { answer: 42 };');
    assert.equal(require(jsFile).answer,42);
    assert.equal(fs.statSync(jsFile).isFile(),true);
    log('ordinary Node module loading and fs remain functional');
}
run().then(async()=>{
    if(app) {
        await app.whenReady();
        const window=new electron.BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true}});
        await window.loadURL('data:text/html,<title>fixture</title><p>renderer alive</p>');
        assert.equal(await window.webContents.executeJavaScript('1+2'),3);
        window.destroy();
        log('sandboxed renderer window and JS execution passed');
        log('requesting normal Electron shutdown');app.quit();
    } else {log('normal Node shutdown');}
});


