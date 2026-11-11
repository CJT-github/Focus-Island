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
    const [template,css,app] = await Promise.all(['index.html','styles.css','app.js'].map(file=>fs.readFile(path.join(root,'ui',file),'utf8')));
    const html = (view,initialState=state,geometry={}) => template.replace('/*__CSS__*/',()=>css).replace('__VIEW__',view)
      .replace('/*__GEO__*/',()=>JSON.stringify(geometry)).replace('/*__STATE__*/',()=>JSON.stringify(initialState)).replace('/*__JS__*/',()=>app);
    const expectClock = page => page.waitForFunction(()=>{
      const now=new Date(),pad=n=>String(n).padStart(2,'0');
      const expected=[now.getHours(),now.getMinutes(),now.getSeconds()].map(pad).join(':');
      return document.querySelector('#island').classList.contains('is-clock') &&
        document.querySelector('#compactTime').textContent===expected &&
        document.querySelector('#readoutDigits').textContent===expected;
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
    assert(initial.geometry.every(distance=>distance<1e-6));await expectCountdown(island,65);
    assert.equal(await island.textContent('#readoutChip'),'准备开始');
    checks.push('60 ticks, 12 labels, centered hand bases; the selected saved task takes priority at startup');

    await panel.click('#btnStart');await panel.click('#btnReset2');await panel.click('#btnClear');
    await panel.fill('#inH','1');await panel.fill('#inM','2');await panel.fill('#inS','3');await panel.click('#btnApplyCustom');
    await panel.click('#btnOpenTaskPage');assert.equal(await panel.locator('#taskCreatePage').getAttribute('aria-hidden'),'false');assert.equal(await panel.locator('#settingsPage').getAttribute('aria-hidden'),'true');
    await panel.fill('#inTaskName','三秒任务');await panel.fill('#inTaskMin','0');await panel.fill('#inTaskSec','3');
    await panel.click('#btnTaskBack');assert.equal(await panel.locator('#settingsPage').getAttribute('aria-hidden'),'false');
    await panel.click('#btnOpenTaskPage');assert.equal(await panel.inputValue('#inTaskName'),'三秒任务');assert.equal(await panel.inputValue('#inTaskMin'),'0');assert.equal(await panel.inputValue('#inTaskSec'),'3');
    await panel.click('#btnCancelTask');assert.equal(await panel.locator('#settingsPage').getAttribute('aria-hidden'),'false');await panel.click('#btnOpenTaskPage');assert.equal(await panel.inputValue('#inTaskName'),'三秒任务');
    const hideBeforeTaskEscape=await panel.evaluate(()=>messages.filter(m=>m.type==='hidePanel').length);await panel.keyboard.press('Escape');assert.equal(await panel.locator('#settingsPage').getAttribute('aria-hidden'),'false');assert.equal(await panel.evaluate(()=>messages.filter(m=>m.type==='hidePanel').length),hideBeforeTaskEscape);await panel.click('#btnOpenTaskPage');
    let beforeInvalid=(await panel.evaluate(()=>messages)).length;
    await panel.fill('#inTaskSec','-2');await panel.click('#btnAddTask');assert.equal((await panel.evaluate(()=>messages)).length,beforeInvalid);
    await panel.fill('#inTaskSec','3');await panel.click('#btnAddTask');
    assert.equal(await panel.locator('#btnAddTask').isDisabled(),true);await panel.locator('#btnAddTask').evaluate(node=>node.click());
    let messages = await panel.evaluate(()=>messages);
    const createRequest=messages.find(message=>message.type==='addTask');assert(Number.isSafeInteger(createRequest.requestId)&&createRequest.requestId>0);
    assert.deepEqual(messages.slice(1).map(({at,...msg})=>msg),[
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

    await island.evaluate(()=>__fromRust('toggleTimer'));await island.waitForTimeout(450);
    await island.evaluate(s=>__applyState({...s,current_id:'b'},true),state);
    let timer = await island.evaluate(()=>messages.filter(m=>m.type==='timerState').at(-1));
    assert.equal(timer.remainingMs,65000);assert.equal(timer.running,false);assert.equal(timer.started,false);
    await expectCountdown(island,65);
    await island.evaluate(()=>__fromRust('toggleTimer'));
    await island.evaluate(()=>{const until=Date.now()+420;while(Date.now()<until){};});
    await island.waitForTimeout(100);
    await island.evaluate(()=>__fromRust('toggleTimer'));
    timer = await island.evaluate(()=>messages.filter(m=>m.type==='timerState').at(-1));
    assert(timer.remainingMs<64600,'a delayed event loop must subtract elapsed time');
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
    // Task priority also overrides eyes-only idle preferences.
    const savedTasks={...emptyState,tasks:[{id:'new',name:'新任务',sec:65},{id:'other',name:'另一任务',sec:125}],current_id:'new',settings:{...emptyState.settings,showIdleClock:false,showIdleEyes:true}};
    await clockPage.evaluate(s=>__applyState(s,true),savedTasks);
    await expectCountdown(clockPage,65);
    assert.equal(await clockPage.textContent('#readoutChip'),'准备开始');
    let configured=await clockPage.evaluate(()=>messages.filter(message=>message.type==='timerState').at(-1));
    assert.equal(configured.totalMs,65000);assert.equal(configured.started,false);
    await clockPage.evaluate(s=>__applyState({...s,current_id:'other',duration_sec:125},true),savedTasks);
    await expectCountdown(clockPage,125);
    configured=await clockPage.evaluate(()=>messages.filter(message=>message.type==='timerState').at(-1));
    assert.equal(configured.totalMs,125000);assert.equal(configured.remainingMs,125000);assert.equal(configured.started,false);
    await clockPage.evaluate(()=>__fromRust('toggleTimer'));
    assert.equal(await clockPage.locator('#island').evaluate(node=>node.classList.contains('is-clock')),false);
    assert.equal(await clockPage.textContent('#readoutDigits'),'00:02:05');
    assert.equal(await clockPage.textContent('#readoutTask'),'另一任务');
    await clockPage.evaluate(()=>__fromRust('toggleTimer'));
    await clockPage.waitForTimeout(150);
    assert.equal(await clockPage.textContent('#readoutDigits'),'00:02:05');
    assert.equal(await clockPage.textContent('#readoutChip'),'已暂停');
    await clockPage.evaluate(()=>__fromRust('resetTimer'));
    await expectCountdown(clockPage,125);
    assert.equal(await clockPage.textContent('#readoutChip'),'准备开始');
    await clockPage.evaluate(s=>__applyState(s,true),emptyState);
    await expectLocalClock();
    assert.equal((await clockPage.evaluate(()=>messages)).filter(message=>message.type==='frontendError').length,0);
    await clockPage.close();
    checks.push('task-free clock updates with hidden hands and across midnight; adding/selecting/resetting a task shows its countdown even with eyes-only preferences; paused free timers stay countdown and clearing tasks restores clock');


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
    await expectCountdown(resetRacePage,1);
    const resetConfiguration=await resetRacePage.evaluate(()=>messages.filter(message=>message.type==='timerState').at(-1));
    assert.equal(resetConfiguration.totalMs,1000);assert.equal(resetConfiguration.started,false);
    assert.equal(await resetRacePage.textContent('#readoutChip'),'准备开始');
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
