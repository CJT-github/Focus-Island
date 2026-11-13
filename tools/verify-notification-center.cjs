/* Controller/UI contract checks. No Bluetooth or external sender is used. */
const fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict');
async function run(){
 const root=path.resolve(__dirname,'..'),output=path.join(root,'tools/verify');
 const {chromium}=require(process.env.PLAYWRIGHT_MODULE||path.resolve(root,'../verify-tools/node_modules/playwright'));
 const [template,css,controller,app]=await Promise.all(['index.html','styles.css','notifications.js','app.js'].map(name=>fs.readFile(path.join(root,'ui',name),'utf8')));
 const browser=await chromium.launch({headless:true,executablePath:process.env.BROWSER_EXE||'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
 const errors=[],checks=[],artifacts=[];
 const page=await browser.newPage({viewport:{width:580,height:580}});
 page.on('pageerror',error=>errors.push(error.message));
 await page.goto('about:blank');
 await page.clock.install({time:new Date('2030-01-01T12:00:00Z')});
 await page.clock.pauseAt(new Date('2030-01-01T12:00:01Z'));
 await page.setContent(template.replace('__VIEW__','island').replace('/*__GEO__*/','{}').replace('/*__STATE__*/','{}').replace('/*__CSS__*/',()=>css).replace('/*__JS__*/',()=>controller));
 await page.evaluate(()=>{
  window.layoutCalls=[];window.layoutCallbacks=[];window.isMainOpen=false;window.reduce=false;
  window.center=createNotificationCenter({
   mainOpen:()=>isMainOpen,reducedMotion:()=>reduce,
   closeMain:()=>{isMainOpen=false;center.syncMain();},
   sendLayout:(layout,callback)=>{layoutCalls.push(layout);layoutCallbacks.push(callback);}
  });
  center.bind();center.configure({enabled:true,displaySeconds:5,listLimit:5});
 });
 const event=(id,extra={})=>({type:'posted',source:'phone',id,app:'Chat',title:'Message '+id,body:'Body '+id,time:Date.now(),...extra});
 const emit=payload=>page.evaluate(payload=>center.receive(payload),payload);
 const state=()=>page.evaluate(()=>center.getState());
 const ack=()=>page.evaluate(()=>{const pending=layoutCallbacks.splice(0);for(const callback of pending)callback?.();});
 const visible=selector=>page.locator(selector).evaluate(node=>!node.hidden);
 const click=selector=>page.locator(selector).first().evaluate(node=>node.click());
 const settle=async(ms=700)=>{await ack();await page.clock.runFor(ms);await ack();};
 const rows=()=>page.locator('#noticeItems .notice-item-title').allTextContents();
 try{
  assert.equal(await page.evaluate(()=>layoutCalls.length),0,'empty boot must not mutate native clipping');
  const firstDeadline=await page.evaluate(()=>Date.now()+5000);
  await emit(event('first',{source:'webhook'}));
  assert.equal(await visible('#noticeCompanion'),false);
  await settle();
  assert.equal(await visible('#noticeCompanion'),true);
  assert.equal((await state()).mode,'preview');
  assert.deepEqual(await page.locator('#noticeCompanion').evaluate(node=>({left:node.offsetLeft,width:node.offsetWidth,top:node.offsetTop,height:node.offsetHeight})),{left:226,width:280,top:120,height:38});
  assert.equal(await page.locator('#island').evaluate(node=>node.style.getPropertyValue('--notification-shift')),'-150px');
  assert.equal(await page.locator('#noticeBody').evaluate(node=>getComputedStyle(node).textOverflow),'ellipsis');
  checks.push('first notification waits for native ACK; 280x38 companion and primary remain centered with ellipsis');

  await page.clock.runFor(1000);await emit(event('first',{source:'webhook',title:'Updated'}));
  await page.clock.runFor(Math.max(0,firstDeadline-1-await page.evaluate(()=>Date.now())));
  assert.equal((await state()).mode,'preview');
  await page.clock.runFor(1);await settle();
  assert.equal((await state()).mode,'count');assert.equal((await state()).count,1);
  assert.equal(await page.textContent('#noticeCount'),'1');
  assert.equal(await page.locator('#noticeCompanion').evaluate(node=>parseFloat(node.style.width)),44);
  assert.equal(await page.locator('#island').evaluate(node=>node.style.getPropertyValue('--notification-shift')),'-32px');
  checks.push('five-second timeout collapses to count without deleting; same-ID updates retain the original deadline');

  await click('#noticeCompanion');await settle();
  assert.equal(await visible('#noticeList'),true);
  for(let i=2;i<=7;i++)await emit(event('q'+i));
  await settle();
  assert.equal((await state()).mode,'list');assert.equal((await state()).count,7);
  assert.deepEqual(await rows(),['Updated','Message q2','Message q3','Message q4','Message q5']);
  const chineseBody='这是一段较长的中文通知正文，内容应自动换行并完整保留，方便在消息列表里阅读。'.repeat(5);
  const englishTitle='DeploymentNotificationWithoutWhitespace'.repeat(4);
  const englishBody='BuildArtifactGeneratedSuccessfullyWithoutWhitespace'.repeat(8);
  await emit(event('first',{source:'webhook',title:'新消息',body:''}));await settle();
  assert.equal((await rows())[0],'新消息','a title-only message keeps its meaningful text');
  await emit(event('q2',{title:'新消息',body:'手机正文'}));await settle();assert.equal((await rows())[1],'新消息','phone titles matching the placeholder remain visible');
  await emit(event('first',{source:'webhook',title:'新消息',body:chineseBody,app:'构建服务'}));
  await emit(event('q2',{title:englishTitle,body:englishBody,app:'Webhook'}));await settle();
  assert.equal((await rows())[0],'','default new-message label is omitted from the list');
  assert.equal(await page.locator('#noticeItems .notice-item').first().locator('.notice-item-title').isVisible(),false);
  assert.equal(await page.locator('#noticeItems .notice-item').first().locator('.notice-item-body').textContent(),chineseBody);
  const rowLayout=await page.locator('#noticeItems .notice-item').evaluateAll(nodes=>nodes.slice(0,2).map(row=>{
    const copy=row.querySelector('.notice-item-copy'),app=row.querySelector('.notice-item-app');
    const box=row.getBoundingClientRect(),copyBox=copy.getBoundingClientRect(),appBox=app.getBoundingClientRect();
    return{appOutsideCopy:!copy.contains(app),appLast:row.lastElementChild===app,appRight:appBox.left>=copyBox.right-1&&appBox.right<=box.right+1,
      text:[...copy.querySelectorAll('.notice-item-title,.notice-item-body')].map(node=>{
        const style=getComputedStyle(node);return{empty:!node.textContent,whiteSpace:style.whiteSpace,ellipsis:style.textOverflow==='ellipsis'||Number(style.webkitLineClamp)>0,
          height:node.getBoundingClientRect().height,lineHeight:parseFloat(style.lineHeight),fitsX:node.scrollWidth<=node.clientWidth+1,fitsY:node.scrollHeight<=node.clientHeight+1};
      })};
  }));
  for(const row of rowLayout){
    assert(row.appOutsideCopy&&row.appLast&&row.appRight,'message type must occupy the rightmost column');
    for(const text of row.text.filter(value=>!value.empty)){
      assert.notEqual(text.whiteSpace,'nowrap');assert.equal(text.ellipsis,false);
      assert(text.height>text.lineHeight*1.5,'long Chinese and unspaced English must occupy multiple lines');
      assert(text.fitsX&&text.fitsY,'wrapped text must not be clipped inside its own box');
    }
  }
  const listMetrics=()=>page.locator('#noticeList').evaluate(node=>{
    const items=document.getElementById('noticeItems');return{height:node.getBoundingClientRect().height,scroll:items.scrollHeight,client:items.clientHeight,horizontal:items.scrollWidth<=items.clientWidth+1};
  });
  const exactNativeHeight=async()=>{
    const height=(await listMetrics()).height,last=await page.evaluate(()=>layoutCalls.findLast(call=>call.mode==='list'));
    assert(last&&Math.abs(last.listHeight-Math.ceil(height))<=1,'native clipping height must match the measured list after content updates');
    assert(last.listHeight>0&&last.listHeight<=280);return height;
  };
  let measured=await listMetrics();assert(measured.height<=280&&measured.scroll>measured.client&&measured.horizontal,'long messages use internal scrolling within the 280px list');
  await exactNativeHeight();
  await fs.mkdir(output,{recursive:true});
  await page.locator('#noticeItems').evaluate(node=>{node.scrollTop=0;});
  const chineseShot='notice-list-wrap-chinese.png';await page.screenshot({path:path.join(output,chineseShot),omitBackground:true,animations:'disabled'});artifacts.push(chineseShot);
  await page.locator('#noticeItems').evaluate(node=>{node.scrollTop+=node.children[1].getBoundingClientRect().top-node.getBoundingClientRect().top;});
  const englishShot='notice-list-wrap-english.png';await page.screenshot({path:path.join(output,englishShot),omitBackground:true,animations:'disabled'});artifacts.push(englishShot);
  await click('#noticeItems input');await settle();
  assert.deepEqual(await rows(),[englishTitle,'Message q3','Message q4','Message q5','Message q6']);
  assert.equal((await state()).count,6);
  await page.evaluate(()=>center.configure({enabled:true,displaySeconds:5,listLimit:1}));await settle();
  const tallHeight=await exactNativeHeight(),callsBeforeShrink=await page.evaluate(()=>layoutCalls.length);
  await emit(event('q2',{title:'小更新',body:'短正文',app:'服务'}));await settle();
  const shortHeight=await exactNativeHeight();assert(shortHeight<tallHeight,'a shorter replacement shrinks the list without keeping stale clipping');
  assert((await page.evaluate(()=>layoutCalls.length))>callsBeforeShrink,'content height changes must request an updated native layout');
  const shortShot='notice-list-updated-short.png';await page.screenshot({path:path.join(output,shortShot),omitBackground:true,animations:'disabled'});artifacts.push(shortShot);
  await emit(event('q2',{title:englishTitle,body:englishBody,app:'Webhook'}));await settle();
  assert((await exactNativeHeight())>shortHeight,'a longer replacement grows the native clipping again');
  await emit(event('q2'));await page.evaluate(()=>center.configure({enabled:true,displaySeconds:5,listLimit:5}));await settle();
  checks.push('FIFO list keeps arrivals and checkbox refill; default label is hidden, type sits right, Chinese and unspaced English wrap fully within 280px scrolling, and replacements update native clipping height');

  await page.evaluate(()=>center.configure({enabled:true,displaySeconds:5,listLimit:2}));await settle();
  assert.equal((await rows()).length,2);
  await emit(event('q2',{source:'webhook',title:'External'}));
  assert.equal((await state()).count,7);
  await page.evaluate(()=>center.clearSource('phone'));await settle();
  assert.equal((await state()).count,1);assert.deepEqual(await rows(),['External']);
  await page.evaluate(()=>center.redactSource('webhook'));
  assert.equal((await state()).items[0].body,'');assert.deepEqual(await rows(),['']);
  assert(!await page.locator('#noticeItems').textContent().then(text=>text.includes('External')));
  checks.push('list limit is configurable; sources isolate equal IDs; clearing/redacting one source preserves others safely');

  await page.evaluate(()=>{isMainOpen=true;center.syncMain();});
  assert.equal((await state()).mode,'count');await settle(660);
  assert.equal(await visible('#noticeList'),false);
  await emit(event('expanded'));await settle();
  assert.equal(await page.locator('#noticeCompanion').evaluate(node=>parseFloat(node.style.width)),196);
  assert.equal(await page.locator('#island').evaluate(node=>node.style.getPropertyValue('--notification-shift')),'-108px');
  await click('#noticeCompanion');await settle(660);
  assert.equal(await page.evaluate(()=>isMainOpen),false);assert.equal((await state()).mode,'list');
  checks.push('main opening closes the list; expanded main uses 196px preview; list opening closes only main appearance');


  await page.evaluate(()=>{isMainOpen=false;center.configure({enabled:false,displaySeconds:5,listLimit:5});center.configure({enabled:true,displaySeconds:5,listLimit:5});});
  const compactCases=[
    {source:'webhook',title:'新消息',body:'构建完成',expectedTitle:'',lines:1},
    {source:'webhook',title:'新消息',body:'',expectedTitle:'新消息',lines:1},
    {source:'phone',title:'新消息',body:'手机通知正文',expectedTitle:'新消息',lines:2},
    {source:'webhook',title:'',body:'只有正文的消息',expectedTitle:'',lines:1},
    {source:'webhook',title:'部署成功',body:'',expectedTitle:'部署成功',lines:1},
    {source:'webhook',title:'部署成功',body:'可到后台查看结果',expectedTitle:'部署成功',lines:2}
  ];
  for(const [index,fixture] of compactCases.entries()){
    const {expectedTitle,lines,...payload}=fixture;
    await emit(event('compact-'+index,{app:'构建',...payload}));await settle();
    assert.equal(await page.textContent('#noticeTitle'),expectedTitle,'only the Webhook placeholder with a body is suppressed in the pill');
    const metrics=await page.locator('#noticeCompanion').evaluate(node=>{
      const box=node.getBoundingClientRect(),app=document.getElementById('noticeApp'),appBox=app.getBoundingClientRect();
      const text=['noticeTitle','noticeBody'].map(id=>document.getElementById(id)).filter(el=>el.textContent&&getComputedStyle(el).display!=='none').map(el=>{
        const rect=el.getBoundingClientRect(),style=getComputedStyle(el);
        return{top:rect.top,bottom:rect.bottom,right:rect.right,center:(rect.top+rect.bottom)/2,ellipsis:style.textOverflow==='ellipsis'};
      });
      return{center:(box.top+box.bottom)/2,top:box.top,bottom:box.bottom,right:box.right,appLeft:appBox.left,appRight:appBox.right,text};
    });
    assert.equal(metrics.text.length,lines);
    assert(metrics.text.every(text=>text.ellipsis&&text.top>=metrics.top&&text.bottom<=metrics.bottom),'pill text keeps ellipsis and fits the 38px surface');
    assert(metrics.appLeft>=Math.max(...metrics.text.map(text=>text.right))-1&&metrics.appRight<=metrics.right,'pill type stays in its own rightmost column');
    if(lines===1)assert(Math.abs(metrics.text[0].center-metrics.center)<=2,'a title-only or body-only pill is vertically centered');
  }

  await emit(event('compact-long',{source:'webhook',app:'Webhook',title:'新消息',body:'这是一条只有正文的长通知，胶囊应显示两行并在末尾省略。'.repeat(8)}));await settle();
  const bodyClamp=await page.locator('#noticeBody').evaluate(node=>{
    const style=getComputedStyle(node);return{height:node.getBoundingClientRect().height,lineHeight:parseFloat(style.lineHeight),clamp:Number(style.webkitLineClamp),text:node.textContent};
  });
  assert.equal(bodyClamp.clamp,2);assert(bodyClamp.height>bodyClamp.lineHeight*1.5&&bodyClamp.height<=bodyClamp.lineHeight*2+1);
  assert.equal(await page.locator('#noticeTitle').isVisible(),false);
  await emit(event('compact-source',{source:'phone',app:'Private app',title:'',body:''}));await settle();
  assert.equal(await page.locator('#noticeTitle').isVisible(),false);assert.equal(await page.locator('#noticeBody').isVisible(),false);
  assert.equal(await page.locator('#noticeApp').isVisible(),true,'privacy-redacted notifications still show their source');

  checks.push('pill text adapts to title/body presence, preserves real phone and title-only labels, omits only Webhook placeholders, and keeps the type on the right');

  await page.evaluate(()=>{
    center.configure({enabled:false,displaySeconds:5,listLimit:5});
    center.configure({enabled:true,displaySeconds:5,listLimit:5});
    for(let i=0;i<8;i++)center.receive({type:'posted',source:'retain',id:'r'+i,app:'App',title:'Row '+i,body:'Readable text on several lines. '.repeat(6)});
  });await settle();await click('#noticeCompanion');await settle();
  await page.evaluate(()=>{
    const items=document.getElementById('noticeItems'),rows=[...items.children],input=rows[2].querySelector('input');
    input.focus({preventScroll:true});items.scrollTop=80;
    window.retainedList={rows,input,scroll:items.scrollTop};
  });
  await emit({type:'posted',source:'retain',id:'r2',app:'App',title:'New 2',body:'Readable text on several lines. '.repeat(6)});
  await emit({type:'posted',source:'retain',id:'r8',app:'App',title:'Queued below visible rows',body:'Tail'});
  await settle();
  assert.deepEqual(await page.evaluate(()=>{
    const items=document.getElementById('noticeItems');
    return{sameRows:[...items.children].every((node,index)=>node===retainedList.rows[index]),
      sameInput:items.children[2].querySelector('input')===retainedList.input,focus:document.activeElement===retainedList.input,
      scroll:items.scrollTop,previousScroll:retainedList.scroll,checked:retainedList.input.checked,
      accessibleName:retainedList.input.getAttribute('aria-label')};
  }),{sameRows:true,sameInput:true,focus:true,scroll:80,previousScroll:80,checked:false,accessibleName:'关闭通知：New 2'});
  await click('#noticeItems input');await settle();
  assert.equal(await page.evaluate(()=>document.activeElement===document.querySelector('#noticeItems input')),true,'dismissal focuses the row that fills its current position');
  await click('#noticeItems input');await settle();
  assert.equal(await page.evaluate(()=>document.activeElement===retainedList.input),true,'a reused dismissal listener must use the current row index, not an old captured index');
  assert.equal(await page.evaluate(()=>document.querySelector('#noticeItems .notice-item')===retainedList.rows[2]),true);
  assert.equal((await rows())[0],'New 2');
  checks.push('same-ID edits and arrivals retain list nodes, checkbox identity, scroll and focus; repeated dismissals use the current index and refill the same focus position');

  await page.evaluate(()=>center.configure({enabled:false,displaySeconds:5,listLimit:5}));
  await emit(event('ignored'));await ack();assert.equal((await state()).count,0);
  assert.equal(await visible('#noticeCompanion'),false);assert.equal(await page.locator('#noticeItems').textContent(),'');
  await page.evaluate(()=>center.configure({enabled:true,displaySeconds:5,listLimit:5}));
  await emit(event('stale'));
  await page.evaluate(()=>center.configure({enabled:false,displaySeconds:5,listLimit:5}));await ack();
  assert.equal(await visible('#noticeCompanion'),false);
  assert.equal(await page.locator('#island').evaluate(node=>node.style.getPropertyValue('--notification-shift')),'0px');
  checks.push('disable clears memory and DOM; stale native ACK cannot reopen or shift the island');


  await page.evaluate(()=>center.configure({enabled:true,displaySeconds:5,listLimit:5}));
  await emit(event('outdated'));
  await page.evaluate(()=>{
    center.configure({enabled:false,displaySeconds:5,listLimit:5});
    center.configure({enabled:true,displaySeconds:5,listLimit:5});
  });
  await emit(event('current',{title:'Current only'}));
  await page.evaluate(()=>{for(const callback of layoutCallbacks.splice(0).reverse())callback?.();});
  await page.clock.runFor(40);
  await emit({type:'removed',source:'phone',id:'current'});
  await emit(event('replacement',{title:'Latest replacement'}));
  await page.evaluate(()=>{for(const callback of layoutCallbacks.splice(0).reverse())callback?.();});
  await settle();
  assert.equal((await state()).count,1);assert.equal((await state()).activeId,'replacement');
  assert.equal(await page.textContent('#noticeTitle'),'Latest replacement');
  assert.equal(await visible('#noticeBridge'),false,'the neck cannot remain after an interrupted animation settles');
  const stableLayoutCount=await page.evaluate(()=>layoutCalls.length);
  await page.evaluate(()=>{
    for(let i=0;i<32;i++)center.receive({type:'posted',source:'burst',id:String(i),app:'Burst',title:'Newest '+i,body:'Body '+i});
  });
  assert.equal((await state()).activeId,'31');assert.equal(await page.textContent('#noticeTitle'),'Newest 31');
  assert.equal(await page.evaluate(()=>layoutCalls.length),stableLayoutCount,'rapid arrivals within one geometry must not replay native layout or split animation');
  await page.evaluate(()=>center.configure({enabled:false,displaySeconds:5,listLimit:5}));await ack();
  await page.clock.runFor(1600);await ack();
  assert.equal((await state()).count,0);assert.equal(await visible('#noticeCompanion'),false);assert.equal(await visible('#noticeBridge'),false);
  assert.equal(await page.locator('#island').evaluate(node=>node.style.getPropertyValue('--notification-shift')),'0px');
  assert.equal(await page.evaluate(()=>['noticeCompanion','noticeSurface','noticePreview','noticeCount','noticeBridge'].reduce((sum,id)=>sum+(document.getElementById(id)?.getAnimations().filter(animation=>animation.playState==='running').length||0),0)),0);
  checks.push('reversed stale ACKs, interrupted removal/replacement and a 32-message burst retain only the newest state; disable cancels motion and cannot resurrect an old island');

  await page.evaluate(()=>{reduce=true;center.configure({enabled:true,displaySeconds:5,listLimit:5});});
  await emit(event('reduced'));
  assert.equal(await visible('#noticeCompanion'),false);await ack();
  assert.equal(await visible('#noticeCompanion'),true);
  assert.equal(await page.locator('#noticeCompanion').evaluate(node=>node.getAnimations().length),0);
  const before=await page.evaluate(()=>Date.now());
  await page.clock.setSystemTime(before+7000);
  await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await ack();
  assert.equal((await state()).mode,'count');
  checks.push('reduced motion still waits for clipping ACK; wall-clock focus recovery collapses overdue preview immediately');

  await page.evaluate(()=>center.suspend(true));
  await emit(event('during-effect'));await ack();
  assert.equal(await visible('#noticeCompanion'),false);
  await page.evaluate(()=>center.suspend(false));await ack();
  assert.equal((await state()).mode,'count');assert.equal((await state()).count,2);
  checks.push('completion effect suspends companion instantly and resumes unread count without replaying stale previews');

  await page.evaluate(()=>{center.configure({enabled:false,displaySeconds:5,listLimit:5});center.configure({enabled:true,displaySeconds:5,listLimit:5});});
  await emit(event('unsafe',{title:'<img src=x onerror=alert(1)>',body:'hello\u0000world\u202E'}));await ack();
  assert.equal(await page.locator('#noticeTitle').textContent(),'<img src=x onerror=alert(1)>');
  assert.equal(await page.locator('#noticeTitle img').count(),0);
  assert.equal((await state()).items[0].body,'hello world');
  await emit(event('bad\u0000id'));await emit(event('界'.repeat(86)));assert.equal((await state()).count,1);
  await page.evaluate(()=>{for(let i=0;i<220;i++)center.receive({type:'posted',source:'load',id:String(i),title:'Load '+i});});
  assert.equal((await state()).count,200);assert.equal((await state()).items[0].id,'20');
  checks.push('text is inert and control-cleaned; malformed identities are rejected; bounded memory keeps the newest 200');

  await page.evaluate(()=>center.clearSource('load'));await ack();
  assert.equal((await state()).count,0);assert.equal(await visible('#noticeCompanion'),false);
  assert.equal(await page.locator('#island').evaluate(node=>node.style.getPropertyValue('--notification-shift')),'0px');

  // Use a separate real-clock app page: Playwright's timer clock does not model WAAPI.
  const live=await browser.newPage({viewport:{width:580,height:580},reducedMotion:'no-preference'});
  live.on('pageerror',error=>errors.push('real-clock: '+error.message));
  const liveState={tasks:[],current_id:null,duration_sec:1500,
    settings:{showHands:true,showSecond:true,showIdleClock:true,showIdleEyes:false,sound:false,reduceMotion:false},
    notifications:{enabled:true,displaySeconds:5,listLimit:5},phone:{enabled:false,hideContent:false}};
  const liveSetup="window.messages=[];window.autoAck=true;window.ipc={postMessage(value){const message=JSON.parse(value);messages.push(message);if(autoAck&&message.requestId&&['setShape','setEffect','setNotificationLayout'].includes(message.type))queueMicrotask(()=>window.__viewportReady?.(message.requestId));}};window.__PLATFORM__='windows';\n";
  await live.setContent(template.replace('__VIEW__','island').replace('/*__GEO__*/',JSON.stringify({dial:340,effect:580,pillW:132,pillH:38}))
    .replace('/*__STATE__*/',JSON.stringify(liveState)).replace('/*__CSS__*/',()=>css).replace('/*__JS__*/',()=>liveSetup+controller+'\n'+app));
  const liveEmit=payload=>live.evaluate(payload=>__notificationEvent(payload),{type:'posted',source:'webhook',app:'Webhook',...payload});
  const liveSettle=()=>live.waitForFunction(()=>!document.getElementById('noticeCompanion').hidden&&document.getElementById('noticeCompanion').dataset.phase==='settled',null,{timeout:4000});
  const realShot=async name=>{await live.screenshot({path:path.join(output,name),omitBackground:true});artifacts.push(name);};
  const realCentered=async open=>{
    const metrics=await live.evaluate(open=>{
      const primary=document.querySelector(open?'#island':'.island__compact').getBoundingClientRect(),companion=document.getElementById('noticeCompanion').getBoundingClientRect();
      return{left:primary.left,right:companion.right,center:(primary.left+companion.right)/2,gap:companion.left-primary.right,height:companion.height};
    },open);
    assert(Math.abs(metrics.center-290)<1,'both islands must share the fixed canvas center after real animation');
    assert(Math.abs(metrics.gap-20)<1&&Math.abs(metrics.height-38)<1);
    assert(metrics.left>=6&&metrics.right<=574,'islands retain room for antialiased edges and soft shadow within the native canvas');
  };

  await live.evaluate(()=>{
    window.noticePaintTrace={done:false,frames:0,leaks:[]};
    const started=performance.now();
    const sample=()=>{
      const companion=document.getElementById('noticeCompanion'),surface=document.getElementById('noticeSurface'),preview=document.getElementById('noticePreview');
      if(!companion.hidden&&!preview.hidden&&Number(getComputedStyle(preview).opacity)>.08){
        const shell=surface.getBoundingClientRect();
        for(const id of ['noticeTitle','noticeBody','noticeApp']){
          const node=document.getElementById(id),box=node.getBoundingClientRect();
          if(!node.textContent||!box.height)continue;
          for(const x of [box.left+1,box.right-1]){
            if(x>=shell.left-1&&x<=shell.right+1)continue;
            const y=(box.top+box.bottom)/2,hit=document.elementFromPoint(x,y);
            if(hit&&(hit===node||node.contains(hit))&&noticePaintTrace.leaks.length<8)
              noticePaintTrace.leaks.push({id,x,shellLeft:shell.left,shellRight:shell.right,elapsed:performance.now()-started});
          }
        }
      }
      noticePaintTrace.frames++;
      if(performance.now()-started<650)requestAnimationFrame(sample);else noticePaintTrace.done=true;
    };
    requestAnimationFrame(sample);
  });
  await liveEmit({id:'visual',title:'新消息',body:'部署已完成，点击查看通知详情'});
  await live.waitForFunction(()=>!document.getElementById('noticeCompanion').hidden);
  await live.waitForTimeout(65);
  const liveTextScale=await live.locator('#noticePreview').evaluate(node=>{
    const transform=getComputedStyle(node).transform,matrix=transform==='none'?new DOMMatrix():new DOMMatrix(transform);
    return{scaleX:matrix.a,scaleY:matrix.d};
  });
  assert(Math.abs(liveTextScale.scaleX-1)<.001&&Math.abs(liveTextScale.scaleY-1)<.001,'the water-drop shell must not scale or blur its text');
  await realShot('notice-motion-separation.png');
  await live.waitForTimeout(80);await realShot('notice-motion-neck.png');
  await liveSettle();await live.waitForFunction(()=>noticePaintTrace.done,null,{timeout:3000});
  const paintTrace=await live.evaluate(()=>noticePaintTrace);
  assert(paintTrace.frames>=5,'real-time sampling must observe more than a single transition frame');
  assert.deepEqual(paintTrace.leaks,[],'visible text and type badge must stay clipped to the moving glass shell');
  await realCentered(false);await realShot('notice-preview-adaptive.png');
  await live.evaluate(()=>__selftestOpen());await liveSettle();
  await live.waitForFunction(()=>document.getElementById('island').classList.contains('is-open'));
  await live.waitForTimeout(700);await realCentered(true);await realShot('notice-expanded-adaptive.png');
  await live.evaluate(()=>__notificationsConfigResult({ok:true,settings:{enabled:true,displaySeconds:1,listLimit:5}}));
  await live.waitForFunction(()=>__notificationState().mode==='count');await liveSettle();await realCentered(true);
  await realShot('notice-count-adaptive.png');
  await liveEmit({id:'visual-long',title:'长通知完整阅读',body:'中文内容按自然段换行，无需挤在一行里。'.repeat(16)});
  await live.locator('#noticeCompanion').evaluate(node=>node.click());await liveSettle();
  await live.waitForTimeout(700);
  assert.equal(await live.locator('#noticeList').isVisible(),true);await realCentered(false);
  await realShot('notice-list-adaptive.png');

  // Interrupt live animation, then acknowledge an old layout after the new one.
  await live.evaluate(()=>{
    __notificationsConfigResult({ok:true,settings:{enabled:false,displaySeconds:5,listLimit:5}});
    __notificationsConfigResult({ok:true,settings:{enabled:true,displaySeconds:5,listLimit:5}});
    window.autoAck=false;window.raceStart=messages.length;
  });
  await liveEmit({id:'old-ack',title:'Obsolete'});
  await live.evaluate(()=>{
    __notificationsConfigResult({ok:true,settings:{enabled:false,displaySeconds:5,listLimit:5}});
    __notificationsConfigResult({ok:true,settings:{enabled:true,displaySeconds:5,listLimit:5}});
  });
  await liveEmit({id:'new-ack',title:'Survivor'});
  await live.evaluate(()=>{
    autoAck=true;
    for(const message of messages.slice(raceStart).filter(message=>message.requestId&&message.type==='setNotificationLayout').reverse())__viewportReady(message.requestId);
  });
  await live.waitForTimeout(65);
  await live.evaluate(()=>__notificationsConfigResult({ok:true,settings:{enabled:false,displaySeconds:5,listLimit:5}}));
  await live.waitForTimeout(850);
  assert.equal(await live.locator('#noticeCompanion').isVisible(),false);
  assert.equal(await live.locator('#noticeBridge').isVisible(),false);
  assert.equal(await live.evaluate(()=>__notificationState().count),0);
  await live.evaluate(()=>__notificationsConfigResult({ok:true,settings:{enabled:true,displaySeconds:5,listLimit:5}}));
  await liveEmit({id:'live-final',title:'Recovered',body:'A fresh notification after interruption'});
  await liveSettle();await realCentered(false);
  assert.equal(await live.evaluate(()=>__notificationState().activeId),'live-final');
  assert.equal(await live.evaluate(()=>__notificationState().count),1);
  assert.deepEqual(await live.evaluate(()=>messages.filter(message=>message.type==='frontendError')),[]);
  await live.close();
  checks.push('real-clock app renders separate water-drop shell and unscaled text, centered preview/count/list/expanded layouts, and recovers from interrupted motion plus reversed stale native ACKs');

  assert.deepEqual(errors,[]);
  checks.push('closing the final message restores one centered island with no frontend errors');
  await fs.mkdir(output,{recursive:true});
  await fs.writeFile(path.join(output,'notification-center-report.json'),JSON.stringify({passed:true,checks,errors,artifacts},null,2));
  console.log(JSON.stringify({passed:true,checks,errors,artifacts},null,2));
 }finally{await browser.close();}
}
run().catch(error=>{console.error(error);process.exitCode=1;});
