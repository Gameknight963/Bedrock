const fs = require('node:fs');
const path = require('node:path');
const {app} = require('electron');
process.on('uncaughtException', error => {fs.appendFileSync(path.join(__dirname,'errors.txt'), String(error.stack)+'\n');app.exit(2);});
fs.appendFileSync(path.join(__dirname,'args.txt'), JSON.stringify(process.argv)+'\n');
const mode = process.argv.at(-1);
const root = path.join(__dirname, 'runs', mode);
fs.mkdirSync(root, {recursive: true});
const report = path.join(root, 'result.txt');
function log(text) {fs.appendFileSync(report, text + '\n');}
fs.writeFileSync(report, '');
const oldLink=path.join(root,'cache.node');
if(fs.existsSync(oldLink)) fs.unlinkSync(oldLink);
const file = path.join(root, 'console.node');
fs.copyFileSync(path.resolve(__dirname, '../../bedrock-plugins/plugins/console/src/bin/x64/Release/console.node'), file);
const probe = require('./probe.node');
let addon = require(file);
addon.filter(false); addon.hide(); addon.write('test');
log(`loaded: ${probe.operation('mapped', file)}`);
try {fs.unlinkSync(file); log('ordinary delete succeeded');} catch(e) {log(`ordinary delete: ${e.code}`);}
if (mode === 'posix') {
 log(`posix last link: ${probe.operation('posix', file)}`);
 const link = path.join(root,'cache.node'); fs.linkSync(file,link);
 log(`posix original with second link: ${probe.operation('posix',file)}`);
 log(`original exists: ${fs.existsSync(file)}`);
 log(`posix remaining link: ${probe.operation('posix',link)}`);
 addon.hide(); log('call after unlink works');
} else {
 delete require.cache[require.resolve(file)];
 if(mode !== 'stale-call') addon=null;
 log(`FreeLibrary: ${probe.operation('free',file)}`);
 log(`still mapped: ${probe.operation('mapped',file)}`);
 fs.unlinkSync(file); log('deleted DLL');
 if(mode==='stale-call') {log('calling retained function'); addon.hide(); log('retained function returned');}
 if(mode==='reload') {
  fs.copyFileSync(path.resolve(__dirname, '../../bedrock-plugins/plugins/console/src/bin/x64/Release/console.node'),file);
  addon=require(file); addon.hide(); log('reload and call succeeded');
 }
}
if(mode==='stress') {
 for(let i=0;i<100;i++) {
  fs.copyFileSync(path.resolve(__dirname, '../../bedrock-plugins/plugins/console/src/bin/x64/Release/console.node'),file);
  addon=require(file); addon.hide(); addon.filter(true); addon.filter(false); addon.write('test');
  delete require.cache[require.resolve(file)]; addon=null;
  for(let j=0;j<3;j++) global.gc();
  const error=probe.operation('free',file);
  if(error || probe.operation('mapped',file)) throw new Error(`iteration ${i}: unload failed (${error})`);
  fs.unlinkSync(file);
 }
 log('100 load/call/GC/unload/delete cycles completed');
}
for(let i=0;i<10;i++) global.gc();
log('GC completed');
app.whenReady().then(()=>setTimeout(()=>{log('exiting normally');app.quit();},300));
process.on('exit',()=>log('JS exit handler'));



