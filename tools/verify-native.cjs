// Native WebView2 integration test. No installed application data is changed.
const fs = require('node:fs');
const path = require('node:path');
const {spawn, execFileSync} = require('node:child_process');
const assert = require('node:assert/strict');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || path.resolve(__dirname,'../../verify-tools/node_modules/playwright'));
const root=path.resolve(__dirname,'..');
const out=path.join(root,'tools/verify');
const data=fs.mkdtempSync(path.join(out,'native-'));
const exe=path.resolve(process.argv[2] || path.join(root,'dist/FocusIsland.exe'));
const port=9457;
const delay=ms=>new Promise(r=>setTimeout(r,ms));
let child,browser,island,panel;
let errors=[];
const report={exe,data,checks:[]};
function pass(name,details){report.checks.push({name,details});console.log('PASS',name,details||'');}
async function connect(){
  for(let n=0;n<100;n++){
    try{browser=await chromium.connectOverCDP('http://127.0.0.1:'+port);break;}catch(error){if(n===99)console.error(error.message);await delay(200);}
  }
  assert(browser,'WebView2 CDP endpoint');
  for(let n=0;n<100;n++){
    for(const context of browser.contexts())for(const page of context.pages()){
      const view=await page.evaluate(()=>document.body?.dataset.view).catch(()=>null);
      if(view==='island')island=page;
      if(view==='panel')panel=page;
    }
    if(island && panel)break;
    await delay(100);
  }
  assert(island && panel,'Both native WebViews loaded');
  await panel.waitForFunction(()=>typeof window.__applyTimer==='function');
  await panel.evaluate(()=>{window.timerEvents=[];const applyTimer=window.__applyTimer;window.__applyTimer=value=>{timerEvents.push({...value,at:Date.now()});applyTimer(value);};});
  for(const page of [island,panel]){
    page.on('pageerror',e=>errors.push(e.message));
    page.on('console',msg=>{if(msg.type()==='error')errors.push(msg.text());});
  }
}
function probe(x,y,dragToX,dragToY){
 const args=['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(root,'tools/window-probe.ps1'),'-AppProcessId',String(child.pid)];
 if(x!==undefined)args.push('-CursorX',String(x),'-CursorY',String(y));
 if(dragToX!==undefined)args.push('-DragToX',String(dragToX),'-DragToY',String(dragToY));
 return JSON.parse(execFileSync('powershell.exe',args,{windowsHide:true,encoding:'utf8'}));
}
function desktopShot(name,w){
 const filename=path.join(out,name).replace(/'/g,"''");
 const width=w.outer.Right-w.outer.Left+40,height=w.outer.Bottom-w.outer.Top+40;
 const left=w.outer.Left-20,top=Math.max(w.monitor.Top,w.outer.Top-20);
 execFileSync('powershell.exe',['-NoProfile','-Command',
  "Add-Type -AssemblyName System.Drawing; $b=[System.Drawing.Bitmap]::new("+width+","+height+"); $g=[System.Drawing.Graphics]::FromImage($b); try { $g.CopyFromScreen("+left+","+top+",0,0,$b.Size); $b.Save('"+filename+"',[System.Drawing.Imaging.ImageFormat]::Png) } finally { $g.Dispose(); $b.Dispose() }"
 ],{windowsHide:true});
}
function centered(w,scale){return Math.abs(w.outer.Left+w.outer.Right-w.monitor.Left-w.monitor.Right)<=2 && Math.abs(w.outer.Top+120*scale-w.monitor.Top-20*scale)<=1;}
async function launch(){
 child=spawn(exe,['--verbose','--debug-port',String(port),'--data-dir',data,'--log-file',path.join(data,'diagnostic.log')],{
  cwd:root,windowsHide:true,env:{...process.env,WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port='+port}
 });
 child.on('error',error=>errors.push(error.message));
 await connect();
 await island.waitForFunction(()=>typeof window.__fromRust==='function');
}
async function stop(){
 if(island&&!island.isClosed())await island.evaluate(()=>window.ipc.postMessage(JSON.stringify({type:'quit'}))).catch(()=>{});
 await delay(500);
 if(browser)await browser.close().catch(()=>{});
 if(child&&child.exitCode===null)child.kill();
 browser=island=panel=null;
}
async function digits(text){await island.waitForFunction(t=>document.querySelector('#readoutDigits').textContent===t,text);}
async function expectClock(){
 await island.waitForFunction(()=>{
  const now=new Date(),pad=n=>String(n).padStart(2,'0');
  const expected=[now.getHours(),now.getMinutes(),now.getSeconds()].map(pad).join(':');
  return document.querySelector('#island').classList.contains('is-clock') &&
    document.querySelector('#compactTime').textContent===expected &&
    document.querySelector('#readoutDigits').textContent===expected;
 },null,{timeout:2000});
}
async function expectPrepared(sec){
 await expectDuration(sec);await expectClock();await expectQuietChip();
 assert.equal(await island.locator('#readoutTask').evaluate(node=>node.hidden),true);
}
async function expectClockPhase(){
 await expectClock();await island.waitForFunction(()=>!document.querySelector('#island').classList.contains('is-idle-eyes')&&Number(getComputedStyle(document.querySelector('#compactTime')).opacity)>.95&&Number(getComputedStyle(document.querySelector('#idleEyes')).opacity)<.05,null,{timeout:2000});
}
async function expectEyes(timeout=12500){
 await island.waitForFunction(()=>{
  const island=document.querySelector('#island'),eyes=document.querySelector('#idleEyes'),compact=document.querySelector('.island__compact'),box=eyes.getBoundingClientRect();
  const pupils=[...eyes.querySelectorAll('.idle-eyes__pupil')];
  return island.classList.contains('is-idle-eyes')&&!window.__isOpen()&&Number(getComputedStyle(eyes).opacity)>.95&&Number(getComputedStyle(compact).opacity)>.95&&Number(getComputedStyle(document.querySelector('#compactTime')).opacity)<.05&&box.width>100&&box.height>30&&pupils.length===2&&[...eyes.querySelectorAll('.idle-eyes__lid')].every(lid=>lid.getBoundingClientRect().height>3)&&pupils.every(p=>{const bounds=p.getBoundingClientRect();return bounds.width>1&&bounds.height>1&&getComputedStyle(p).visibility==='visible';});
 },null,{timeout});
 assert.equal(await island.locator('#readoutTask').evaluate(node=>node.hidden),true);
}
async function expectTaskName(name){
 await island.waitForFunction(name=>{const task=document.querySelector('#readoutTask');return !task.hidden&&task.textContent===name&&!document.querySelector('#island').classList.contains('is-idle-eyes');},name,{timeout:2000});
}
async function expectQuietChip(){assert.equal(await island.locator('#readoutChip').evaluate(node=>node.hidden&&node.textContent===''),true);}
async function expectCompletedIdle(run,mode='clock'){
 await panel.waitForFunction(id=>timerEvents.at(-1)?.runId===id&&timerEvents.at(-1)?.idleAfterCompletion===true,run.runId,{timeout:13000});
 const idle=await panel.evaluate(()=>timerEvents.at(-1));
 for(const key of ['runId','taskId','done','started','running','remainingMs'])assert.equal(idle[key],run[key],key+' survives returning to idle');
 await expectQuietChip();await island.waitForFunction(()=>!window.__isOpen(),null,{timeout:3000});
 if(mode==='eyes')await expectEyes(2000);else await expectClockPhase();
 assert.equal(await island.locator('#readoutTask').evaluate(node=>node.hidden),true);
 assert.equal(await island.locator('#island').evaluate(node=>node.classList.contains('is-idle')&&!node.classList.contains('is-done')),true);
}
async function expectDuration(sec){
 for(let n=0;n<80;n++){
  try{if(JSON.parse(fs.readFileSync(path.join(data,'state.json'),'utf8')).duration_sec===sec)return;}catch{}
  await delay(25);
 }
 assert.equal(JSON.parse(fs.readFileSync(path.join(data,'state.json'),'utf8')).duration_sec,sec,'Configured duration persists independently of clock digits');
}
async function custom(sec){
 await panel.locator('#inH').fill('0');await panel.locator('#inM').fill('0');await panel.locator('#inS').fill(String(sec));
 await panel.locator('#btnApplyCustom').click();
 await expectDuration(sec);await expectPrepared(sec);
}
(async()=>{
 try{
  fs.writeFileSync(path.join(data,'state.json'),JSON.stringify({tasks:[{id:'initial',name:'测试初始任务',sec:1500}],current_id:'initial',duration_sec:25*60,settings:{showHands:true,showSecond:true,showIdleEyes:true,showIdleClock:true,sound:false,notify:false,alwaysOnTop:true,reduceMotion:false}}));
  await launch();report.prefersReducedMotion=await island.evaluate(()=>matchMedia('(prefers-reduced-motion: reduce)').matches);assert.equal(report.prefersReducedMotion,false,'The actual system prefers reduced motion, so eyes are intentionally disabled; no preference emulation was applied');
  const initial=await island.evaluate(()=>({width:innerWidth,height:innerHeight,time:document.querySelector('#compactTime').textContent}));
  assert.equal(initial.width,580);assert.equal(initial.height,580);await expectPrepared(1500);await expectDuration(1500);
  assert.equal(await island.locator('#readoutTask').count(),1);assert.equal(await island.locator('#islandAction,#btnCancelIslandAction').count(),0);await expectQuietChip();await expectClockPhase();
  await expectEyes();report.startupEyesPageElapsedMs=await island.evaluate(()=>performance.now());assert(report.startupEyesPageElapsedMs>=9500,'Saved selected tasks begin with a ten-second clock slot before the eye slot');
  await island.screenshot({path:path.join(out,'native-startup-eyes.png'),omitBackground:true});
  desktopShot('native-startup-eyes-desktop.png',probe().windows.find(w=>w.title==='Focus Island'));
  pass('Saved selected task starts idle with clock first, then actual visible eyes after about ten seconds',initial);
  await island.evaluate(()=>{window.__selftestOpen();window.__fromRust('toggleTimer');});await island.waitForFunction(()=>window.__isOpen());await expectTaskName('测试初始任务');
  await island.evaluate(()=>window.__fromRust('toggleTimer'));await expectTaskName('测试初始任务');
  await island.evaluate(()=>window.__fromRust('resetTimer'));await expectPrepared(1500);await island.locator('#island').evaluate(node=>node.click());await island.waitForFunction(()=>!window.__isOpen());
  pass('Starting and pausing reveal the saved task name and stop idle eyes; resetting restores idle without changing its duration');
  await island.evaluate(async()=>{
    for(let n=0;n<6;n++){
      document.querySelector('#island').click();
      await new Promise(resolve=>setTimeout(resolve,35));
    }
  });
  await island.waitForFunction(()=>!window.__isOpen() && innerWidth===580 && innerHeight===580,null,{timeout:3000});
  assert.equal(await island.locator('#island').evaluate(node=>node.classList.contains('is-open')),false);
  pass('Rapid expansion/collapse cancels stale viewport requests');
  const beforeProbe=probe(), nativePill=beforeProbe.windows.find(w=>w.title==='Focus Island');
  const islandScale=await island.evaluate(()=>devicePixelRatio);
  assert(centered(nativePill,islandScale));
  assert.equal(nativePill.exStyle&0x200000,0x200000);
  assert.equal(nativePill.exStyle&(0x80000|32),0,'No layered/transparent style toggles during morph');
  pass('Stable canvas anchored at visible top 20px; native region handles click-through');
  const glassStyle=await island.locator('.island__glass').first().evaluate(e=>{const s=getComputedStyle(e);return {border:s.borderTopWidth,backdrop:s.backdropFilter,background:s.backgroundColor};});
  assert.equal(glassStyle.border,'0px');assert(glassStyle.backdrop.includes('blur'));
  pass('Borderless translucent glass',glassStyle);
  desktopShot('native-pill-desktop.png',nativePill);
  await island.screenshot({path:path.join(out,'native-pill.png'),omitBackground:true});
  await island.locator('#island').click({position:{x:170,y:19}});
  await island.waitForFunction(()=>window.__isOpen());await delay(650);
  const dial=await island.evaluate(()=>({ticks:document.querySelectorAll('#ticks line').length,marks:document.querySelector('#hourMarks').children.length,offsets:window.__checkHandGeometry()}));
  const nativeDial=probe().windows.find(w=>w.title==='Focus Island');
  assert(centered(nativeDial,islandScale));
  assert.deepEqual(nativeDial.outer,nativePill.outer);
  assert.equal(nativeDial.exStyle,nativePill.exStyle);
  desktopShot('native-dial-desktop.png',nativeDial);
  assert.equal(dial.ticks,60);assert.equal(dial.marks,12);assert(dial.offsets.every(x=>x<1e-6));pass('Native dial and hand geometry',dial);
  await island.screenshot({path:path.join(out,'native-dial.png'),omitBackground:true});
  await island.locator('#island').click({button:'right',position:{x:170,y:20}});await delay(400);
  const panelNative=probe().windows.find(w=>w.title==='Focus Island · 功能面板');
  assert(panelNative.outer.Left>=panelNative.work.Left&&panelNative.outer.Top>=panelNative.work.Top&&panelNative.outer.Right<=panelNative.work.Right&&panelNative.outer.Bottom<=panelNative.work.Bottom);
  const panelScale=await panel.evaluate(()=>devicePixelRatio);
  assert(Math.abs(panelNative.work.Right-panelNative.outer.Right-20*panelScale)<=1);
  assert(Math.abs(panelNative.work.Bottom-panelNative.outer.Bottom-20*panelScale)<=1);
  pass('Settings panel starts at bottom right above the taskbar',panelNative.outer);
  const handle=await panel.locator('#panelDragHandle').boundingBox();
  const dragX=Math.round(panelNative.origin.X+(handle.x+40)*panelScale);
  const dragY=Math.round(panelNative.origin.Y+(handle.y+handle.height/2)*panelScale);
  const movedPanel=probe(dragX,dragY,dragX-160,dragY-100).windows.find(w=>w.title==='Focus Island · 功能面板');
  const panelMargin=Math.round(20*panelScale);
  const expectedLeft=Math.max(panelNative.work.Left+panelMargin,panelNative.outer.Left-160);
  const expectedTop=Math.max(panelNative.work.Top+panelMargin,panelNative.outer.Top-100);
  assert(panelNative.outer.Left-expectedLeft>60,'Fixture must retain horizontal space for a meaningful drag');
  assert(Math.abs(movedPanel.outer.Left-expectedLeft)<=2,'Title drag reaches the requested or clamped horizontal coordinate: '+JSON.stringify({expectedLeft,movedPanel:movedPanel.outer}));
  assert(Math.abs(movedPanel.outer.Top-expectedTop)<=2,'Title drag respects the vertical work-area margin even when panel height fills it: '+JSON.stringify({expectedTop,movedPanel:movedPanel.outer}));
  await panel.locator('#btnClose').click();
  await island.locator('#island').click({button:'right',position:{x:170,y:20}});await delay(250);
  assert.deepEqual(probe().windows.find(w=>w.title==='Focus Island · 功能面板').outer,movedPanel.outer);
  await island.evaluate(()=>document.querySelector('#island').click());await delay(600);
  assert.deepEqual(probe().windows.find(w=>w.title==='Focus Island · 功能面板').outer,movedPanel.outer);
  await island.evaluate(()=>document.querySelector('#island').click());await delay(600);
  assert.deepEqual(probe().windows.find(w=>w.title==='Focus Island · 功能面板').outer,movedPanel.outer);
  pass('Native title dragging; position retained across reopening and island resizing',movedPanel.outer);

  await panel.screenshot({path:path.join(out,'native-panel.png'),omitBackground:true});
  await custom(8);await panel.locator('#btnStart').click();await delay(1150);
  assert(await island.locator('#island').evaluate(e=>e.classList.contains('is-running')));
  assert.equal(await panel.locator('#btnStart').textContent(),'暂停');await expectQuietChip();await expectTaskName('测试初始任务');
  await panel.locator('#btnOpenPreferencesPage').click();await panel.locator('label:has(#swSecond)').click();await panel.locator('#btnOpenTimerPage').click();
  assert(await island.locator('#island').evaluate(e=>e.classList.contains('is-running')));
  await panel.locator('#btnStart').click();await delay(200);
  const paused=await island.locator('#readoutDigits').textContent();await delay(1200);
  assert.equal(await island.locator('#readoutDigits').textContent(),paused);
  assert.equal(await island.locator('#island').evaluate(e=>e.classList.contains('is-clock')),false);await expectQuietChip();await expectTaskName('测试初始任务');
  pass('Panel start/pause controls island; paused timer remains countdown and preferences preserve it',paused);
  await panel.locator('#btnReset2').click();await expectPrepared(8);await expectDuration(8);pass('Reset restores idle and preserves the selected task configured duration');
  await panel.locator('#btnClear').click();await delay(150);
  assert.equal(JSON.parse(fs.readFileSync(path.join(data,'state.json'))).tasks.length,0);pass('Clear tasks persists empty list');
  await expectClock();
  const emptyClock=await island.locator('#compactTime').textContent();
  await island.waitForFunction(previous=>document.querySelector('#compactTime').textContent!==previous,emptyClock,{timeout:2000});
  await expectClock();
  pass('Clearing tasks shows an updating local HH:mm:ss clock');

  await panel.locator('#btnOpenTaskPage').click();await panel.locator('#inTaskName').fill('</script>秒级检查');await panel.locator('#inTaskMin').fill('0');await panel.locator('#inTaskSec').fill('3');await panel.locator('#btnAddTask').click();
  await expectDuration(3);await expectPrepared(3);
  assert.equal(JSON.parse(fs.readFileSync(path.join(data,'state.json'))).tasks[0].sec,3);pass('Three-second task creation remains idle and persists its configured duration');
  await panel.locator('#btnOpenTaskPage').click();await panel.locator('#inTaskName').fill('备用任务');await panel.locator('#inTaskSec').fill('5');await panel.locator('#btnAddTask').click();
  await expectDuration(5);await expectPrepared(5);
  await panel.locator('.task__select').first().click();await expectDuration(3);await expectPrepared(3);
  await expectQuietChip();assert.equal(await panel.locator('.task.is-active .task__name').textContent(),'</script>秒级检查');
  pass('Adding and selecting tasks remain idle with no task label before starting');
  await panel.locator('#btnOpenPreferencesPage').click();await panel.locator('label:has(#swNotify)').click();await panel.locator('#btnOpenTimerPage').click();
  await panel.locator('#btnStart').click();await expectTaskName('</script>秒级检查');
  await island.waitForFunction(()=>document.querySelector('#island').classList.contains('is-cracking'));
  assert.equal(await island.evaluate(()=>innerWidth),580);
  await delay(220);await island.screenshot({path:path.join(out,'native-crack.png'),omitBackground:true});
  await island.waitForFunction(()=>!document.querySelector('#island').classList.contains('is-finishing'));
  await digits('00:00:00');assert.equal(await island.locator('#readoutChip').textContent(),'时间到');await expectTaskName('</script>秒级检查');
  assert.equal(await island.evaluate(()=>innerWidth),580);pass('3s completion returns the dial on the stable 580 canvas');
  await island.screenshot({path:path.join(out,'native-done.png'),omitBackground:true});
  await panel.waitForFunction(()=>timerEvents.at(-1)?.done===true&&timerEvents.at(-1)?.remainingMs===0);const completedRun=await panel.evaluate(()=>timerEvents.at(-1));
  await expectCompletedIdle(completedRun);assert.deepEqual(probe().windows.find(w=>w.title==='Focus Island').outer,nativePill.outer);assert.equal(await island.evaluate(()=>innerWidth===580&&innerHeight===580),true);
  assert.equal(await panel.locator('.task.is-active .task__name').textContent(),'</script>秒级检查');
  const postCompletionIdleAt=await panel.evaluate(()=>timerEvents.at(-1).at);await expectEyes();assert(Date.now()-postCompletionIdleAt>=9500,'Completed idle starts a fresh ten-second clock slot before eyes');
  const afterEyes=await panel.evaluate(()=>timerEvents.at(-1));assert.equal(afterEyes.runId,completedRun.runId);assert.equal(afterEyes.idleAfterCompletion,true);assert.equal(afterEyes.done,true);
  await island.screenshot({path:path.join(out,'native-completed-eyes.png'),omitBackground:true});desktopShot('native-completed-eyes-desktop.png',probe().windows.find(w=>w.title==='Focus Island'));
  pass('Completion returns to clock after ten seconds, then actual visible eyes after another ten seconds, retaining completed identity and stable canvas');
  await panel.locator('#btnOpenPreferencesPage').click();await panel.locator('label:has(#swMotion)').click();await panel.locator('#btnOpenTimerPage').click();await panel.locator('#btnReset2').click();await expectPrepared(3);await expectDuration(3);
  await panel.locator('#btnStart').click();await island.waitForFunction(()=>document.querySelector('#island').classList.contains('is-done'));
  assert.equal(await island.locator('.crack__piece').count(),0);pass('Reduced motion finishes without fragments');
  await panel.waitForFunction(()=>timerEvents.at(-1)?.done===true&&timerEvents.at(-1)?.runId!==''&&timerEvents.at(-1)?.idleAfterCompletion===false);const reducedRun=await panel.evaluate(()=>timerEvents.at(-1));assert.notEqual(reducedRun.runId,completedRun.runId);
  await island.locator('#island').evaluate(node=>node.click());await expectCompletedIdle(reducedRun);assert.deepEqual(probe().windows.find(w=>w.title==='Focus Island').outer,nativePill.outer);
  pass('Clicking a completed island returns immediately to idle without resetting completion facts or changing the selected task');
  await panel.locator('#btnOpenPreferencesPage').click();await panel.locator('label:has(#swMotion)').click();await panel.locator('label:has(#swIdleClock)').click();await panel.locator('#btnOpenTimerPage').click();await panel.locator('#btnReset2').click();await expectEyes(2000);
  await panel.locator('#btnStart').click();await expectTaskName('</script>秒级检查');await panel.waitForFunction(()=>timerEvents.at(-1)?.done===true&&timerEvents.at(-1)?.idleAfterCompletion===false);const eyesOnlyRun=await panel.evaluate(()=>timerEvents.at(-1));assert.notEqual(eyesOnlyRun.runId,reducedRun.runId);
  await expectCompletedIdle(eyesOnlyRun,'eyes');assert.equal(await island.locator('.crack__piece').count(),0);assert.deepEqual(probe().windows.find(w=>w.title==='Focus Island').outer,nativePill.outer);
  pass('With only eyes enabled, the completed timer returns directly to actual visible eyes without an extra clock delay');
  await panel.locator('#btnOpenPreferencesPage').click();await panel.locator('label:has(#swIdleClock)').click();await panel.locator('label:has(#swMotion)').click();await panel.locator('#btnOpenTimerPage').click();await expectClockPhase();
  const memory=execFileSync('powershell.exe',['-NoProfile','-Command','Get-Process -Id '+child.pid+' | Select-Object Id,WorkingSet64,PrivateMemorySize64 | ConvertTo-Json -Compress'],{windowsHide:true,encoding:'utf8'});
  report.nativeMemory=JSON.parse(memory);pass('Native process memory measurement',report.nativeMemory);
  const cdp=await browser.newBrowserCDPSession();
  const processes=await cdp.send('SystemInfo.getProcessInfo');
  const ids=[...new Set([child.pid,...processes.processInfo.map(p=>p.id)])];
  const processMemory=execFileSync('powershell.exe',['-NoProfile','-Command','Get-Process -Id '+ids.join(',')+' -ErrorAction SilentlyContinue | Select-Object Id,ProcessName,WorkingSet64,PrivateMemorySize64 | ConvertTo-Json -Compress'],{windowsHide:true,encoding:'utf8'});
  report.processMemory=JSON.parse(processMemory);
  report.totalWorkingSetBytes=report.processMemory.reduce((sum,p)=>sum+p.WorkingSet64,0);
  await cdp.detach();pass('Whole application memory (includes WebView2)',report.totalWorkingSetBytes);
  await stop();await launch();
  await expectPrepared(3);await expectDuration(3);
  assert.equal(await panel.locator('.task__name').first().textContent(),'</script>秒级检查');
  assert.equal(await panel.locator('.task').first().evaluate(node=>node.classList.contains('is-active')),true);
  const restore=await panel.evaluate(()=>({second:document.querySelector('#swSecond').checked,motion:document.querySelector('#swMotion').checked}));
  assert.deepEqual(restore,{second:false,motion:true});pass('Restart restores the selected task and configured seconds while starting idle, retaining settings and escaped task text');
  await island.evaluate(()=>window.__selftestOpen());await delay(600);
  await island.evaluate(()=>window.__fromRust('resetTimer'));
  await island.locator('#island').click({position:{x:170,y:15}});
  await island.waitForFunction(()=>!window.__isOpen());await delay(150);
  assert.deepEqual(probe().windows.find(w=>w.title==='Focus Island').outer,nativePill.outer);
  pass('Collapse retains the stable native viewport');
  const log=fs.readFileSync(path.join(data,'diagnostic.log'),'utf8');
  assert(!log.includes('FRONTEND ERROR'));assert.deepEqual(errors,[]);pass('No frontend runtime errors');
  report.passed=true;
 }finally{
  await stop();report.errors=errors;fs.writeFileSync(path.join(out,'native-report.json'),JSON.stringify(report,null,2));
 }
})().catch(error=>{console.error(error);process.exitCode=1;});
