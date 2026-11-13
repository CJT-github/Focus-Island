/* Run: node tools/verify-frontend.cjs (requires Playwright and a Chromium browser).
   Optional: PLAYWRIGHT_MODULE=/path/to/playwright, BROWSER_EXE=/path/to/browser */
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
async function run(options = {}) {
  const root = path.resolve(__dirname,'..');
  const playwright = options.playwright || require(process.env.PLAYWRIGHT_MODULE || path.resolve(root,'../verify-tools/node_modules/playwright'));
  let executablePath = process.env.BROWSER_EXE;
  if (!executablePath && process.platform==='win32') {
    const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
    try { await fs.access(edge); executablePath=edge; } catch {}
  }
  const browser = await playwright.chromium.launch({headless:true,...(executablePath?{executablePath}:{})});
  const errors = [], checks = [];
  const state = {
    tasks:[{id:'a',name:'验证任务',sec:65},{id:'b',name:'同秒任务',sec:65}],
    current_id:'a',duration_sec:65,
    settings:{showHands:true,showSecond:true,sound:false,notify:false,alwaysOnTop:true,reduceMotion:false}
  };
  try {
    const [template,css,notifications,app] = await Promise.all(['index.html','styles.css','notifications.js','app.js'].map(file=>fs.readFile(path.join(root,'ui',file),'utf8')));
    const html = (view,initialState=state,geometry={}) => template.replace('/*__CSS__*/',()=>css).replace('__VIEW__',view)
      .replace('/*__GEO__*/',()=>JSON.stringify(geometry)).replace('/*__STATE__*/',()=>JSON.stringify(initialState)).replace('/*__JS__*/',()=>(notifications+'\n'+app));
    const expectClock = page => page.waitForFunction(()=>{
      const now=new Date(),pad=n=>String(n).padStart(2,'0');
      const expected=[now.getHours(),now.getMinutes(),now.getSeconds()].map(pad).join(':');
      return document.querySelector('#island').classList.contains('is-clock') &&
        document.querySelector('#compactTime').textContent===expected &&
        document.querySelector('#readoutDigits').textContent===expected;
    },null,{timeout:2000});
    const expectIdleEyes = page => page.waitForFunction(()=>{
      const island=document.querySelector('#island');
      return island.classList.contains('is-clock') && island.classList.contains('is-idle-eyes') && document.querySelector('#readoutTask').hidden;
    },null,{timeout:2000});
    const expectCountdown = (page,sec) => page.waitForFunction(sec=>{
      const pad=n=>String(n).padStart(2,'0'),h=Math.floor(sec/3600),m=Math.floor(sec%3600/60),s=sec%60;
      const full=pad(h)+':'+pad(m)+':'+pad(s),compact=h?h+':'+pad(m)+':'+pad(s):pad(m)+':'+pad(s);
      const island=document.querySelector('#island');
      return !island.classList.contains('is-clock') && !island.classList.contains('is-idle-eyes') &&
        document.querySelector('#compactTime').textContent===compact &&
        document.querySelector('#readoutDigits').textContent===full;
    },sec,{timeout:2000});
    const island = await browser.newPage({viewport:{width:580,height:580}});
    const panel = await browser.newPage({viewport:{width:340,height:640}});
    for (const page of [island,panel]) {
      page.on('pageerror',e=>errors.push(e.message));
      await page.addInitScript(()=>{
        window.messages=[];
        window.ipc={postMessage(value){window.messages.push({...JSON.parse(value),at:performance.now()});}};
      });
      await page.goto('about:blank');
    }
    await island.setContent(html('island')); await panel.setContent(html('panel'));
    const initial = await island.evaluate(()=>({
      ticks:document.querySelector('#ticks').children.length,hours:document.querySelector('#hourMarks').children.length,
      geometry:__checkHandGeometry(),text:document.querySelector('#compactTime').textContent
    }));
    assert.equal(initial.ticks,60);assert.equal(initial.hours,12);
    assert(initial.geometry.every(distance=>distance<1e-6));await expectClock(island);
    assert.equal(await island.locator('#readoutTask').count(),1);
    assert.equal(await island.locator('#readoutTask').evaluate(node=>node.hidden),true);
    const initialTimer=await island.evaluate(()=>messages.filter(message=>message.type==='timerState').at(-1));
    assert.equal(initialTimer.taskId,'a');assert.equal(initialTimer.totalMs,65000);assert.equal(initialTimer.started,false);
    assert((await panel.locator('.task.is-active').textContent()).includes('验证任务'));
    await island.evaluate(()=>__applyState({settings:{showIdleClock:false,showIdleEyes:true}},false));await expectIdleEyes(island);
    await island.evaluate(()=>__applyState({settings:{showIdleClock:true,showIdleEyes:false}},false));await expectClock(island);
    assert.equal(await island.locator('#readoutChip').isHidden(),true);
    checks.push('60 ticks, 12 labels and centered hand bases; saved selected tasks retain their duration and identity while startup shows configured clock or eyes');

    await panel.click('#btnStart');await panel.click('#btnReset2');await panel.click('#btnClear');
    await panel.fill('#inH','1');await panel.fill('#inM','2');await panel.fill('#inS','3');await panel.click('#btnApplyCustom');
    await panel.click('#btnOpenTaskPage');assert.equal(await panel.locator('#taskCreatePage').getAttribute('aria-hidden'),'false');assert.equal(await panel.locator('#settingsPage').getAttribute('aria-hidden'),'true');
    await panel.fill('#inTaskName','三秒任务');await panel.fill('#inTaskMin','0');await panel.fill('#inTaskSec','3');
    await panel.click('#btnTaskBack');assert.equal(await panel.locator('#settingsPage').getAttribute('aria-hidden'),'false');
    await panel.click('#btnOpenTaskPage');assert.equal(await panel.inputValue('#inTaskName'),'三秒任务');assert.equal(await panel.inputValue('#inTaskMin'),'0');assert.equal(await panel.inputValue('#inTaskSec'),'3');
    await panel.click('#btnCancelTask');assert.equal(await panel.locator('#settingsPage').getAttribute('aria-hidden'),'false');await panel.click('#btnOpenTaskPage');assert.equal(await panel.inputValue('#inTaskName'),'三秒任务');
    const hideBeforeTaskEscape=await panel.evaluate(()=>messages.filter(m=>m.type==='hidePanel').length);await panel.keyboard.press('Escape');assert.equal(await panel.locator('#settingsPage').getAttribute('aria-hidden'),'false');assert.equal(await panel.evaluate(()=>messages.filter(m=>m.type==='hidePanel').length),hideBeforeTaskEscape);await panel.click('#btnOpenTaskPage');
    let beforeInvalid=(await panel.evaluate(()=>messages)).length;
    await panel.fill('#inTaskSec','-2');await panel.click('#btnAddTask');assert.equal((await panel.evaluate(()=>messages)).length,beforeInvalid,JSON.stringify(await panel.evaluate(()=>messages)));
    await panel.fill('#inTaskSec','3');await panel.click('#btnAddTask');
    assert.equal(await panel.locator('#btnAddTask').isDisabled(),true);await panel.locator('#btnAddTask').evaluate(node=>node.click());
    let messages = await panel.evaluate(()=>messages);
    const createRequest=messages.find(message=>message.type==='addTask');assert(Number.isSafeInteger(createRequest.requestId)&&createRequest.requestId>0);
    assert.equal(messages.filter(message=>message.type==='webhookStatus').length,1);
    assert.equal(messages.filter(message=>message.type==='relayStatus').length,1);
    assert.deepEqual(messages.slice(1).filter(message=>!['webhookStatus','relayStatus'].includes(message.type)).map(({at,...msg})=>msg),[
      {type:'toggleTimer'},{type:'resetTimer'},{type:'clearTasks'},
      {type:'setDuration',sec:3723},{type:'addTask',name:'三秒任务',sec:3,completionAction:{enabled:false,kind:'command',command:'',delaySec:10},requestId:createRequest.requestId}
    ]);
    assert.equal(await panel.textContent('#btnStart'),'开始');
    await panel.evaluate(s=>__applyState({...s,settings:{...s.settings,sound:true}}),state);assert.equal(await panel.locator('#taskCreatePage').getAttribute('aria-hidden'),'false');assert.equal(await panel.inputValue('#inTaskName'),'三秒任务');
    await panel.evaluate(s=>__applyState({...s,tasks:[...s.tasks,{id:'created',name:'三秒任务',sec:3}],current_id:'created',duration_sec:3},true),state);
    assert.equal(await panel.locator('#taskCreatePage').getAttribute('aria-hidden'),'false');assert.equal(await panel.locator('#btnAddTask').isDisabled(),true);
    await panel.evaluate(requestId=>__taskCreateResult({ok:true,message:'已创建',requestId,taskId:'created'}),createRequest.requestId);
    assert.equal(await panel.locator('#settingsPage').getAttribute('aria-hidden'),'false');assert.equal(await panel.locator('#taskCreatePage').getAttribute('aria-hidden'),'true');assert.equal(await panel.inputValue('#inTaskName'),'');assert.equal(await panel.locator('#btnAddTask').isDisabled(),false);
    assert((await panel.locator('.task.is-active').textContent()).includes('三秒任务'));
    checks.push('separate task page preserves drafts on Back, validates inputs, submits once and returns only after a matching selected-task acknowledgement');
    await panel.evaluate(s=>__applyState(s,true),state);
    await panel.fill('#inH','0.5');await panel.click('#btnApplyCustom');
    assert.equal((await panel.evaluate(()=>messages)).length,messages.length);
    await panel.fill('#inH','7');
    await panel.evaluate(s=>__applyState({...s,settings:{...s.settings,sound:true}}),state);
    assert.equal(await panel.inputValue('#inH'),'7');
    await panel.evaluate(()=>__applyTimer({running:true,done:false,remainingMs:3000,totalMs:65000}));
    assert.equal(await panel.textContent('#btnStart'),'暂停');
    await panel.click('#btnClose');await panel.keyboard.press('Escape');
    assert.deepEqual((await panel.evaluate(()=>messages)).slice(-2).map(m=>m.type),['hidePanel','hidePanel']);
    checks.push('panel commands, second precision, duration validation, draft preservation and close behavior');

    // Moving the native island is a preference-only change. Exercise the actual
    // editor and relay its IPC to an island without resetting the timer.
    const positionPanel=await browser.newPage({viewport:{width:340,height:620}});
    const positionIsland=await browser.newPage({viewport:{width:580,height:580}});
    for (const page of [positionPanel,positionIsland]) {
      page.on('pageerror',error=>errors.push(error.message));
      await page.addInitScript(()=>{
        window.messages=[];
        window.ipc={postMessage(value){messages.push(JSON.parse(value));}};
      });
      await page.goto('about:blank');
    }
    await positionPanel.setContent(html('panel'));
    await positionIsland.setContent(html('island'));
    assert.equal(await positionPanel.inputValue('#inTopOffset'),'20','legacy settings default to 20 px');
    await positionPanel.evaluate(s=>__applyState({...s,settings:{...s.settings,topOffset:80}}),state);
    assert.equal(await positionPanel.inputValue('#inTopOffset'),'80');
    await positionPanel.fill('#inH','7');
    await positionPanel.click('#btnOpenPreferencesPage');
    await positionPanel.fill('#inTopOffset','92');
    await positionPanel.evaluate(s=>__applyState({...s,settings:{...s.settings,topOffset:80,sound:true}}),state);
    assert.equal(await positionPanel.inputValue('#inTopOffset'),'92','unrelated broadcasts preserve a position draft');
    assert.equal(await positionPanel.inputValue('#inH'),'7');
    await positionPanel.press('#inTopOffset','Enter');
    const offsetUpdate=await positionPanel.evaluate(()=>messages.at(-1));
    assert.equal(offsetUpdate.type,'updateSettings');assert.equal(offsetUpdate.settings.topOffset,92);
    assert.equal(offsetUpdate.settings.sound,true);assert.equal(offsetUpdate.settings.showHands,true);
    assert.equal(await positionPanel.inputValue('#inH'),'7','applying position preserves an unfinished duration');
    const updateCount=await positionPanel.evaluate(()=>messages.length);
    for (const invalid of ['', '-1', '1001', '1.5']) {
      await positionPanel.fill('#inTopOffset',invalid);await positionPanel.click('#btnApplyTopOffset');
      assert.equal(await positionPanel.evaluate(()=>messages.length),updateCount);
      assert.equal(await positionPanel.getAttribute('#inTopOffset','aria-invalid'),'true');
      assert.match(await positionPanel.textContent('#topOffsetNote'),/0–1000/);
    }
    for (const valid of ['0','1000']) {
      await positionPanel.fill('#inTopOffset',valid);await positionPanel.click('#btnApplyTopOffset');
      assert.equal(await positionPanel.evaluate(()=>messages.at(-1).settings.topOffset),Number(valid));
      assert.equal(await positionPanel.getAttribute('#inTopOffset','aria-invalid'),'false');
    }
    await positionPanel.evaluate(s=>__applyState({...s,settings:{...s.settings,topOffset:1000}}),state);
    assert.equal(await positionPanel.inputValue('#inTopOffset'),'1000');
    const offsetBounds=await positionPanel.locator('.top-offset').boundingBox();
    const offsetButtonBounds=await positionPanel.locator('#btnApplyTopOffset').boundingBox();
    assert(offsetBounds.x>=0 && offsetBounds.x+offsetBounds.width<=340);
    assert(offsetButtonBounds.x+offsetButtonBounds.width<=offsetBounds.x+offsetBounds.width+1);
    assert((await positionPanel.evaluate(()=>messages)).every(message=>['pageReady','webhookStatus','relayStatus','updateSettings'].includes(message.type)));

    await positionIsland.clock.setFixedTime(new Date('2030-01-01T12:00:00Z'));
    const stableTimer=()=>positionIsland.evaluate(()=>{
      __fromRust('syncTimer');return messages.filter(message=>message.type==='timerState').at(-1);
    });
    const applyPosition=()=>positionIsland.evaluate(settings=>__applyState({settings},false),offsetUpdate.settings);
    const selectedIdle=await stableTimer();await applyPosition();
    assert.deepEqual(await stableTimer(),selectedIdle);await expectClock(positionIsland);
    await positionIsland.evaluate(()=>__fromRust('toggleTimer'));
    const runningPosition=await stableTimer();assert.equal(runningPosition.running,true);
    await applyPosition();assert.deepEqual(await stableTimer(),runningPosition,'moving a running island preserves run identity and deadline');
    await positionIsland.evaluate(()=>__fromRust('toggleTimer'));
    const pausedPosition=await stableTimer();assert.equal(pausedPosition.running,false);assert.equal(pausedPosition.started,true);
    await applyPosition();assert.deepEqual(await stableTimer(),pausedPosition);
    await positionIsland.evaluate(s=>__applyState({...s,tasks:[],current_id:''},true),state);
    const freeIdle=await stableTimer();await applyPosition();assert.deepEqual(await stableTimer(),freeIdle);await expectClock(positionIsland);
    await positionIsland.evaluate(()=>{__fromRust('toggleTimer');__fromRust('toggleTimer');});
    const freePaused=await stableTimer();await applyPosition();assert.deepEqual(await stableTimer(),freePaused);await expectCountdown(positionIsland,65);
    await positionPanel.close();await positionIsland.close();
    checks.push('top offset defaults to 20 px, validates 0–1000 integers, preserves both drafts and settings, fits the panel, and never resets task/free or running/paused timers');

    const durationPanel=await browser.newPage({viewport:{width:340,height:620}});
    durationPanel.on('pageerror',error=>errors.push(error.message));
    await durationPanel.addInitScript(()=>{
      window.messages=[];window.ipc={postMessage(value){messages.push(JSON.parse(value));}};
    });
    await durationPanel.goto('about:blank');await durationPanel.setContent(html('panel'));
    const editTask=async id=>{
      if(await durationPanel.locator('#taskSettingsPage').getAttribute('aria-hidden')==='false')await durationPanel.click('#btnTaskBack');
      await durationPanel.locator('.task__edit[data-task-id="'+id+'"]').click();
    };
    await editTask('b');assert.equal(await durationPanel.inputValue('#editTaskMin'),'1');assert.equal(await durationPanel.inputValue('#editTaskSec'),'5');
    await durationPanel.fill('#editTaskMin','2');await durationPanel.fill('#editTaskSec','7');
    await durationPanel.fill('#actionCommand','independent action draft');
    await durationPanel.evaluate(s=>__applyState({...s,settings:{...s.settings,sound:true}},false),state);
    assert.equal(await durationPanel.inputValue('#editTaskMin'),'2');assert.equal(await durationPanel.inputValue('#editTaskSec'),'7');
    await editTask('a');assert.equal(await durationPanel.inputValue('#editTaskMin'),'1');await editTask('b');
    assert.equal(await durationPanel.inputValue('#editTaskSec'),'7');assert.equal(await durationPanel.inputValue('#actionCommand'),'independent action draft');
    const countBeforeDuration=await durationPanel.evaluate(()=>messages.length);
    for (const [minutes,seconds] of [['0','0'],['0.5','1'],['6000','0'],['1','60']]) {
      await durationPanel.fill('#editTaskMin',minutes);await durationPanel.fill('#editTaskSec',seconds);await durationPanel.click('#btnSaveTaskDuration');
      assert.equal(await durationPanel.evaluate(()=>messages.length),countBeforeDuration);assert(await durationPanel.textContent('#taskDurationNote'));
    }
    await durationPanel.fill('#editTaskMin','2');await durationPanel.fill('#editTaskSec','7');await durationPanel.press('#editTaskSec','Enter');
    const durationRequest=await durationPanel.evaluate(()=>messages.at(-1));
    assert.equal(durationRequest.type,'setTaskDuration');assert.equal(durationRequest.taskId,'b');assert.equal(durationRequest.sec,127);assert(Number.isSafeInteger(durationRequest.requestId));
    assert.equal(await durationPanel.locator('#editTaskMin').isDisabled(),true);assert.equal(await durationPanel.locator('#editTaskSec').isDisabled(),true);
    await durationPanel.locator('#btnSaveTaskDuration').evaluate(node=>node.click());assert.equal(await durationPanel.evaluate(()=>messages.length),countBeforeDuration+1);
    await durationPanel.evaluate(request=>__taskDurationResult({ok:true,...request,requestId:request.requestId+1}),durationRequest);
    assert.equal(await durationPanel.locator('#btnSaveTaskDuration').isDisabled(),true);
    await durationPanel.evaluate(request=>__taskDurationResult({ok:false,...request,message:'模拟保存失败'}),durationRequest);
    assert.equal(await durationPanel.locator('#btnSaveTaskDuration').isDisabled(),false);assert.equal(await durationPanel.inputValue('#editTaskSec'),'7');assert.equal(await durationPanel.textContent('#taskDurationNote'),'模拟保存失败');
    await durationPanel.click('#btnSaveTaskDuration');const retryDuration=await durationPanel.evaluate(()=>messages.at(-1));assert.notEqual(retryDuration.requestId,durationRequest.requestId);
    await editTask('a');await durationPanel.fill('#editTaskMin','3');await durationPanel.fill('#editTaskSec','9');
    const changedTaskB={...state,tasks:state.tasks.map(task=>task.id==='b'?{...task,sec:127}:task)};
    await durationPanel.evaluate(s=>__applyState(s,false),changedTaskB);
    await durationPanel.evaluate(request=>__taskDurationResult({ok:true,...request,message:'已保存'}),retryDuration);
    assert.equal(await durationPanel.inputValue('#editTaskMin'),'3');assert.equal(await durationPanel.inputValue('#editTaskSec'),'9');
    assert.equal(await durationPanel.textContent('#actionScope'),'验证任务');assert.equal(await durationPanel.textContent('#taskDurationNote'),'尚未保存');
    await editTask('b');assert.equal(await durationPanel.inputValue('#editTaskMin'),'2');assert.equal(await durationPanel.inputValue('#editTaskSec'),'7');assert.equal(await durationPanel.inputValue('#actionCommand'),'independent action draft');
    await editTask('a');await durationPanel.fill('#editTaskMin','5999');await durationPanel.fill('#editTaskSec','59');await durationPanel.click('#btnSaveTaskDuration');
    const maximumRequest=await durationPanel.evaluate(()=>messages.at(-1));assert.equal(maximumRequest.sec,359999);assert.equal(maximumRequest.taskId,'a');
    await durationPanel.evaluate(s=>__applyState(s,true),{...changedTaskB,tasks:changedTaskB.tasks.map(task=>task.id==='a'?{...task,sec:359999}:task),duration_sec:359999});
    assert.equal(await durationPanel.locator('#btnSaveTaskDuration').isDisabled(),true,'state alone cannot acknowledge an edit');
    await durationPanel.evaluate(request=>__taskDurationResult({ok:true,...request}),maximumRequest);
    assert.equal(await durationPanel.locator('#btnSaveTaskDuration').isDisabled(),false);
    await durationPanel.locator('#btnSaveAction').scrollIntoViewIfNeeded();
    const saveBounds=await durationPanel.locator('#btnSaveAction').boundingBox();assert(saveBounds.y>=0 && saveBounds.y+saveBounds.height<=620);
    await editTask('b');await durationPanel.fill('#editTaskMin','0');await durationPanel.fill('#editTaskSec','1');await durationPanel.click('#btnSaveTaskDuration');
    const removedRequest=await durationPanel.evaluate(()=>messages.at(-1));assert.equal(removedRequest.sec,1);
    await durationPanel.evaluate(s=>__applyState({...s,tasks:s.tasks.filter(task=>task.id!=='b')},false),changedTaskB);
    await durationPanel.evaluate(request=>__taskDurationResult({ok:true,...request}),removedRequest);
    assert.equal(await durationPanel.locator('#settingsPage').getAttribute('aria-hidden'),'false');
    assert((await durationPanel.evaluate(()=>messages)).every(message=>['pageReady','webhookStatus','relayStatus','setTaskDuration'].includes(message.type)),'editing tasks must not select or reset the current timer');
    await durationPanel.close();
    checks.push('task duration editor isolates task/action drafts, validates seconds and limits, disables duplicate saves, matches scoped request IDs, preserves failures and ignores deleted-task callbacks');

    const completionPage=await browser.newPage({viewport:{width:580,height:580}});
    completionPage.on('pageerror',error=>errors.push(error.message));
    await completionPage.clock.install({time:new Date('2030-01-01T12:00:00Z')});
    await completionPage.clock.pauseAt(new Date('2030-01-01T12:00:01Z'));
    await completionPage.addInitScript(()=>{
      window.messages=[];window.ipc={postMessage(value){messages.push({...JSON.parse(value),at:Date.now()});}};
    });
    await completionPage.goto('about:blank');
    await completionPage.setContent(html('island',{...state,duration_sec:1,settings:{...state.settings,showIdleClock:true,showIdleEyes:false}},
      {dial:340,effect:580,pillW:132,pillH:38}));
    assert.equal(await completionPage.locator('#readoutTask').count(),1);
    assert.equal(await completionPage.locator('#readoutTask').evaluate(node=>node.hidden),true);
    assert.equal(await completionPage.locator('#islandAction').count(),0);await expectClock(completionPage);
    await completionPage.locator('#island').focus();
    assert.equal(await completionPage.locator('#island').evaluate(node=>getComputedStyle(node).outlineStyle),'none');
    const completionTimer=()=>completionPage.evaluate(()=>messages.filter(message=>message.type==='timerState').at(-1));
    await completionPage.evaluate(()=>__fromRust('toggleTimer'));
    assert.equal(await completionPage.textContent('#readoutTask'),'验证任务');assert.equal(await completionPage.locator('#readoutTask').evaluate(node=>node.hidden),false);
    await completionPage.clock.runFor(1040);
    const finished=await completionTimer();assert.equal(finished.done,true);assert.equal(finished.idleAfterCompletion,false);
    assert.equal(await completionPage.textContent('#readoutTask'),'验证任务');assert.equal(await completionPage.locator('#readoutTask').evaluate(node=>node.hidden),false);
    const finishAt=await completionPage.evaluate(()=>messages.find(message=>message.type==='timerDone').at);
    const staleEffect=await completionPage.evaluate(()=>messages.filter(message=>message.type==='setEffect'&&message.active).at(-1).requestId);
    const untilDeadline=finishAt+10000-await completionPage.evaluate(()=>Date.now());
    await completionPage.clock.runFor(untilDeadline-1);assert.equal((await completionTimer()).idleAfterCompletion,false);
    assert.equal(await completionPage.textContent('#readoutTask'),'验证任务');assert.equal(await completionPage.locator('#readoutTask').evaluate(node=>node.hidden),false);
    await completionPage.clock.runFor(1);const completedDisplay=await completionTimer();
    assert.equal(completedDisplay.idleAfterCompletion,true);assert.equal(completedDisplay.at-finishAt,10000);
    for(const key of ['runId','taskId','done','started','remainingMs','totalMs'])assert.equal(completedDisplay[key],finished[key]);
    assert.equal(await completionPage.locator('#island').evaluate(node=>node.classList.contains('is-open')||node.classList.contains('is-done')),false);
    assert.equal(await completionPage.locator('#readoutChip').isHidden(),true);assert.equal(await completionPage.locator('#readoutTask').evaluate(node=>node.hidden),true);await expectClock(completionPage);
    await completionPage.evaluate(id=>__viewportReady(id),staleEffect);await completionPage.clock.runFor(32);
    assert.equal(await completionPage.locator('.crack__piece').count(),0);
    await panel.evaluate(payload=>__applyTimer(payload),completedDisplay);
    assert.equal(await panel.textContent('#btnStart'),'再来一次');assert.equal(await panel.locator('#island').evaluate(node=>node.classList.contains('is-clock')),true);
    await completionPage.evaluate(()=>__applyState({settings:{showIdleClock:false,showIdleEyes:true}},false));
    assert.equal(await completionPage.locator('#island').evaluate(node=>node.classList.contains('is-idle-eyes')),true);
    await completionPage.evaluate(()=>__applyState({settings:{showIdleClock:false,showIdleEyes:false}},false));
    assert.equal(await completionPage.textContent('#compactTime'),'');assert.equal(await completionPage.textContent('#readoutDigits'),'等待开始');
    await completionPage.evaluate(()=>__applyState({settings:{showIdleClock:true,showIdleEyes:false}},false));await expectClock(completionPage);

    // A real completion fragment exists before the user dismisses it. No reset
    // or cancel-action message may be used to return the presentation to idle.
    await completionPage.evaluate(()=>__fromRust('toggleTimer'));await completionPage.clock.runFor(1040);
    await completionPage.evaluate(()=>__viewportReady(messages.filter(message=>message.type==='setEffect'&&message.active).at(-1).requestId));
    await completionPage.clock.runFor(32);assert.equal(await completionPage.locator('.crack__piece').count(),2);
    const clickedRun=await completionTimer();
    await completionPage.locator('#island').evaluate(node=>node.click());
    const clickedIdle=await completionTimer();assert.equal(clickedIdle.runId,clickedRun.runId);assert.equal(clickedIdle.idleAfterCompletion,true);
    assert.equal(await completionPage.locator('.crack__piece').count(),0);await expectClock(completionPage);
    assert.equal((await completionPage.evaluate(()=>messages)).filter(message=>['resetTimer','cancelCompletionAction'].includes(message.type)).length,0);
    // Starting again invalidates the previous 10-second callback. Use a longer
    // duration so the stale callback cannot be confused with a new completion.
    await completionPage.evaluate(()=>__applyState({duration_sec:20},true));
    await completionPage.evaluate(()=>__fromRust('toggleTimer'));const freshRun=await completionTimer();
    await completionPage.clock.runFor(11000);const stillRunning=await completionTimer();
    assert.equal(stillRunning.runId,freshRun.runId);assert.equal(stillRunning.running,true);assert.equal(stillRunning.idleAfterCompletion,false);assert(stillRunning.remainingMs>0);
    await completionPage.evaluate(()=>__fromRust('resetTimer'));assert.equal((await completionTimer()).idleAfterCompletion,false);await expectClock(completionPage);
    assert.equal((await completionTimer()).totalMs,20000);assert.equal(await completionPage.locator('#readoutTask').evaluate(node=>node.hidden),true);
    await completionPage.close();
    checks.push('dial shows the active task name through completion then hides it in idle; no action card or click outline; 10-second/click return preserves action-run facts and ignores stale ACKs/timeouts');

    await island.evaluate(()=>__fromRust('toggleTimer'));await island.waitForTimeout(450);
    await island.evaluate(s=>__applyState({...s,current_id:'b'},true),state);
    let timer = await island.evaluate(()=>messages.filter(m=>m.type==='timerState').at(-1));
    assert.equal(timer.remainingMs,65000);assert.equal(timer.running,false);assert.equal(timer.started,false);assert.equal(timer.taskId,'b');
    await expectClock(island);
    await island.evaluate(()=>__fromRust('toggleTimer'));
    assert.equal(await island.textContent('#readoutTask'),'同秒任务');assert.equal(await island.locator('#readoutTask').evaluate(node=>node.hidden),false);
    await island.evaluate(()=>{const until=Date.now()+420;while(Date.now()<until){};});
    await island.waitForTimeout(100);
    await island.evaluate(()=>__fromRust('toggleTimer'));
    timer = await island.evaluate(()=>messages.filter(m=>m.type==='timerState').at(-1));
    assert(timer.remainingMs<64600,'a delayed event loop must subtract elapsed time');
    assert.equal(await island.textContent('#readoutTask'),'同秒任务');assert.equal(await island.locator('#readoutTask').evaluate(node=>node.hidden),false);
    await island.evaluate(s=>__applyState({...s,settings:{...s.settings,showSecond:false}},false),state);
    assert.equal(await island.locator('#handSecond').evaluate(el=>getComputedStyle(el).display),'none');
    checks.push('same-duration task reset, wall-clock countdown, live preference application');


    // A dedicated page keeps clock changes away from the countdown/animation tests.
    const emptyState = {...state,tasks:[],current_id:'',settings:{...state.settings,showIdleClock:true,showIdleEyes:false}};
    const clockPage = await browser.newPage({viewport:{width:580,height:580}});
    clockPage.on('pageerror',e=>errors.push(e.message));
    await clockPage.addInitScript(()=>{
      window.messages=[];
      window.ipc={postMessage(value){window.messages.push(JSON.parse(value));}};
    });
    await clockPage.goto('about:blank');
    await clockPage.setContent(html('island',emptyState));
    const expectLocalClock = () => expectClock(clockPage);
    await expectLocalClock();
    const initialClock = await clockPage.textContent('#compactTime');
    await clockPage.waitForFunction(previous=>document.querySelector('#compactTime').textContent!==previous,initialClock,{timeout:2000});
    await expectLocalClock();
    await clockPage.evaluate(s=>__applyState({...s,settings:{...s.settings,showHands:false,showSecond:false}},false),emptyState);
    const hiddenHandsClock = await clockPage.textContent('#compactTime');
    await clockPage.waitForFunction(previous=>document.querySelector('#compactTime').textContent!==previous,hiddenHandsClock,{timeout:2000});
    await expectLocalClock();

    // Freeze Date only, so an immediate start/pause deterministically leaves all
    // 65 seconds. It must still show a paused countdown rather than the clock.
    const beforeMidnight = await clockPage.evaluate(()=>new Date(2030,0,1,23,59,59).getTime());
    await clockPage.clock.setFixedTime(new Date(beforeMidnight));
    await clockPage.waitForFunction(()=>document.querySelector('#compactTime').textContent==='23:59:59');
    const immediatelyPaused = await clockPage.evaluate(()=>{
      __fromRust('toggleTimer');__fromRust('toggleTimer');
      return messages.filter(message=>message.type==='timerState').at(-1);
    });
    assert.equal(immediatelyPaused.remainingMs,65000);
    assert.equal(immediatelyPaused.running,false);
    assert.equal(immediatelyPaused.started,true);
    assert.equal(await clockPage.textContent('#compactTime'),'01:05');
    assert.equal(await clockPage.textContent('#readoutDigits'),'00:01:05');
    await clockPage.waitForTimeout(150);
    assert.equal(await clockPage.textContent('#readoutDigits'),'00:01:05');
    await clockPage.evaluate(()=>__fromRust('resetTimer'));
    await clockPage.waitForFunction(()=>document.querySelector('#compactTime').textContent==='23:59:59');
    const midnight = await clockPage.evaluate(()=>new Date(2030,0,2,0,0,0).getTime());
    await clockPage.clock.setFixedTime(new Date(midnight));
    await clockPage.waitForFunction(()=>document.querySelector('#compactTime').textContent==='00:00:00');
    assert.equal(await clockPage.textContent('#readoutDigits'),'00:00:00');
    assert.equal(await clockPage.locator('#island').evaluate(node=>node.classList.contains('is-done')),false);
    // Selecting a saved task keeps idle preferences until the user starts it.
    const savedTasks={...emptyState,tasks:[{id:'new',name:'新任务',sec:65},{id:'other',name:'另一任务',sec:125}],current_id:'new',settings:{...emptyState.settings,showIdleClock:false,showIdleEyes:true}};
    await clockPage.evaluate(s=>__applyState(s,true),savedTasks);
    await expectIdleEyes(clockPage);
    assert.equal(await clockPage.locator('#readoutChip').isHidden(),true);
    let configured=await clockPage.evaluate(()=>messages.filter(message=>message.type==='timerState').at(-1));
    assert.equal(configured.totalMs,65000);assert.equal(configured.started,false);assert.equal(configured.taskId,'new');
    await clockPage.evaluate(s=>__applyState({...s,current_id:'other',duration_sec:125},true),savedTasks);
    await expectIdleEyes(clockPage);
    configured=await clockPage.evaluate(()=>messages.filter(message=>message.type==='timerState').at(-1));
    assert.equal(configured.totalMs,125000);assert.equal(configured.remainingMs,125000);assert.equal(configured.started,false);assert.equal(configured.taskId,'other');
    await clockPage.evaluate(()=>__fromRust('toggleTimer'));
    assert.equal(await clockPage.locator('#island').evaluate(node=>node.classList.contains('is-clock')),false);
    assert.equal(await clockPage.textContent('#readoutDigits'),'00:02:05');
    assert.equal(await clockPage.textContent('#readoutTask'),'另一任务');assert.equal(await clockPage.locator('#readoutTask').evaluate(node=>node.hidden),false);
    await clockPage.evaluate(()=>__fromRust('toggleTimer'));
    await clockPage.waitForTimeout(150);
    assert.equal(await clockPage.textContent('#readoutDigits'),'00:02:05');
    assert.equal(await clockPage.textContent('#readoutTask'),'另一任务');assert.equal(await clockPage.locator('#readoutTask').evaluate(node=>node.hidden),false);
    assert.equal(await clockPage.locator('#readoutChip').isHidden(),true);
    await clockPage.evaluate(()=>__fromRust('resetTimer'));
    await expectIdleEyes(clockPage);
    assert.equal(await clockPage.locator('#readoutChip').isHidden(),true);
    await clockPage.evaluate(s=>__applyState(s,true),emptyState);
    await expectLocalClock();
    assert.equal((await clockPage.evaluate(()=>messages)).filter(message=>message.type==='frontendError').length,0);
    await clockPage.close();
    checks.push('live idle clock updates with hidden hands and across midnight; saved/selected/reset tasks keep configured idle, starting uses selected duration/name, paused task/free timers remain countdown');


    // Reset a collapsed timer after completion was requested, before native ACK.
    // The eventual dial region must expose a dial, not an invisible larger hit
    // target around a pill; the user's next click must then collapse normally.
    const resetRacePage=await browser.newPage({viewport:{width:580,height:580}});
    resetRacePage.on('pageerror',e=>errors.push(e.message));
    await resetRacePage.addInitScript(()=>{
      window.messages=[];
      window.ipc={postMessage(value){messages.push(JSON.parse(value));}};
    });
    await resetRacePage.goto('about:blank');
    await resetRacePage.setContent(html('island',{...state,duration_sec:1},
      {dial:340,effect:580,pillW:132,pillH:38}));
    await resetRacePage.evaluate(()=>__fromRust('toggleTimer'));
    await resetRacePage.waitForFunction(()=>messages.some(message=>message.type==='setEffect' && message.active));
    const pendingCompletion=await resetRacePage.evaluate(()=>messages.find(message=>message.type==='setEffect' && message.active).requestId);
    await resetRacePage.evaluate(()=>__fromRust('resetTimer'));
    const pendingRestore=await resetRacePage.evaluate(()=>messages.filter(message=>message.type==='setEffect' && !message.active).at(-1).requestId);
    await resetRacePage.evaluate(id=>__viewportReady(id),pendingCompletion);
    await resetRacePage.waitForTimeout(80);
    assert.equal(await resetRacePage.locator('.crack__piece').count(),0);
    assert.equal(await resetRacePage.locator('#island').evaluate(node=>node.classList.contains('is-open')),false);
    await resetRacePage.evaluate(id=>__viewportReady(id),pendingRestore);
    await resetRacePage.waitForFunction(()=>document.querySelector('#island').classList.contains('is-open'));
    await expectClock(resetRacePage);assert.equal(await resetRacePage.locator('#readoutTask').evaluate(node=>node.hidden),true);
    const resetConfiguration=await resetRacePage.evaluate(()=>messages.filter(message=>message.type==='timerState').at(-1));
    assert.equal(resetConfiguration.totalMs,1000);assert.equal(resetConfiguration.started,false);
    assert.equal(await resetRacePage.locator('#readoutChip').isHidden(),true);
    await resetRacePage.locator('#island').click({position:{x:170,y:20}});
    await resetRacePage.waitForFunction(()=>messages.some(message=>message.type==='setShape' && !message.open));
    await resetRacePage.evaluate(()=>__viewportReady(messages.filter(message=>message.type==='setShape' && !message.open).at(-1).requestId));
    assert.equal(await resetRacePage.locator('#island').evaluate(node=>node.classList.contains('is-open')),false);
    assert.equal((await resetRacePage.evaluate(()=>messages)).filter(message=>message.type==='frontendError').length,0);
    await resetRacePage.close();
    checks.push('reset before completion ACK restores a visible dial; stale ACK cannot revive fragments and the next click collapses normally');

    await island.evaluate(()=>{
      window.effectSamples=[];
      window.effectPoll=setInterval(()=>{
        const island=document.querySelector('#island'),piece=document.querySelector('.crack__piece');
        effectSamples.push({
          original:Number(getComputedStyle(island.querySelector(':scope > .island__expanded')).opacity),
          piece:piece?Number(getComputedStyle(piece).opacity)*Number(getComputedStyle(piece.parentElement).opacity):0,
          cracking:island.classList.contains('is-cracking')
        });
      },20);
      __selftestCycle();
    });
    await island.waitForFunction(()=>messages.some(m=>m.type==='timerDone'));
    await island.waitForTimeout(100);
    const polygons = await island.locator('.crack__piece').evaluateAll(nodes=>nodes.map(n=>n.style.clipPath));
    const area = polygon => {
      const values=polygon.match(/-?[\d.]+/g).map(Number),points=[];
      for(let i=0;i<values.length;i+=2)points.push([values[i],values[i+1]]);
      return Math.abs(points.reduce((sum,p,i)=>{const q=points[(i+1)%points.length];return sum+p[0]*q[1]-q[0]*p[1];},0))/2;
    };
    assert.equal(polygons.length,2);assert(Math.abs(area(polygons[0])+area(polygons[1])-10000)<1e-8);
    const duplicateIds = await island.evaluate(()=>{
      const ids=[...document.querySelectorAll('[id]')].map(n=>n.id);return ids.length!==new Set(ids).size;
    });
    assert.equal(duplicateIds,false);
    await island.waitForFunction(()=>messages.some(m=>m.type==='animationDone'));
    const effect = await island.evaluate(()=>{
      clearInterval(effectPoll);
      return {samples:effectSamples.filter(s=>s.cracking),messages,geometry:__checkHandGeometry(),
        text:document.querySelector('#readoutDigits').textContent,chip:document.querySelector('#readoutChip').textContent};
    });
    assert(effect.samples.length>30);
    assert(effect.samples.every(s=>s.original+s.piece>0.2),'animation must retain visible content throughout');
    assert(effect.samples.some(s=>s.original===0 && s.piece>0.8),'original must be hidden during split');
    assert.equal(effect.text,'00:00:00');assert.equal(effect.chip,'时间到');
    assert(effect.messages.some(m=>m.type==='selftestResult' && m.ok));
    const doneAt=effect.messages.find(m=>m.type==='timerDone').at;
    const endAt=effect.messages.find(m=>m.type==='animationDone').at;
    assert(endAt-doneAt>=1400 && endAt-doneAt<1900);
    checks.push('complementary 100% clip areas, hidden original, no empty frames, 1.5s completion, native selftest hooks');

    await island.evaluate(s=>{
      __applyState({...s,duration_sec:1,settings:{...s.settings,reduceMotion:true}},true);
      __fromRust('toggleTimer');
    },state);
    await island.waitForTimeout(1250);
    assert.equal(await island.locator('.crack__piece').count(),0);
    assert.equal(await island.textContent('#readoutChip'),'时间到');
    await island.evaluate(()=>document.querySelector('#island').click());
    await island.waitForTimeout(100);
    assert((await island.evaluate(()=>messages)).some(m=>m.type==='setShape' && m.open===false));
    await island.screenshot({path:path.join(root,'shot-pill.png'),omitBackground:true});
    await island.evaluate(s=>__applyState(s,true),state);await island.evaluate(()=>__selftestOpen());await island.waitForTimeout(550);
    await island.screenshot({path:path.join(root,'shot-dial.png'),omitBackground:true});
    await panel.evaluate(s=>{__applyState(s,true);document.querySelector('#inTaskName').value='';document.querySelector('#inTaskMin').value='25';document.querySelector('#inTaskSec').value='0';document.querySelector('#inTaskSec').setAttribute('aria-invalid','false');document.querySelector('#taskNote').textContent='';},state);await panel.screenshot({path:path.join(root,'shot-panel.png'),omitBackground:true});
    checks.push('reduced motion and collapse; refreshed transparent preview screenshots');
    assert.deepEqual(errors,[]);
    assert.equal((await island.evaluate(()=>messages)).filter(m=>m.type==='frontendError').length,0);
    return {ok:true,checks,consoleErrors:errors};
  } finally {await browser.close();}
}
module.exports={run};
if (require.main===module)run().then(async result=>{const out=path.resolve(__dirname,'verify');await fs.mkdir(out,{recursive:true});await fs.writeFile(path.join(out,'frontend-report.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));}).catch(error=>{console.error(error);process.exitCode=1;});
