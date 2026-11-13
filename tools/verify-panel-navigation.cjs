// Navigation regression uses an isolated headless document and captures IPC only.
const fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict');
async function run(){
 const root=path.resolve(__dirname,'..'),out=path.join(root,'tools/verify');
 const {chromium}=require(process.env.PLAYWRIGHT_MODULE||path.resolve(root,'../verify-tools/node_modules/playwright'));
 const [template,css,notifications,app]=await Promise.all(['index.html','styles.css','notifications.js','app.js'].map(name=>fs.readFile(path.join(root,'ui',name),'utf8')));
 const browser=await chromium.launch({headless:true,executablePath:process.env.BROWSER_EXE||'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
 const errors=[],checks=[],artifacts=[];
 const state={tasks:Array.from({length:12},(_,index)=>({id:'task-'+index,name:'Navigation task '+index,sec:1800,completionAction:{enabled:false,kind:'command',command:'',delaySec:10}})),current_id:'task-0',duration_sec:1800,settings:{showIdleClock:true,showIdleEyes:true,sound:false,notify:false,reduceMotion:true,topOffset:20},phone:{enabled:true,displaySeconds:8,hideContent:false,deviceAddress:'',deviceName:''}};
 const routes={timer:'settingsPage',webhook:'webhookPage',phone:'phonePage',preferences:'preferencesPage',create:'taskCreatePage',task:'taskSettingsPage'};
 const menu={timer:'btnOpenTimerPage',webhook:'btnOpenWebhookPage',phone:'btnOpenPhonePage',preferences:'btnOpenPreferencesPage'};
 async function makePage(viewport={width:560,height:660}){
  const page=await browser.newPage({viewport});page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(()=>{window.messages=[];window.ipc={postMessage(value){messages.push(JSON.parse(value));}};});await page.goto('about:blank');
  await page.setContent(template.replace('__VIEW__','panel').replace('/*__GEO__*/',JSON.stringify({dial:340,effect:580,pillW:132,pillH:38})).replace('/*__STATE__*/',JSON.stringify(state)).replace('/*__CSS__*/',()=>css).replace('/*__JS__*/',()=>(notifications+'\n'+app)));
  await page.evaluate(()=>__phoneStatus({supported:true,phase:'idle',message:'',devices:[]}));return page;
 }
 async function current(page,name){
  const id=routes[name],parent=['create','task'].includes(name)?'timer':name;
  await page.waitForFunction(id=>{const node=document.getElementById(id);return node?.getAttribute('aria-hidden')==='false'&&getComputedStyle(node).visibility==='visible';},id);
  assert.deepEqual(await page.locator('.panel-page[aria-hidden="false"]').evaluateAll(nodes=>nodes.map(node=>node.id)),[id]);
  assert.deepEqual(await page.locator('#panelNav [aria-current="page"]').evaluateAll(nodes=>nodes.map(node=>node.dataset.panelPage)),[parent]);
  for(const candidate of Object.values(routes))assert.equal(await page.locator('#'+candidate).evaluate(node=>node.inert),candidate!==id,candidate+' inert isolation');
  assert.equal(await page.locator('#btnTaskBack').isVisible(),['create','task'].includes(name));
 }
 async function focusOn(page,id){await page.waitForFunction(id=>document.activeElement.id===id,id,{timeout:1500});}
 async function go(page,name){const returning=name==='timer'&&await page.locator('#taskCreatePage[aria-hidden="false"],#taskSettingsPage[aria-hidden="false"]').count()>0;await page.locator('#'+menu[name]).click();await current(page,name);if(returning)await page.waitForFunction(()=>document.activeElement.matches('#btnOpenTaskPage,.task__edit'),null,{timeout:1500});else await focusOn(page,menu[name]);}
 const onlyNavigation=messages=>messages.every(message=>['pageReady','webhookStatus','relayStatus'].includes(message.type));
 try{
  if(!process.argv.includes('--layout-only')){
  const page=await makePage();await current(page,'timer');
  assert.equal(await page.locator('#panelNav button[data-panel-page]').count(),4);
  assert.equal(await page.locator('#settingsPage #completionActionSection').count(),0);
  assert.equal(await page.locator('#preferencesPage #inTopOffset').count(),1);
  assert.equal(await page.locator('#preferencesPage #notificationsSettings #notificationDisplaySeconds').count(),1);
  assert.equal(await page.locator('#notificationsPage,#btnOpenNotificationsPage').count(),0);
  assert.deepEqual(await page.locator('#panelNav [data-panel-page]').evaluateAll(nodes=>nodes.map(node=>node.dataset.panelPage)),['timer','webhook','phone','preferences']);
  checks.push('Timer, Webhook, phone and preferences are four top-level routes; notification controls belong to the preferences group, with one active accessible page and parent-aware navigation.');

  await page.fill('#inH','7');await go(page,'preferences');await page.fill('#inTopOffset','94');
  await page.fill('#notificationDisplaySeconds','12');await go(page,'timer');assert.equal(await page.inputValue('#inH'),'7');
  await page.locator('#btnOpenTaskPage').click();await current(page,'create');await focusOn(page,'inTaskName');
  await page.fill('#inTaskName','Navigation draft');await page.fill('#inTaskMin','2');await page.fill('#inTaskSec','7');await page.fill('#createActionCommand','Write-Output "draft only"');
  await go(page,'preferences');assert.equal(await page.inputValue('#notificationDisplaySeconds'),'12');assert.equal(await page.inputValue('#inTopOffset'),'94');
  await go(page,'timer');await page.locator('#btnOpenTaskPage').click();await current(page,'create');assert.equal(await page.inputValue('#inTaskName'),'Navigation draft');assert.equal(await page.inputValue('#inTaskSec'),'7');assert.equal(await page.inputValue('#createActionCommand'),'Write-Output "draft only"');
  await page.keyboard.press('Escape');await current(page,'timer');await focusOn(page,'btnOpenTaskPage');
  await page.locator('.task__edit').first().click();await current(page,'task');await focusOn(page,'editTaskMin');
  await page.fill('#editTaskMin','4');await page.fill('#actionCommand','Write-Output "task draft"');await go(page,'phone');await go(page,'timer');await page.locator('.task__edit').first().click();await current(page,'task');
  assert.equal(await page.inputValue('#editTaskMin'),'4');assert.equal(await page.inputValue('#actionCommand'),'Write-Output "task draft"');
  await page.locator('#btnTaskBack').click();await current(page,'timer');await page.waitForFunction(()=>document.activeElement.dataset.taskId==='task-0',null,{timeout:1500});
  await page.locator('.task__edit').first().click();await current(page,'task');await page.evaluate(s=>{document.getElementById('btnTaskBack').click();__applyState(s,false);},state);await current(page,'timer');await page.waitForFunction(()=>document.activeElement.matches('.task__edit')&&document.activeElement.dataset.taskId==='task-0',null,{timeout:1500});
  assert(onlyNavigation(await page.evaluate(()=>messages)),'Menu changes and unsaved form edits must not mutate timer, tasks or preferences.');
  checks.push('Timer, position, notification, new-task and task-edit drafts survive menu changes; Back and Escape restore the initiating control without sending mutation IPC.');

  for(const [route,id] of Object.entries(menu)){
   await go(page,route);await page.locator('#'+id).focus();
   for(let i=0;i<18;i++){await page.keyboard.press('Tab');assert.equal(await page.evaluate(()=>!!document.activeElement.closest('[inert], [aria-hidden="true"]')),false,'Tab never enters an inactive page');}
   const before=await page.evaluate(()=>messages.filter(message=>message.type==='hidePanel').length);await page.keyboard.press('Escape');assert.equal(await page.evaluate(()=>messages.filter(message=>message.type==='hidePanel').length),before+1);await current(page,route);
  }
  await go(page,'timer');await page.locator('#btnOpenTimerPage').focus();await page.keyboard.press('ArrowDown');await focusOn(page,'btnOpenWebhookPage');await current(page,'timer');
  await page.keyboard.press('Enter');await current(page,'webhook');await page.keyboard.press('ArrowDown');await focusOn(page,'btnOpenPhonePage');await page.keyboard.press('End');await focusOn(page,'btnOpenPreferencesPage');await page.keyboard.press('Space');await current(page,'preferences');await page.keyboard.press('Home');await focusOn(page,'btnOpenTimerPage');
  await go(page,'timer');await page.evaluate(()=>{document.getElementById('btnOpenTaskPage').click();document.getElementById('btnOpenPhonePage').click();});await current(page,'phone');await focusOn(page,'btnOpenPhonePage');await page.waitForTimeout(80);await focusOn(page,'btnOpenPhonePage');
  await go(page,'timer');
  const chosenFocus=await page.evaluate(async()=>{document.getElementById('btnOpenTaskPage').click();document.getElementById('inTaskSec').focus();await new Promise(requestAnimationFrame);return document.activeElement.id;});
  assert.equal(chosenFocus,'inTaskSec','Delayed route focus must preserve a user-selected input on the destination page');
  await page.keyboard.press('Control+A');await page.keyboard.insertText('-2');assert.equal(await page.inputValue('#inTaskName'),'Navigation draft');assert.equal(await page.inputValue('#inTaskSec'),'-2');
  await page.fill('#inTaskSec','7');await page.keyboard.press('Escape');await current(page,'timer');await focusOn(page,'btnOpenTaskPage');
  checks.push('Keyboard navigation changes focus independently, activates on Enter/Space, keeps Tab out of hidden pages and closes each root route on Escape; rapid switching cannot revive stale page focus.');

  await go(page,'timer');await page.locator('#btnOpenTaskPage').click();await page.locator('#btnAddTask').click();const request=await page.evaluate(()=>messages.filter(message=>message.type==='addTask').at(-1));assert(request?.requestId);
  await go(page,'phone');await page.evaluate(requestId=>__taskCreateResult({ok:true,taskId:'created',requestId,message:'Created'}),request.requestId);await current(page,'phone');await focusOn(page,'btnOpenPhonePage');assert.equal(await page.inputValue('#notificationDisplaySeconds'),'12');
  await go(page,'timer');await page.locator('#btnOpenTaskPage').click();assert.equal(await page.inputValue('#inTaskName'),'');assert.equal(await page.locator('#btnAddTask').isDisabled(),false);
  await go(page,'timer');await page.locator('.task__edit').first().click();await go(page,'preferences');await page.evaluate(s=>__applyState({...s,tasks:s.tasks.slice(1)},false),state);await current(page,'preferences');
  checks.push('Late creation acknowledgements and task-list broadcasts update state without stealing the selected menu or keyboard focus.');await page.close();
  }

  await fs.mkdir(out,{recursive:true});
  for(const viewport of [{width:560,height:660},{width:340,height:620},{width:560,height:420},{width:340,height:360}]){
   const layout=await makePage(viewport);
   for(const name of ['timer','webhook','phone','preferences','create','task']){
    if(name==='create'){await go(layout,'timer');await layout.locator('#btnOpenTaskPage').click();}
    else if(name==='task'){await go(layout,'timer');await layout.locator('.task__edit').first().click();}
    else await go(layout,name);
    await current(layout,name);
    const size=await layout.evaluate(id=>{const node=document.getElementById(id),nav=document.getElementById('panelNav'),box=node.getBoundingClientRect(),navBox=nav.getBoundingClientRect();return{scrollWidth:node.scrollWidth,clientWidth:node.clientWidth,docWidth:document.documentElement.scrollWidth,docHeight:document.documentElement.scrollHeight,box:{left:box.left,right:box.right,top:box.top,bottom:box.bottom},nav:{left:navBox.left,right:navBox.right,top:navBox.top,bottom:navBox.bottom},height:node.clientHeight};},routes[name]);
    assert(size.clientWidth>0&&size.height>40,JSON.stringify({viewport,name,size}));assert(size.scrollWidth<=size.clientWidth+1,JSON.stringify({viewport,name,size}));assert(size.docWidth<=viewport.width+1&&size.docHeight<=viewport.height+1,JSON.stringify({viewport,name,size}));
    assert(size.box.left>=0&&size.box.right<=viewport.width+1&&size.box.bottom<=viewport.height+1,JSON.stringify({viewport,name,size}));assert(size.nav.left>=0&&size.nav.right<=viewport.width+1&&size.nav.bottom<=viewport.height+1,JSON.stringify({viewport,name,size}));
    if((viewport.width===560&&viewport.height===660&&['timer','webhook','phone','preferences'].includes(name))||(viewport.width===340&&viewport.height===620&&['timer','create'].includes(name))){
     await layout.locator('#'+routes[name]).evaluate(node=>node.scrollTop=0);const topShot='panel-'+viewport.width+'x'+viewport.height+'-'+name+'-top.png';await layout.screenshot({path:path.join(out,topShot),omitBackground:true,animations:'disabled'});artifacts.push(topShot);
    }
    await layout.locator('#'+routes[name]).evaluate(node=>node.scrollTop=node.scrollHeight);
    const lastButton={timer:'#btnClear',phone:'#btnPhoneNotificationSettings',webhook:'#webhookPowerShellExample',preferences:'#btnTestNotification',create:'#btnAddTask',task:'#btnSaveAction'}[name];
    if(name==='webhook')await layout.locator(lastButton).evaluate(node=>{node.parentElement.open=true;});
    await layout.locator(lastButton).scrollIntoViewIfNeeded();
    const shot='panel-'+viewport.width+'x'+viewport.height+'-'+name+'.png';await layout.screenshot({path:path.join(out,shot),omitBackground:true,animations:'disabled'});artifacts.push(shot);
   }
   // Each route remembers its own scroll position without moving navigation.
   await go(layout,'timer');const scroll=await layout.locator('#settingsPage').evaluate(node=>{node.scrollTop=Math.min(60,node.scrollHeight-node.clientHeight);return node.scrollTop;});await go(layout,'preferences');await go(layout,'timer');assert.equal(await layout.locator('#settingsPage').evaluate(node=>node.scrollTop),scroll);
   await layout.close();
  }
  checks.push('All six views fit 560/340 px widths and short 420/360 px heights; page-local scrolling reaches final controls and survives switching, with screenshots.');
  assert.deepEqual(errors,[]);return{ok:true,checks,consoleErrors:errors,artifacts,scope:'Isolated headless UI and captured IPC; no real countdown or completion command executed.'};
 }finally{await browser.close();}
}
module.exports={run};
if(require.main===module)run().then(async result=>{await fs.writeFile(path.join(__dirname,'verify/panel-navigation-report.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));}).catch(error=>{console.error(error);process.exitCode=1;});
