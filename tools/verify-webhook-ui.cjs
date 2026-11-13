/* Webhook panel contracts; captures native IPC and never opens a real HTTP listener. */
const fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict');
async function run(){
 const root=path.resolve(__dirname,'..'),out=path.join(root,'tools/verify');
 const {chromium}=require(process.env.PLAYWRIGHT_MODULE||path.resolve(root,'../verify-tools/node_modules/playwright'));
 const [template,css,notifications,app]=await Promise.all(['index.html','styles.css','notifications.js','app.js'].map(name=>fs.readFile(path.join(root,'ui',name),'utf8')));
 const browser=await chromium.launch({headless:true,executablePath:process.env.BROWSER_EXE||'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
 const errors=[],checks=[],artifacts=[];
 const initial={tasks:[{id:'t1',name:'Webhook test timer',sec:60}],current_id:'t1',duration_sec:60,settings:{reduceMotion:true,sound:false,showIdleClock:true},notifications:{enabled:true,displaySeconds:5,listLimit:5}};
 const tokenA='a'.repeat(64),tokenB='b'.repeat(64);
 async function makePage(view='panel',platform='windows',viewport={width:560,height:660}){
  const page=await browser.newPage({viewport:view==='island'?{width:580,height:580}:viewport});
  page.on('pageerror',error=>errors.push(error.message));await page.goto('about:blank');
  await page.clock.install({time:new Date('2030-01-01T12:00:00Z')});await page.clock.pauseAt(new Date('2030-01-01T12:00:01Z'));
  const setup="window.messages=[];window.copied=[];Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async value=>copied.push(value)}});window.ipc={postMessage(value){const message=JSON.parse(value);messages.push(message);if(message.requestId&&['setShape','setEffect','setNotificationLayout'].includes(message.type))queueMicrotask(()=>__viewportReady(message.requestId));}};window.__PLATFORM__="+JSON.stringify(platform)+";\n";
  await page.setContent(template.replace('__VIEW__',view).replace('/*__GEO__*/',JSON.stringify({dial:340,effect:580,pillW:132,pillH:38})).replace('/*__STATE__*/',JSON.stringify(initial)).replace('/*__CSS__*/',()=>css).replace('/*__JS__*/',()=>setup+notifications+'\n'+app));
  if(view==='panel')await page.locator('#webhookLocal').evaluate(node=>{node.open=true;});
  return page;
 }
 const click=(page,id)=>page.locator('#'+id).evaluate(node=>node.click());
 const count=(page,type)=>page.evaluate(type=>messages.filter(item=>item.type===type).length,type);
 const last=(page,type)=>page.evaluate(type=>messages.filter(item=>item.type===type).at(-1),type);
 const status=(page,extra={})=>page.evaluate(payload=>__webhookStatus(payload),{phase:'disabled',message:'Ready',endpoint:'http://127.0.0.1:17891/api/webhook',lanAddresses:[],acceptedCount:0,lastReceivedAt:null,settings:{enabled:false,scope:'local',port:17891},...extra});
 const result=(page,request,extra={})=>page.evaluate(payload=>__webhookConfigResult(payload),{requestId:request.requestId,ok:true,settings:request.settings||{enabled:false,scope:'local',port:17891},...extra});
 try{
  const page=await makePage();
  assert.equal(await count(page,'webhookStatus'),1);
  assert.deepEqual(await page.locator('#panelNav [data-panel-page]').evaluateAll(nodes=>nodes.map(node=>node.dataset.panelPage)),['timer','webhook','phone','preferences']);
  await click(page,'btnOpenWebhookPage');assert.equal(await count(page,'webhookStatus'),2);
  assert.equal(await page.getAttribute('#webhookPage','aria-hidden'),'false');
  assert.equal(await page.locator('#webhookEnabled').isChecked(),false);assert.equal(await page.inputValue('#webhookPort'),'17891');
  assert.equal(await page.getAttribute('#webhookScopeLocal','aria-pressed'),'true');assert.equal(await page.locator('#webhookPage select').count(),0);
  assert.equal(await page.inputValue('#webhookToken'),'');assert.equal(await page.getAttribute('#webhookToken','type'),'password');
  assert.equal(await page.locator('#btnTestWebhook').isDisabled(),true);
  checks.push('four menus include independent Webhook; panel startup and route entry query status; service defaults off/local/17891 and credentials are masked');

  await status(page,{token:tokenA,acceptedCount:7,lastReceivedAt:Date.now()});
  await page.locator('.webhook-advanced').evaluate(node=>{node.open=true;});
  assert.equal(await page.inputValue('#webhookToken'),tokenA);assert.equal(await page.getAttribute('#webhookToken','type'),'password');
  assert.match(await page.textContent('#webhookCurlExample'),/YOUR_WEBHOOK_URL/);assert(!await page.textContent('#webhookCurlExample').then(value=>value.includes(tokenA)));
  assert(!await page.textContent('#webhookPowerShellExample').then(value=>value.includes(tokenA)));
  await click(page,'btnRevealWebhookToken');assert.equal(await page.getAttribute('#webhookToken','type'),'text');
  await page.evaluate(()=>window.dispatchEvent(new Event('blur')));assert.equal(await page.getAttribute('#webhookToken','type'),'password');
  await click(page,'btnCopyWebhookToken');assert.equal(await page.evaluate(()=>copied.at(-1)),tokenA);
  await click(page,'btnCopyWebhookEndpoint');assert.equal(await page.evaluate(()=>copied.at(-1)),'http://127.0.0.1:17891/api/webhook/'+tokenA);
  await click(page,'btnRevealWebhookToken');await click(page,'btnOpenTimerPage');assert.equal(await page.getAttribute('#webhookToken','type'),'password');await click(page,'btnOpenWebhookPage');
  checks.push('token arrives only via panel callback, never appears in examples, is copied explicitly and re-masks on blur or leaving the menu');

  for(const value of ['','0','1023','65536','1.5']){
   await page.fill('#webhookPort',value);const before=await count(page,'webhookConfigure');await click(page,'btnSaveWebhook');
   assert.equal(await count(page,'webhookConfigure'),before);assert.equal(await page.getAttribute('#webhookPort','aria-invalid'),'true');
  }
  await page.fill('#webhookPort','18000');await click(page,'webhookScopeLan');await click(page,'webhookEnabled');
  await status(page,{token:tokenA});await page.evaluate(()=>__applyState({settings:{sound:true},webhook:{enabled:false,scope:'local',port:17891,token:'ignored-state-token'}},false));
  assert.equal(await page.inputValue('#webhookPort'),'18000');assert.equal(await page.getAttribute('#webhookScopeLan','aria-pressed'),'true');assert.equal(await page.locator('#webhookEnabled').isChecked(),true);assert.equal(await page.inputValue('#webhookToken'),tokenA);
  await click(page,'btnOpenPhonePage');await click(page,'btnOpenWebhookPage');assert.equal(await page.inputValue('#webhookPort'),'18000');
  await click(page,'btnSaveWebhook');let request=await last(page,'webhookConfigure');
  assert.deepEqual(request.settings,{enabled:true,scope:'lan',port:18000,publicBaseUrl:''});assert(Number.isSafeInteger(request.requestId));assert(!JSON.stringify(request).includes(tokenA));
  for(const id of ['webhookEnabled','webhookPort','webhookPublicBaseUrl','webhookScopeLocal','webhookScopeLan','btnSaveWebhook','btnRotateWebhookToken'])assert.equal(await page.locator('#'+id).isDisabled(),true);
  await result(page,{...request,requestId:request.requestId-1},{ok:true});assert.equal(await page.locator('#btnSaveWebhook').isDisabled(),true);
  await result(page,request,{ok:false,message:'Port busy',settings:{enabled:false,scope:'local',port:17891}});
  assert.equal(await page.inputValue('#webhookPort'),'18000');assert.equal(await page.getAttribute('#webhookScopeLan','aria-pressed'),'true');assert.equal(await page.locator('#webhookEnabled').isChecked(),true);assert.equal(await page.textContent('#webhookConfigNote'),'Port busy');
  await click(page,'btnSaveWebhook');request=await last(page,'webhookConfigure');await result(page,request,{token:tokenA});
  await status(page,{phase:'listening',token:tokenA,settings:request.settings,endpoint:'http://127.0.0.1:18000/api/webhook',lanAddresses:['192.168.1.20','999.2.3.4','<img>']});
  assert.equal(await page.inputValue('#webhookEndpoint'),'http://192.168.1.20:18000/api/webhook/'+tokenA);assert.match(await page.textContent('#webhookLanAddresses'),/192\.168\.1\.20/);assert(!await page.textContent('#webhookLanAddresses').then(value=>value.includes('999.2')));
  checks.push('port validation, dirty drafts, navigation, busy controls and request-ID gating protect settings; failures retain drafts and LAN endpoints use validated addresses');

  await page.fill('#webhookPort','19002');await click(page,'webhookScopeLocal');
  await click(page,'btnRotateWebhookToken');request=await last(page,'webhookRotateToken');
  assert(request.requestId);assert.equal(request.settings,undefined);
  await result(page,request,{settings:{enabled:true,scope:'lan',port:18000},token:tokenB});
  assert.equal(await page.inputValue('#webhookToken'),tokenB);assert.equal(await page.getAttribute('#webhookToken','type'),'password');
  assert.equal(await page.inputValue('#webhookPort'),'19002');assert.equal(await page.getAttribute('#webhookScopeLocal','aria-pressed'),'true');
  await page.fill('#webhookPort','18000');assert.match(await page.textContent('#webhookScopeNote'),/更换端口/);
  for(const port of [1024,65535]){
   await page.fill('#webhookPort',String(port));await page.press('#webhookPort','Enter');request=await last(page,'webhookConfigure');assert.equal(request.settings.port,port);await result(page,request,{token:tokenB});
  }
  checks.push('token rotation uses its own request, preserves unsaved service drafts, masks the replacement and accepts both valid port boundaries');

  await status(page,{phase:'listening',token:tokenB,settings:{enabled:true,scope:'local',port:65535},endpoint:'http://127.0.0.1:65535/api/webhook'});
  await page.evaluate(()=>{window.syntheticNotifications=0;window.__notificationEvent=()=>syntheticNotifications++;});
  await click(page,'btnTestWebhook');const testRequest=await last(page,'webhookTest');
  assert(testRequest.requestId);assert.equal(await page.locator('#btnTestWebhook').isDisabled(),true);assert.equal(await page.evaluate(()=>syntheticNotifications),0);
  await page.evaluate(id=>__webhookTestResult({requestId:id-1,ok:true}),testRequest.requestId);assert.equal(await page.locator('#btnTestWebhook').isDisabled(),true);
  await page.evaluate(id=>__webhookTestResult({requestId:id,ok:false,message:'HTTP 401'}),testRequest.requestId);assert.equal(await page.textContent('#webhookTestNote'),'HTTP 401');assert.equal(await page.locator('#btnTestWebhook').isDisabled(),false);
  await click(page,'btnTestWebhook');const successful=await last(page,'webhookTest');await page.evaluate(id=>__webhookTestResult({requestId:id,ok:true,message:'HTTP 202 delivered'}),successful.requestId);assert.equal(await page.textContent('#webhookTestNote'),'HTTP 202 delivered');
  await page.evaluate(()=>__applyState({notifications:{enabled:false,displaySeconds:5,listLimit:5}},false));
  assert.equal(await page.locator('#btnTestWebhook').isDisabled(),true);assert.equal(await page.locator('#webhookNotificationNote').evaluate(node=>node.hidden),false);
  const beforeDisabledTest=await count(page,'webhookTest');await click(page,'btnTestWebhook');assert.equal(await count(page,'webhookTest'),beforeDisabledTest);
  await click(page,'btnWebhookNotifications');await page.clock.runFor(240);
  assert.equal(await page.getAttribute('#preferencesPage','aria-hidden'),'false');
  assert.equal(await page.evaluate(()=>document.activeElement.id),'notificationsEnabled');
  assert.equal(await page.locator('#notificationsEnabled').evaluate(node=>{const box=node.closest('label').getBoundingClientRect(),page=document.getElementById('preferencesPage').getBoundingClientRect();return box.top>=page.top-1&&box.bottom<=page.bottom+1;}),true);
  await click(page,'btnOpenWebhookPage');await page.clock.runFor(240);
  await page.evaluate(()=>__applyState({notifications:{enabled:true,displaySeconds:5,listLimit:5}},false));
  checks.push('test button requests native HTTP only, matches test result IDs and reports failures; closing notification display blocks testing without faking delivery, and its shortcut focuses notification settings within preferences');

  await page.fill('#webhookPort','23456');await click(page,'btnSaveWebhook');const timedOut=await last(page,'webhookConfigure');
  await page.clock.runFor(12001);assert.equal(await page.locator('#btnSaveWebhook').isDisabled(),false);assert.equal(await page.inputValue('#webhookPort'),'23456');assert.match(await page.textContent('#webhookConfigNote'),/未收到/);
  await result(page,timedOut,{settings:{enabled:true,scope:'local',port:23456},token:tokenA});assert.equal(await page.inputValue('#webhookToken'),tokenB);
  await status(page,{phase:'error',message:'<img src=x onerror=alert(1)>',endpoint:'javascript:alert(1)',settings:{enabled:false,scope:'local',port:17891}});
  assert.equal(await page.locator('#webhookStatusText img').count(),0);assert.equal(await page.inputValue('#webhookEndpoint'),'http://127.0.0.1:17891/api/webhook/'+tokenB);assert.equal(await page.inputValue('#webhookPort'),'23456');
  assert.equal(await count(page,'updateSettings'),0);assert.equal(await count(page,'toggleTimer'),0);assert.equal(await count(page,'setDuration'),0);
  checks.push('lost save replies unlock after a bounded timeout without losing drafts; stale results, markup and invalid endpoints cannot corrupt state or execute content');

  const island=await makePage('island');assert.equal(await count(island,'webhookStatus'),0);
  await island.evaluate(()=>{__fromRust('toggleTimer');__fromRust('syncTimer');});
  const beforeTimer=await last(island,'timerState');
  await island.evaluate(token=>{__webhookStatus({phase:'listening',token,settings:{enabled:true,scope:'lan',port:19000}});__webhookConfigResult({ok:true,requestId:1,token});__webhookTestResult({ok:true,requestId:1});__applyState({webhook:{enabled:true,scope:'lan',port:19000,token}},false);__fromRust('syncTimer');},tokenA);
  const afterTimer=await last(island,'timerState');for(const key of ['runId','taskId','running','done','started','remainingMs','totalMs'])assert.equal(afterTimer[key],beforeTimer[key]);
  assert.equal(await island.inputValue('#webhookToken'),'');assert(!await island.textContent('#webhookCurlExample').then(value=>value.includes(tokenA)));
  const mac=await makePage('panel','macos');await click(mac,'btnOpenWebhookPage');assert.equal(await mac.locator('#webhookEnabled').isDisabled(),false);assert.equal(await mac.locator('#btnSaveWebhook').isDisabled(),false);
  checks.push('island ignores credential/status callbacks and Webhook state sync preserves running timer facts; Webhook remains available on macOS');

  const publicPage=await makePage();await click(publicPage,'btnOpenWebhookPage');await status(publicPage,{token:tokenA});
  assert.equal(await publicPage.inputValue('#webhookPublicBaseUrl'),'');
  for(const value of ['http://example.com','https://example.com/path','https://user:secret@example.com','https://example.com?x=1','https://example.com/#fragment','example.com']){
   await publicPage.fill('#webhookPublicBaseUrl',value);const before=await count(publicPage,'webhookConfigure');await click(publicPage,'btnSaveWebhook');
   assert.equal(await count(publicPage,'webhookConfigure'),before);assert.equal(await publicPage.getAttribute('#webhookPublicBaseUrl','aria-invalid'),'true');
  }
  await publicPage.fill('#webhookPublicBaseUrl','https://hooks.example.test:8443/');await click(publicPage,'btnSaveWebhook');
  const publicRequest=await last(publicPage,'webhookConfigure');
  assert.deepEqual(publicRequest.settings,{enabled:false,scope:'local',port:17891,publicBaseUrl:'https://hooks.example.test:8443'});
  await result(publicPage,publicRequest,{token:tokenA});
  assert.equal(await publicPage.inputValue('#webhookEndpoint'),'https://hooks.example.test:8443/api/webhook/'+tokenA);
  assert.equal(await publicPage.getAttribute('#webhookEndpoint','type'),'password');
  await click(publicPage,'btnRevealWebhookEndpoint');assert.equal(await publicPage.getAttribute('#webhookEndpoint','type'),'text');
  await click(publicPage,'btnCopyWebhookEndpoint');assert.equal(await publicPage.evaluate(()=>copied.at(-1)),'https://hooks.example.test:8443/api/webhook/'+tokenA);
  await publicPage.evaluate(()=>window.dispatchEvent(new Event('blur')));assert.equal(await publicPage.getAttribute('#webhookEndpoint','type'),'password');
  assert.equal(await count(publicPage,'webhookTest'),0);assert.equal(publicRequest.settings.scope,'local');
  assert.match(await publicPage.textContent('#webhookCurlExample'),/"msg_type":"text"/);
  assert.match(await publicPage.textContent('#webhookCurlExample'),/YOUR_WEBHOOK_URL/);
  assert(!await publicPage.textContent('#webhookCurlExample').then(value=>value.includes('Authorization')||value.includes(tokenA)));
  assert.match(await publicPage.textContent('#webhookPowerShellExample'),/content = @\{ text/);
  await publicPage.fill('#webhookPublicBaseUrl','https://draft.example.test');
  await status(publicPage,{token:tokenA,settings:publicRequest.settings});
  assert.equal(await publicPage.inputValue('#webhookPublicBaseUrl'),'https://draft.example.test');
  checks.push('public HTTPS origin is optional and strictly validated; secret-path URL masks/copies correctly, supports local listeners and uses credential-free Feishu text examples');

  await fs.mkdir(out,{recursive:true});
  for(const viewport of [{width:560,height:660},{width:340,height:620},{width:340,height:360}]){
   const layout=await makePage('panel','windows',viewport);await click(layout,'btnOpenWebhookPage');
   await status(layout,{phase:'listening',token:tokenA,settings:{enabled:true,scope:'lan',port:17891},lanAddresses:['192.168.1.20'],acceptedCount:12,lastReceivedAt:Date.now()});
   const sizes=await layout.locator('#webhookPage').evaluate(node=>({width:node.clientWidth,scroll:node.scrollWidth,height:node.clientHeight}));
   assert(sizes.height>40);assert(sizes.scroll<=sizes.width+1);
   const name='webhook-'+viewport.width+'x'+viewport.height+'.png';await layout.screenshot({path:path.join(out,name),omitBackground:true,animations:'disabled'});artifacts.push(name);
   await layout.locator('#webhookPowerShellExample').evaluate(node=>{node.parentElement.open=true;node.scrollIntoView({block:'end'});});
   const endName='webhook-'+viewport.width+'x'+viewport.height+'-examples.png';await layout.screenshot({path:path.join(out,endName),omitBackground:true,animations:'disabled'});artifacts.push(endName);
   assert.equal(await layout.getAttribute('#webhookToken','type'),'password');
  }
  checks.push('glass page fits 560px and 340px widths with short-window scrolling; tokens remain masked in layout artifacts');
  assert.deepEqual(errors,[]);
  return {ok:true,checks,consoleErrors:errors,artifacts,scope:'Headless panel/bridge contracts only; native listener and actual HTTP delivery require separate native tests.'};
 }finally{await browser.close();}
}
module.exports={run};
if(require.main===module)run().then(async result=>{await fs.writeFile(path.join(__dirname,'verify/webhook-ui-report.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));}).catch(error=>{console.error(error);process.exitCode=1;});
