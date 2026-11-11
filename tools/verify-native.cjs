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
async function expectCountdown(sec){
 const pad=n=>String(n).padStart(2,'0');
 await digits(pad(Math.floor(sec/3600))+':'+pad(Math.floor(sec%3600/60))+':'+pad(sec%60));
 assert.equal(await island.locator('#island').evaluate(node=>node.classList.contains('is-clock')||node.classList.contains('is-idle-eyes')),false);
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
 await expectDuration(sec);await expectCountdown(sec);
}
(async()=>{
 try{
  fs.writeFileSync(path.join(data,'state.json'),JSON.stringify({tasks:[{id:'initial',name:'测试初始任务',sec:1500}],current_id:'initial',duration_sec:25*60,settings:{showHands:true,showSecond:true,sound:false,notify:false,alwaysOnTop:true,reduceMotion:false}}));
  await launch();
  const initial=await island.evaluate(()=>({width:innerWidth,height:innerHeight,time:document.querySelector('#compactTime').textContent}));
  assert.equal(initial.width,580);assert.equal(initial.height,580);await expectCountdown(1500);await expectDuration(1500);
  pass('Stable native canvas with the selected saved task countdown',initial);
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
  const panelNative=probe().windows.find(w=>w.title==='Focus Island 设置');
  assert(panelNative.outer.Left>=panelNative.work.Left&&panelNative.outer.Top>=panelNative.work.Top&&panelNative.outer.Right<=panelNative.work.Right&&panelNative.outer.Bottom<=panelNative.work.Bottom);
  const panelScale=await panel.evaluate(()=>devicePixelRatio);
  assert(Math.abs(panelNative.work.Right-panelNative.outer.Right-20*panelScale)<=1);
  assert(Math.abs(panelNative.work.Bottom-panelNative.outer.Bottom-20*panelScale)<=1);
  pass('Settings panel starts at bottom right above the taskbar',panelNative.outer);
  const handle=await panel.locator('#panelDragHandle').boundingBox();
  const dragX=Math.round(panelNative.origin.X+(handle.x+40)*panelScale);
  const dragY=Math.round(panelNative.origin.Y+(handle.y+handle.height/2)*panelScale);
  const movedPanel=probe(dragX,dragY,dragX-160,dragY-100).windows.find(w=>w.title==='Focus Island 设置');
  assert(movedPanel.outer.Left < panelNative.outer.Left-60 && movedPanel.outer.Left>=panelNative.work.Left,'title drag moves native window horizontally: '+JSON.stringify(movedPanel.outer));
  assert(movedPanel.outer.Top < panelNative.outer.Top-40 && movedPanel.outer.Top>=panelNative.work.Top,'title drag moves native window vertically: '+JSON.stringify(movedPanel.outer));
  await panel.locator('#btnClose').click();
  await island.locator('#island').click({button:'right',position:{x:170,y:20}});await delay(250);
  assert.deepEqual(probe().windows.find(w=>w.title==='Focus Island 设置').outer,movedPanel.outer);
  await island.evaluate(()=>document.querySelector('#island').click());await delay(600);
  assert.deepEqual(probe().windows.find(w=>w.title==='Focus Island 设置').outer,movedPanel.outer);
  await island.evaluate(()=>document.querySelector('#island').click());await delay(600);
  assert.deepEqual(probe().windows.find(w=>w.title==='Focus Island 设置').outer,movedPanel.outer);
  pass('Native title dragging; position retained across reopening and island resizing',movedPanel.outer);

  await panel.screenshot({path:path.join(out,'native-panel.png'),omitBackground:true});
  await custom(8);await panel.locator('#btnStart').click();await delay(1150);
  assert(await island.locator('#island').evaluate(e=>e.classList.contains('is-running')));
  assert.equal(await panel.locator('#btnStart').textContent(),'暂停');
  await panel.locator('label:has(#swSecond)').click();
  assert(await island.locator('#island').evaluate(e=>e.classList.contains('is-running')));
  await panel.locator('#btnStart').click();await delay(200);
  const paused=await island.locator('#readoutDigits').textContent();await delay(1200);
  assert.equal(await island.locator('#readoutDigits').textContent(),paused);
  assert.equal(await island.locator('#island').evaluate(e=>e.classList.contains('is-clock')),false);
  pass('Panel start/pause controls island; paused timer remains countdown and preferences preserve it',paused);
  await panel.locator('#btnReset2').click();await expectCountdown(8);await expectDuration(8);pass('Reset keeps the selected task countdown at its configured duration');
  await panel.locator('#btnClear').click();await delay(150);
  assert.equal(JSON.parse(fs.readFileSync(path.join(data,'state.json'))).tasks.length,0);pass('Clear tasks persists empty list');
  await expectClock();
  const emptyClock=await island.locator('#compactTime').textContent();
  await island.waitForFunction(previous=>document.querySelector('#compactTime').textContent!==previous,emptyClock,{timeout:2000});
  await expectClock();
  pass('Clearing tasks shows an updating local HH:mm:ss clock');

  await panel.locator('#btnOpenTaskPage').click();await panel.locator('#inTaskName').fill('</script>秒级检查');await panel.locator('#inTaskMin').fill('0');await panel.locator('#inTaskSec').fill('3');await panel.locator('#btnAddTask').click();
  await expectDuration(3);await expectCountdown(3);
  assert.equal(JSON.parse(fs.readFileSync(path.join(data,'state.json'))).tasks[0].sec,3);pass('Three-second task creation replaces the idle clock with its countdown');
  await panel.locator('#btnOpenTaskPage').click();await panel.locator('#inTaskName').fill('备用任务');await panel.locator('#inTaskSec').fill('5');await panel.locator('#btnAddTask').click();
  await expectDuration(5);await expectCountdown(5);
  await panel.locator('.task__select').first().click();await expectDuration(3);await expectCountdown(3);
  assert.equal(await island.locator('#readoutChip').textContent(),'准备开始');
  pass('Adding and selecting tasks displays the selected countdown before starting it');
  await panel.locator('label:has(#swNotify)').click();
  await panel.locator('#btnStart').click();
  await island.waitForFunction(()=>document.querySelector('#island').classList.contains('is-cracking'));
  assert.equal(await island.evaluate(()=>innerWidth),580);
  await delay(220);await island.screenshot({path:path.join(out,'native-crack.png'),omitBackground:true});
  await island.waitForFunction(()=>!document.querySelector('#island').classList.contains('is-finishing'));
  await digits('00:00:00');assert.equal(await island.locator('#readoutChip').textContent(),'时间到');
  assert.equal(await island.evaluate(()=>innerWidth),580);pass('3s completion returns the dial on the stable 580 canvas');
  await island.screenshot({path:path.join(out,'native-done.png'),omitBackground:true});
  await panel.locator('label:has(#swMotion)').click();await panel.locator('#btnReset2').click();await expectCountdown(3);await expectDuration(3);
  await panel.locator('#btnStart').click();await island.waitForFunction(()=>document.querySelector('#island').classList.contains('is-done'));
  assert.equal(await island.locator('.crack__piece').count(),0);pass('Reduced motion finishes without fragments');
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
  await expectCountdown(3);await expectDuration(3);
  assert.equal(await panel.locator('.task__name').first().textContent(),'</script>秒级检查');
  assert.equal(await panel.locator('.task').first().evaluate(node=>node.classList.contains('is-active')),true);
  const restore=await panel.evaluate(()=>({second:document.querySelector('#swSecond').checked,motion:document.querySelector('#swMotion').checked}));
  assert.deepEqual(restore,{second:false,motion:true});pass('Restart restores the selected task countdown, configured seconds, settings and escaped task text');
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
