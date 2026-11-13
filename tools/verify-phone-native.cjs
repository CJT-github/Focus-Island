/* Native Windows WebView/IPC/region integration for the notification companion.
   Preview messages use real notificationTest IPC. Phone events below are explicit
   presentation fixtures; this is NOT a phone-to-PC Bluetooth delivery test. */
const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path');
const {spawn,execFileSync}=require('node:child_process');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'D:/workDir/verify-tools/node_modules/playwright');
const root=path.resolve(__dirname,'..'),out=path.join(__dirname,'verify'),delay=ms=>new Promise(r=>setTimeout(r,ms));
async function main(){
 await fs.mkdir(out,{recursive:true});
 const profile=await fs.mkdtemp(path.join(out,'phone-native-')),stateFile=path.join(profile,'state.json');
 const exe=path.resolve(process.argv[2]||path.join(root,'target/verified/release/focus-island.exe'));
 const report={mode:'native',checks:[],errors:[],bluetoothEndToEnd:false,
  notificationSource:'real notificationTest IPC and explicitly injected phone adapter fixtures',profile,exe};
 const pass=(name,details)=>{report.checks.push({name,details});console.log('PASS',name);};
 const userPath=path.join(process.env.APPDATA,'FocusIsland/state.json'),userBefore=await fs.readFile(userPath).catch(()=>null);
 const fixture={tasks:[{id:'notice-test',name:'通知框验证',sec:8,completionAction:{enabled:false,kind:'command',command:'',delaySec:10}}],
  current_id:'notice-test',duration_sec:8,settings:{showHands:true,showSecond:true,showIdleEyes:false,showIdleClock:true,sound:false,notify:false,alwaysOnTop:true,reduceMotion:false,topOffset:20},
  phone:{enabled:false,displaySeconds:8,hideContent:false,deviceAddress:'',deviceName:''}};
 // Missing notifications is intentional: native defaults must migrate safely.
 await fs.writeFile(stateFile,JSON.stringify(fixture));
 let child,browser,island,panel;
 const send=(page,value)=>page.evaluate(v=>window.ipc.postMessage(JSON.stringify(v)),value);
 const region=()=>JSON.parse(execFileSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(__dirname,'phone-window-region.ps1'),'-AppProcessId',String(child.pid)],{encoding:'utf8',windowsHide:true}));
 const state=()=>island.evaluate(()=>window.__notificationState());
 const waitMode=(mode)=>island.waitForFunction(mode=>window.__notificationState()?.mode===mode&&window.__notificationState()?.renderedMode===mode,mode);
 const settled=()=>island.waitForFunction(()=>document.getElementById('noticeCompanion').dataset.phase==='settled');
 const posted=(source,id,body='消息正文')=>island.evaluate(n=>window.__notificationEvent(n),
  {type:'posted',source,id,app:'测试来源',title:'长消息标题 '.repeat(20),body,time:Date.now()});
 const removed=(source,id)=>island.evaluate(n=>window.__notificationEvent(n),{type:'removed',source,id});
 const configure=async(settings)=>{
  const before=await panel.evaluate(()=>noticeResults.length);
  await send(panel,{type:'notificationsConfigure',settings});
  await panel.waitForFunction(before=>noticeResults.length>before,before);
  return panel.evaluate(()=>noticeResults.at(-1));
 };
 const phoneConfigure=async(settings)=>{
  const before=await panel.evaluate(()=>phoneResults.length);
  await send(panel,{type:'phoneConfigure',settings});
  await panel.waitForFunction(before=>phoneResults.length>before,before);
  return panel.evaluate(()=>phoneResults.at(-1));
 };
 const test=async()=>{
  const before=await island.evaluate(()=>receivedNotices.length);
  await send(panel,{type:'notificationTest'});
  await island.waitForFunction(before=>receivedNotices.length>before,before);
  return island.evaluate(()=>receivedNotices.at(-1));
 };
 const clearMessages=async()=>{
  for(const message of (await state()).items)await removed(message.source,message.id);
  await waitMode('none');await delay(500);
 };
 try{
  child=spawn(exe,['--debug-port','9481','--data-dir',profile,'--log-file',path.join(profile,'native.log'),'--verbose'],{cwd:root,windowsHide:true});
  child.on('error',e=>report.errors.push(e.message));
  for(let i=0;i<100&&!browser;i++){try{browser=await chromium.connectOverCDP('http://127.0.0.1:9481');}catch{await delay(200);}}
  assert(browser,'CDP is available');
  for(let i=0;i<100&&(!island||!panel);i++){
   for(const context of browser.contexts())for(const page of context.pages()){
    const view=await page.evaluate(()=>document.body?.dataset.view).catch(()=>null);
    if(view==='island')island=page;else if(view==='panel')panel=page;
   }
   if(!island||!panel)await delay(100);
  }
  assert(island&&panel,'both native views');
  for(const page of [island,panel]){
   page.on('pageerror',e=>report.errors.push(e.message));
   await page.waitForFunction(()=>typeof window.__notificationsConfigResult==='function');
   await page.evaluate(()=>{
    window.phoneEvents=[];window.phoneResults=[];window.timerEvents=[];window.noticeResults=[];window.receivedNotices=[];window.viewportAcks=[];
    const status=window.__phoneStatus,phone=window.__phoneConfigResult,notice=window.__notificationsConfigResult;
    const timer=window.__applyTimer,event=window.__notificationEvent,ack=window.__viewportReady;
    window.__phoneStatus=v=>{phoneEvents.push(v);status(v);};
    window.__phoneConfigResult=v=>{phoneResults.push(v);phone(v);};
    window.__notificationsConfigResult=v=>{noticeResults.push(v);notice(v);};
    window.__notificationEvent=v=>{receivedNotices.push({...v,receivedAt:Date.now()});event(v);};
    if(timer)window.__applyTimer=v=>{timerEvents.push(v);timer(v);};
    if(ack)window.__viewportReady=v=>{viewportAcks.push(v);ack(v);};
   });
  }
  assert.deepEqual((await state()).settings,{enabled:true,displaySeconds:5,listLimit:5});
  await send(island,{type:'togglePanel'});await panel.locator('#btnOpenPreferencesPage').click();
  assert.equal(await panel.locator('#notificationDisplaySeconds').inputValue(),'5');
  assert.equal(await panel.locator('#notificationListLimit').inputValue(),'5');
  await panel.locator('#btnSaveNotifications').click();
  await panel.waitForFunction(()=>noticeResults.some(v=>v.ok));
  let saved=JSON.parse(await fs.readFile(stateFile,'utf8'));
  assert.deepEqual(saved.notifications,{enabled:true,displaySeconds:5,listLimit:5});
  assert.equal(saved.tasks[0].id,'notice-test');assert.equal(saved.duration_sec,8);assert.deepEqual(saved.phone,fixture.phone);
  const savedBytes=await fs.readFile(stateFile),memoryBefore=await state();
  assert.equal((await configure({enabled:true,displaySeconds:1.5,listLimit:5})).ok,false);
  assert.deepEqual(await fs.readFile(stateFile),savedBytes);assert.deepEqual((await state()).settings,memoryBefore.settings);
  const backup=path.join(profile,'state-preserved.json');
  await fs.rename(stateFile,backup);await fs.mkdir(stateFile);
  try{
   assert.equal((await configure({enabled:false,displaySeconds:2,listLimit:2})).ok,false);
   assert.deepEqual((await state()).settings,memoryBefore.settings);
   assert.deepEqual(await fs.readFile(backup),savedBytes);
  }finally{await fs.rmdir(stateFile);await fs.rename(backup,stateFile);}
  pass('Independent defaults and real configuration IPC preserve tasks and phone settings; validation/save failure is atomic');
  const before=region();
  assert.equal(before.outer.Right-before.outer.Left,before.outer.Bottom-before.outer.Top);
  const scale=(before.outer.Right-before.outer.Left)/580;
  const first=await test();await waitMode('preview');await settled();
  const box=await island.locator('#noticeCompanion').boundingBox(),mainBox=await island.locator('#compact').boundingBox();
  assert.equal(Math.round(box.width),280);assert.equal(Math.round(box.height),38);
  await island.screenshot({path:path.join(out,'notice-preview-native.png'),omitBackground:true});
  assert(Math.abs((mainBox.x+box.x+box.width)/2-290)<1,JSON.stringify({mainBox,box}));
  assert(Math.abs(box.x-(mainBox.x+mainBox.width)-20)<1);
  const during=region();assert.deepEqual(during.outer,before.outer);
  assert(Math.abs((during.region.Right-during.region.Left)/scale-450)<5);
  assert((await island.evaluate(()=>viewportAcks.length))>0);
  await island.screenshot({path:path.join(out,'notice-preview-native.png'),omitBackground:true});
  await waitMode('count');
  const elapsed=Date.now()-first.receivedAt;assert(elapsed>=4900&&elapsed<7000,'default five-second preview deadline');
  await settled();
  assert.equal(Math.round((await island.locator('#noticeCompanion').boundingBox()).width),44);
  assert.equal(await island.locator('#noticeCount').textContent(),'1');
  assert.deepEqual(region().outer,before.outer);
  pass('Real notificationTest separates a centered companion, then shrinks after five seconds without resizing the native canvas',{elapsedMs:elapsed});
  for(let i=0;i<6;i++)await test();
  await island.locator('#noticeCompanion').click();await waitMode('list');await settled();
  let items=(await state()).items;assert.equal(items.length,7);
  assert.equal(await island.locator('#noticeItems li').count(),5);
  const visibleBefore=await island.locator('#noticeItems li').evaluateAll(rows=>rows.map(row=>JSON.parse(row.dataset.noticeKey)[1]));
  assert.deepEqual(visibleBefore,items.slice(0,5).map(v=>v.id));
  await island.locator('#noticeItems .notice-check').first().click();
  await island.waitForFunction(()=>window.__notificationState().count===6);
  const visibleAfter=await island.locator('#noticeItems li').evaluateAll(rows=>rows.map(row=>JSON.parse(row.dataset.noticeKey)[1]));
  assert.deepEqual(visibleAfter,items.slice(1,6).map(v=>v.id));
  assert.equal(await island.locator('#noticeItems li').count(),5);
  const listBox=await island.locator('#noticeList').boundingBox();
  assert.equal(Math.round(listBox.width),380);assert(listBox.height<=280);assert(Math.abs(listBox.x+listBox.width/2-290)<1);
  assert.deepEqual(region().outer,before.outer);
  await island.screenshot({path:path.join(out,'notice-list-native.png'),omitBackground:true});
  assert.equal((await configure({enabled:true,displaySeconds:5,listLimit:3})).ok,true);
  await island.waitForFunction(()=>document.querySelectorAll('#noticeItems li').length===3);
  assert.equal((await configure({enabled:true,displaySeconds:5,listLimit:5})).ok,true);
  pass('Count opens the centered capped list; checking a message removes it and promotes the next queued unread item');
  await clearMessages();
  await posted('fixture','long','这是一段很长的消息正文。'.repeat(60));await waitMode('preview');await settled();
  const ellipsis=await island.locator('#noticeTitle').evaluate(n=>({overflow:getComputedStyle(n).textOverflow,scroll:n.scrollWidth,client:n.clientWidth}));
  assert.equal(ellipsis.overflow,'ellipsis');assert(ellipsis.scroll>ellipsis.client);
  await clearMessages();
  pass('Preview maximum width applies real ellipsis to overflowing message text');
  await send(island,{type:'toggleTimer'});
  await panel.waitForFunction(()=>timerEvents.some(v=>v.running));
  const started=await panel.evaluate(()=>timerEvents.at(-1));
  await test();await waitMode('preview');await settled();
  await island.locator('#compact').click();await settled();await delay(280);
  assert.equal(Math.round((await island.locator('#noticeCompanion').boundingBox()).width),196);
  assert.equal(Math.round((await island.locator('#island').boundingBox()).width),340);
  assert.deepEqual(region().outer,before.outer);
  await panel.waitForFunction(start=>timerEvents.at(-1)?.runId===start.runId&&timerEvents.at(-1)?.running&&timerEvents.at(-1)?.remainingMs<start.remainingMs,started);
  const later=await panel.evaluate(()=>timerEvents.at(-1));assert.equal(later.taskId,started.taskId);
  await island.screenshot({path:path.join(out,'notice-timer-native.png'),omitBackground:true});
  await island.waitForFunction(()=>window.__notificationState()?.suspended&&document.getElementById('island').classList.contains('is-cracking'),null,{timeout:10000});
  assert.equal(await island.locator('#noticeCompanion').isVisible(),false);
  const effectRegion=region();assert.deepEqual(effectRegion.outer,before.outer);assert.equal(effectRegion.kind,0);
  await posted('fixture','during-completion','Message retained during completion animation');
  await island.waitForFunction(()=>!window.__notificationState()?.suspended&&window.__notificationState()?.mode==='count');
  assert.equal((await state()).count,2);await settled();
  await panel.waitForFunction(()=>timerEvents.at(-1)?.idleAfterCompletion===true,null,{timeout:12000});
  await settled();await delay(200);
  assert.equal(await island.locator('#island').evaluate(n=>n.classList.contains('is-clock')),true);
  assert.equal((await state()).mode,'count');assert.deepEqual(region().outer,before.outer);
  assert.equal(await panel.evaluate(()=>timerEvents.at(-1).runId),started.runId);
  pass('Timer continues through companion expansion; completion animation has priority and restores the unread count, then idle');
  await send(island,{type:'resetTimer'});
  await send(island,{type:'setDuration',sec:3});
  await panel.waitForFunction(()=>timerEvents.at(-1)?.totalMs===3000&&!timerEvents.at(-1)?.running);
  await send(island,{type:'toggleTimer'});
  await panel.waitForFunction(previous=>timerEvents.at(-1)?.running&&timerEvents.at(-1)?.runId!==previous,started.runId);
  const interruptedRun=await panel.evaluate(()=>timerEvents.at(-1).runId);
  await island.waitForFunction(()=>window.__notificationState()?.suspended&&document.getElementById('island').classList.contains('is-cracking'),null,{timeout:6000});
  await island.locator('#island').click({position:{x:170,y:60}});
  await panel.waitForFunction(run=>timerEvents.at(-1)?.runId===run&&timerEvents.at(-1)?.idleAfterCompletion,interruptedRun);
  await island.waitForFunction(()=>!window.__notificationState()?.suspended&&window.__notificationState()?.mode==='count',null,{timeout:4000});
  await waitMode('count');await settled();
  assert.equal((await state()).count,2);
  assert.equal(await island.locator('#island').evaluate(n=>n.classList.contains('is-clock')),true);
  assert.deepEqual(region().outer,before.outer);
  await test();await waitMode('preview');await settled();
  assert.equal((await state()).count,3);
  assert.equal(await island.locator('#noticeCompanion').isVisible(),true);
  pass('Clicking during completion restores count and idle; a subsequent real test notification previews normally');
  await send(island,{type:'resetTimer'});await clearMessages();
  assert.equal((await phoneConfigure({enabled:true,displaySeconds:8,hideContent:false})).ok,true);
  await delay(300);
  await island.evaluate(()=>window.__phoneStatus({supported:true,phase:'connected',notificationAccess:true,deviceAddress:'1',deviceName:'UI fixture only',devices:[]}));
  await posted('fixture','shared-id','Non-phone message remains visible');
  await island.evaluate(()=>window.__phoneNotification({type:'posted',id:'shared-id',app:'Phone fixture',package:'test.phone',title:'Private phone title',body:'private-native-fixture-must-not-render',time:Date.now()}));
  assert.equal((await state()).count,2);
  assert.equal((await phoneConfigure({enabled:true,displaySeconds:8,hideContent:true})).ok,true);
  let phoneMessage=(await state()).items.find(v=>v.source==='phone');
  assert.equal(phoneMessage.title,'');assert.equal(phoneMessage.body,'');
  assert(!(await island.locator('#noticeCompanion').textContent()).includes('private-native-fixture-must-not-render'));
  await island.evaluate(()=>window.__phoneNotification({type:'removed',id:'shared-id'}));
  assert.equal((await state()).count,1);
  await island.evaluate(()=>window.__phoneNotification({type:'posted',id:'second',app:'Phone fixture',title:'hidden',body:'private-native-fixture-must-not-render',time:Date.now()}));
  assert.equal((await state()).count,2);
  assert.equal((await phoneConfigure({enabled:false,displaySeconds:8,hideContent:true})).ok,true);
  await island.waitForFunction(()=>window.__notificationState().count===1);
  assert.equal((await state()).items[0].source,'fixture');
  pass('Explicit phone adapter fixtures share the queue, namespace IDs, honor privacy, and remove only their own source');
  await panel.locator('#btnOpenPreferencesPage').click();
  await panel.locator('#notificationsSettings').evaluate(node=>node.scrollIntoView({block:'start',behavior:'instant'}));
  await panel.screenshot({path:path.join(out,'notice-settings-native.png'),omitBackground:true});
  assert.equal((await configure({enabled:false,displaySeconds:5,listLimit:5})).ok,true);
  await waitMode('none');
  assert.equal((await state()).count,0);assert.equal(await island.locator('#noticeCompanion').isVisible(),false);
  assert.equal((await configure({enabled:true,displaySeconds:5,listLimit:5})).ok,true);
  assert.equal((await state()).count,0);
  pass('Disabling clears messages and re-enabling never replays old contents');
  const log=await fs.readFile(path.join(profile,'native.log'),'utf8');
  assert(!log.includes('private-native-fixture-must-not-render'));assert(!log.includes('FRONTEND ERROR'));assert(!log.includes('FATAL:'));
  saved=JSON.parse(await fs.readFile(stateFile,'utf8'));assert.equal(saved.tasks[0].completionAction.enabled,false);
  assert(!JSON.stringify(saved).includes('private-native-fixture'));assert(!JSON.stringify(saved).includes('Non-phone message'));
  assert.deepEqual(report.errors,[]);
 }catch(error){report.errors.push(error.stack||String(error));throw error;}
 finally{
  if(island&&!island.isClosed())await send(island,{type:'quit'}).catch(()=>{});
  await delay(400);if(browser)await browser.close().catch(()=>{});
  if(child&&child.exitCode===null)child.kill();
  const userAfter=await fs.readFile(userPath).catch(()=>null);
  report.userProfileUnchanged=(!userBefore&&!userAfter)||!!(userBefore&&userAfter&&userBefore.equals(userAfter));
  if(!report.userProfileUnchanged)report.errors.push('User profile changed');
  report.passed=report.errors.length===0;
  await fs.writeFile(path.join(out,'phone-native-report.json'),JSON.stringify(report,null,2));
  if(!report.userProfileUnchanged)throw new Error('User profile changed');
 }
 return report;
}
main().then(r=>console.log(JSON.stringify(r,null,2))).catch(e=>{console.error(e);process.exitCode=1;});
