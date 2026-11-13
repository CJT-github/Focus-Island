/* Real Windows WebView + loopback HTTP integration, using an isolated profile only.
   Reports never include credentials, secret URLs, request bodies or notification text. */
const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),http=require('node:http'),net=require('node:net');
const {spawn}=require('node:child_process');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'D:/workDir/verify-tools/node_modules/playwright');
const root=path.resolve(__dirname,'..'),out=path.join(__dirname,'verify'),delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function boundServer(){const server=net.createServer(socket=>socket.destroy());await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});return server;}
async function availablePort(){const server=await boundServer(),port=server.address().port;await new Promise(resolve=>server.close(resolve));return port;}
async function portIsFree(port){const server=net.createServer();try{await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});return true;}catch{return false;}finally{if(server.listening)await new Promise(resolve=>server.close(resolve));}}
async function main(){
 await fs.mkdir(out,{recursive:true});
 const profile=await fs.mkdtemp(path.join(out,'webhook-native-')),stateFile=path.join(profile,'state.json');
 const exe=path.resolve(process.argv[2]||path.join(root,'target/verified/release/focus-island.exe'));
 const report={mode:'native',httpTransport:'actual loopback HTTP',checks:[],errors:[],profile,exe,publicServerDeployed:false};
 const pass=name=>{report.checks.push({name});console.log('PASS',name);};
 const redactions=new Set();let activeToken='',oldToken='',port=await availablePort(),launchCount=0,child,browser,island,panel,occupied;
 const redact=value=>{
  let result=String(value).replace(/\b[0-9a-f]{64}\b/gi,'[redacted credential]');
  for(const entry of redactions)if(entry)result=result.split(entry).join('[redacted content]');
  return result;
 };
 const userPath=path.join(process.env.APPDATA,'FocusIsland/state.json'),userBefore=await fs.readFile(userPath).catch(()=>null);
 const fixture={tasks:[{id:'webhook-test',name:'Webhook 独立验证',sec:120,completionAction:{enabled:false,kind:'command',command:'',delaySec:10}}],
  current_id:'webhook-test',duration_sec:120,settings:{showHands:true,showSecond:true,showIdleEyes:false,showIdleClock:true,sound:false,notify:false,alwaysOnTop:true,reduceMotion:false,topOffset:20},
  phone:{enabled:false,displaySeconds:8,hideContent:false,deviceAddress:'',deviceName:''},notifications:{enabled:true,displaySeconds:5,listLimit:5}};
 await fs.writeFile(stateFile,JSON.stringify(fixture));
 const initialBytes=await fs.readFile(stateFile);
 const send=(page,value)=>page.evaluate(payload=>window.ipc.postMessage(JSON.stringify(payload)),value);
 const notice=()=>island.evaluate(()=>window.__notificationState());
 const waitCount=count=>island.waitForFunction(count=>window.__notificationState()?.count===count,count,{timeout:5000});
 const waitMode=mode=>island.waitForFunction(mode=>window.__notificationState()?.mode===mode&&window.__notificationState()?.renderedMode===mode,mode,{timeout:5000});
 async function installHooks(page){
  await page.waitForFunction(()=>typeof window.__webhookConfigResult==='function');
  page.on('pageerror',error=>report.errors.push(redact(error.message)));
  await page.evaluate(()=>{
   window.webhookConfigEvents=[];window.webhookStatusEvents=[];window.webhookTestEvents=[];window.notificationConfigEvents=[];window.timerEvents=[];window.incomingEvents=[];
   window.publicStateHasToken=Object.prototype.hasOwnProperty.call(window.__STATE__?.webhook||{},'token');
   window.webhookCredentialCallbackSeen=false;
   const config=window.__webhookConfigResult,status=window.__webhookStatus,test=window.__webhookTestResult,notificationConfig=window.__notificationsConfigResult;
   const apply=window.__applyState,timer=window.__applyTimer,incoming=window.__notificationEvent;
   window.__webhookConfigResult=value=>{webhookConfigEvents.push({ok:value.ok,requestId:value.requestId,settings:value.settings,message:value.message});if(value.token)webhookCredentialCallbackSeen=true;config(value);};
   window.__webhookStatus=value=>{webhookStatusEvents.push({phase:value.phase,settings:value.settings,acceptedCount:value.acceptedCount,hasToken:Object.prototype.hasOwnProperty.call(value,'token')});if(value.token)webhookCredentialCallbackSeen=true;status(value);};
   window.__webhookTestResult=value=>{webhookTestEvents.push({ok:value.ok,requestId:value.requestId,message:value.message});test(value);};
   window.__notificationsConfigResult=value=>{notificationConfigEvents.push({ok:value.ok,settings:value.settings});notificationConfig(value);};
   window.__applyState=(value,reset)=>{if(Object.prototype.hasOwnProperty.call(value?.webhook||{},'token'))publicStateHasToken=true;apply(value,reset);};
   if(timer)window.__applyTimer=value=>{timerEvents.push(value);timer(value);};
   window.__notificationEvent=value=>{incomingEvents.push({type:value.type,source:value.source,id:value.id});incoming(value);};
  });
 }
 async function openApp(){
  assert(await portIsFree(9483),'isolated CDP port must be available');
  launchCount++;
  child=spawn(exe,['--debug-port','9483','--data-dir',profile,'--log-file',path.join(profile,'native-'+launchCount+'.log'),'--verbose'],{cwd:root,windowsHide:true});
  child.on('error',error=>report.errors.push(redact(error.message)));
  browser=island=panel=null;
  for(let i=0;i<100&&!browser;i++){try{browser=await chromium.connectOverCDP('http://127.0.0.1:9483');}catch{await delay(200);}}
  assert(browser,'native CDP starts');
  for(let i=0;i<100&&(!island||!panel);i++){
   for(const context of browser.contexts())for(const page of context.pages()){
    const view=await page.evaluate(()=>document.body?.dataset.view).catch(()=>null);
    if(view==='island')island=page;else if(view==='panel')panel=page;
   }
   if(!island||!panel)await delay(100);
  }
  assert(island&&panel,'both native views exist');
  for(const page of [island,panel])await installHooks(page);
  await send(island,{type:'togglePanel'});await panel.locator('#btnOpenWebhookPage').click();
  await panel.waitForFunction(()=>webhookStatusEvents.length>0);
  if(await panel.locator('#webhookLocal').count())await panel.locator('#webhookLocal').evaluate(node=>{node.open=true;});
 }
 async function closeApp(){
  if(island&&!island.isClosed())await send(island,{type:'quit'}).catch(()=>{});
  for(let i=0;i<30&&child&&child.exitCode===null;i++)await delay(100);
  if(child&&child.exitCode===null){child.kill();await delay(250);}
  if(browser)await browser.close().catch(()=>{});
  browser=island=panel=null;
  for(let i=0;i<30&&!await portIsFree(9483);i++)await delay(100);
 }
 async function status(){
  const before=await panel.evaluate(()=>webhookStatusEvents.length);await send(panel,{type:'webhookStatus'});
  await panel.waitForFunction(before=>webhookStatusEvents.length>before,before);
  return panel.evaluate(()=>webhookStatusEvents.at(-1));
 }
 async function saveUI({enabled=true,targetPort=port,scope='local',publicBaseUrl=''}={}){
  await panel.evaluate(({targetPort,publicBaseUrl})=>{for(const [id,value]of [['webhookPort',String(targetPort)],['webhookPublicBaseUrl',publicBaseUrl]]){const input=document.getElementById(id);input.value=value;input.dispatchEvent(new Event('input',{bubbles:true}));}},{targetPort,publicBaseUrl});
  if(await panel.locator('#webhookEnabled').isChecked()!==enabled)await panel.locator('label.switch:has(#webhookEnabled)').click();
  await panel.locator(scope==='local'?'#webhookScopeLocal':'#webhookScopeLan').click();
  const before=await panel.evaluate(()=>webhookConfigEvents.length);
  await panel.locator('#btnSaveWebhook').click();
  await panel.waitForFunction(before=>webhookConfigEvents.length>before,before,{timeout:8000});
  return panel.evaluate(()=>webhookConfigEvents.at(-1));
 }
 async function notificationConfig(enabled){
  const before=await panel.evaluate(()=>notificationConfigEvents.length);
  await send(panel,{type:'notificationsConfigure',settings:{enabled,displaySeconds:5,listLimit:5}});
  await panel.waitForFunction(before=>notificationConfigEvents.length>before,before);
  assert((await panel.evaluate(()=>notificationConfigEvents.at(-1))).ok,'notification configuration persisted');
 }
 async function timer(){
  const before=await panel.evaluate(()=>timerEvents.length);
  await island.evaluate(()=>__fromRust('syncTimer'));
  await panel.waitForFunction(before=>timerEvents.length>before,before);
  return panel.evaluate(()=>timerEvents.at(-1));
 }
 async function post(payload,options={}){
  if(typeof payload==='object'&&payload){if(typeof payload.body==='string')redactions.add(payload.body);if(typeof payload.content?.text==='string')redactions.add(payload.content.text);}
  const bytes=Buffer.from(typeof payload==='string'?payload:JSON.stringify(payload));
  const targetPath=options.path||('/api/webhook/'+activeToken);
  const headers={'Content-Type':'application/json','Content-Length':bytes.length,'Connection':'close',...options.headers};
  if(options.bearer)headers.Authorization='Bearer '+(options.token||activeToken);
  return new Promise((resolve,reject)=>{
   const request=http.request({host:'127.0.0.1',port:options.port||port,path:targetPath,method:'POST',headers},response=>{
    const chunks=[];response.on('data',chunk=>chunks.push(chunk));response.on('end',()=>{
     let value;try{value=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{value=null;}
     resolve({status:response.statusCode,value});
    });
   });
   request.on('error',reject);request.setTimeout(4000,()=>request.destroy(new Error('loopback HTTP request timed out')));request.end(bytes);
  });
 }
 async function checkNoCredentialLeak(){
  for(const page of [island,panel])assert.equal(await page.evaluate(()=>publicStateHasToken),false,'ordinary state never carries a credential field');
  assert.equal(await island.evaluate(()=>webhookCredentialCallbackSeen),false,'island never receives panel-only credentials');
  const html=await island.content();
  for(const token of [activeToken,oldToken])if(token)assert(!html.includes(token),'island HTML never embeds credentials');
  assert.equal(await island.locator('#webhookToken').inputValue(),'');
 }
 try{
  await openApp();assert((await fs.readFile(stateFile)).equals(initialBytes),'startup must not mutate an untouched profile');
  assert.equal(await panel.locator('#webhookPort').inputValue(),'17891');assert.equal(await panel.locator('#webhookEnabled').isChecked(),false);
  let configured=await saveUI({publicBaseUrl:'https://saved.example.test'});assert(configured.ok,'real UI enables service');
  await panel.waitForFunction(()=>document.getElementById('webhookPhase').dataset.phase==='listening');
  activeToken=await panel.locator('#webhookToken').inputValue();assert(/^[0-9a-f]{64}$/.test(activeToken),'native creates a random 64-hex token');redactions.add(activeToken);
  let saved=JSON.parse(await fs.readFile(stateFile,'utf8'));
  assert(saved.webhook.token===activeToken,'token persists');assert.equal(saved.webhook.port,port);assert.equal(saved.webhook.publicBaseUrl,'https://saved.example.test');
  assert.equal(saved.tasks[0].completionAction.enabled,false);assert.equal(saved.tasks[0].id,fixture.tasks[0].id);
  await checkNoCredentialLeak();
  await panel.waitForFunction(()=>webhookStatusEvents.some(event=>event.phase==='listening'&&!event.hasToken),null,{timeout:2500});
  assert((await panel.locator('#webhookToken').inputValue())===activeToken,'periodic redacted status does not erase panel token');
  assert.equal(await panel.locator('#webhookEndpoint').getAttribute('type'),'password');
  await panel.locator('#webhookPage').evaluate(node=>{node.scrollTop=0;});
  await panel.screenshot({path:path.join(out,'webhook-settings-native.png'),omitBackground:true});
  pass('Real UI enables isolated loopback service, generates credentials and preserves them across redacted status broadcasts without island/state leakage');

  let response=await post({msg_type:'text',id:'feishu-first',app:'构建服务',content:{text:'自动构建已完成，安装包已准备好。'}});
  assert.equal(response.status,202);assert.equal(response.value?.code,0);await waitCount(1);await waitMode('preview');
  assert((await notice()).items[0].source==='webhook','transport owns the notification source');
  assert((await notice()).items[0].body==='自动构建已完成，安装包已准备好。','Feishu text reaches notification body');
  await island.waitForFunction(()=>document.getElementById('noticeCompanion').dataset.phase==='settled');
  await island.screenshot({path:path.join(out,'webhook-preview-native.png'),omitBackground:true});
  response=await post({id:'generic',app:'Build',title:'Generic message',body:'native-generic-body'},{path:'/api/webhook',bearer:true});assert.equal(response.status,202);await waitCount(2);
  response=await post({id:'generic',title:'Updated message',body:'native-updated-body'},{path:'/api/webhook',bearer:true});assert.equal(response.status,202);
  await island.waitForFunction(()=>__notificationState().items.some(item=>item.id==='generic'&&item.title==='Updated message'));assert.equal((await notice()).count,2);
  response=await post({type:'removed',id:'generic'},{path:'/api/webhook',bearer:true});assert.equal(response.status,202);await waitCount(1);
  pass('Secret URL accepts Feishu text over HTTP; Bearer endpoint delivers generic JSON, updates equal IDs and removes messages');

  await send(island,{type:'toggleTimer'});await panel.waitForFunction(()=>timerEvents.at(-1)?.running);
  await delay(200);await send(island,{type:'toggleTimer'});await panel.waitForFunction(()=>timerEvents.at(-1)?.started&&!timerEvents.at(-1)?.running);
  const paused=await timer(),countBefore=(await notice()).count;
  const rejected=[
   [{title:'No credential'},{path:'/api/webhook'},401],
   [{title:'Wrong path'},{path:'/other'},404],
   [{title:'Wrong credential'},{path:'/api/webhook/'+(activeToken[0]==='f'?'e':'f').repeat(64)},401],
   [{title:'Origin blocked'},{headers:{Origin:'https://example.test'}},400],
   [{title:'Command forbidden',command:'never execute'}, {},400],
   [{body:'x'.repeat(17000)}, {},413]
  ];
  for(const [index,[payload,options,expected]]of rejected.entries()){try{assert.equal((await post(payload,options)).status,expected);}catch(error){report.errors.push('HTTP rejection case '+index+' failed: '+redact(error.message));}}
  await delay(150);assert.equal((await notice()).count,countBefore);
  const afterRejected=await timer();for(const key of ['runId','taskId','running','done','started','remainingMs','totalMs'])assert.equal(afterRejected[key],paused[key],key+' unchanged by rejected HTTP');
  pass('Unauthenticated, invalid-path, Origin, command-bearing and oversized requests are rejected without messages or timer changes');

  await panel.locator('#btnTestWebhook').scrollIntoViewIfNeeded();
  const testBefore=await panel.evaluate(()=>webhookTestEvents.length),receivedBefore=(await notice()).count,acceptedBefore=(await status()).acceptedCount;
  await panel.locator('#btnTestWebhook').click();
  await panel.waitForFunction(before=>webhookTestEvents.length>before,testBefore,{timeout:6000});assert((await panel.evaluate(()=>webhookTestEvents.at(-1))).ok,'test callback confirms HTTP success');
  await waitCount(receivedBefore+1);assert((await status()).acceptedCount>acceptedBefore,'native test traverses HTTP acceptance counter');
  pass('Test button traverses actual authenticated HTTP and reaches the common notification queue');

  const savedBytes=await fs.readFile(stateFile),backup=path.join(profile,'state-preserved.json'),preparedPort=await availablePort();
  await fs.rename(stateFile,backup);await fs.mkdir(stateFile);
  try{
   configured=await saveUI({targetPort:preparedPort,publicBaseUrl:'https://rejected.example.test'});
   assert.equal(configured.ok,false);assert((await fs.readFile(backup)).equals(savedBytes),'failed save preserves saved bytes');
   assert((await panel.locator('#webhookToken').inputValue())===activeToken,'failed save preserves token');
   assert.equal(await panel.locator('#webhookPort').inputValue(),String(preparedPort),'failed UI save keeps draft');
   assert.equal(await panel.locator('#webhookPublicBaseUrl').inputValue(),'https://rejected.example.test');
   assert.equal((await post({id:'after-save-failure',title:'Still active'})).status,202);
   assert(await portIsFree(preparedPort),'prepared replacement listener rolls back');
   const live=await status();assert.equal(live.settings.port,port);assert.equal(live.settings.publicBaseUrl,'https://saved.example.test');
  }finally{await fs.rmdir(stateFile);await fs.rename(backup,stateFile);}
  occupied=await boundServer();const occupiedPort=occupied.address().port;
  configured=await saveUI({targetPort:occupiedPort,publicBaseUrl:'https://occupied.example.test'});
  assert.equal(configured.ok,false);assert((await fs.readFile(stateFile)).equals(savedBytes),'occupied port cannot commit configuration');
  assert((await panel.locator('#webhookToken').inputValue())===activeToken,'bind failure preserves token');
  assert.equal((await post({id:'after-bind-failure',title:'Old service active'})).status,202);
  await new Promise(resolve=>occupied.close(resolve));occupied=null;
  pass('Persistence and port-bind failures preserve old listener, credentials and public URL, while keeping editable UI drafts');

  await panel.locator('.webhook-advanced').evaluate(node=>{node.open=true;});
  const rotationBefore=await panel.evaluate(()=>webhookConfigEvents.length);
  await panel.locator('#btnRotateWebhookToken').click();
  await panel.waitForFunction(before=>webhookConfigEvents.length>before,rotationBefore);
  assert((await panel.evaluate(()=>webhookConfigEvents.at(-1))).ok,'rotation succeeds');
  oldToken=activeToken;activeToken=await panel.locator('#webhookToken').inputValue();redactions.add(activeToken);
  assert(/^[0-9a-f]{64}$/.test(activeToken)&&activeToken!==oldToken,'rotation produces a new credential');
  assert.equal((await post({title:'Old secret URL'},{path:'/api/webhook/'+oldToken})).status,401);
  assert.equal((await post({title:'Old Bearer'},{path:'/api/webhook',bearer:true,token:oldToken})).status,401);
  assert.equal((await post({id:'rotated',title:'New URL active'})).status,202);
  assert.equal(await panel.locator('#webhookToken').getAttribute('type'),'password');
  await checkNoCredentialLeak();
  pass('Rotation invalidates old secret URLs and Bearer tokens immediately; the new URL succeeds and remains masked');

  await notificationConfig(false);await waitCount(0);
  assert.equal((await post({id:'display-disabled',title:'Do not retain'})).status,503);assert.equal((await notice()).count,0);
  await notificationConfig(true);
  assert.equal((await post({id:'after-reenable',title:'Display enabled'})).status,202);await waitCount(1);
  pass('Notification display disabled returns HTTP 503 and retains nothing; re-enabling accepts fresh messages');

  const persisted=await fs.readFile(stateFile,'utf8');
  for(const value of redactions)if(value!==activeToken&&value!==oldToken)assert(!persisted.includes(value),'notification bodies are never persisted');
  saved=JSON.parse(persisted);assert(saved.webhook.token===activeToken,'rotated credential persists');assert.equal(saved.webhook.publicBaseUrl,'https://saved.example.test');
  await closeApp();assert(await portIsFree(port),'shutdown releases HTTP listener');
  await openApp();await panel.waitForFunction(()=>webhookStatusEvents.at(-1)?.phase==='listening');
  assert((await panel.locator('#webhookToken').inputValue())===activeToken,'restart reloads credential');
  assert.equal((await notice()).count,0,'restart never replays old notifications');await checkNoCredentialLeak();
  assert.equal((await post({id:'after-restart',msg_type:'text',content:{text:'重启后连接正常。'}})).status,202);await waitCount(1);
  pass('Restart restores the isolated enabled listener and rotated credential without replaying messages; fresh HTTP still delivers');
  await closeApp();assert(await portIsFree(port),'final shutdown releases HTTP listener');
  for(let i=1;i<=launchCount;i++){
   const log=await fs.readFile(path.join(profile,'native-'+i+'.log'),'utf8');
   for(const value of redactions)assert(!log.includes(value),'diagnostic logs exclude notification text and credentials');
   assert(!log.includes('FRONTEND ERROR')&&!log.includes('FATAL:'),'native log has no fatal/frontend errors');
  }
  assert.deepEqual(report.errors,[]);pass('Both app shutdowns release the port; diagnostic logs omit credentials and payload text');
 }catch(error){report.errors.push(redact(error.stack||error));}
 finally{
  if(occupied)await new Promise(resolve=>occupied.close(resolve)).catch(()=>{});
  await closeApp().catch(error=>report.errors.push(redact(error.message)));
  const userAfter=await fs.readFile(userPath).catch(()=>null);
  report.userProfileUnchanged=(!userBefore&&!userAfter)||!!(userBefore&&userAfter&&userBefore.equals(userAfter));
  if(!report.userProfileUnchanged)report.errors.push('User profile changed');
  report.passed=report.errors.length===0;
  await fs.writeFile(path.join(out,'webhook-native-report.json'),JSON.stringify(report,null,2));
 }
 if(!report.passed)throw new Error(report.errors.join('\n'));
 return report;
}
main().then(report=>console.log(JSON.stringify(report,null,2))).catch(error=>{console.error(error.message);process.exitCode=1;});
