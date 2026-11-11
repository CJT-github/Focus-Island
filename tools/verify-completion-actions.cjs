/* Completion actions regression. System actions are configured, never executed.
   node tools/verify-completion-actions.cjs [--native path/to/focus-island.exe] */
const fs = require('node:fs/promises');
const syncFs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {createHash} = require('node:crypto');
const {spawn} = require('node:child_process');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || path.resolve(__dirname,'../../verify-tools/node_modules/playwright'));
const root=path.resolve(__dirname,'..'),out=path.join(root,'tools/verify');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const frozenPages=new WeakSet();
async function settleMenu(page){if(frozenPages.has(page))await page.clock.runFor(200);else await delay(200);}
const disabled={enabled:false,kind:'command',command:'',delaySec:10};
const fixture={tasks:[{id:'a',name:'动作验证 A',sec:2},{id:'b',name:'动作验证 B',sec:3}],current_id:'a',duration_sec:2,
  settings:{showHands:true,showSecond:true,showIdleClock:true,showIdleEyes:false,sound:false,notify:false,alwaysOnTop:true,reduceMotion:true}};
const clone=value=>JSON.parse(JSON.stringify(value));
async function htmlFactory(){
  const [template,css,app]=await Promise.all(['index.html','styles.css','app.js'].map(file=>fs.readFile(path.join(root,'ui',file),'utf8')));
  return (view,state=fixture,platform='windows')=>template.replace('/*__CSS__*/',()=>css).replace('__VIEW__',view).replace('/*__GEO__*/','{}').replace('/*__STATE__*/',()=>JSON.stringify(state)).replace('/*__JS__*/',()=>('window.__PLATFORM__='+JSON.stringify(platform)+';\n'+app));
}
async function input(page,selector,value){await page.locator(selector).fill(String(value));}
async function setChecked(page,selector,value){if(await page.locator(selector).isChecked()!==value)await page.locator(selector).evaluate(node=>node.click());}
async function taskHome(page){if(await page.locator('#btnTaskBack').isVisible()){await page.locator('#btnTaskBack').click();await settleMenu(page);}}
async function editTask(page,name){await taskHome(page);await page.getByRole('button',{name:'设置任务 '+name,exact:true}).click();await settleMenu(page);assert.equal(await page.locator('#taskSettingsPage').getAttribute('aria-hidden'),'false');}
async function openActionMenu(page,scope='action'){await page.locator('#'+scope+'KindTrigger').scrollIntoViewIfNeeded();await settleMenu(page);await page.locator('#'+scope+'KindTrigger').click();await settleMenu(page);}
async function chooseActionKind(page,kind,scope='action'){await openActionMenu(page,scope);await page.locator('[data-action-kind="'+kind+'"]').click();await settleMenu(page);assert.equal(await page.inputValue('#'+scope+'Kind'),kind);}
async function menuBounds(page){
  await settleMenu(page);
  assert.equal(await page.locator('#actionKindMenu').isVisible(),true);
  const result=await page.locator('#actionKindMenu').evaluate(menu=>{const bounds=menu.getBoundingClientRect();return{left:bounds.left,top:bounds.top,right:bounds.right,bottom:bounds.bottom,width:innerWidth,height:innerHeight,position:getComputedStyle(menu).position,unclipped:[...menu.querySelectorAll('[data-action-kind]')].every(option=>{const r=option.getBoundingClientRect();return document.elementFromPoint(r.left+r.width/2,r.top+r.height/2)?.closest('[data-action-kind]')===option;})};});
  assert(result.left>=0&&result.top>=0&&result.right<=result.width&&result.bottom<=result.height,'Menu fits within the settings viewport');assert.equal(result.position,'fixed');assert.equal(result.unclipped,true,'Every option is hit-testable and not clipped by a scrolling card');return result;
}
async function actionForm(page,action,scope='action'){
  await setChecked(page,'#'+scope+'Enabled',action.enabled);
  await chooseActionKind(page,action.kind,scope);
  if(['command','shell'].includes(action.kind))await input(page,'#'+scope+'Command',action.command);
  await input(page,'#'+scope+'Delay',action.delaySec);
}
async function headless(){
  const report={mode:'headless',checks:[],errors:[]},pass=(name,details)=>{report.checks.push({name,details});console.log('PASS',name);};
  const browser=await chromium.launch({headless:true,executablePath:process.env.BROWSER_EXE||(process.platform==='win32'?'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe':undefined)});
  try{
    const html=await htmlFactory();
    async function page(view,state=fixture,platform='windows'){
      const p=await browser.newPage({viewport:view==='island'?{width:580,height:580}:{width:340,height:640}});
      p.on('pageerror',error=>report.errors.push(error.message));
      await p.addInitScript(()=>{window.messages=[];window.ipc={postMessage(raw){messages.push({...JSON.parse(raw),at:Date.now()});}};});
      await p.goto('about:blank');await p.clock.install({time:new Date('2030-01-01T12:00:00Z')});await p.clock.pauseAt(new Date('2030-01-01T12:00:00Z'));frozenPages.add(p);await p.setContent(html(view,state,platform));return p;
    }
    const panel=await page('panel',{...fixture,freeCompletionAction:{enabled:true,kind:'shutdown',command:'',delaySec:10}});
    const lastSave=()=>panel.evaluate(()=>messages.filter(m=>m.type==='setCompletionAction').at(-1));
    const saves=()=>panel.evaluate(()=>messages.filter(m=>m.type==='setCompletionAction').length);
    const acknowledge=scope=>panel.evaluate(taskId=>__actionConfigResult({taskId,ok:true,message:'已保存'}),scope);
    assert.equal(await panel.locator('#settingsPage #completionActionSection').count(),0);assert.equal(await panel.locator('#taskSettingsPage #completionActionSection').count(),1);await editTask(panel,'动作验证 A');
    assert.equal(await panel.locator('#actionEnabled').isChecked(),false);assert.equal(await panel.inputValue('#actionKind'),'command');assert.equal(await panel.inputValue('#actionDelay'),'10');
    assert((await panel.textContent('#actionScope')).includes('动作验证 A'));
    pass('Actions appear only in a task settings page and legacy free configuration cannot supply defaults');
    assert.equal(await panel.locator('#actionKind').isVisible(),false);
    await panel.locator('#actionKindTrigger').scrollIntoViewIfNeeded();await settleMenu(panel);await panel.locator('#actionKindTrigger').focus();await settleMenu(panel);await panel.keyboard.press('ArrowDown');await menuBounds(panel);assert.equal(await panel.locator('#actionKindTrigger').getAttribute('aria-expanded'),'true');
    await panel.keyboard.press('End');await panel.keyboard.press('Enter');await settleMenu(panel);assert.equal(await panel.inputValue('#actionKind'),'restart');assert.equal(await panel.locator('#actionKindMenu').isVisible(),false);
    await panel.locator('#actionKindTrigger').click();await panel.keyboard.press('Home');await panel.keyboard.press('Space');await settleMenu(panel);assert.equal(await panel.inputValue('#actionKind'),'command');
    const beforeEscape=await panel.evaluate(()=>messages.filter(m=>m.type==='hidePanel').length);await panel.locator('#actionKindTrigger').click();await panel.keyboard.press('Escape');await settleMenu(panel);assert.equal(await panel.locator('#actionKindMenu').isVisible(),false);assert.equal(await panel.evaluate(()=>messages.filter(m=>m.type==='hidePanel').length),beforeEscape);
    await panel.locator('#actionKindTrigger').click();await panel.locator('#actionScope').click();await settleMenu(panel);assert.equal(await panel.locator('#actionKindMenu').isVisible(),false);
    pass('Glass action menu supports keyboard selection, Escape and outside click without clipping or hiding settings');
    await actionForm(panel,{enabled:true,kind:'command',command:'Write-Output "draft A"',delaySec:3});
    await panel.evaluate(s=>__applyState({...s,settings:{...s.settings,showSecond:false}}),fixture);
    assert.equal(await panel.inputValue('#actionCommand'),'Write-Output "draft A"');
    await editTask(panel,'动作验证 B');
    assert.equal(await panel.inputValue('#actionCommand'),'');await input(panel,'#actionCommand','Write-Output "draft B"');
    await editTask(panel,'动作验证 A');assert.equal(await panel.inputValue('#actionCommand'),'Write-Output "draft A"');
    await panel.locator('#btnSaveAction').click();let saved=await lastSave();assert.deepEqual(saved.action,{enabled:true,kind:'command',command:'Write-Output "draft A"',delaySec:3});assert.equal(saved.taskId,'a');
    await input(panel,'#actionCommand','Write-Output "new edit while saving"');await acknowledge('a');
    await panel.evaluate(s=>__applyState({...s,tasks:s.tasks.map(t=>t.id==='a'?{...t,completionAction:{enabled:true,kind:'command',command:'Write-Output "draft A"',delaySec:3}}:t)}),fixture);
    assert.equal(await panel.inputValue('#actionCommand'),'Write-Output "new edit while saving"');
    await editTask(panel,'动作验证 B');assert.equal(await panel.inputValue('#actionCommand'),'Write-Output "draft B"');
    await input(panel,'#actionCommand','Write-Output "B edited"');await panel.evaluate(()=>__actionConfigResult({taskId:'a',ok:false,message:'old scope failure'}));assert(!(await panel.textContent('#actionConfigNote')).includes('old scope'));
    assert.equal(await panel.evaluate(()=>messages.some(message=>['selectTask','resetTimer','toggleTimer'].includes(message.type))),false);
    pass('Editing another task preserves independent drafts and never selects or resets the active timer');
    await actionForm(panel,{enabled:true,kind:'command',command:'  ',delaySec:0});let before=await saves();await panel.locator('#btnSaveAction').click();assert.equal(await saves(),before);assert.equal(await panel.locator('#actionCommand').getAttribute('aria-invalid'),'true');
    await input(panel,'#actionCommand','Write-Output "task B"');
    for(const invalid of [-1,301,1.5]){await input(panel,'#actionDelay',invalid);await panel.locator('#btnSaveAction').click();assert.equal(await saves(),before);}
    await input(panel,'#actionDelay',0);
    // Native maxlength truncates simulated typing; assign a malformed value to
    // independently exercise the JavaScript validation used before IPC.
    for(const invalid of ['x'.repeat(4097),'echo'+String.fromCharCode(0)+'bad']){await panel.locator('#actionCommand').evaluate((node,value)=>{node.value=value;node.dispatchEvent(new Event('input',{bubbles:true}));},invalid);await panel.locator('#btnSaveAction').click();assert.equal(await saves(),before);}
    await input(panel,'#actionCommand','Write-Output "task B"');await panel.locator('#btnSaveAction').click();saved=await lastSave();assert.equal(saved.taskId,'b');assert.equal(saved.action.delaySec,0);await acknowledge('b');
    await actionForm(panel,{enabled:false,kind:'command',command:'',delaySec:300});await panel.locator('#btnSaveAction').click();assert.deepEqual((await lastSave()).action,{enabled:false,kind:'command',command:'',delaySec:300});await acknowledge('b');
    pass('Task-bound command and integer delay validation enforce boundaries');
    for(const kind of ['lock','sleep','shutdown','restart']){
      await actionForm(panel,{enabled:true,kind,command:'',delaySec:10});await panel.locator('#btnSaveAction').click();saved=await lastSave();assert.equal(saved.action.kind,kind);assert.equal(saved.taskId,'b');await acknowledge('b');
    }
    assert.equal(await panel.evaluate(()=>messages.some(m=>['timerState','timerDone'].includes(m.type))),false);
    pass('All four system action choices serialize configuration only; settings cannot publish timer completion');

    const island=await page('island');const lastTimer=()=>island.evaluate(()=>messages.filter(m=>m.type==='timerState').at(-1));
    assert.equal((await lastTimer()).runId,'');
    await island.evaluate(()=>__fromRust('toggleTimer'));let started=await lastTimer();assert(started.runId);assert.equal(started.taskId,'a');assert.equal(started.started,true);assert.equal(started.running,true);
    await island.clock.runFor(400);await island.evaluate(()=>__fromRust('toggleTimer'));let paused=await lastTimer();assert.equal(paused.runId,started.runId);assert.equal(paused.running,false);assert(paused.remainingMs<2000);
    await island.clock.runFor(2000);await island.evaluate(()=>__fromRust('toggleTimer'));assert.equal((await lastTimer()).runId,started.runId);
    await island.evaluate(()=>__fromRust('resetTimer'));assert.equal((await lastTimer()).runId,'');
    await island.evaluate(()=>__fromRust('toggleTimer'));const second=await lastTimer();assert.notEqual(second.runId,started.runId);await island.clock.runFor(2200);
    const done=await island.evaluate(()=>messages.filter(m=>m.type==='timerDone').at(-1)),doneState=await lastTimer();assert.equal(done.runId,second.runId);assert.equal(done.taskId,'a');assert.equal(doneState.runId,done.runId);assert.equal(doneState.done,true);assert.equal(doneState.running,false);assert.equal(doneState.remainingMs,0);assert.equal(Object.hasOwn(done,'command'),false);
    const order=await island.evaluate(()=>messages.map(m=>m.type));assert(order.lastIndexOf('timerState')<order.lastIndexOf('timerDone'));
    await island.evaluate(()=>__fromRust('toggleTimer'));assert.notEqual((await lastTimer()).runId,second.runId);
    pass('Run identity is unique per start/reset cycle, stable across pause/resume, and matches the final done state');
    await island.evaluate(s=>__applyState({...s,current_id:'b',duration_sec:3},true),fixture);assert.equal((await lastTimer()).runId,'');await island.evaluate(()=>__fromRust('toggleTimer'));assert.equal((await lastTimer()).taskId,'b');
    await island.evaluate(s=>__applyState({...s,tasks:[],current_id:''},true),fixture);await island.evaluate(()=>__fromRust('toggleTimer'));assert.equal((await lastTimer()).taskId,'');pass('Task switch resets the run and free timers carry an explicit empty task identity');

    for(const [p,card,cancel] of [[panel,'#panelAction','#btnCancelPanelAction'],[island,'#islandAction','#btnCancelIslandAction']]){
      await p.evaluate(()=>__actionStatus({runId:'status-run',taskId:'b',phase:'pending',label:'自定义命令',message:'等待执行',remainingSec:4}));
      assert.equal(await p.locator(card).getAttribute('data-phase'),'pending');assert((await p.locator(card+' .action-status__phase').textContent()).includes('4'));
      await p.locator(cancel).evaluate(node=>node.click());assert.equal(await p.evaluate(()=>messages.filter(m=>m.type==='cancelCompletionAction').at(-1).runId),'status-run');
      for(const phase of ['running','success','error','cancelled']){await p.evaluate(phase=>__actionStatus({runId:'status-run',taskId:'b',phase,label:'自定义命令',message:phase==='error'?'退出码 7':phase,remainingSec:0}),phase);assert.equal(await p.locator(card).getAttribute('data-phase'),phase);assert.equal(await p.locator(cancel).evaluate(node=>node.hidden),true);}
      assert.equal(await p.locator(card).evaluate(node=>node.hidden),false);
      await p.evaluate(()=>__actionStatus({runId:'',phase:'idle',label:'',message:'',remainingSec:0}));assert.equal(await p.locator(card).evaluate(node=>node.hidden),true);
    }
    await panel.evaluate(()=>__actionStatus({runId:'other-run',taskId:'a',phase:'pending',label:'其他任务',message:'',remainingSec:5}));assert.equal(await panel.locator('#panelAction').evaluate(node=>node.hidden),true);await editTask(panel,'动作验证 A');assert.equal(await panel.locator('#panelAction').evaluate(node=>node.hidden),false);await taskHome(panel);assert.equal(await panel.locator('#panelAction').evaluate(node=>node.hidden),true);
    await panel.locator('#btnStart').click();assert.equal(await panel.evaluate(()=>messages.at(-1).type),'toggleTimer');
    pass('Both views render pending countdown/cancel and execution outcomes without disabling timer controls');
    await editTask(panel,'动作验证 B');await panel.evaluate(s=>__applyState({...s,tasks:s.tasks.filter(task=>task.id!=='b')}),fixture);assert.equal(await panel.locator('#settingsPage').getAttribute('aria-hidden'),'false');
    await panel.evaluate(s=>__applyState({...s,tasks:[],current_id:''},true),fixture);assert.equal(await panel.locator('.task__edit').count(),0);assert.equal(await panel.locator('#settingsPage #completionActionSection').count(),0);pass('Deleting the edited task returns to the list, and a task-free page exposes no action editor');

    const createState=clone(fixture);createState.tasks[0].completionAction={enabled:true,kind:'sleep',command:'',delaySec:20};createState.freeCompletionAction={enabled:true,kind:'shutdown',command:'',delaySec:30};
    const create=await page('panel',createState),createCount=()=>create.evaluate(()=>messages.filter(m=>m.type==='addTask').length);
    await editTask(create,'动作验证 A');await taskHome(create);await create.locator('#btnOpenTaskPage').click();
    assert.equal(await create.locator('#createActionEnabled').isChecked(),false);assert.equal(await create.inputValue('#createActionKind'),'command');assert.equal(await create.inputValue('#createActionCommand'),'');assert.equal(await create.inputValue('#createActionDelay'),'10');
    await input(create,'#inTaskName','原子创建验证');await input(create,'#inTaskMin',0);await input(create,'#inTaskSec',2);
    await actionForm(create,{enabled:true,kind:'command',command:'Write-Output "create draft"',delaySec:4},'createAction');
    await create.locator('#btnTaskBack').click();await editTask(create,'动作验证 A');assert.equal(await create.inputValue('#actionKind'),'sleep');await taskHome(create);await create.locator('#btnOpenTaskPage').click();
    await create.evaluate(s=>__applyState({...s,settings:{...s.settings,showSecond:false}}),createState);
    assert.equal(await create.inputValue('#inTaskName'),'原子创建验证');assert.equal(await create.inputValue('#inTaskSec'),'2');assert.equal(await create.inputValue('#createActionCommand'),'Write-Output "create draft"');assert.equal(await create.inputValue('#createActionDelay'),'4');assert.equal(await create.locator('#createActionEnabled').isChecked(),true);
    pass('New-task actions default off independently of task/free actions and preserve the complete draft on Back and settings sync');

    await settleMenu(create);await create.locator('#createActionKindTrigger').focus();await create.keyboard.press('ArrowDown');await menuBounds(create);await create.keyboard.press('End');await create.keyboard.press('Enter');await settleMenu(create);assert.equal(await create.inputValue('#createActionKind'),'restart');
    await create.locator('#createActionKindTrigger').click();await create.keyboard.press('Escape');await settleMenu(create);assert.equal(await create.locator('#actionKindMenu').isVisible(),false);assert.equal(await create.locator('#taskCreatePage').getAttribute('aria-hidden'),'false');
    for(const kind of ['lock','sleep','shutdown','restart','command'])await chooseActionKind(create,kind,'createAction');
    assert.equal(await createCount(),0);await editTask(create,'动作验证 A');assert.equal(await create.inputValue('#actionKind'),'sleep');await taskHome(create);await create.locator('#btnOpenTaskPage').click();
    pass('Shared glass menu supports all creation action types and keyboard/Escape within the new-task page without changing the main action');

    await input(create,'#createActionCommand',' ');await create.locator('#btnAddTask').click();assert.equal(await createCount(),0);
    await input(create,'#createActionCommand','Write-Output "create draft"');
    for(const invalid of [-1,301,1.5]){await input(create,'#createActionDelay',invalid);await create.locator('#btnAddTask').click();assert.equal(await createCount(),0);}
    await input(create,'#createActionDelay',4);
    for(const invalid of ['x'.repeat(4097),'echo'+String.fromCharCode(0)+'bad']){await create.locator('#createActionCommand').evaluate((node,value)=>{node.value=value;node.dispatchEvent(new Event('input',{bubbles:true}));},invalid);await create.locator('#btnAddTask').click();assert.equal(await createCount(),0);}
    await input(create,'#createActionCommand','Write-Output "create draft"');await create.locator('#btnAddTask').click();
    const submitted=await create.evaluate(()=>messages.filter(m=>m.type==='addTask').at(-1));assert(Number.isSafeInteger(submitted.requestId)&&submitted.requestId>0);assert.deepEqual(submitted.completionAction,{enabled:true,kind:'command',command:'Write-Output "create draft"',delaySec:4});assert.equal(submitted.name,'原子创建验证');assert.equal(submitted.sec,2);
    for(const selector of ['inTaskName','inTaskMin','inTaskSec','createActionEnabled','createActionKind','createActionKindTrigger','createActionCommand','createActionDelay','btnAddTask'])assert.equal(await create.locator('#'+selector).isDisabled(),true,selector+' is disabled during submission');
    await create.locator('#btnAddTask').evaluate(node=>node.click());assert.equal(await createCount(),1);
    await create.evaluate(requestId=>__taskCreateResult({requestId:requestId+1,ok:true,taskId:'wrong',message:'wrong response'}),submitted.requestId);assert.equal(await create.locator('#btnAddTask').isDisabled(),true);assert.equal(await create.inputValue('#inTaskName'),'原子创建验证');
    const acknowledgedState={...createState,tasks:[...createState.tasks,{id:'created',name:'原子创建验证',sec:2,completionAction:submitted.completionAction}],current_id:'created',duration_sec:2};
    await create.evaluate(s=>__applyState(s,true),acknowledgedState);assert.equal(await create.locator('#btnAddTask').isDisabled(),true);assert.equal(await create.locator('#taskCreatePage').getAttribute('aria-hidden'),'false');
    await create.evaluate(requestId=>__taskCreateResult({requestId,ok:false,taskId:'',message:'磁盘写入失败'}),submitted.requestId);assert.equal(await create.locator('#btnAddTask').isDisabled(),false);assert.equal(await create.inputValue('#inTaskName'),'原子创建验证');assert.equal(await create.inputValue('#createActionCommand'),'Write-Output "create draft"');assert((await create.textContent('#taskNote')).includes('磁盘写入失败'));
    pass('Creation validates command/delay, sends one complete payload, ignores mismatched results and preserves drafts after failure');

    await create.locator('#btnAddTask').click();const retried=await create.evaluate(()=>messages.filter(m=>m.type==='addTask').at(-1));assert.notEqual(retried.requestId,submitted.requestId);
    await create.evaluate(requestId=>__taskCreateResult({requestId,ok:false,taskId:'',message:'stale failure'}),submitted.requestId);assert.equal(await create.locator('#btnAddTask').isDisabled(),true);
    await create.evaluate(s=>__applyState(s,true),acknowledgedState);await create.evaluate(requestId=>__taskCreateResult({requestId,ok:true,taskId:'created',message:'已创建'}),retried.requestId);
    assert.equal(await create.locator('#settingsPage').getAttribute('aria-hidden'),'false');assert.equal(await create.inputValue('#inTaskName'),'');assert.equal(await create.locator('#createActionEnabled').isChecked(),false);assert.equal(await create.inputValue('#createActionKind'),'command');assert.equal(await create.inputValue('#createActionCommand'),'');assert.equal(await create.inputValue('#createActionDelay'),'10');assert.equal(await create.inputValue('#inTaskSec'),'2');
    await editTask(create,'原子创建验证');assert.equal(await create.locator('#actionEnabled').isChecked(),true);assert.equal(await create.inputValue('#actionCommand'),'Write-Output "create draft"');
    pass('Only the matching successful create result resets the new-task form and returns to its saved independent action');
    const macState=clone(fixture),legacyScript='Write-Output "Windows command stays unchanged"';macState.tasks[0].completionAction={enabled:true,kind:'command',command:legacyScript,delaySec:10};
    const mac=await page('panel',macState,'macos');await editTask(mac,'动作验证 A');assert.equal(await mac.inputValue('#actionKind'),'command');assert.equal(await mac.inputValue('#actionCommand'),legacyScript);assert((await mac.textContent('#actionKindValue')).includes('Windows'));
    await openActionMenu(mac);await menuBounds(mac);assert.deepEqual(await mac.locator('#actionKindMenu [data-action-kind]').evaluateAll(nodes=>nodes.filter(node=>!node.hidden).map(node=>node.dataset.actionKind)),['shell','sleep','shutdown','restart']);await mac.keyboard.press('Escape');await settleMenu(mac);
    await mac.locator('#btnSaveAction').click();const preserved=await mac.evaluate(()=>messages.filter(message=>message.type==='setCompletionAction').at(-1));assert.equal(preserved.action.kind,'command');assert.equal(preserved.action.command,legacyScript);await mac.evaluate(()=>__actionConfigResult({taskId:'a',ok:false,message:'当前平台不支持 Windows PowerShell'}));
    await taskHome(mac);await mac.locator('#btnOpenTaskPage').click();assert.equal(await mac.inputValue('#createActionKind'),'shell');assert.equal(await mac.locator('#createActionEnabled').isChecked(),false);assert((await mac.locator('#createActionCommand').getAttribute('placeholder')).includes('open -a TextEdit'));
    await input(mac,'#inTaskName','Mac shell task');await input(mac,'#inTaskMin',0);await input(mac,'#inTaskSec',2);await actionForm(mac,{enabled:true,kind:'shell',command:'printf "ok"',delaySec:0},'createAction');await mac.locator('#btnAddTask').click();const shellCreate=await mac.evaluate(()=>messages.filter(message=>message.type==='addTask').at(-1));assert.equal(shellCreate.completionAction.kind,'shell');assert.equal(shellCreate.completionAction.command,'printf "ok"');
    pass('Mac UI defaults to zsh shell with four supported choices and preserves saved Windows commands without reinterpretation');
    assert.deepEqual(report.errors,[]);report.passed=true;return report;
  }finally{await browser.close();await fs.writeFile(path.join(out,'completion-actions-report.json'),JSON.stringify(report,null,2)+'\n');}
}

async function native(executable,uiOnly=false){
  const exe=path.resolve(executable||path.join(root,'target/verified/release/focus-island.exe'));
  const profile=await fs.mkdtemp(path.join(out,'completion-')),marker=path.join(profile,'finished.txt'),stateFile=path.join(profile,'state.json'),logFile=path.join(profile,'diagnostic.log');
  const report={mode:'native',exe,checks:[],errors:[],artifacts:[],userProfileReadOnly:true,systemActionsExecuted:false};
  const pass=(name,details)=>{report.checks.push({name,details});console.log('PASS',name);};
  let browser,child,island,panel,originalBytes;
  const originalState=process.env.APPDATA?path.join(process.env.APPDATA,'FocusIsland/state.json'):null;
  const command="Add-Content -LiteralPath '"+marker.replace(/'/g,"''")+"' -Value 'completion-marker' # completion-private-script-sentinel";
  const createdMarker=path.join(profile,'created-task.txt'),createdCommand="Add-Content -LiteralPath '"+createdMarker.replace(/'/g,"''")+"' -Value 'created-once'";
  const action=(delaySec=0)=>({enabled:true,kind:'command',command,delaySec});
  async function send(page,message){await page.evaluate(message=>window.ipc.postMessage(JSON.stringify(message)),message);}
  async function lines(){try{return(await fs.readFile(marker,'utf8')).trim().split(/\r?\n/).filter(Boolean).length;}catch(error){if(error.code==='ENOENT')return 0;throw error;}}
  async function launch(){
    child=spawn(exe,['--debug-port','9473','--data-dir',profile,'--verbose','--log-file',logFile],{cwd:root,windowsHide:true});child.on('error',error=>report.errors.push(error.message));
    for(let n=0;n<100&&!browser;n++){try{browser=await chromium.connectOverCDP('http://127.0.0.1:9473');}catch{await delay(200);}}
    assert(browser,'Native CDP endpoint');
    for(let n=0;n<100&&(!island||!panel);n++){
      for(const context of browser.contexts())for(const page of context.pages()){const view=await page.evaluate(()=>document.body?.dataset.view).catch(()=>null);if(view==='island')island=page;else if(view==='panel')panel=page;}
      if(!island||!panel)await delay(100);
    }
    assert(island&&panel,'Both native views');
    for(const page of [island,panel]){
      page.on('pageerror',error=>report.errors.push(error.message));
      await page.waitForFunction(()=>typeof __actionStatus==='function');
      await page.evaluate(()=>{
        window.actionEvents=[];window.configEvents=[];window.timerEvents=[];window.createEvents=[];
        const status=window.__actionStatus,result=window.__actionConfigResult,timer=window.__applyTimer,created=window.__taskCreateResult;
        window.__actionStatus=value=>{actionEvents.push({...value,at:Date.now()});status(value);};
        window.__actionConfigResult=value=>{configEvents.push(value);result(value);};
        if(timer)window.__applyTimer=value=>{timerEvents.push({...value,at:Date.now()});timer(value);};
        if(created)window.__taskCreateResult=value=>{createEvents.push(value);created(value);};
      });
    }
    await island.evaluate(()=>document.querySelector('#island').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true})));
    await delay(100);
  }
  async function stop(){
    if(island&&!island.isClosed())await send(island,{type:'quit'}).catch(()=>{});
    await delay(500);if(browser)await browser.close().catch(()=>{});if(child&&child.exitCode===null)child.kill();browser=island=panel=null;
  }
  async function status(phase,runId){
    await island.waitForFunction(({phase,runId})=>actionEvents.some(e=>e.phase===phase&&(!runId||e.runId===runId)),{phase,runId},{timeout:10000});
    return island.evaluate(({phase,runId})=>actionEvents.filter(e=>e.phase===phase&&(!runId||e.runId===runId)).at(-1),{phase,runId});
  }
  async function reset(){const count=await panel.evaluate(()=>timerEvents.length);await island.evaluate(()=>__fromRust('resetTimer'));await panel.waitForFunction(count=>timerEvents.length>count&&timerEvents.at(-1)?.started===false,count);}
  async function select(id){const count=await panel.evaluate(()=>timerEvents.length);await send(panel,{type:'selectTask',id});await panel.waitForFunction(({id,count})=>timerEvents.length>count&&timerEvents.at(-1)?.taskId===id&&timerEvents.at(-1)?.started===false,{id,count});}
  async function start(){
    const count=await panel.evaluate(()=>timerEvents.length);
    await island.evaluate(()=>{actionEvents=[];__fromRust('toggleTimer');});
    await panel.waitForFunction(count=>timerEvents.length>count&&timerEvents.at(-1)?.running===true,count);
    return panel.evaluate(()=>timerEvents.at(-1));
  }
  async function finished(run){await panel.waitForFunction(runId=>timerEvents.some(e=>e.runId===runId&&e.done),run.runId,{timeout:6000});}
  async function configure(value,scope='a',throughForm=false){
    const configuredState=JSON.parse(await fs.readFile(stateFile,'utf8')),configuredTask=configuredState.tasks.find(task=>task.id===scope);assert(configuredTask,'Only an existing task can have an action');await editTask(panel,configuredTask.name);
    const count=await panel.evaluate(()=>configEvents.length);
    if(throughForm){await actionForm(panel,value);await panel.locator('#btnSaveAction').click();}
    else await send(panel,{type:'setCompletionAction',taskId:scope,action:value});
    await panel.waitForFunction(({count,scope})=>configEvents.length>count&&configEvents.slice(count).some(e=>e.taskId===scope&&e.ok),{count,scope});
    for(let n=0;n<60;n++){
      const state=JSON.parse(await fs.readFile(stateFile,'utf8')),saved=state.tasks.find(t=>t.id===scope)?.completionAction;
      if(JSON.stringify(saved)===JSON.stringify(value)||saved&&['enabled','kind','command','delaySec'].every(key=>saved[key]===value[key]))return;
      await delay(50);
    }
    assert.fail('Native configuration did not persist');
  }
  async function shot(name,page=island){await delay(350);await page.screenshot({path:path.join(out,name),omitBackground:true});report.artifacts.push(name);}
  try{
    if(originalState)try{originalBytes=await fs.readFile(originalState);report.originalStateSha256=createHash('sha256').update(originalBytes).digest('hex');}catch(error){if(error.code!=='ENOENT')throw error;}
    const legacyMarker=path.join(profile,'legacy-free.txt'),legacyCommand="Add-Content -LiteralPath '"+legacyMarker.replace(/'/g,"''")+"' -Value 'must-never-run'";
    await fs.writeFile(stateFile,JSON.stringify({...fixture,tasks:[],current_id:'',duration_sec:1,freeCompletionAction:{enabled:true,kind:'command',command:legacyCommand,delaySec:0}}));await launch();
    assert.equal(await panel.locator('#settingsPage #completionActionSection').count(),0);assert.equal(await panel.locator('.task__edit').count(),0);
    await send(panel,{type:'setCompletionAction',taskId:'',action:{enabled:true,kind:'command',command:legacyCommand,delaySec:0}});await panel.waitForFunction(()=>configEvents.some(event=>event.taskId===''&&!event.ok));
    const freeRun=await start();assert.equal(freeRun.taskId,'');await finished(freeRun);assert.equal(await island.textContent('#readoutChip'),'时间到');await delay(250);await assert.rejects(fs.access(legacyMarker),error=>error.code==='ENOENT');
    await send(panel,{type:'setDuration',sec:2});for(let n=0;n<30;n++){const saved=JSON.parse(await fs.readFile(stateFile,'utf8'));if(!Object.hasOwn(saved,'freeCompletionAction')&&!Object.hasOwn(saved,'free_completion_action'))break;await delay(50);}
    const migrated=JSON.parse(await fs.readFile(stateFile,'utf8'));assert.equal(Object.hasOwn(migrated,'freeCompletionAction'),false);assert.equal(Object.hasOwn(migrated,'free_completion_action'),false);await stop();
    pass('Legacy free actions are ignored and removed on save; empty-task configuration is rejected while a free timer still completes without executing');
    const initial=clone(fixture);initial.tasks[0].completionAction={...action(),enabled:false};await fs.writeFile(stateFile,JSON.stringify(initial));
    await launch();assert.equal(await panel.locator('#settingsPage #completionActionSection').count(),0);await editTask(panel,'动作验证 A');assert.equal(await panel.locator('#actionEnabled').isChecked(),false);
    const beforeInvalid=await fs.readFile(stateFile);
    await send(panel,{type:'addTask',name:'非法动作不得创建',sec:2,completionAction:{enabled:true,kind:'invalid-kind',command:'',delaySec:0},requestId:900001});
    await panel.waitForFunction(()=>createEvents.some(e=>e.requestId===900001&&!e.ok));assert((await fs.readFile(stateFile)).equals(beforeInvalid));assert.equal(await panel.locator('.task').count(),2);pass('Invalid creation action returns an error without a partial task or state change');
    await panel.locator('#actionKindTrigger').click();const nativeMenu=await menuBounds(panel);await shot('completion-native-action-menu.png',panel);await panel.keyboard.press('Escape');await settleMenu(panel);assert.equal(await panel.locator('#actionKindMenu').isVisible(),false);pass('Native glass dropdown remains unclipped and Escape closes only its menu',nativeMenu);
    await taskHome(panel);await panel.locator('#btnOpenTaskPage').click();assert.equal(await panel.locator('#taskCreatePage').getAttribute('aria-hidden'),'false');
    assert.equal(await panel.locator('#createActionEnabled').isChecked(),false);await input(panel,'#inTaskName','新增页面验证');await input(panel,'#inTaskMin',0);await input(panel,'#inTaskSec',2);
    const createdAction={enabled:true,kind:'command',command:createdCommand,delaySec:0};await actionForm(panel,createdAction,'createAction');
    await panel.locator('#btnTaskBack').click();await panel.locator('#btnOpenTaskPage').click();assert.equal(await panel.inputValue('#inTaskName'),'新增页面验证');
    assert.equal(await panel.inputValue('#createActionCommand'),createdCommand);await openActionMenu(panel,'createAction');await menuBounds(panel);await shot('completion-native-create-action-menu.png',panel);await panel.keyboard.press('Escape');await settleMenu(panel);
    await shot('completion-native-create-task.png',panel);await panel.locator('#btnAddTask').click();
    await panel.waitForFunction(()=>document.querySelector('#settingsPage').getAttribute('aria-hidden')==='false'&&document.querySelector('#taskCreatePage').getAttribute('aria-hidden')==='true');
    const createdState=JSON.parse(await fs.readFile(stateFile,'utf8'));assert.equal(createdState.tasks.length,3);const created=createdState.tasks.find(t=>t.name==='新增页面验证');assert(created);assert.equal(createdState.current_id,created.id);assert.deepEqual(created.completionAction,createdAction);assert.equal(await panel.inputValue('#inTaskName'),'');assert.equal(await panel.locator('#createActionEnabled').isChecked(),false);await editTask(panel,created.name);assert.equal(await panel.locator('#actionEnabled').isChecked(),true);
    pass('Native task page atomically saves the task and its action, selects it and clears only the new-task draft');
    if(uiOnly){if(originalBytes){report.originalStateUnchanged=(await fs.readFile(originalState)).equals(originalBytes);assert(report.originalStateUnchanged);}report.mode='native-ui';assert.deepEqual(report.errors,[]);report.passed=true;return report;}
    await stop();await launch();await editTask(panel,created.name);assert.equal(await panel.locator('#actionEnabled').isChecked(),true);assert.equal(await panel.inputValue('#actionCommand'),createdCommand);assert.equal(await island.locator('#island').evaluate(node=>node.classList.contains('is-running')),false);await delay(2200);await assert.rejects(fs.access(createdMarker),error=>error.code==='ENOENT');
    let createdRun=await start();await status('success',createdRun.runId);assert.equal((await fs.readFile(createdMarker,'utf8')).trim(),'created-once');await send(island,{type:'timerDone',runId:createdRun.runId,taskId:created.id});await delay(300);assert.equal((await fs.readFile(createdMarker,'utf8')).trim(),'created-once');
    pass('A newly created action survives restart without running, then executes exactly once at its real timer completion');
    await select('a');
    let run=await start();await editTask(panel,'动作验证 B');const preservedRun=await panel.evaluate(()=>timerEvents.at(-1));assert.equal(preservedRun.runId,run.runId);assert.equal(preservedRun.taskId,'a');assert.equal(preservedRun.running,true);assert.equal(JSON.parse(await fs.readFile(stateFile,'utf8')).current_id,'a');pass('Opening an unselected task editor leaves the running task, run identity and timer untouched');await finished(run);await delay(250);assert.equal(await lines(),0);assert.equal(await island.evaluate(()=>actionEvents.some(e=>['pending','running','success'].includes(e.phase))),false);
    pass('Disabled completion action completes a real timer without launching the stored harmless command');

    await reset();await configure(action(), 'a', true);
    await send(panel,{type:'setDuration',sec:8});await panel.waitForFunction(()=>timerEvents.at(-1)?.totalMs===8000&&timerEvents.at(-1)?.started===false);const activeTaskRun=await start();await status('armed',activeTaskRun.runId);
    await configure({...disabled},'b',true);const stillRunning=await panel.evaluate(()=>timerEvents.at(-1));assert.equal(stillRunning.runId,activeTaskRun.runId);assert.equal(stillRunning.taskId,'a');assert.equal(stillRunning.running,true);assert.equal(await island.evaluate(id=>actionEvents.some(event=>event.runId===id&&event.phase==='cancelled'),activeTaskRun.runId),false);assert.equal(await panel.locator('#panelAction').evaluate(node=>node.hidden),true);
    await editTask(panel,'动作验证 A');assert.equal(await panel.locator('#panelAction').evaluate(node=>node.hidden),false);await reset();await select('a');pass('Saving task B through its editor neither resets task A nor cancels its armed action; status appears only in the matching task editor');
    const forged={type:'timerState',runId:'panel-forgery',taskId:'a',started:true,running:true,done:false,remainingMs:2000,totalMs:2000};
    await send(panel,forged);await send(panel,{...forged,running:false,done:true,remainingMs:0});await send(panel,{type:'timerDone',runId:'panel-forgery',taskId:'a',task:'forged'});await delay(200);assert.equal(await lines(),0);
    run=await start();await status('armed',run.runId);
    for(const message of [{type:'timerDone',taskId:'a'},{type:'timerDone',runId:'expired-run',taskId:'a'},{type:'timerDone',runId:run.runId,taskId:'b'},{type:'timerDone',runId:run.runId,taskId:'a'}])await send(island,message);
    await send(panel,{type:'timerDone',runId:run.runId,taskId:'a'});await delay(200);assert.equal(await lines(),0,'No command before the actual countdown finishes');
    await status('success',run.runId);assert.equal(await lines(),1);await send(island,{type:'timerDone',runId:run.runId,taskId:'a'});await delay(350);assert.equal(await lines(),1);
    pass('Only a real island completion executes once; missing/stale/wrong-task/panel/early/replayed done messages cannot launch or consume the run');

    await reset();await configure(action(3));run=await start();await status('pending',run.runId);await shot('completion-native-pending.png');
    await panel.locator('#btnCancelPanelAction').click();await status('cancelled',run.runId);await delay(3300);assert.equal(await lines(),1);
    pass('Pending action shows a cancellable countdown and cancellation prevents the command');

    for(const boundary of ['reset','task switch','duration change','configuration update']){
      if(boundary==='reset')await reset();else{await select('a');await reset();}
      await configure(action(1));run=await start();await status('pending',run.runId);
      if(boundary==='reset')await reset();
      else if(boundary==='task switch')await select('b');
      else if(boundary==='duration change')await send(panel,{type:'setDuration',sec:3});
      else await configure({...action(1),enabled:false});
      await status('cancelled',run.runId);await delay(1300);assert.equal(await lines(),1,boundary+' must cancel pending execution');
      pass('Pending execution is cancelled by '+boundary);
    }

    await select('a');await reset();await configure({...action(0),command:'exit 7'});run=await start();const failure=await status('error',run.runId);assert(/7/.test(failure.message));assert.equal(await lines(),1);await shot('completion-native-error.png');await reset();assert.equal(await panel.textContent('#btnStart'),'开始');
    pass('A nonzero command exit reports failure while timer controls remain usable');

    await configure(action(3));run=await start();await status('pending',run.runId);await stop();await launch();await editTask(panel,'动作验证 A');assert.equal(await panel.locator('#actionEnabled').isChecked(),true);assert.equal(await panel.inputValue('#actionDelay'),'3');await delay(3300);assert.equal(await lines(),1);assert.equal(await island.evaluate(()=>actionEvents.some(e=>e.phase==='running')),false);
    pass('Configuration persists across restart; a pending action is cancelled on quit and never replayed at startup');

    // Saving system choices is safe. No timer is started after these writes.
    for(const kind of ['lock','sleep','shutdown','restart'])await configure({enabled:false,kind,command,delaySec:10},'a',true);
    await configure({...disabled});await shot('completion-native-settings.png',panel);
    const log=await fs.readFile(logFile,'utf8');assert(!log.includes('completion-private-script-sentinel'));assert(!log.includes('Add-Content'));assert(!log.includes(marker));
    pass('System choices persist without execution and diagnostic logs omit command text');
    if(originalBytes){report.originalStateUnchanged=(await fs.readFile(originalState)).equals(originalBytes);assert(report.originalStateUnchanged,'Original user state remains byte-for-byte unchanged');pass('Original user state remains byte-for-byte unchanged');}
    report.observedPhases=await island.evaluate(()=>[...new Set(actionEvents.map(e=>e.phase))]);assert.deepEqual(report.errors,[]);report.passed=true;return report;
  }finally{
    await stop();await fs.writeFile(path.join(out,uiOnly?'completion-actions-native-ui-report.json':'completion-actions-native-report.json'),JSON.stringify(report,null,2)+'\n');
    const actual=await fs.realpath(profile),parent=await fs.realpath(out);if(path.dirname(actual).toLowerCase()===parent.toLowerCase()&&/^completion-[A-Za-z0-9]{6}$/.test(path.basename(actual)))await fs.rm(actual,{recursive:true,force:true,maxRetries:5,retryDelay:200});
  }
}
module.exports={headless,native};
if(require.main===module){syncFs.mkdirSync(out,{recursive:true});const index=process.argv.indexOf('--native');(index<0?headless():native(process.argv[index+1],process.argv.includes('--ui-only'))).then(result=>console.log(JSON.stringify(result,null,2))).catch(error=>{console.error(error);process.exitCode=1;});}
