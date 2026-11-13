/* HTTPS relay UI contracts. Credentials are fixtures; no real server is contacted. */
const fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict');
async function run(){
 const root=path.resolve(__dirname,'..'),out=path.join(__dirname,'verify');
 const {chromium}=require(process.env.PLAYWRIGHT_MODULE||path.resolve(root,'../verify-tools/node_modules/playwright'));
 const [template,css,notifications,app]=await Promise.all(['index.html','styles.css','notifications.js','app.js'].map(name=>fs.readFile(path.join(root,'ui',name),'utf8')));
 const browser=await chromium.launch({headless:true,executablePath:process.env.BROWSER_EXE||'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
 const errors=[],checks=[],artifacts=[],key='c'.repeat(64),token='d'.repeat(64),replacement='e'.repeat(64);
 const initial={tasks:[{id:'t1',name:'Relay test timer',sec:60}],current_id:'t1',duration_sec:60,settings:{reduceMotion:true,sound:false,showIdleClock:true},notifications:{enabled:true,displaySeconds:5,listLimit:5}};
 const settings={enabled:true,serviceUrl:'https://relay.example.test'};
 async function makePage(view='panel',platform='windows',viewport={width:560,height:660}){
  const page=await browser.newPage({viewport:view==='island'?{width:580,height:580}:viewport});page.on('pageerror',error=>errors.push(error.message));await page.goto('about:blank');
  await page.clock.install({time:new Date('2030-01-01T12:00:00Z')});await page.clock.pauseAt(new Date('2030-01-01T12:00:01Z'));
  const setup="window.messages=[];window.copied=[];Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async value=>copied.push(value)}});window.ipc={postMessage(value){const message=JSON.parse(value);messages.push(message);if(message.requestId&&['setShape','setEffect','setNotificationLayout'].includes(message.type))queueMicrotask(()=>__viewportReady(message.requestId));}};window.__PLATFORM__="+JSON.stringify(platform)+";\n";
  await page.setContent(template.replace('__VIEW__',view).replace('/*__GEO__*/',JSON.stringify({dial:340,effect:580,pillW:132,pillH:38})).replace('/*__STATE__*/',JSON.stringify(initial)).replace('/*__CSS__*/',()=>css).replace('/*__JS__*/',()=>setup+notifications+'\n'+app));
  return page;
 }
 const click=(page,id)=>page.locator('#'+id).evaluate(node=>node.click());
 const fill=(page,id,value)=>page.locator('#'+id).evaluate((node,value)=>{node.value=value;node.dispatchEvent(new Event('input',{bubbles:true}));},value);
 const count=(page,type)=>page.evaluate(type=>messages.filter(item=>item.type===type).length,type);
 const last=(page,type)=>page.evaluate(type=>messages.filter(item=>item.type===type).at(-1),type);
 const status=(page,extra={})=>page.evaluate(value=>__relayStatus(value),{phase:'connected',message:'服务器连接正常',acceptedCount:0,lastReceivedAt:null,settings,hasConnectionKey:true,...extra});
 const result=(page,request,extra={})=>page.evaluate(value=>__relayConfigResult(value),{ok:true,requestId:request.requestId,settings:{enabled:request.settings.enabled,serviceUrl:request.settings.serviceUrl},hasConnectionKey:true,...extra});
 try{
  const page=await makePage();assert.equal(await count(page,'relayStatus'),1);assert.equal(await count(page,'relayConfigure'),0);
  await click(page,'btnOpenWebhookPage');assert.equal(await count(page,'relayStatus'),2);
  assert.equal(await page.locator('#relayEnabled').isChecked(),false);assert.equal(await page.inputValue('#relayServiceUrl'),'');assert.equal(await page.inputValue('#relayConnectionKey'),'');
  assert.equal(await page.getAttribute('#relayConnectionKey','type'),'password');assert.equal(await page.locator('#webhookLocal').evaluate(node=>node.open),false);
  assert.equal(await page.locator('#webhookEnabled').isChecked(),false);assert.equal(await page.locator('#btnCopyRelayEndpoint').isDisabled(),true);
  checks.push('Server connection is first, disabled by default and never starts the independent collapsed local listener; page queries are read-only.');

  await click(page,'relayEnabled');
  for(const url of ['','http://relay.example.test','https://user:password@relay.example.test','https://relay.example.test/path','https://relay.example.test?query=1','https://relay.example.test/#fragment','relay.example.test','https://relay.example.test?','https://relay.example.test#','https://@relay.example.test','https://relay.example.test:0','https://bad_host.example.test','https://-bad.example.test','https://relay.example.test/path/..']){
   await fill(page,'relayServiceUrl',url);await fill(page,'relayConnectionKey',key);const before=await count(page,'relayConfigure');await click(page,'btnSaveRelay');assert.equal(await count(page,'relayConfigure'),before);assert.equal(await page.getAttribute('#relayServiceUrl','aria-invalid'),'true');
  }
  await fill(page,'relayServiceUrl',settings.serviceUrl+'/');
  for(const value of ['','x'.repeat(64),'a'.repeat(63)]){
   await fill(page,'relayConnectionKey',value);const before=await count(page,'relayConfigure');await click(page,'btnSaveRelay');assert.equal(await count(page,'relayConfigure'),before);assert.equal(await page.getAttribute('#relayConnectionKey','aria-invalid'),'true');
  }
  await fill(page,'relayConnectionKey',key);await click(page,'btnSaveRelay');let request=await last(page,'relayConfigure');
  assert.deepEqual(request.settings,{...settings,connectionKey:key});assert(Number.isSafeInteger(request.requestId));
  for(const id of ['relayEnabled','relayServiceUrl','relayConnectionKey','btnSaveRelay'])assert.equal(await page.locator('#'+id).isDisabled(),true);
  await result(page,{...request,requestId:request.requestId-1});assert.equal(await page.locator('#btnSaveRelay').isDisabled(),true);
  await result(page,request,{ok:false,message:'Cannot save'});assert.equal(await page.inputValue('#relayConnectionKey'),key);assert.equal(await page.inputValue('#relayServiceUrl'),settings.serviceUrl+'/');assert.equal(await page.textContent('#relayConfigNote'),'Cannot save');
  await status(page,{phase:'disabled',settings:{enabled:false,serviceUrl:''},hasConnectionKey:false});
  await page.evaluate(()=>__applyState({relay:{enabled:false,serviceUrl:'https://other.example.test',connectionKey:'never-render-state-key',webhookToken:'never-render-state-token'}},false));
  await click(page,'btnOpenTimerPage');await click(page,'btnOpenWebhookPage');assert.equal(await page.inputValue('#relayConnectionKey'),key);assert.equal(await page.inputValue('#relayServiceUrl'),settings.serviceUrl+'/');
  await click(page,'btnSaveRelay');request=await last(page,'relayConfigure');await result(page,request);
  assert.equal(await page.inputValue('#relayConnectionKey'),'');assert.match(await page.getAttribute('#relayConnectionKey','placeholder'),/已保存/);
  assert.equal(await count(page,'webhookConfigure'),0);
  checks.push('HTTPS origin and 64-hex key validation, busy controls, request IDs and drafts protect saving; failures preserve input and success erases the typed key.');

  const beforeTokenQuery=await count(page,'relayStatus');
  await status(page);assert.equal(await count(page,'relayStatus'),beforeTokenQuery+1);
  await status(page);assert.equal(await count(page,'relayStatus'),beforeTokenQuery+1);
  await status(page,{webhookToken:null});assert.equal(await count(page,'relayStatus'),beforeTokenQuery+1);
  await status(page,{webhookToken:token});
  const endpoint=settings.serviceUrl+'/api/webhook/'+token;
  assert.equal(await page.inputValue('#relayEndpoint'),endpoint);assert.equal(await page.getAttribute('#relayEndpoint','type'),'password');
  await status(page,{acceptedCount:3});assert.equal(await page.inputValue('#relayEndpoint'),endpoint);
  await click(page,'btnCopyRelayEndpoint');assert.equal(await page.evaluate(()=>copied.at(-1)),endpoint);assert.match(await page.textContent('#relayCopyNote'),/已复制/);
  await click(page,'btnRevealRelayEndpoint');assert.equal(await page.getAttribute('#relayEndpoint','type'),'text');
  await page.evaluate(()=>window.dispatchEvent(new Event('blur')));assert.equal(await page.getAttribute('#relayEndpoint','type'),'password');
  await click(page,'btnRevealRelayEndpoint');await click(page,'btnOpenPhonePage');assert.equal(await page.getAttribute('#relayEndpoint','type'),'password');await click(page,'btnOpenWebhookPage');
  for(const id of ['webhookCurlExample','webhookPowerShellExample']){const text=await page.textContent('#'+id);assert(!text.includes(token)&&!text.includes(key));assert(text.includes('YOUR_WEBHOOK_URL'));}
  const beforeReconnect=await count(page,'relayStatus');await status(page,{phase:'reconnecting'});assert.equal(await page.inputValue('#relayEndpoint'),'');await status(page);assert.equal(await count(page,'relayStatus'),beforeReconnect+1);await status(page,{webhookToken:replacement});assert.equal(await page.inputValue('#relayEndpoint'),settings.serviceUrl+'/api/webhook/'+replacement);
  checks.push('Connected status obtains a token once, preserves it across redacted updates, re-queries after reconnect, and masks or explicitly copies the URL without embedding secrets in examples.');

  await click(page,'btnSaveRelay');request=await last(page,'relayConfigure');assert.deepEqual(request.settings,settings);await result(page,request);
  await fill(page,'relayServiceUrl','https://new.example.test');const unchanged=await count(page,'relayConfigure');await click(page,'btnSaveRelay');assert.equal(await count(page,'relayConfigure'),unchanged);assert.equal(await page.getAttribute('#relayConnectionKey','aria-invalid'),'true');
  await page.evaluate(()=>__applyState({relay:{enabled:true,serviceUrl:'https://new.example.test'}},false));assert.equal(await page.inputValue('#relayEndpoint'),'');
  await fill(page,'relayConnectionKey',key);await click(page,'btnSaveRelay');request=await last(page,'relayConfigure');await result(page,request);
  await status(page,{settings:{enabled:true,serviceUrl:'https://new.example.test'},webhookToken:replacement});
  assert.equal(await page.inputValue('#relayEndpoint'),'https://new.example.test/api/webhook/'+replacement);
  checks.push('Blank keys preserve a saved credential only for the same server; changing servers requires a new key and never attaches a cached token to another origin.');

  await fill(page,'relayConnectionKey',key);await click(page,'btnSaveRelay');const timedOut=await last(page,'relayConfigure');await page.clock.runFor(12001);
  assert.equal(await page.locator('#btnSaveRelay').isDisabled(),false);assert.equal(await page.inputValue('#relayConnectionKey'),key);assert.match(await page.textContent('#relayConfigNote'),/未收到/);
  await result(page,timedOut);assert.equal(await page.inputValue('#relayConnectionKey'),key);
  await status(page,{phase:'error',settings:{enabled:true,serviceUrl:'https://new.example.test'},message:'<img src=x onerror=alert(1)>',webhookToken:'bad-token'});
  assert.equal(await page.locator('#relayStatusText img').count(),0);assert.equal(await page.inputValue('#relayEndpoint'),'');assert.equal(await page.locator('#btnCopyRelayEndpoint').isDisabled(),true);
  for(const type of ['toggleTimer','setDuration','updateSettings','webhookConfigure'])assert.equal(await count(page,type),0);
  assert.equal(await page.evaluate(()=>__relayNotification({deliveryId:'panel-blocked',notification:{type:'posted',id:'x',title:'x'}})),false);
  checks.push('Timeouts retain drafts and reject late results; untrusted status text cannot create markup, invalid tokens cannot form URLs, and panel callbacks never deliver notifications or alter timers.');

  const island=await makePage('island');assert.equal(await count(island,'relayStatus'),0);
  await island.evaluate(()=>{__fromRust('toggleTimer');__fromRust('syncTimer');});const beforeTimer=await last(island,'timerState');
  await island.evaluate(({key,token})=>{__relayStatus({phase:'connected',settings:{enabled:true,serviceUrl:'https://relay.example.test'},hasConnectionKey:true,webhookToken:token});__relayConfigResult({ok:true,requestId:1});__applyState({relay:{enabled:true,serviceUrl:'https://relay.example.test',connectionKey:key,webhookToken:token}},false);}, {key,token});
  assert.equal(await island.inputValue('#relayConnectionKey'),'');assert.equal(await island.inputValue('#relayEndpoint'),'');
  const envelope={deliveryId:'delivery-1',notification:{type:'posted',source:'untrusted',id:'message-1',app:'Server',title:'Original',body:'Relay body'}};
  assert.equal(await island.evaluate(value=>__relayNotification(value),envelope),true);
  assert.equal(await island.evaluate(value=>__relayNotification({...value,notification:{...value.notification,title:'Duplicate changed'}}),envelope),true);
  let notice=await island.evaluate(()=>__notificationState());assert.equal(notice.count,1);assert.equal(notice.items[0].source,'webhook');assert.equal(notice.items[0].title,'Original');
  for(const invalid of [null,{}, {...envelope,deliveryId:''},{...envelope,deliveryId:'bad\nid'},{...envelope,notification:{type:'command',id:'x',title:'x'}},{...envelope,notification:{type:'posted',id:'x'}},{...envelope,notification:{type:'posted',id:'bad\u202eid',title:'x'}},{...envelope,notification:{type:'posted',id:'x',title:{bad:true},body:'valid text'}},{...envelope,notification:{type:'posted',id:'界'.repeat(86),title:'x'}}])assert.equal(await island.evaluate(value=>__relayNotification(value),invalid),false);
  assert.equal(await island.evaluate(()=>__relayNotification({deliveryId:'delivery-remove',notification:{type:'removed',id:'message-1'}})),true);assert.equal((await island.evaluate(()=>__notificationState())).count,0);
  const bounded=await island.evaluate(envelope=>{
   let calls=0;const original=__notificationEvent;window.__notificationEvent=value=>{calls++;original(value);};
   for(let i=0;i<201;i++)if(!__relayNotification({deliveryId:'bounded-'+i,notification:{type:'posted',id:'bounded-'+i,title:'test'}}))return false;
   __relayNotification(envelope);return calls===202&&__notificationState().count===200;
  },envelope);assert.equal(bounded,true,'delivery dedup and queue are bounded to 200 entries');
  await island.evaluate(()=>__applyState({notifications:{enabled:false,displaySeconds:5,listLimit:5}},false));
  assert.equal(await island.evaluate(value=>__relayNotification(value),{...envelope,deliveryId:'disabled'}),false);assert.equal((await island.evaluate(()=>__notificationState())).count,0);
  await island.evaluate(()=>{__applyState({notifications:{enabled:true,displaySeconds:5,listLimit:5}},false);__fromRust('syncTimer');});
  const afterTimer=await last(island,'timerState');for(const name of ['runId','taskId','running','done','started','remainingMs','totalMs'])assert.equal(afterTimer[name],beforeTimer[name]);
  checks.push('Island-only receipt validates envelopes, forces webhook source, deduplicates retries without replay, bounds memory, rejects disabled delivery and preserves a running countdown.');

  const rotated=await makePage();await click(rotated,'btnOpenWebhookPage');
  await status(rotated,{tokenRevision:1,webhookToken:token});const revisionQueries=await count(rotated,'relayStatus');
  await status(rotated,{tokenRevision:2});assert.equal(await rotated.inputValue('#relayEndpoint'),'');assert.equal(await count(rotated,'relayStatus'),revisionQueries+1);
  await status(rotated,{tokenRevision:2});assert.equal(await count(rotated,'relayStatus'),revisionQueries+1);
  await status(rotated,{tokenRevision:2,webhookToken:replacement});assert.equal(await rotated.inputValue('#relayEndpoint'),settings.serviceUrl+'/api/webhook/'+replacement);
  await status(rotated,{tokenRevision:1,webhookToken:token});assert.equal(await rotated.inputValue('#relayEndpoint'),settings.serviceUrl+'/api/webhook/'+replacement);
  await status(rotated,{tokenRevision:3,webhookToken:token});assert.equal(await rotated.inputValue('#relayEndpoint'),settings.serviceUrl+'/api/webhook/'+token);assert.equal(await count(rotated,'relayStatus'),revisionQueries+1);
  checks.push('Token revision changes invalidate cached URLs and query once; an included replacement is used immediately and stale revision replies cannot restore an old token.');
  const mac=await makePage('panel','macos');await click(mac,'btnOpenWebhookPage');assert.equal(await mac.locator('#relayEnabled').isDisabled(),false);assert.equal(await mac.locator('#btnSaveRelay').isDisabled(),false);
  await fs.mkdir(out,{recursive:true});
  for(const viewport of [{width:560,height:660},{width:340,height:620},{width:340,height:360}]){
   const layout=await makePage('panel','windows',viewport);await click(layout,'btnOpenWebhookPage');await status(layout,{webhookToken:token,acceptedCount:5,lastReceivedAt:Date.now()});
   const size=await layout.locator('#webhookPage').evaluate(node=>({width:node.clientWidth,scroll:node.scrollWidth,height:node.clientHeight}));assert(size.height>40&&size.scroll<=size.width+1);
   const name='relay-'+viewport.width+'x'+viewport.height+'.png';await layout.screenshot({path:path.join(out,name),omitBackground:true,animations:'disabled'});artifacts.push(name);
   await layout.locator('#relayEndpoint').evaluate(node=>node.scrollIntoView({block:'center'}));const endpointName='relay-'+viewport.width+'x'+viewport.height+'-endpoint.png';await layout.screenshot({path:path.join(out,endpointName),omitBackground:true,animations:'disabled'});artifacts.push(endpointName);
   assert.equal(await layout.getAttribute('#relayEndpoint','type'),'password');assert.equal(await layout.inputValue('#relayConnectionKey'),'');assert.equal(await layout.locator('#webhookLocal').evaluate(node=>node.open),false);
  }
  checks.push('Windows and macOS expose the same relay controls; glass layout fits wide, narrow and short windows with masked credentials and reachable external URL.');
  assert.deepEqual(errors,[]);return{ok:true,checks,consoleErrors:errors,artifacts,scope:'Isolated UI and IPC contracts; no external server deployment or network traffic.'};
 }finally{await browser.close();}
}
module.exports={run};
if(require.main===module)run().then(async report=>{await fs.writeFile(path.join(__dirname,'verify/relay-ui-report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));}).catch(error=>{console.error(error);process.exitCode=1;});
