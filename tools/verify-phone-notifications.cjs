/* App integration contracts only: all notifications and native ACKs are local fixtures. */
const fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict');
async function run(){
 const root=path.resolve(__dirname,'..');
 const {chromium}=require(process.env.PLAYWRIGHT_MODULE||path.resolve(root,'../verify-tools/node_modules/playwright'));
 const [template,css,controller,app]=await Promise.all(['index.html','styles.css','notifications.js','app.js'].map(name=>fs.readFile(path.join(root,'ui',name),'utf8')));
 const output=path.join(root,'tools/verify');await fs.mkdir(output,{recursive:true});
 const browser=await chromium.launch({headless:true,executablePath:process.env.BROWSER_EXE||'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
 const errors=[],checks=[];
 const phone={enabled:true,displaySeconds:17,hideContent:false,deviceAddress:'1234',deviceName:'Android'};
 const state={tasks:[{id:'a',name:'Notification integration task',sec:65}],current_id:'a',duration_sec:65,
  settings:{showHands:true,showSecond:true,showIdleClock:true,showIdleEyes:false,sound:false,reduceMotion:false},phone};
 const geometry={dial:340,effect:580,pillW:132,pillH:38};
 async function pageFor(view,initial=state,platform='windows'){
  const page=await browser.newPage({viewport:view==='panel'?{width:680,height:700}:{width:580,height:580}});
  page.on('pageerror',error=>errors.push({view,platform,message:error.message}));
  await page.goto('about:blank');
  await page.clock.install({time:new Date('2030-01-01T12:00:00Z')});
  await page.clock.pauseAt(new Date('2030-01-01T12:00:01Z'));
  const setup="window.messages=[];window.autoAck=true;window.ipc={postMessage(value){const message=JSON.parse(value);messages.push({...message,at:Date.now()});if(autoAck&&message.requestId&&['setShape','setEffect','setNotificationLayout'].includes(message.type))queueMicrotask(()=>window.__viewportReady?.(message.requestId));}};window.__PLATFORM__="+JSON.stringify(platform)+";\n";
  await page.setContent(template.replace('__VIEW__',view).replace('/*__GEO__*/',JSON.stringify(geometry))
   .replace('/*__STATE__*/',JSON.stringify(initial)).replace('/*__CSS__*/',()=>css).replace('/*__JS__*/',()=>setup+controller+'\n'+app));
  return page;
 }
 const posted=(id,extra={})=>({type:'posted',id,app:'Phone app',package:'test.app',title:'Phone '+id,body:'Body '+id,time:Date.now(),...extra});
 const emit=(page,payload)=>page.evaluate(payload=>__phoneNotification(payload),payload);
 const external=(page,payload)=>page.evaluate(payload=>__notificationEvent(payload),{source:'test',...payload});
 const status=(page,extra={})=>page.evaluate(payload=>__phoneStatus(payload),{supported:true,phase:'connected',devices:[],deviceName:'Android',deviceAddress:'1234',notificationAccess:true,...extra});
 const notice=page=>page.evaluate(()=>__notificationState());
 const visible=(page,selector)=>page.locator(selector).evaluate(node=>!node.hidden);
 const click=(page,selector)=>page.locator(selector).evaluate(node=>node.click());
 const tick=(page,ms=700)=>page.clock.runFor(ms);
 const message=(page,type)=>page.evaluate(type=>messages.filter(item=>item.type===type).at(-1),type);
 const messageCount=(page,type)=>page.evaluate(type=>messages.filter(item=>item.type===type).length,type);
 const timer=page=>page.evaluate(()=>{__fromRust('syncTimer');return messages.filter(item=>item.type==='timerState').at(-1);});
 const timerKeys=['runId','taskId','running','done','started','remainingMs','totalMs'];
 const sameTimer=(actual,expected,keys=timerKeys)=>{for(const key of keys)assert.equal(actual[key],expected[key],key);};
 const phoneResult=(page,settings,ok=true)=>page.evaluate(payload=>__phoneConfigResult(payload),{ok,settings,message:ok?'Saved':'Save rejected'});
 try{
  const island=await pageFor('island');
  const idle=await timer(island);
  await emit(island,posted('idle-gated'));assert.equal((await notice(island)).count,0);
  await status(island,{notificationAccess:null});await emit(island,posted('unknown-access'));assert.equal((await notice(island)).count,0,'unknown notification access must not pass the phone callback gate');
  await status(island,{notificationAccess:false});await emit(island,posted('no-access'));assert.equal((await notice(island)).count,0);
  await status(island);await island.evaluate(()=>{autoAck=false;});await emit(island,posted('first',{source:'forged'}));
  assert.equal(await visible(island,'#noticeCompanion'),false,'app waits for matching native notification ACK');
  const request=await message(island,'setNotificationLayout');assert.equal(request.mode,'transition');
  await island.evaluate(id=>{autoAck=true;__viewportReady(id);},request.requestId);await tick(island);
  assert.equal((await notice(island)).items[0].source,'phone','phone adapter owns its source identity');
  sameTimer(await timer(island),idle);
  assert.equal(await island.locator('#island').evaluate(node=>node.classList.contains('is-clock')),true);
  assert.equal((await notice(island)).settings.displaySeconds,5,'legacy phone duration cannot override shared default');
  checks.push('phone callbacks require connection and granted access; adapter fixes source identity; native ACK gates companion without replacing idle clock');

  await external(island,posted('first',{title:'External secret',body:'External body'}));assert.equal((await notice(island)).count,2);
  await phoneResult(island,{...phone,hideContent:true});
  let items=(await notice(island)).items;
  assert.equal(items.find(item=>item.source==='phone').title,'');assert.equal(items.find(item=>item.source==='phone').body,'');
  assert.equal(items.find(item=>item.source==='test').title,'External secret');
  await emit(island,posted('private',{title:'Must not retain',body:'Private body'}));
  assert.equal((await notice(island)).items.find(item=>item.id==='private').body,'');
  await phoneResult(island,{...phone,enabled:false});
  assert.deepEqual((await notice(island)).items.map(item=>item.source),['test']);
  await emit(island,posted('disabled'));assert.equal((await notice(island)).count,1);
  await phoneResult(island,phone);await status(island);await emit(island,posted('disconnect'));
  await status(island,{phase:'reconnecting'});assert.deepEqual((await notice(island)).items.map(item=>item.source),['test']);
  await emit(island,posted('stale'));assert.equal((await notice(island)).count,1);
  await status(island);await emit(island,posted('revoked'));await status(island,{notificationAccess:false});
  assert.deepEqual((await notice(island)).items.map(item=>item.source),['test']);
  await status(island);await emit(island,posted('scan-retained'));await status(island,{phase:'scanning'});
  assert.equal((await notice(island)).count,2);await emit(island,posted('scan-gated'));assert.equal((await notice(island)).count,2);
  await status(island);await status(island,{supported:false,phase:'unsupported'});
  assert.deepEqual((await notice(island)).items.map(item=>item.source),['test']);
  await island.evaluate(()=>__notificationsConfigResult({ok:true,settings:{enabled:false,displaySeconds:5,listLimit:5}}));
  assert.equal((await notice(island)).count,0);assert.equal(await visible(island,'#noticeCompanion'),false);
  await external(island,posted('disabled-center'));assert.equal((await notice(island)).count,0);
  await island.evaluate(()=>__notificationsConfigResult({ok:true,settings:{enabled:true,displaySeconds:5,listLimit:5}}));
  await external(island,posted('restored-center'));assert.equal((await notice(island)).count,1);

  checks.push('privacy redacts existing and future phone content; phone disable/disconnect/revocation clear only phone; shared disable clears all sources and equal external IDs stay independent');

  await status(island);await island.evaluate(()=>__fromRust('toggleTimer'));
  await tick(island,1040);const running=await timer(island);assert.equal(running.running,true);
  await emit(island,posted('running'));sameTimer(await timer(island),running);
  await tick(island);await click(island,'#noticeCompanion');await tick(island);
  assert.equal((await notice(island)).mode,'list');
  const duringList=await timer(island);assert.equal(duringList.runId,running.runId);assert.equal(duringList.running,true);assert(duringList.remainingMs<running.remainingMs);
  await island.evaluate(()=>__fromRust('toggleTimer'));const paused=await timer(island);assert.equal(paused.running,false);
  await emit(island,posted('paused'));await tick(island,2200);sameTimer(await timer(island),paused);
  const queuedBeforeDismiss=(await notice(island)).count;await island.locator('#noticeItems input').first().evaluate(node=>node.click());
  assert.equal((await notice(island)).count,queuedBeforeDismiss-1);sameTimer(await timer(island),paused);
  await island.keyboard.press('Escape');await tick(island);sameTimer(await timer(island),paused);
  assert.equal((await notice(island)).mode,'count');
  await island.evaluate(()=>__fromRust('toggleTimer'));await tick(island,1040);
  const resumed=await timer(island);assert.equal(resumed.runId,running.runId);assert.equal(resumed.running,true);assert(resumed.remainingMs<paused.remainingMs);
  checks.push('running and paused countdowns preserve run identity and timing through new messages, list opening, dismissal, Escape and resume');

  const donePage=await pageFor('island',{...state,duration_sec:1,tasks:[{id:'a',name:'One second',sec:1}]});
  await external(donePage,posted('before-completion'));await tick(donePage);
  await donePage.evaluate(()=>__fromRust('toggleTimer'));await tick(donePage,1040);
  const completed=await timer(donePage);assert.equal(completed.done,true);assert.equal(completed.running,false);
  assert.equal((await notice(donePage)).suspended,true);assert.equal(await visible(donePage,'#noticeCompanion'),false);
  await external(donePage,posted('during-completion'));assert.equal((await notice(donePage)).count,2);assert.equal((await notice(donePage)).mode,'none');
  await tick(donePage,2300);assert.equal((await notice(donePage)).suspended,false);assert.equal((await notice(donePage)).mode,'count');
  assert.equal(await visible(donePage,'#noticeCompanion'),true);sameTimer(await timer(donePage),completed);
  assert.equal(await messageCount(donePage,'timerDone'),1);
  await tick(donePage,8500);const idleCompleted=await timer(donePage);assert.equal(idleCompleted.runId,completed.runId);assert.equal(idleCompleted.done,true);assert.equal(idleCompleted.idleAfterCompletion,true);
  assert.equal((await notice(donePage)).mode,'count');assert.equal(await donePage.locator('#island').evaluate(node=>node.classList.contains('is-clock')),true);
  checks.push('completion effect hides the companion immediately, queues arrivals, resumes count and keeps one timer completion before ten-second idle recovery');

  const resumeRaces=[];
  for(const phase of ['during-effect','waiting-for-effect-end-ack']){
   const racePage=await pageFor('island',{...state,duration_sec:1,tasks:[{id:'a',name:'Completion race',sec:1}]});
   await external(racePage,posted('race-'+phase));await tick(racePage);
   await racePage.evaluate(()=>__fromRust('toggleTimer'));await tick(racePage,1120);
   assert.equal((await notice(racePage)).suspended,true);
   const raceCompleted=await timer(racePage);assert.equal(raceCompleted.done,true);
   await racePage.evaluate(()=>{autoAck=false;});
   if(phase==='waiting-for-effect-end-ack'){
    await tick(racePage,1800);
    const effectEnd=await message(racePage,'setEffect');
    assert.equal(effectEnd.active,false,'second race must wait on the effect-end native ACK');
    assert.equal(await visible(racePage,'#noticeCompanion'),false,'companion waits for its own native layout ACK while effect-end ACK is delayed');
   }
   await click(racePage,'#island');
   const clicked=await timer(racePage);
   assert.equal(clicked.idleAfterCompletion,true);assert.equal(clicked.runId,raceCompleted.runId);
   // Deliver pending ACKs newest first, including now-obsolete effect ACKs.
   await racePage.evaluate(()=>{
    autoAck=true;
    const pending=messages.filter(item=>item.requestId&&['setShape','setEffect','setNotificationLayout'].includes(item.type)).map(item=>item.requestId).reverse();
    for(const id of pending)__viewportReady(id);
   });
   await tick(racePage,900);
   const restored=await notice(racePage),restoredTimer=await timer(racePage);
   resumeRaces.push({phase,suspended:restored.suspended,mode:restored.mode,count:restored.count,visible:await visible(racePage,'#noticeCompanion'),idleAfterCompletion:restoredTimer.idleAfterCompletion});
   sameTimer(restoredTimer,clicked);
   assert.equal(await messageCount(racePage,'timerDone'),1);
  }
  await fs.writeFile(path.join(output,'notification-completion-race-report.json'),JSON.stringify(resumeRaces,null,2));
  assert.deepEqual(resumeRaces.map(item=>({suspended:item.suspended,mode:item.mode,count:item.count,visible:item.visible,idleAfterCompletion:item.idleAfterCompletion})),
   resumeRaces.map(()=>({suspended:false,mode:'count',count:1,visible:true,idleAfterCompletion:true})),
   'click-to-idle must resume the unread companion despite cancelled or stale effect-end ACKs');
  checks.push('click-to-idle during completion and before delayed effect-end ACK both resume unread count; stale ACKs cannot keep the companion suspended');


  for(const missedAcks of [1,2]){
   const retryPage=await pageFor('island');
   await external(retryPage,posted('ack-retry-'+missedAcks));await tick(retryPage);
   await retryPage.evaluate(()=>{autoAck=false;});await tick(retryPage,4300);
   const firstAttempt=await message(retryPage,'setNotificationLayout');
   assert.equal(firstAttempt.mode,'transition');
   assert.equal((await notice(retryPage)).mode,'count');assert.equal((await notice(retryPage)).renderedMode,'preview');
   await tick(retryPage,2000);
   const secondAttempt=await message(retryPage,'setNotificationLayout');
   assert(secondAttempt.requestId>firstAttempt.requestId,'retry must use a fresh native identity');
   await retryPage.evaluate(id=>__viewportReady(id),firstAttempt.requestId);
   assert.equal((await notice(retryPage)).renderedMode,'preview','obsolete ACK cannot reveal the current layout');
   if(missedAcks===1){
    await retryPage.evaluate(id=>{autoAck=true;__viewportReady(id);},secondAttempt.requestId);
   }else{
    await retryPage.evaluate(()=>{window.expectedLayoutTimeouts=1;});
    await tick(retryPage,2001);
    const failedRequests=await messageCount(retryPage,'setNotificationLayout');
    await tick(retryPage,1000);
    assert.equal(await messageCount(retryPage,'setNotificationLayout'),failedRequests,'two failed attempts must stop automatic retries');
    assert.equal(await messageCount(retryPage,'frontendError'),1);
    await retryPage.evaluate(()=>{autoAck=true;window.dispatchEvent(new Event('focus'));});
    assert((await message(retryPage,'setNotificationLayout')).requestId>secondAttempt.requestId,'focus retries after terminal failure invalidates the controller cache');
   }
   await tick(retryPage);
   assert.equal((await notice(retryPage)).renderedMode,'count');
   assert.equal((await notice(retryPage)).count,1);
   assert.equal(await retryPage.locator('#noticeCompanion').evaluate(node=>node.style.width),'44px');
   await retryPage.evaluate(ids=>{for(const id of ids)__viewportReady(id);},[firstAttempt.requestId,secondAttempt.requestId]);
   assert.equal((await notice(retryPage)).renderedMode,'count');
   assert.equal(await messageCount(retryPage,'frontendError'),missedAcks===1?0:1);
  }
  checks.push('one lost layout ACK retries once with a fresh ID; two losses stop retrying and a later focus recovers the 44px count without stale-ACK interference');


  const initialPhone={...phone,enabled:false,deviceAddress:'',deviceName:''};
  const panel=await pageFor('panel',{...state,phone:initialPhone});
  await status(panel,{phase:'idle'});await click(panel,'#btnOpenPreferencesPage');await tick(panel,240);
  assert.equal(await panel.getAttribute('#preferencesPage','aria-hidden'),'false');
  assert.equal(await panel.locator('#preferencesPage #notificationsSettings #notificationsEnabled').count(),1);
  assert.equal(await panel.inputValue('#notificationDisplaySeconds'),'5');assert.equal(await panel.inputValue('#notificationListLimit'),'5');
  assert.equal(await panel.locator('#notificationsEnabled').isChecked(),true);
  for(const value of ['','0','31','1.5']){
   const count=await messageCount(panel,'notificationsConfigure');
   await panel.fill('#notificationDisplaySeconds',value);await click(panel,'#btnSaveNotifications');
   assert.equal(await messageCount(panel,'notificationsConfigure'),count);assert.equal(await panel.getAttribute('#notificationDisplaySeconds','aria-invalid'),'true');
  }
  await panel.fill('#notificationDisplaySeconds','5');
  for(const value of ['','0','11','2.5']){
   const count=await messageCount(panel,'notificationsConfigure');
   await panel.fill('#notificationListLimit',value);await click(panel,'#btnSaveNotifications');
   assert.equal(await messageCount(panel,'notificationsConfigure'),count);assert.equal(await panel.getAttribute('#notificationListLimit','aria-invalid'),'true');
  }
  await panel.fill('#notificationDisplaySeconds','7');await panel.fill('#notificationListLimit','3');
  await panel.evaluate(()=>__applyState({settings:{sound:true}},false));
  assert.equal(await panel.inputValue('#notificationDisplaySeconds'),'7');assert.equal(await panel.inputValue('#notificationListLimit'),'3');
  await click(panel,'#btnSaveNotifications');
  assert.deepEqual((await message(panel,'notificationsConfigure')).settings,{enabled:true,displaySeconds:7,listLimit:3});
  assert.equal(await panel.locator('#notificationDisplaySeconds').isDisabled(),true);
  await panel.evaluate(()=>__notificationsConfigResult({ok:false,message:'Storage unavailable',settings:{enabled:true,displaySeconds:5,listLimit:5}}));
  assert.equal(await panel.inputValue('#notificationDisplaySeconds'),'7');assert.equal(await panel.inputValue('#notificationListLimit'),'3');
  assert.equal(await panel.textContent('#notificationsConfigNote'),'Storage unavailable');assert.equal(await panel.locator('#btnSaveNotifications').isDisabled(),false);
  await panel.fill('#notificationDisplaySeconds','30');await panel.fill('#notificationListLimit','10');await panel.press('#notificationListLimit','Enter');
  assert.deepEqual((await message(panel,'notificationsConfigure')).settings,{enabled:true,displaySeconds:30,listLimit:10});
  await panel.evaluate(()=>__notificationsConfigResult({ok:true,settings:{enabled:true,displaySeconds:30,listLimit:10}}));
  await click(panel,'#btnTestNotification');assert.equal((await message(panel,'notificationTest')).type,'notificationTest');
  await panel.fill('#notificationDisplaySeconds','1');await panel.fill('#notificationListLimit','1');await click(panel,'#btnSaveNotifications');
  assert.deepEqual((await message(panel,'notificationsConfigure')).settings,{enabled:true,displaySeconds:1,listLimit:1});
  await panel.evaluate(()=>__notificationsConfigResult({ok:true,settings:{enabled:true,displaySeconds:1,listLimit:1}}));
  await click(panel,'#notificationsEnabled');assert.equal((await message(panel,'notificationsConfigure')).settings.enabled,false);
  await panel.evaluate(()=>__notificationsConfigResult({ok:true,settings:{enabled:false,displaySeconds:1,listLimit:1}}));
  assert.equal(await panel.locator('#btnTestNotification').isDisabled(),true);
  checks.push('notification settings inside preferences default to 5/5, validates integer ranges 1–30/1–10, preserves drafts across broadcasts and failed saves, and persists boundaries/test/enable controls');

  await click(panel,'#btnOpenPhonePage');await tick(panel,240);
  assert.equal(await panel.getAttribute('#phonePage','aria-hidden'),'false');
  assert.equal(await panel.locator('#phoneDisplaySeconds').count(),0);assert.equal(await panel.locator('#btnSavePhoneConfig').count(),0);
  await click(panel,'#phoneEnabled');let requestPhone=await message(panel,'phoneConfigure');
  assert.deepEqual(requestPhone.settings,{enabled:true,displaySeconds:17,hideContent:false});
  assert.equal(await panel.locator('#phoneEnabled').isDisabled(),true);
  await phoneResult(panel,initialPhone,false);assert.equal(await panel.locator('#phoneEnabled').isChecked(),false);
  await click(panel,'#phoneEnabled');await phoneResult(panel,phone);
  assert.equal(await panel.locator('#phoneEnabled').isChecked(),true);
  await click(panel,'#phoneHideContent');requestPhone=await message(panel,'phoneConfigure');assert.equal(requestPhone.settings.hideContent,true);await phoneResult(panel,{...phone,hideContent:true});
  await click(panel,'#btnPhoneScan');assert.equal((await message(panel,'phoneScan')).type,'phoneScan');
  await status(panel,{phase:'idle',devices:[{address:'1234',name:'<b>Android</b>'}]});
  assert.equal(await panel.locator('#phoneDevices b').count(),0);
  await click(panel,'[data-phone-address="1234"]');assert.equal((await message(panel,'phoneConnect')).address,'1234');
  await status(panel);await click(panel,'#btnPhoneDisconnect');assert.equal((await message(panel,'phoneDisconnect')).type,'phoneDisconnect');
  await click(panel,'#btnPhoneNotificationSettings');await tick(panel,240);
  assert.equal(await panel.getAttribute('#preferencesPage','aria-hidden'),'false');assert.equal(await panel.inputValue('#notificationDisplaySeconds'),'1');
  assert.equal(await panel.evaluate(()=>document.activeElement.id),'notificationsEnabled');
  assert.equal(await panel.locator('#notificationsEnabled').evaluate(node=>{const box=node.closest('label').getBoundingClientRect(),page=document.getElementById('preferencesPage').getBoundingClientRect();return box.top>=page.top-1&&box.bottom<=page.bottom+1;}),true);
  assert.equal(await messageCount(panel,'updateSettings'),0);
  checks.push('phone toggles auto-save and roll back failed saves, old duration/save controls are removed, exact device IPC and notification-settings shortcut opens preferences and focuses the visible notification toggle');

  const mac=await pageFor('panel',state,'macos');await click(mac,'#btnOpenPhonePage');await tick(mac,240);
  assert.match(await mac.textContent('#phoneSupportNote'),/Windows \+ Android/);
  for(const selector of ['#phoneEnabled','#phoneHideContent','#btnPhoneScan','#btnPhoneDisconnect'])assert.equal(await mac.locator(selector).isDisabled(),true);
  await click(mac,'#btnPhoneNotificationSettings');await tick(mac,240);
  assert.equal(await mac.getAttribute('#preferencesPage','aria-hidden'),'false');assert.equal(await mac.evaluate(()=>document.activeElement.id),'notificationsEnabled');
  for(const selector of ['#notificationsEnabled','#notificationDisplaySeconds','#notificationListLimit','#btnSaveNotifications','#btnTestNotification'])assert.equal(await mac.locator(selector).isDisabled(),false);
  await mac.fill('#notificationDisplaySeconds','6');await click(mac,'#btnSaveNotifications');
  assert.equal((await message(mac,'notificationsConfigure')).settings.displaySeconds,6);
  const macIsland=await pageFor('island',state,'macos');await status(macIsland);await emit(macIsland,posted('unsupported'));assert.equal((await notice(macIsland)).count,0);
  await external(macIsland,posted('supported-external'));await tick(macIsland);assert.equal((await notice(macIsland)).count,1);assert.equal(await visible(macIsland,'#noticeCompanion'),true);
  checks.push('macOS disables only unavailable Bluetooth controls while shared notification settings and generic incoming messages remain usable');

  for(const page of browser.contexts().flatMap(context=>context.pages())){
   const frontendErrors=await page.evaluate(()=>messages.filter(item=>item.type==='frontendError'));
   const expectedTimeouts=await page.evaluate(()=>window.expectedLayoutTimeouts||0);
   assert.equal(frontendErrors.filter(item=>/^Notification layout ACK timed out: /.test(item.message)).length,expectedTimeouts);
   assert.deepEqual(frontendErrors.filter(item=>!/^Notification layout ACK timed out: /.test(item.message)),[],'only deliberately exhausted ACK retries may report a frontend diagnostic');
  }
  assert.deepEqual(errors,[]);
  return {ok:true,scope:'Headless app/UI contracts with synthetic callbacks and native ACKs; no Bluetooth transport, Android hardware, external endpoint or real task action is executed.',checks,consoleErrors:errors};
 }finally{await browser.close();}
}
module.exports={run};
if(require.main===module)run().then(async result=>{await fs.writeFile(path.join(__dirname,'verify/phone-notifications-report.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));}).catch(error=>{console.error(error);process.exitCode=1;});
