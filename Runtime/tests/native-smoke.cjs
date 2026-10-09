const {app,BrowserWindow}=require('electron');
const fs=require('node:fs');const path=require('node:path');const assert=require('node:assert/strict');
const repo=path.resolve(__dirname,'../..');
const {createPluginManager}=require(path.join(repo,'Runtime/plugins.cjs'));
const root=fs.mkdtempSync(path.join(require('node:os').tmpdir(),'Bedrock-native-smoke-'));let window;
app.setPath('userData',path.join(root,'profile'));
const logs=[];const output=path.resolve(process.argv[2] || path.join(root,'result.txt'));fs.writeFileSync(output,'');
const manager=createPluginManager(root,{
 nativeDirectory:path.join(repo,'Native/PluginHost/bin/x64/Release'),
 nativeTargets(environment){
  if(environment==='main')return [{pid:process.pid,creationTime:0}];
  const metrics=app.getAppMetrics();
  if(environment==='gpu')return metrics.filter(m=>m.type==='GPU');
  return metrics.filter(m=>m.pid===window.webContents.getOSProcessId());
 },
 log(level,id,args){const line=id+': '+args.join(' ');logs.push(line);fs.appendFileSync(output,line+'\n');}
});
function packageNative(environment){
 const folder=path.join(root,'plugins',environment);fs.mkdirSync(folder,{recursive:true});
 fs.copyFileSync(path.join(repo,'Examples/native/bin/x64/Release/native-example.dll'),path.join(folder,'plugin.dll'));
 fs.writeFileSync(path.join(folder,'plugin.json'),JSON.stringify({manifestVersion:2,id:'test.'+environment,name:environment,version:'1.0.0',entrypoints:{[environment]:{runtime:'native',path:'plugin.dll'}}}));
}
const wait=async predicate=>{for(let i=0;i<150;i++){if(predicate())return;await new Promise(r=>setTimeout(r,100));}throw Error('Timed out: '+JSON.stringify(logs));};
app.whenReady().then(async()=>{
 window=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true}});
 await window.loadURL('data:text/html,<p>Native plugin fixture</p>');
 for(const type of ['main','gpu','renderer'])packageNative(type);
 manager.scan();
 await wait(()=>['main','gpu','renderer'].every(type=>logs.includes('test.'+type+': Native example started.')));
 for(const type of ['main','gpu','renderer']){
   manager.settings('test.'+type).set('message','Updated '+type+' ?');
   await wait(()=>logs.includes('test.'+type+': Updated '+type+' ?'));
   await manager.setEnabled('test.'+type,false);
   await manager.setEnabled('test.'+type,true);
 }
 await wait(()=>['main','gpu','renderer'].every(type=>logs.filter(line=>line==='test.'+type+': Native example started.').length===2));
 const gpu = app.getAppMetrics().find(metric => metric.type === 'GPU');
 process.kill(gpu.pid);
 await wait(()=>logs.filter(line=>line==='test.gpu: Native example started.').length===3);
 await manager.stopAll();
 fs.appendFileSync(output,'PASS: main, sandboxed GPU and sandboxed renderer lifecycle/settings.\n');
 app.exit(0);
}).catch(error=>{fs.appendFileSync(output,'FAIL: '+error.stack+'\n');app.exit(1);});
