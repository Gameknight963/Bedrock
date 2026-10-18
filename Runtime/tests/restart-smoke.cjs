const {app, BrowserWindow} = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bedrock-restart-smoke-'));
app.setPath('userData', path.join(root, 'profile'));
const folder = path.join(root, 'plugins', 'restart');
fs.mkdirSync(folder, {recursive:true});
fs.writeFileSync(path.join(folder, 'plugin.json'), JSON.stringify({manifestVersion:3,id:'test.restart',name:'Restart fixture',version:'1.0.0',
    entrypoints:{renderer:{runtime:'javascript',path:'renderer.js',requiresApi:'1.3.0'}}}));
fs.writeFileSync(path.join(folder, 'renderer.js'), `export function start(ctx) { ctx.requireRestart('Renderer process change'); }
    export function unload(ctx) {
        if (ctx.signal || ctx.settings || ctx.cleanup) throw new Error('Unload context contains activation resources');
        ctx.log.info('Final renderer cleanup'); ctx.requireRestart('Renderer callbacks remain registered');
    }`);
require('../bootstrap.cjs').install({root,allowURL:url => url.hostname === '127.0.0.1'});
const server = http.createServer((request,response) => {response.setHeader('Content-Type','text/html');response.end('<html><body>Restart fixture</body></html>');});
app.whenReady().then(async () => {
    await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
    const window = new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true}});
    const url = `http://127.0.0.1:${server.address().port}`;
    const wait = async predicate => {
        for (let count=0;count<150;count++) {if (predicate()) return; await new Promise(resolve => setTimeout(resolve,50));}
        throw new Error('Restart fixture timed out');
    };
    await window.loadURL(url);
    await wait(() => BedrockMain.restartRequests().length === 1);
    await window.loadURL(url);
    await wait(() => BedrockMain.restartRequests().length === 1);
    await BedrockMain.remove('test.restart');
    assert.equal(BedrockMain.list().length,0);
    assert.equal(BedrockMain.restartRequests().length,2);
    assert.equal(BedrockMain.pendingChanges()[0].reason,'Renderer callbacks remain registered');
    await window.loadURL(url);
    const snapshot = await window.webContents.executeJavaScript('BedrockNative.request("list")');
    assert.equal(snapshot.restartRequests.length,2);
    assert.equal(snapshot.plugins.length,0);
    console.log('PASS: renderer restart requests survive uninstall and navigation; unload uses its context.');
    server.close(); app.exit(0);
}).catch(error => {console.error(error); server.close(); app.exit(1);});
