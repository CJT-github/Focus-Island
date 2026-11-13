// Native regression for top offset. Uses an isolated profile; never edits user data.
const fs = require('node:fs');
const path = require('node:path');
const {spawn, execFileSync} = require('node:child_process');
const assert = require('node:assert/strict');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || path.resolve(__dirname,'../../verify-tools/node_modules/playwright'));
const root=path.resolve(__dirname,'..'), out=path.join(root,'tools/verify');
fs.mkdirSync(out,{recursive:true});
const data=fs.mkdtempSync(path.join(out,'top-offset-'));
const exe=path.resolve(process.argv[2] || path.join(root,'target/verified/release/focus-island.exe'));
const port=9468, delay=ms=>new Promise(r=>setTimeout(r,ms));
const report={exe,checks:[],errors:[]};
let child,browser,island,panel;
const saved=()=>JSON.parse(fs.readFileSync(path.join(data,'state.json'),'utf8'));
function pass(name,detail){report.checks.push({name,detail});console.log('PASS',name);}
function geometry(){
 const raw=execFileSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(root,'tools/window-probe.ps1'),'-AppProcessId',String(child.pid)],{windowsHide:true,encoding:'utf8'});
 return JSON.parse(raw).windows;
}
async function launch(){
 child=spawn(exe,['--verbose','--debug-port',String(port),'--data-dir',data,'--log-file',path.join(data,'diagnostic.log')],{cwd:root,windowsHide:true});
 child.on('error',e=>report.errors.push(e.message));
 for(let i=0;i<100&&!browser;i++){
  try{browser=await chromium.connectOverCDP('http://127.0.0.1:'+port);}catch{await delay(100);}
 }
 assert(browser,'CDP connection');
 for(let i=0;i<100&&(!island||!panel);i++){
  for(const context of browser.contexts())for(const page of context.pages()){
   const view=await page.evaluate(()=>document.body?.dataset.view).catch(()=>null);
   if(view==='island')island=page;if(view==='panel')panel=page;
  }
  if(!island||!panel)await delay(100);
 }
 assert(island&&panel,'Both WebViews');
 for(const page of [island,panel])page.on('pageerror',e=>report.errors.push(e.message));
 await island.waitForFunction(()=>typeof window.__fromRust==='function');
 await panel.waitForFunction(()=>typeof window.__applyTimer==='function');
 await panel.evaluate(()=>{
  const apply=window.__applyTimer;
  window.__applyTimer=payload=>{window.__testTimer=payload;apply(payload);};
 });
 await island.evaluate(()=>{
  window.__fromRust('syncTimer');
  window.ipc.postMessage(JSON.stringify({type:'togglePanel'}));
 });
 await panel.locator('#btnOpenPreferencesPage').click();
 await panel.waitForFunction(()=>!!document.querySelector('#inTopOffset'));
 await delay(250);
}
async function stop(){
 if(island&&!island.isClosed())await island.evaluate(()=>window.ipc.postMessage(JSON.stringify({type:'quit'}))).catch(()=>{});
 await delay(250);
 if(browser)await browser.close().catch(()=>{});
 if(child&&child.exitCode===null){child.kill();await delay(200);}
 browser=island=panel=null;
}
async function assertPosition(requested){
 const scale=await island.evaluate(()=>devicePixelRatio),w=geometry().find(w=>w.title==='Focus Island');
 const min=Math.max(0,(w.work.Top-w.monitor.Top)/scale);
 const max=Math.max(min,(w.work.Bottom-w.monitor.Top)/scale-340);
 const actual=Math.min(max,Math.max(min,requested));
 assert(Math.abs(w.outer.Top+120*scale-w.monitor.Top-actual*scale)<=1,'native visible top '+JSON.stringify({requested,actual,w,scale}));
 assert(Math.abs(w.outer.Left+w.outer.Right-w.monitor.Left-w.monitor.Right)<=2,'horizontally centered');
 assert.equal(await island.evaluate(()=>innerWidth),580);assert.equal(await island.evaluate(()=>innerHeight),580);
 return w.outer;
}
async function apply(value){
 await panel.locator('#btnOpenPreferencesPage').click();
 await panel.locator('#inTopOffset').fill(String(value));
 await panel.locator('#inTopOffset').press('Enter');
 for(let i=0;i<100&&saved().settings.topOffset!==value;i++)await delay(25);
 assert.equal(saved().settings.topOffset,value,'offset saved');
 return assertPosition(value);
}
(async()=>{
 try{
  fs.writeFileSync(path.join(data,'state.json'),JSON.stringify({tasks:[{id:'offset-test',name:'位置验证',sec:120}],current_id:'offset-test',duration_sec:120,settings:{sound:false,notify:false,showIdleEyes:false}}));
  await launch();
  assert.equal(await panel.inputValue('#inTopOffset'),'20');await assertPosition(20);
  pass('Legacy profile defaults to 20 px');
  const panelBefore=geometry().find(w=>w.title==='Focus Island · 功能面板').outer;
  const pill=await apply(80);
  assert.deepEqual(geometry().find(w=>w.title==='Focus Island · 功能面板').outer,panelBefore);
  await island.evaluate(()=>document.querySelector('#island').click());
  await island.waitForFunction(()=>window.__isOpen());await delay(500);
  assert.deepEqual(await assertPosition(80),pill);
  await island.evaluate(()=>document.querySelector('#island').click());
  await island.waitForFunction(()=>!window.__isOpen());await delay(500);
  assert.deepEqual(await assertPosition(80),pill);
  pass('Apply moves pill immediately; dial and collapse share the same stable viewport');
  await panel.locator('#btnOpenTimerPage').click();await panel.locator('#btnStart').click();
  await panel.waitForFunction(()=>window.__testTimer?.running===true);
  const before=await panel.evaluate(()=>window.__testTimer);
  await apply(250);await delay(1100);
  const after=await panel.evaluate(()=>window.__testTimer);
  assert.equal(after.runId,before.runId);assert.equal(after.taskId,before.taskId);
  assert.equal(after.totalMs,before.totalMs);assert(after.running&&after.remainingMs<=before.remainingMs);
  assert.equal(saved().current_id,'offset-test');assert.equal(saved().duration_sec,120);
  await panel.locator('#btnOpenTimerPage').click();await panel.locator('#btnStart').click();
  await panel.waitForFunction(()=>window.__testTimer?.running===false);
  const paused=await island.textContent('#readoutDigits');await apply(84);await delay(1100);
  assert.equal(await island.textContent('#readoutDigits'),paused);
  pass('Offset updates preserve running and paused countdowns and their run identity');
  await apply(1000);assert.equal(saved().settings.topOffset,1000);
  await island.evaluate(()=>document.querySelector('#island').click());await delay(500);await assertPosition(1000);
  await apply(0);await assertPosition(0);
  pass('Large offsets are constrained to the work area and zero is supported');
  await apply(77);
  await panel.screenshot({path:path.join(out,'top-offset-panel.png'),omitBackground:true});
  await stop();await launch();
  assert.equal(await panel.inputValue('#inTopOffset'),'77');await assertPosition(77);
  assert.equal(saved().tasks.length,1);assert.equal(saved().current_id,'offset-test');
  pass('Restart restores the requested offset without losing the task');
  const log=fs.readFileSync(path.join(data,'diagnostic.log'),'utf8');
  assert(!/FRONTEND ERROR|FATAL|TopOffset:/.test(log));assert.deepEqual(report.errors,[]);
  pass('No frontend or native position errors');report.passed=true;
 }finally{
  await stop();
  fs.writeFileSync(path.join(out,'top-offset-native-report.json'),JSON.stringify(report,null,2));
  if(data.startsWith(out+path.sep+'top-offset-'))fs.rmSync(data,{recursive:true,force:true});
 }
})().catch(error=>{console.error(error);process.exitCode=1;});