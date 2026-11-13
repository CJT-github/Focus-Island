// Idle-eye behavior regression. Uses fake JS time and deterministic randomness, without touching user data.
// node tools/verify-idle-eyes.cjs [--native path/to/FocusIsland.exe] [--state path/to/state.json]
const fs=require('node:fs/promises'),syncFs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {spawn,execFileSync}=require('node:child_process');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||path.resolve(__dirname,'../../verify-tools/node_modules/playwright'));
const root=path.resolve(__dirname,'..'),out=path.join(root,'tools/verify');
// Empty task list exercises idle displays. Selected saved tasks are covered
// separately because their countdown now has priority before Start is pressed.
const state={tasks:[],current_id:'',duration_sec:300,settings:{showHands:true,showSecond:true,sound:false,notify:false,alwaysOnTop:true,reduceMotion:false,showIdleClock:false,showIdleEyes:true}};
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const active=page=>page.locator('#island').evaluate(node=>node.classList.contains('is-idle-eyes'));
const read=page=>page.evaluate(()=>{
 const eyes=document.querySelector('#idleEyes'),pupils=[...eyes.querySelectorAll('.idle-eyes__pupil')];
 const effectiveOpacity=node=>{let opacity=1;for(;node&&node!==document.body;node=node.parentElement){const style=getComputedStyle(node);if(style.display==='none'||style.visibility==='hidden')return 0;opacity*=Number(style.opacity);}return opacity;};
 return {active:document.querySelector('#island').classList.contains('is-idle-eyes'),text:document.querySelector('#compactTime').textContent,
  timeOpacity:effectiveOpacity(document.querySelector('#compactTime')),eyeOpacity:effectiveOpacity(eyes),blink:eyes.classList.contains('is-blinking'),following:eyes.classList.contains('is-following'),
  x:parseFloat(eyes.style.getPropertyValue('--gaze-x'))||0,y:parseFloat(eyes.style.getPropertyValue('--gaze-y'))||0,pupils:pupils.map(p=>getComputedStyle(p).transform)};
});
async function assertClock(page){
 assert(await page.evaluate(()=>{const d=new Date(),p=n=>String(n).padStart(2,'0');return document.querySelector('#compactTime').textContent===[d.getHours(),d.getMinutes(),d.getSeconds()].map(p).join(':');}),'Clock matches current local hours, minutes, seconds');
}
async function headless(){
 const [template,css,notifications,app]=await Promise.all(['index.html','styles.css','notifications.js','app.js'].map(file=>fs.readFile(path.join(root,'ui',file),'utf8')));
 const html=(initial=state,geometry={})=>template.replace('/*__CSS__*/',()=>css).replace('__VIEW__','island').replace('/*__GEO__*/',()=>JSON.stringify(geometry)).replace('/*__STATE__*/',()=>JSON.stringify(initial)).replace('/*__JS__*/',()=>(notifications+'\n'+app));
 const executablePath=process.env.BROWSER_EXE||(process.platform==='win32'?'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe':undefined);
 const browser=await chromium.launch({headless:true,...(executablePath?{executablePath}:{})});
 const report={mode:'headless',checks:[],errors:[]};
 const pass=(name,details)=>{report.checks.push({name,details});console.log('PASS',name,details||'');};
 const both={...state,settings:{...state.settings,showIdleClock:true}};
 const clockOnly={...both,settings:{...both.settings,showIdleEyes:false}};
 const selected={...both,tasks:[{id:'t1',name:'任务一',sec:1500},{id:'t2',name:'任务二',sec:2700},{id:'t3',name:'任务三',sec:900}],current_id:'t3'};
 async function page(initial=state,geometry={},random='minimum'){
  const p=await browser.newPage({viewport:{width:580,height:580}});p.on('pageerror',e=>report.errors.push(e.message));
  await p.addInitScript(random=>{
   window.messages=[];window.ipc={postMessage(value){messages.push({...JSON.parse(value),at:Date.now(),eyes:!!document.querySelector('#island')?.classList.contains('is-idle-eyes')});}};
   let seed=90210;Math.random=random==='minimum'?()=>0:()=>{seed=(seed*16807)%2147483647;return (seed-1)/2147483646;};
  },random);
  await p.goto('about:blank');const time=new Date('2031-04-04T02:11:12.000Z');await p.clock.install({time});await p.clock.pauseAt(time);await p.setContent(html(initial,geometry));
  await p.evaluate(()=>{
   window.eyeLog=[];window.eyeStart=Date.now();let previous=document.querySelector('#island').classList.contains('is-idle-eyes'),blink=false;
   if(previous)eyeLog.push({type:'enter',at:eyeStart});
   const observer=new MutationObserver(()=>{const island=document.querySelector('#island'),eyes=document.querySelector('#idleEyes'),current=island.classList.contains('is-idle-eyes'),blinking=eyes.classList.contains('is-blinking');
    if(current!==previous){eyeLog.push({type:current?'enter':'exit',at:Date.now()});previous=current;}
    if(blinking!==blink){eyeLog.push({type:blinking?'blink':'unblink',at:Date.now()});blink=blinking;}
    eyeLog.push({type:'gaze',at:Date.now(),x:parseFloat(eyes.style.getPropertyValue('--gaze-x'))||0,y:parseFloat(eyes.style.getPropertyValue('--gaze-y'))||0});
   });observer.observe(document.querySelector('#island'),{attributes:true,attributeFilter:['class']});observer.observe(document.querySelector('#idleEyes'),{attributes:true,attributeFilter:['class','style']});
  });return p;
 }
 async function never(p,duration=60000){const before=await p.evaluate(()=>eyeLog.filter(e=>e.type==='enter').length);await p.clock.runFor(duration);assert.equal(await active(p),false);assert.equal(await p.evaluate(()=>eyeLog.filter(e=>e.type==='enter').length),before);}
 async function followPhase(p){for(let n=0;n<100;n++){if(await p.evaluate(()=>messages.filter(m=>m.type==='watchCursor').at(-1)?.enabled===true))return;await p.clock.runFor(100);}assert.fail('First occasional follow phase must begin within 10 seconds');}
 async function noVisibleClock(p){const s=await read(p);assert(!(s.timeOpacity>.02&&/^\d\d:\d\d:\d\d$/.test(s.text)));}
 try{
  const legacy={...state,settings:{...state.settings}};delete legacy.settings.showIdleEyes;delete legacy.settings.showIdleClock;
  const defaults=await page(legacy);await assertClock(defaults);await never(defaults,120000);pass('Missing settings default to continuous clock only');await defaults.close();

  const toggles=await page(clockOnly);await never(toggles);await toggles.evaluate(s=>__applyState(s),state);assert.equal(await active(toggles),true);await toggles.clock.runFor(1600);
  await toggles.evaluate(s=>__applyState(s),clockOnly);assert.equal(await active(toggles),false);await assertClock(toggles);const cleared=await read(toggles);assert(!cleared.blink&&!cleared.following&&cleared.x===0&&cleared.y===0);await never(toggles);
  await toggles.evaluate(s=>__applyState(s),state);assert.equal(await active(toggles),true);pass('Switching between clock-only and eyes-only is immediate and clears obsolete animation work');await toggles.close();

  const rotating=await page(both);assert.equal(await active(rotating),false);await assertClock(rotating);await rotating.clock.runFor(9999);assert.equal(await active(rotating),false);await rotating.clock.runFor(1);assert.equal(await active(rotating),true);await delay(400);let s=await read(rotating);assert(s.eyeOpacity>.98&&s.timeOpacity<.02);
  await rotating.clock.runFor(9999);assert.equal(await active(rotating),true);await rotating.clock.runFor(1);assert.equal(await active(rotating),false);await rotating.clock.runFor(10);await assertClock(rotating);await rotating.clock.runFor(60000);
  const rotation=await rotating.evaluate(()=>({start:eyeStart,events:eyeLog.filter(e=>e.type==='enter'||e.type==='exit'),watches:messages.filter(m=>m.type==='watchCursor'&&m.enabled)}));
  assert(rotation.events.length>=8);for(let n=0;n<rotation.events.length;n++){assert.equal(rotation.events[n].type,n%2===0?'enter':'exit');assert(Math.abs(rotation.events[n].at-rotation.start-(n+1)*10000)<1);}
  assert(rotation.watches.length>=3&&rotation.watches.every(m=>m.eyes));pass('Both enabled alternate clock and eyes every ten seconds; following occurs only inside eye slots',rotation.events);await rotating.close();

  const eyes=await page(state,{},'seeded');assert.equal(await active(eyes),true);assert.equal(await eyes.locator('.idle-eyes__eye').count(),2);assert.equal(await eyes.locator('.idle-eyes__pupil').count(),2);await delay(400);s=await read(eyes);assert(s.eyeOpacity>.98);await eyes.screenshot({path:path.join(out,'idle-eyes-headless.png'),omitBackground:true});
  await eyes.clock.runFor(120000);assert.equal(await active(eyes),true);const log=await eyes.evaluate(()=>({start:eyeStart,events:eyeLog,watches:messages.filter(m=>m.type==='watchCursor')}));assert.equal(log.events.filter(e=>e.type==='enter').length,1);assert.equal(log.events.filter(e=>e.type==='exit').length,0);
  const phases=[];let started=null,previousEnd=log.start;for(const event of log.watches){if(event.enabled){assert(started===null);const gap=event.at-previousEnd;assert(gap>=(phases.length?9999:2999));started=event.at;}else if(started!==null){const duration=event.at-started;assert(duration>=1800&&duration<=3201);phases.push({duration,gap:started-previousEnd});previousEnd=event.at;started=null;}}
  assert(phases.length>=3);assert(phases.reduce((sum,p)=>sum+p.duration,0)<60000);const gazes=log.events.filter(e=>e.type==='gaze');assert(gazes.every(e=>Math.abs(e.x)<=4&&Math.abs(e.y)<=2.5));assert(new Set(gazes.map(e=>e.x+','+e.y)).size>5);assert(log.events.some(e=>e.type==='blink'));
  await eyes.evaluate(s=>__applyState({...s,settings:{...s.settings,showIdleEyes:false}}),state);assert.equal(await active(eyes),false);await delay(400);await noVisibleClock(eyes);pass('Eyes-only remains visible for two minutes with blinking, random gaze and brief occasional follow phases',phases);await eyes.close();

  const neither=await page({...state,settings:{...state.settings,showIdleEyes:false}});await never(neither);await noVisibleClock(neither);await neither.evaluate(()=>__fromRust('toggleTimer'));await neither.clock.runFor(2000);await delay(400);s=await read(neither);assert.equal(s.text,'04:58');assert(s.timeOpacity>.98);pass('Both idle options off show no clock or eyes, but started countdown remains visible');await neither.close();

  const task=await page(selected);assert.equal(await active(task),false);await assertClock(task);assert.equal(await task.locator('#readoutTask').isHidden(),true);
  await task.clock.runFor(10000);assert.equal(await active(task),true);
  await task.evaluate(s=>__applyState({...s,settings:{...s.settings,showIdleClock:false}},true),selected);assert.equal(await active(task),true);
  await task.evaluate(()=>__fromRust('toggleTimer'));assert.equal(await active(task),false);assert.equal(await task.textContent('#compactTime'),'05:00');assert.equal(await task.textContent('#readoutTask'),'任务三');
  await task.evaluate(s=>__applyState({...s,current_id:'t1',duration_sec:1500},true),selected);await assertClock(task);assert.equal(await task.locator('#readoutTask').isHidden(),true);
  await task.evaluate(()=>__fromRust('toggleTimer'));assert.equal(await task.textContent('#compactTime'),'25:00');assert.equal(await task.textContent('#readoutTask'),'任务一');
  await task.evaluate(()=>__fromRust('resetTimer'));await assertClock(task);assert.equal(await task.locator('#readoutTask').isHidden(),true);
  await task.evaluate(s=>__applyState(s,true),state);assert.equal(await active(task),true);pass('Saved task selections stay idle until Start; starting uses the selected duration and name, while resetting restores idle');await task.close();

  const interrupt=await page(both);await interrupt.clock.runFor(9999);await interrupt.evaluate(s=>__applyState(s,true),selected);await interrupt.clock.runFor(1);assert.equal(await active(interrupt),true);
  await interrupt.evaluate(()=>__fromRust('toggleTimer'));assert.equal(await active(interrupt),false);await interrupt.clock.runFor(1040);assert.equal(await interrupt.textContent('#compactTime'),'04:59');
  await interrupt.evaluate(s=>__applyState(s,true),both);assert.equal(await active(interrupt),false);await assertClock(interrupt);await interrupt.clock.runFor(10000);assert.equal(await active(interrupt),true);pass('Selecting a task preserves idle rotation; starting interrupts it and resetting starts a fresh clock slot');await interrupt.close();
  for(const [label,fixture] of [['free timer',state],['selected-task timer',selected]]){
   const timer=await page(fixture);await timer.evaluate(()=>__fromRust('toggleTimer'));assert.equal(await active(timer),false);await never(timer);await timer.evaluate(()=>__fromRust('toggleTimer'));await never(timer);assert.equal(await timer.textContent('#compactTime'),'04:00');await timer.evaluate(()=>__fromRust('resetTimer'));assert.equal(await active(timer),label==='free timer');if(label==='selected-task timer')await assertClock(timer);pass('Running and paused '+label+' keep countdown priority; reset restores the configured idle mode');await timer.close();
   const done=await page({...fixture,duration_sec:1});await done.evaluate(()=>__fromRust('toggleTimer'));await done.clock.runFor(3500);assert.equal(await done.textContent('#readoutChip'),'时间到');
   const completedRun=await done.evaluate(()=>messages.filter(m=>m.type==='timerState').at(-1));
   await done.evaluate(()=>document.querySelector('#island').click());await done.clock.runFor(1000);
   const idleRun=await done.evaluate(()=>messages.filter(m=>m.type==='timerState').at(-1));
   for(const field of ['runId','taskId','done','started','remainingMs','totalMs'])assert.equal(idleRun[field],completedRun[field]);
   assert.equal(idleRun.idleAfterCompletion,true);assert.equal(await done.evaluate(()=>__isOpen()),false);
   if(fixture.settings.showIdleClock){await assertClock(done);assert.equal(await active(done),false);await done.clock.runFor(9000);assert.equal(await active(done),true);await done.clock.runFor(10000);assert.equal(await active(done),false);await done.clock.runFor(10);await assertClock(done);}
   else {assert.equal(await active(done),true);await done.clock.runFor(60000);assert.equal(await active(done),true);}
   pass('Completed '+label+' returns to configured idle on click, preserves the completed run and resumes clock/eye scheduling');await done.close();
  }

  const follow=await page();await followPhase(follow);await follow.evaluate(()=>__cursorPosition(-1000,-1000));const left=await read(follow);await follow.evaluate(()=>__cursorPosition(2000,2000));const right=await read(follow);assert(left.x<0&&right.x>0&&left.y<0&&right.y>0);assert([left,right].every(p=>Math.abs(p.x)<=4&&Math.abs(p.y)<=2.5));
  await follow.evaluate(s=>{__applyState(s,true);__fromRust('toggleTimer');},selected);assert.equal(await follow.evaluate(()=>messages.filter(m=>m.type==='watchCursor').at(-1)?.enabled),false);const canceled=await read(follow);await follow.evaluate(()=>__cursorPosition(-2000,2000));const stale=await read(follow);assert.equal(stale.x,canceled.x);assert.equal(stale.y,canceled.y);await never(follow);pass('Starting a selected task stops native cursor watching and ignores stale callbacks after bounded follow movement');await follow.close();

  const pending=await page(state,{dial:340,effect:580,pillW:132,pillH:38});assert.equal(await active(pending),true);await pending.evaluate(()=>__selftestOpen());assert.equal(await active(pending),false);assert.equal(await pending.locator('#island').evaluate(e=>e.classList.contains('is-open')),false);await pending.clock.runFor(500);const request=await pending.evaluate(()=>messages.filter(m=>m.type==='setShape'&&m.open).at(-1));await pending.evaluate(()=>document.querySelector('#island').click());const collapse=await pending.evaluate(()=>messages.filter(m=>m.type==='setShape'&&!m.open).at(-1));await pending.evaluate(ids=>{__viewportReady(ids.old);__viewportReady(ids.current);},{old:request.requestId,current:collapse.requestId});await pending.clock.runFor(20);assert.equal(await pending.evaluate(()=>__isOpen()),false);assert.equal(await active(pending),true);assert.equal(await pending.evaluate(()=>messages.filter(m=>m.type==='frontendError').length),0);pass('Opening cancels eyes before native ACK and stale ACK cannot resurrect the old shape');await pending.close();

  const hidden=await page();await hidden.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,get:()=>true});document.dispatchEvent(new Event('visibilitychange'));});await never(hidden);await hidden.evaluate(()=>{delete document.hidden;document.dispatchEvent(new Event('visibilitychange'));});assert.equal(await active(hidden),true);await hidden.evaluate(()=>window.dispatchEvent(new Event('pagehide')));await never(hidden);await hidden.evaluate(()=>window.dispatchEvent(new Event('pageshow')));assert.equal(await active(hidden),true);pass('Hidden/unloaded pages stop eyes and resume eligible eyes-only immediately');await hidden.close();
  const lifecycle=await page(both);await lifecycle.clock.runFor(10000);assert.equal(await active(lifecycle),true);await lifecycle.evaluate(()=>window.dispatchEvent(new Event('pagehide')));await never(lifecycle);await lifecycle.evaluate(()=>window.dispatchEvent(new Event('pageshow')));assert.equal(await active(lifecycle),false);await lifecycle.clock.runFor(10);await assertClock(lifecycle);await lifecycle.clock.runFor(10000);assert.equal(await active(lifecycle),true);pass('Both-mode lifecycle restart begins a fresh ten-second clock slot');await lifecycle.close();

  // Advance only wall-clock time, leaving callbacks suspended, then resume the
  // view. A late completion timeout must not strand the display on its result.
  for(const event of ['visibilitychange','pageshow','focus']){
   const recovered=await page({...selected,duration_sec:1,settings:{...state.settings}});
   await recovered.evaluate(()=>__fromRust('toggleTimer'));await recovered.clock.runFor(1040);
   const originalRun=await recovered.evaluate(()=>messages.filter(m=>m.type==='timerState').at(-1));assert(originalRun.done);
   await recovered.evaluate(event=>{if(event==='pageshow')window.dispatchEvent(new Event('pagehide'));Object.defineProperty(document,'hidden',{configurable:true,get:()=>true});document.dispatchEvent(new Event('visibilitychange'));},event);
   await recovered.clock.setSystemTime(await recovered.evaluate(()=>Date.now()+30000));
   await recovered.evaluate(event=>{delete document.hidden;(event==='visibilitychange'?document:window).dispatchEvent(new Event(event));},event);
   const idle=await recovered.evaluate(()=>messages.filter(m=>m.type==='timerState').at(-1));assert.equal(idle.idleAfterCompletion,true);assert.equal(idle.runId,originalRun.runId);assert.equal(idle.taskId,originalRun.taskId);assert(idle.done&&idle.started);assert.equal(await active(recovered),true);
   await recovered.clock.runFor(11000);assert.equal(await recovered.evaluate(()=>messages.filter(m=>m.type==='timerDone').length),1);await recovered.close();
  }
  pass('Returning from suspended callbacks reconciles an expired completion deadline and restores eyes without resetting or repeating the run');
  const lateCycle=await page(both);await lateCycle.clock.setSystemTime(await lateCycle.evaluate(()=>Date.now()+35000));await lateCycle.evaluate(()=>window.dispatchEvent(new Event('focus')));assert.equal(await active(lateCycle),true);await lateCycle.clock.runFor(5000);assert.equal(await active(lateCycle),false);await lateCycle.clock.runFor(10);await assertClock(lateCycle);await lateCycle.close();pass('Late idle callbacks reconcile the correct clock/eye slot against wall time');

  const reduced=await page();await reduced.evaluate(s=>__applyState({...s,settings:{...s.settings,reduceMotion:true}}),state);await never(reduced);await reduced.evaluate(s=>__applyState(s),state);assert.equal(await active(reduced),true);await reduced.emulateMedia({reducedMotion:'reduce'});await delay(80);await never(reduced);await reduced.emulateMedia({reducedMotion:'no-preference'});await delay(80);assert.equal(await active(reduced),true);pass('App and system reduced-motion changes stop and restore eligible eyes');await reduced.close();
  const race=await page();await race.clock.runFor(2999);await race.evaluate(()=>__fromRust('toggleTimer'));await race.clock.runFor(2);await never(race);assert.equal(await race.evaluate(()=>messages.some(m=>m.type==='watchCursor'&&m.enabled)),false);pass('Starting a timer immediately before follow cancels pending cursor requests');await race.close();
  assert.deepEqual(report.errors,[]);report.passed=true;return report;
 }finally{await browser.close();await fs.writeFile(path.join(out,'idle-eyes-report.json'),JSON.stringify(report,null,2)+'\n');}
}

async function native(executable,stateFile){
 const exe=path.resolve(executable||path.join(root,'target/verified/release/focus-island.exe')),profile=await fs.mkdtemp(path.join(out,'eyes-'));
 const report={mode:'native',exe,checks:[],errors:[],artifacts:[],skippedChecks:[]};let child,browser,page,panel,nativeWindow,nativeScale,sourceStateBytes,sourceStatePath;
 const pass=(name,details)=>{report.checks.push({name,details});console.log('PASS',name,details||'');};
 async function shot(name){await page.screenshot({path:path.join(out,name),omitBackground:true});report.artifacts.push(name);}
 async function stop(){
  if(page&&!page.isClosed())await page.evaluate(()=>window.ipc.postMessage(JSON.stringify({type:'quit'}))).catch(()=>{});await delay(500);if(browser)await browser.close().catch(()=>{});if(child&&child.exitCode===null)child.kill();browser=page=panel=null;
 }
 async function launch(){
  child=spawn(exe,['--debug-port','9471','--data-dir',profile],{cwd:root,windowsHide:true});
  for(let n=0;n<100&&!browser;n++){try{browser=await chromium.connectOverCDP('http://127.0.0.1:9471');}catch{await delay(200);}}
  assert(browser,'Native CDP endpoint');
  for(let n=0;n<100&&(!page||!panel);n++){
   for(const context of browser.contexts())for(const candidate of context.pages()){const view=await candidate.evaluate(()=>document.body?.dataset.view).catch(()=>null);if(view==='island')page=candidate;else if(view==='panel')panel=candidate;}
   if(!page||!panel)await delay(100);
  }
  assert(page&&panel,'Native island and settings');for(const p of [page,panel])p.on('pageerror',error=>report.errors.push(error.message));await page.waitForFunction(()=>typeof __isOpen==='function');
  // Wry freezes window.ipc. Observe the public cursor callback and the real
  // follow class instead of attempting to replace its read-only IPC method.
  await page.evaluate(()=>{window.__nativeCursorSamples=[];const original=window.__cursorPosition;window.__cursorPosition=(x,y)=>{__nativeCursorSamples.push({x,y,at:Date.now()});original(x,y);};});
  await page.evaluate(()=>{const island=document.querySelector('#island');let seen=island.classList.contains('is-idle-eyes');window.__eyeInterrupted=false;window.__continuousEyeStart=Date.now();new MutationObserver(()=>{const current=island.classList.contains('is-idle-eyes');if(seen&&!current)__eyeInterrupted=true;seen=seen||current;}).observe(island,{attributes:true,attributeFilter:['class']});});
  const windows=JSON.parse(execFileSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(root,'tools/window-probe.ps1'),'-AppProcessId',String(child.pid)],{windowsHide:true,encoding:'utf8'}));nativeWindow=windows.windows.find(w=>w.title==='Focus Island');nativeScale=await page.evaluate(()=>devicePixelRatio);
 }
 async function configureEyes(enabled,showClock){
  await page.locator('#island').click({button:'right',position:{x:170,y:19}});
  await panel.locator('#btnOpenPreferencesPage').click();
  if(showClock!==undefined&&await panel.locator('#swIdleClock').isChecked()!==showClock)await panel.locator('label:has(#swIdleClock)').click();
  if(await panel.locator('#swEyes').isChecked()!==enabled)await panel.locator('label:has(#swEyes)').click();
  let saved;
  for(let n=0;n<30;n++){saved=JSON.parse(await fs.readFile(path.join(profile,'state.json'),'utf8'));if(saved.settings.showIdleEyes===enabled&&(showClock===undefined||saved.settings.showIdleClock===showClock))break;await delay(100);}
  assert.equal(saved.settings.showIdleEyes,enabled,'Settings toggle persists in isolated state');if(showClock!==undefined)assert.equal(saved.settings.showIdleClock,showClock);await panel.locator('#btnClose').click();
 }
 function moveCursor(x,y){return JSON.parse(execFileSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(root,'tools/window-probe.ps1'),'-AppProcessId',String(child.pid),'-CursorX',String(x),'-CursorY',String(y)],{windowsHide:true,encoding:'utf8'}));}
 function desktopShot(name){
  const filename=path.join(out,name).replace(/'/g,"''"),left=Math.round((nativeWindow.outer.Left+nativeWindow.outer.Right)/2-90*nativeScale),top=Math.round(nativeWindow.outer.Top+105*nativeScale),width=Math.round(180*nativeScale),height=Math.round(68*nativeScale);
  try{execFileSync('powershell.exe',['-NoProfile','-Command',"Add-Type -AssemblyName System.Drawing; $b=[System.Drawing.Bitmap]::new("+width+","+height+"); $g=[System.Drawing.Graphics]::FromImage($b); try { $g.CopyFromScreen("+left+","+top+",0,0,$b.Size); $b.Save('"+filename+"',[System.Drawing.Imaging.ImageFormat]::Png) } finally { $g.Dispose(); $b.Dispose() }"],{windowsHide:true,stdio:['ignore','pipe','pipe']});report.desktopAvailable=true;report.artifacts.push(name);}
  catch{report.desktopAvailable=false;syncFs.rmSync(path.join(out,name),{force:true});report.skippedChecks.push('Desktop capture '+name+': Windows screen handle unavailable');console.log('SKIP desktop capture: Windows screen handle unavailable');}
 }
 try{
  const source=stateFile?path.resolve(stateFile):(process.env.APPDATA?path.join(process.env.APPDATA,'FocusIsland/state.json'):null);
  let fixture=state;
  if(source){try{sourceStateBytes=await fs.readFile(source);fixture=JSON.parse(sourceStateBytes.toString('utf8'));await fs.copyFile(source,path.join(profile,'state.json'));sourceStatePath=source;report.fixtureSource='read-only copy of '+source;}catch(error){if(stateFile||error.code!=='ENOENT')throw error;}}
  if(!report.fixtureSource){await fs.writeFile(path.join(profile,'state.json'),JSON.stringify(fixture));report.fixtureSource='saved-task fallback fixture';}
  // Only the copied test profile is changed; the real user's preference is preserved.
  report.sourceTaskCount=fixture.tasks.length;
  fixture={...fixture,tasks:[],current_id:'',settings:{...fixture.settings}};delete fixture.settings.showIdleClock;delete fixture.settings.showIdleEyes;await fs.writeFile(path.join(profile,'state.json'),JSON.stringify(fixture));
  report.fixture={taskCount:fixture.tasks.length,currentId:fixture.current_id,durationSec:fixture.duration_sec};
  await launch();assert.equal(await panel.locator('#swEyes').isChecked(),false);assert.equal(await panel.locator('#swIdleClock').isChecked(),true);assert.equal(await active(page),false);await assertClock(page);pass('Native user-profile copy without either new field defaults to eyes off and clock on');
  await shot('idle-native-clock.png');desktopShot('idle-native-clock-desktop.png');
  await configureEyes(true,false);assert.equal(await active(page),true,'Native eyes show immediately after enabling');await stop();await launch();assert.equal(await panel.locator('#swEyes').isChecked(),true);assert.equal(await panel.locator('#swIdleClock').isChecked(),false);assert.equal(await active(page),true);pass('Eyes show immediately and independent eyes=true/idle-clock=false settings survive restart');
  await page.locator('#island').click({button:'right',position:{x:170,y:19}});await panel.screenshot({path:path.join(out,'idle-native-settings.png'),omitBackground:true});await panel.locator('#btnClose').click();
  const hiddenTime=await read(page);assert(!(hiddenTime.timeOpacity>.02&&/^\d\d:\d\d:\d\d$/.test(hiddenTime.text)));await shot('idle-native-time-off.png');
  await delay(350);assert.equal(await active(page),true);await shot('idle-native-eyes.png');desktopShot('idle-native-eyes-desktop.png');
  await page.waitForFunction(()=>Math.abs(parseFloat(document.querySelector('#idleEyes').style.getPropertyValue('--gaze-x'))||0)>0);await delay(220);const look=await read(page);assert(Math.abs(look.x)<=4&&Math.abs(look.y)<=2.5);await shot('idle-native-look.png');
  await page.waitForFunction(()=>document.querySelector('#idleEyes').classList.contains('is-blinking'),null,{timeout:4000});await delay(55);report.blinkTransforms=await page.locator('.idle-eyes__lid').evaluateAll(nodes=>nodes.map(node=>getComputedStyle(node).transform));await shot('idle-native-blink.png');
  assert.equal(nativeWindow.outer.Right-nativeWindow.outer.Left,580*nativeScale);pass('Native eyes, gaze and blink render on the unchanged transparent canvas',look);
  if(report.desktopAvailable!==false){
   await page.waitForFunction(()=>document.querySelector('#idleEyes').classList.contains('is-following'),null,{timeout:30000});
   let originalCursor;
   try{
   originalCursor=moveCursor(nativeWindow.monitor.Left+20,nativeWindow.monitor.Bottom-100).cursor;const left=await read(page);await shot('idle-native-follow-left.png');
   moveCursor(nativeWindow.monitor.Right-20,nativeWindow.monitor.Bottom-100);const right=await read(page);await shot('idle-native-follow-right.png');
   assert(left.x<0&&right.x>0,'Native pupils follow actual cursor across the full screen');assert([left,right].every(s=>Math.abs(s.x)<=4&&Math.abs(s.y)<=2.5));pass('Native follow phase receives real desktop cursor movement within gaze limits',{left:{x:left.x,y:left.y},right:{x:right.x,y:right.y}});
   }finally{if(originalCursor)moveCursor(originalCursor.X,originalCursor.Y);}
  }else{report.skippedChecks.push('Actual desktop cursor movement unavailable in this desktop session');}
  const observedMs=await page.evaluate(()=>Date.now()-__continuousEyeStart);if(observedMs<8500)await delay(8500-observedMs);
  assert.equal(await active(page),true);assert.equal(await page.evaluate(()=>__eyeInterrupted),false);report.continuousIdleMs=await page.evaluate(()=>Date.now()-__continuousEyeStart);pass('Native eyes-only stays continuously visible while blinking and looking around',report.continuousIdleMs);
  await page.locator('#island').click({button:'right',position:{x:170,y:19}});await panel.locator('#btnOpenTaskPage').click();await panel.locator('#inTaskName').fill('任务优先验证');await panel.locator('#inTaskMin').fill('5');await panel.locator('#inTaskSec').fill('0');await panel.locator('#btnAddTask').click();
  await page.waitForFunction(()=>document.querySelector('#island').classList.contains('is-idle-eyes'));assert.equal(await active(page),true);await panel.locator('#btnStart').click();await page.waitForFunction(()=>document.querySelector('#compactTime').textContent==='05:00');assert.equal(await active(page),false);assert.equal(await page.locator('#island').evaluate(e=>e.classList.contains('is-running')),true);assert.equal(await page.textContent('#readoutTask'),'任务优先验证');await delay(350);await shot('idle-native-task-priority.png');
  await delay(160);const taskCursorCount=await page.evaluate(()=>__nativeCursorSamples.length);await delay(250);assert.equal(await page.evaluate(()=>__nativeCursorSamples.length),taskCursorCount);pass('A new task keeps eyes idle until Start, then displays its name and countdown',{nativeCursorCallbacksPreviouslyReceived:taskCursorCount});
  await panel.locator('#btnClear').click();await page.waitForFunction(()=>document.querySelector('#island').classList.contains('is-idle-eyes'));await panel.locator('#btnClose').click();
  await configureEyes(false,true);assert.equal(await active(page),false);await assertClock(page);assert.equal(await page.locator('#idleEyes').evaluate(e=>e.classList.contains('is-following')),false);
  await delay(160);const cursorCount=await page.evaluate(()=>__nativeCursorSamples.length);if(report.desktopAvailable!==false)assert(cursorCount>0,'Native cursor callbacks were received');await delay(250);assert.equal(await page.evaluate(()=>__nativeCursorSamples.length),cursorCount);pass('Disabling eyes restores the separately enabled clock',{nativeCursorCallbacksPreviouslyReceived:cursorCount});
  await stop();await launch();assert.equal(await panel.locator('#swEyes').isChecked(),false);assert.equal(await panel.locator('#swIdleClock').isChecked(),true);assert.equal(await active(page),false);await assertClock(page);pass('Both independent display preferences survive another restart');
  await configureEyes(true,true);assert.equal(await active(page),false);await assertClock(page);const cycleStart=Date.now();
  await page.waitForFunction(()=>document.querySelector('#island').classList.contains('is-idle-eyes'),null,{timeout:11500});const eyeAt=Date.now()-cycleStart;await delay(350);await shot('idle-native-rotation-eyes.png');
  await page.waitForFunction(()=>!document.querySelector('#island').classList.contains('is-idle-eyes'),null,{timeout:11500});const clockAt=Date.now()-cycleStart;await delay(350);await assertClock(page);await shot('idle-native-rotation-clock.png');assert(eyeAt>=9000&&eyeAt<11000&&clockAt>=19000&&clockAt<21000);pass('Both native displays complete clock to eyes to clock in ten-second slots',{eyeAt,clockAt});
  await stop();await launch();assert.equal(await panel.locator('#swEyes').isChecked(),true);assert.equal(await panel.locator('#swIdleClock').isChecked(),true);assert.equal(await active(page),false);await assertClock(page);pass('Both-enabled mode persists and starts with the clock after restart');
  if(sourceStatePath){report.sourceStateUnchanged=(await fs.readFile(sourceStatePath)).equals(sourceStateBytes);assert(report.sourceStateUnchanged,'Original user state remains byte-for-byte unchanged');pass('Original user state remains byte-for-byte unchanged');}
  assert.deepEqual(report.errors,[]);report.passed=true;return report;
 }finally{
  await stop();
  await fs.writeFile(path.join(out,'idle-eyes-native-report.json'),JSON.stringify(report,null,2)+'\n');
  const actual=await fs.realpath(profile),parent=await fs.realpath(out);if(path.dirname(actual).toLowerCase()===parent.toLowerCase()&&/^eyes-[A-Za-z0-9]{6}$/.test(path.basename(actual)))await fs.rm(actual,{recursive:true,force:true,maxRetries:5,retryDelay:200});
 }
}
module.exports={headless,native};
if(require.main===module){syncFs.mkdirSync(out,{recursive:true});const index=process.argv.indexOf('--native'),stateIndex=process.argv.indexOf('--state');(index<0?headless():native(process.argv[index+1],stateIndex<0?undefined:process.argv[stateIndex+1])).then(result=>console.log(JSON.stringify(result,null,2))).catch(error=>{console.error(error);process.exitCode=1;});}
