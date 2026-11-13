/* Isolated Windows Relay bridge checks. No remote host, trusted TLS server or real user profile is used. */
const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),net=require('node:net');
const {spawn}=require('node:child_process'),{randomBytes}=require('node:crypto');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'D:/workDir/verify-tools/node_modules/playwright');
const root=path.resolve(__dirname,'..'),out=path.join(__dirname,'verify'),delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function free(port=0){const server=net.createServer();try{await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});return server.address().port;}catch{return null;}finally{if(server.listening)await new Promise(resolve=>server.close(resolve));}}
async function main(){
 await fs.mkdir(out,{recursive:true});const profile=await fs.mkdtemp(path.join(out,'relay-native-')),file=path.join(profile,'state.json');
 const exe=path.resolve(process.argv[2]||path.join(root,'target/verified/release/focus-island.exe')),key=randomBytes(32).toString('hex'),otherKey=randomBytes(32).toString('hex'),loopbackPort=await free(),serviceUrl='https://127.0.0.1:'+loopbackPort;
 const report={mode:'native',checks:[],errors:[],profile,exe,externalServerContacted:false,coverageLimit:'Real WebView/IPC, persistence and failed outbound HTTPS retries. Trusted TLS receipt and server HTTP acknowledgements require server deployment and are not claimed.'};
 const redact=value=>String(value).replace(/\b[0-9a-f]{64}\b/gi,'[redacted credential]');
 const pass=name=>{report.checks.push(name);console.log('PASS',name);};
 const userPath=path.join(process.env.APPDATA,'FocusIsland/state.json'),userBefore=await fs.readFile(userPath).catch(()=>null);
 const fixture={tasks:[{id:'relay-timer',name:'Relay 独立验证',sec:120,completionAction:{enabled:false,kind:'command',command:'',delaySec:10}}],current_id:'relay-timer',duration_sec:120,settings:{sound:false,notify:false,showIdleClock:true,showIdleEyes:false,reduceMotion:true,alwaysOnTop:true,topOffset:20},notifications:{enabled:true,displaySeconds:5,listLimit:5},phone:{enabled:false}};
 await fs.writeFile(file,JSON.stringify(fixture));const untouched=await fs.readFile(file);
 let child,browser,island,panel,spy,attempts=0,launches=0;
 const send=(page,value)=>page.evaluate(value=>ipc.postMessage(JSON.stringify(value)),value);
 const click=(page,id)=>page.locator('#'+id).evaluate(node=>node.click());
 async function hooks(page){
  page.on('pageerror',error=>report.errors.push(redact(error.message)));await page.waitForFunction(()=>typeof __relayConfigResult==='function');
  await page.evaluate(()=>{
   window.relayConfigEvents=[];window.relayStatusEvents=[];window.timerEvents=[];window.privateRelayCallback=false;
   window.publicRelaySecretSeen=['connectionKey','webhookToken'].some(name=>Object.prototype.hasOwnProperty.call(__STATE__?.relay||{},name));
   const status=__relayStatus,config=__relayConfigResult,apply=__applyState,timer=__applyTimer;
   window.__relayStatus=value=>{relayStatusEvents.push({phase:value.phase,settings:value.settings,hasConnectionKey:value.hasConnectionKey,hasToken:!!value.webhookToken});if(value.webhookToken||value.connectionKey)privateRelayCallback=true;status(value);};
   window.__relayConfigResult=value=>{relayConfigEvents.push({ok:value.ok,requestId:value.requestId,settings:value.settings,hasConnectionKey:value.hasConnectionKey});if(value.webhookToken||value.connectionKey)privateRelayCallback=true;config(value);};
   window.__applyState=(value,reset)=>{if(['connectionKey','webhookToken'].some(name=>Object.prototype.hasOwnProperty.call(value?.relay||{},name)))publicRelaySecretSeen=true;apply(value,reset);};
   if(timer)window.__applyTimer=value=>{timerEvents.push(value);timer(value);};
  });
 }
 async function open(){
  assert(await free(9484),'isolated CDP port is available');launches++;
  child=spawn(exe,['--debug-port','9484','--data-dir',profile,'--log-file',path.join(profile,'native-'+launches+'.log'),'--verbose'],{cwd:root,windowsHide:true});
  child.on('error',error=>report.errors.push(redact(error.message)));browser=island=panel=null;
  for(let i=0;i<100&&!browser;i++){try{browser=await chromium.connectOverCDP('http://127.0.0.1:9484');}catch{await delay(200);}}
  assert(browser,'native CDP starts');
  for(let i=0;i<80&&(!island||!panel);i++){for(const context of browser.contexts())for(const page of context.pages()){const view=await page.evaluate(()=>document.body?.dataset.view).catch(()=>null);if(view==='island')island=page;else if(view==='panel')panel=page;}if(!island||!panel)await delay(100);}
  assert(island&&panel,'native views exist');for(const page of [island,panel])await hooks(page);
  await send(island,{type:'togglePanel'});await click(panel,'btnOpenWebhookPage');await panel.waitForFunction(()=>relayStatusEvents.length>0);
 }
 async function close(){
  if(island&&!island.isClosed())await send(island,{type:'quit'}).catch(()=>{});
  for(let i=0;i<50&&child&&child.exitCode===null;i++)await delay(100);
  if(child&&child.exitCode===null){child.kill();await delay(250);}
  if(browser)await browser.close().catch(()=>{});browser=island=panel=null;
  for(let i=0;i<30&&!await free(9484);i++)await delay(100);
 }
 async function configure({enabled=false,url=serviceUrl,connectionKey=''}={}){
  await panel.evaluate(({enabled,url,connectionKey})=>{
   const checkbox=document.getElementById('relayEnabled');checkbox.checked=enabled;checkbox.dispatchEvent(new Event('change',{bubbles:true}));
   for(const [id,value]of [['relayServiceUrl',url],['relayConnectionKey',connectionKey]]){const input=document.getElementById(id);input.value=value;input.dispatchEvent(new Event('input',{bubbles:true}));}
  },{enabled,url,connectionKey});
  const before=await panel.evaluate(()=>relayConfigEvents.length);await click(panel,'btnSaveRelay');
  await panel.waitForFunction(before=>relayConfigEvents.length>before,before,{timeout:8000});return panel.evaluate(()=>relayConfigEvents.at(-1));
 }
 async function timer(){
  const before=await panel.evaluate(()=>timerEvents.length);await island.evaluate(()=>__fromRust('syncTimer'));await panel.waitForFunction(before=>timerEvents.length>before,before);return panel.evaluate(()=>timerEvents.at(-1));
 }
 async function privacy(){
  for(const page of [panel,island])assert.equal(await page.evaluate(()=>publicRelaySecretSeen),false,'ordinary state omits secret fields');
  assert.equal(await island.evaluate(()=>privateRelayCallback),false,'island has no private credential callbacks');
  for(const secret of [key,otherKey])assert(!(await island.content()).includes(secret),'island HTML excludes stored credentials');
  assert.equal(await island.inputValue('#relayConnectionKey'),'');assert.equal(await island.inputValue('#relayEndpoint'),'');
 }
 try{
  await open();assert((await fs.readFile(file)).equals(untouched),'untouched startup does not persist defaults');
  assert.equal(await panel.locator('#relayEnabled').isChecked(),false);assert.equal(await panel.locator('#webhookEnabled').isChecked(),false);
  let result=await configure({connectionKey:key});assert.equal(result.ok,true);assert.equal(result.hasConnectionKey,true);
  let stored=JSON.parse(await fs.readFile(file,'utf8'));assert(stored.relay.connectionKey===key,'disabled configuration stores credential');assert.equal(stored.relay.enabled,false);assert.equal(stored.relay.serviceUrl,serviceUrl);
  assert.equal(stored.tasks[0].completionAction.enabled,false);assert.equal(await panel.inputValue('#relayConnectionKey'),'');assert.match(await panel.getAttribute('#relayConnectionKey','placeholder'),/已保存/);
  await privacy();await panel.screenshot({path:path.join(out,'relay-native-disabled.png'),omitBackground:true});
  pass('Real UI saves disabled HTTPS configuration and a hidden connection key without enabling the local listener or leaking secrets to state/island.');
  await close();await open();assert.equal(await panel.inputValue('#relayConnectionKey'),'');assert.match(await panel.getAttribute('#relayConnectionKey','placeholder'),/已保存/);assert.equal(await panel.locator('#relayEnabled').isChecked(),false);await privacy();
  pass('Restart restores has-key state and HTTPS service address while the password input remains empty and the connection stays disabled.');

  const originalBytes=await fs.readFile(file),backup=path.join(profile,'saved-state.json');await fs.rename(file,backup);await fs.mkdir(file);
  try{
   result=await configure({url:'https://127.0.0.1:'+await free(),connectionKey:otherKey});assert.equal(result.ok,false);
   assert((await fs.readFile(backup)).equals(originalBytes),'failed save leaves old bytes');assert((await panel.inputValue('#relayConnectionKey'))===otherKey,'failed save keeps key draft');
   assert.match(await panel.textContent('#relayConfigNote'),/失败|保存/);
  }finally{await fs.rmdir(file);await fs.rename(backup,file);}
  result=await configure({connectionKey:''});assert.equal(result.ok,true);stored=JSON.parse(await fs.readFile(file,'utf8'));assert(stored.relay.connectionKey===key,'blank same-server key retains saved secret');
  const beforeInvalid=await panel.evaluate(()=>relayConfigEvents.length),invalidRequest=Date.now()+10000;
  await send(panel,{type:'relayConfigure',settings:{enabled:true,serviceUrl:'https://127.0.0.1:'+await free()},requestId:invalidRequest});
  await panel.waitForFunction(before=>relayConfigEvents.length>before,beforeInvalid);assert.equal(await panel.evaluate(()=>relayConfigEvents.at(-1).ok),false);
  assert((await fs.readFile(file)).equals(originalBytes),'server switch without key cannot persist');
  pass('Persistence failures retain old settings and editable key drafts; blank keys preserve the same server, while native IPC rejects a server switch without a fresh key.');

  await send(island,{type:'toggleTimer'});await panel.waitForFunction(()=>timerEvents.at(-1)?.running);const runningBefore=await timer();
  result=await configure({enabled:true});assert.equal(result.ok,true);
  await panel.waitForFunction(()=>document.getElementById('relayPhase').dataset.phase==='error',null,{timeout:12000});
  assert.equal(await panel.inputValue('#relayEndpoint'),'');assert.equal(await panel.locator('#btnCopyRelayEndpoint').isDisabled(),true);
  spy=net.createServer(socket=>{attempts++;socket.destroy();});await new Promise((resolve,reject)=>{spy.once('error',reject);spy.listen(loopbackPort,'127.0.0.1',resolve);});
  for(let i=0;i<150&&attempts<2;i++)await delay(100);
  assert(attempts>=2,'failed outbound HTTPS reconnects without manual retry');const runningAfter=await timer();
  assert.equal(runningAfter.runId,runningBefore.runId);assert.equal(runningAfter.running,true);assert(runningAfter.remainingMs<runningBefore.remainingMs-1000,'countdown advances during connection failures');
  assert.equal((await island.evaluate(()=>__notificationState())).count,0);await privacy();await panel.screenshot({path:path.join(out,'relay-native-error.png'),omitBackground:true});
  pass('Loopback HTTPS connection refusal displays an error and automatically retries, while the same countdown keeps running and no notification is fabricated.');

  result=await configure({enabled:false});assert.equal(result.ok,true);await panel.waitForFunction(()=>document.getElementById('relayPhase').dataset.phase==='disabled');
  const stoppedAttempts=attempts;await delay(9000);assert.equal(attempts,stoppedAttempts,'disabled relay does not retry at the next backoff interval');
  await send(island,{type:'toggleTimer'});await panel.waitForFunction(()=>timerEvents.at(-1)?.started&&!timerEvents.at(-1)?.running);const paused=await timer();
  pass('Disabling the connection stops subsequent retry attempts and preserves independent timer control.');

  const event={deliveryId:'1'.repeat(64),notification:{type:'posted',source:'webhook',id:'native-relay-receipt',app:'Relay verification',title:'Receipt test',body:'Isolated receipt check'}};
  const accepted=await island.evaluate(value=>Boolean(window.__relayNotification&&window.__relayNotification(value)),event);assert.strictEqual(accepted,true);
  assert.strictEqual(await island.evaluate(value=>Boolean(window.__relayNotification&&window.__relayNotification(value)),event),true);
  assert.equal((await island.evaluate(()=>__notificationState())).count,1);
  assert.strictEqual(await panel.evaluate(value=>Boolean(window.__relayNotification&&window.__relayNotification(value)),event),false);
  assert.strictEqual(await island.evaluate(()=>Boolean(window.__relayNotification&&window.__relayNotification({deliveryId:'invalid',notification:null}))),false);
  const configBefore=await panel.evaluate(()=>relayConfigEvents.length);
  await send(island,{type:'relayConfigure',settings:{enabled:true,serviceUrl,connectionKey:key},requestId:Date.now()+20000});await send(island,{type:'relayStatus'});
  await delay(150);assert.equal(await panel.evaluate(()=>relayConfigEvents.length),configBefore);assert.equal(JSON.parse(await fs.readFile(file,'utf8')).relay.enabled,false);
  const pausedAfter=await timer();for(const name of ['runId','taskId','running','started','done','remainingMs','totalMs'])assert.equal(pausedAfter[name],paused[name]);
  pass('Actual WebView receipt returns boolean true once and on duplicates without replay, false for invalid/panel input; island IPC cannot configure credentials and timer facts remain unchanged.');

  await privacy();await close();assert(await free(9484),'shutdown releases debug listener');
  if(spy){await new Promise(resolve=>spy.close(resolve));spy=null;}assert(await free(loopbackPort),'isolated loopback port released');
  for(let i=1;i<=launches;i++){const log=await fs.readFile(path.join(profile,'native-'+i+'.log'),'utf8');assert(!log.includes(key)&&!log.includes(otherKey),'logs omit credentials');assert(!log.includes(event.notification.body),'logs omit test notification body');assert(!log.includes('FRONTEND ERROR')&&!log.includes('FATAL:'),'native logs contain no fatal/frontend errors');}
  assert.deepEqual(report.errors,[]);pass('Both isolated app launches shut down cleanly and their logs contain no credentials or notification body.');
 }catch(error){report.errors.push(redact(error.stack||error));}
 finally{
  await close().catch(error=>report.errors.push(redact(error.message)));if(spy)await new Promise(resolve=>spy.close(resolve)).catch(()=>{});
  const after=await fs.readFile(userPath).catch(()=>null);report.userProfileUnchanged=(!userBefore&&!after)||!!(userBefore&&after&&userBefore.equals(after));if(!report.userProfileUnchanged)report.errors.push('Real user profile changed');
  report.passed=report.errors.length===0;await fs.writeFile(path.join(out,'relay-native-report.json'),JSON.stringify(report,null,2));
 }
 if(!report.passed)throw new Error(report.errors.join('\n'));return report;
}
main().then(report=>console.log(JSON.stringify(report,null,2))).catch(error=>{console.error(error.message);process.exitCode=1;});
