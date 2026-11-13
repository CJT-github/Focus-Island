/* Focus Island: one timer in the island WebView; settings is a command surface. */
(() => {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const hasOwn = (object,key) => Object.prototype.hasOwnProperty.call(object,key);
  const isPanel = document.body.dataset.view === 'panel';
  const hasNativeBridge = () => typeof window.ipc?.postMessage === 'function';
  function send(msg) {
    if (hasNativeBridge()) window.ipc.postMessage(JSON.stringify(msg));
  }
  window.addEventListener('error', e => send({type:'frontendError', message:e.message}));
  window.addEventListener('unhandledrejection', e => send({type:'frontendError', message:String(e.reason)}));

  const platform = window.__PLATFORM__==='macos'?'macos':'windows';
  const defaultCommandKind = platform==='macos'?'shell':'command';
  const isScriptKind = kind => kind==='command' || kind==='shell';
  const defaultCompletionAction = {enabled:false,kind:defaultCommandKind,command:'',delaySec:10};
  const actionKinds = {command:'Windows PowerShell',shell:'macOS Shell',lock:'锁屏',sleep:'睡眠',shutdown:'关机',restart:'重启'};
  const actionOptionLabels = {...actionKinds,
    command:platform==='windows'?'自定义 PowerShell 命令':'Windows PowerShell 命令',
    shell:platform==='macos'?'自定义 Shell 命令':'macOS Shell 命令',
    lock:platform==='macos'?'锁屏（当前 Mac 不支持）':'锁屏'};
  const defaults = {
    tasks: [{id:'t1',name:'深度工作',sec:1500},{id:'t2',name:'阅读论文',sec:2700},{id:'t3',name:'代码评审',sec:900}],
    current_id:'t1', duration_sec:1500,
    settings:{showHands:true,showSecond:true,showIdleClock:true,showIdleEyes:false,sound:true,notify:false,alwaysOnTop:true,reduceMotion:false,topOffset:20}
  };

  const notificationDefaults={enabled:true,displaySeconds:5,listLimit:5};
  function normalizedNotifications(value={}) {
    return {enabled:typeof value.enabled==='boolean'?value.enabled:true,
      displaySeconds:Number.isInteger(value.displaySeconds)&&value.displaySeconds>=1&&value.displaySeconds<=30?value.displaySeconds:5,
      listLimit:Number.isInteger(value.listLimit)&&value.listLimit>=1&&value.listLimit<=10?value.listLimit:5};
  }
  const webhookDefaults={enabled:false,scope:'local',port:17891,publicBaseUrl:''};
  function publicWebhookOrigin(value) {
    if(typeof value!=='string' || !value.trim())return '';
    const raw=value.trim();
    if(new TextEncoder().encode(raw).length>2048 || /[\u0000-\u001f\u007f-\u009f\\?#]/.test(raw) || !/^https:\/\//i.test(raw))return null;
    const authority=raw.slice(8).replace(/\/$/,'');
    if(!authority || /[\/@]/.test(authority) || authority.endsWith(':'))return null;
    try{
      const url=new URL(raw),host=url.hostname.replace(/\.$/,'');
      if(!url.hostname.startsWith('[') && (host.length>253 || host.split('.').some(label=>!label||label.length>63||!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label))))return null;
      if(url.protocol==='https:' && !url.username && !url.password && !url.search && !url.hash && url.pathname==='/' && url.port!=='0')return url.origin;
    }catch{}
    return null;
  }
  function normalizedWebhook(value={}) {
    return {enabled:value.enabled===true,scope:value.scope==='lan'?'lan':'local',
      port:Number.isInteger(value.port)&&value.port>=1024&&value.port<=65535?value.port:webhookDefaults.port,
      publicBaseUrl:publicWebhookOrigin(value.publicBaseUrl) || ''};
  }

  function normalizedRelay(value={}) {return {enabled:value.enabled===true,serviceUrl:publicWebhookOrigin(value.serviceUrl)||''};}
  const phoneDefaults={enabled:false,displaySeconds:8,hideContent:false,deviceAddress:'',deviceName:''};
  function normalizedPhone(value={}) {
    return {enabled:!!value.enabled,displaySeconds:Number.isInteger(value.displaySeconds)&&value.displaySeconds>=3&&value.displaySeconds<=30?value.displaySeconds:8,
      hideContent:!!value.hideContent,deviceAddress:typeof value.deviceAddress==='string'?value.deviceAddress:'',deviceName:typeof value.deviceName==='string'?value.deviceName:''};
  }
  let S = {...defaults, ...window.__STATE__};
  S.phone=normalizedPhone({...phoneDefaults,...S.phone});
  S.notifications=normalizedNotifications(S.notifications);
  S.webhook=normalizedWebhook(S.webhook);
  S.relay=normalizedRelay(S.relay);
  S.settings = {...defaults.settings, ...S.settings};
  const MAX_SEC = 359999;
  const duration = value => Math.min(MAX_SEC, Math.max(1, Math.trunc(Number(value) || 1500)));
  S.duration_sec = duration(S.duration_sec);
  let remain = S.duration_sec * 1000, total = remain;
  let running = false, done = false, timerStarted = false, deadline = 0, tickTimer = null;
  let lastTimerMessage = '', closeTimer = null, effectTimer = null, effectActive = false;
  let effectGeneration = 0, selftesting = false, durationDraftDirty = false;
  let runId = '', runTaskId = '', runTaskName = '', runSequence = 0;
  let topOffsetDraftDirty = false;
  let completedIdle = false, completionIdleTimer = null, completionIdleGeneration = 0, completionIdleAt = 0;
  const taskDurationDrafts = new Map(), taskDurationPending = new Map();
  let taskDurationSequence = Date.now();
  let actionDraftScope = null, actionDraftRevision = 0;
  const actionDrafts = new Map(), actionPending = new Map();
  let actionStatus = {phase:'idle',runId:''};
  let panelPage = 'timer', editingTaskId = '', settingsReturnTaskId = '', pendingTaskCreate = null;
  const panelScrollPositions = new Map();
  let panelNavigationRevision = 0;
  let taskCreateSequence = Date.now(), activeKindEditor = null;
  let kindMenuOpen = false, kindMenuIndex = 0, kindMenuTimer = null, kindMenuFrame = null;
  let phoneStatus={supported:platform==='macos'?false:null,phase:platform==='macos'?'unsupported':'idle',message:'',devices:[]};
  let phoneConfigPending=null;
  let webhookConfigPending=null,webhookTestPending=null,webhookDraftDirty=false,webhookDraftScope=S.webhook.scope;
  let webhookSequence=Date.now(),webhookToken='',webhookTokenVisible=false,webhookEndpointVisible=false;
  let webhookStatus={phase:'disabled',message:'',endpoint:'',lanAddresses:[],acceptedCount:0,lastReceivedAt:null};
  let relayConfigPending=null,relayDraftDirty=false,relayHasConnectionKey=window.__STATE__?.relay?.hasConnectionKey===true,relayWebhookToken='',relayTokenOrigin='',relayTokenRevision=null,relayTokenQueried=false,relayEndpointVisible=false;
  let relayStatus={phase:'disabled',message:'',acceptedCount:0,lastReceivedAt:null};
  let notificationCenter=null,noticeViewportPending=null,notificationsConfigPending=null,notificationsDraftDirty=false;

  const el = Object.fromEntries([
    'island','compactTime','idleEyes','readoutTask','readoutDigits','readoutChip','miniRing','dialProgress',
    'handHour','handMinute','handSecond','ticks','hourMarks','fx','btnToggle','btnReset',
    'taskList','presets','inH','inM','inS','durNote','inTaskName','inTaskMin','inTaskSec','taskNote',
    'swHands','swSecond','swIdleClock','swEyes','swSound','swNotify','swTop','swMotion',
    'inTopOffset','btnApplyTopOffset','topOffsetNote',
    'btnClose','btnStart','btnReset2','btnClear','btnAddTask','btnApplyCustom','expanded',
    'actionScope','actionEnabled','actionKind','actionCommand','actionCommandField','actionDelay','btnSaveAction','actionConfigNote',
    'panelAction','btnCancelPanelAction',
    'panelNav','preferencesPage','btnOpenTimerPage','btnOpenPreferencesPage','timerNavStatus','phoneNavStatus',
    'settingsPage','taskCreatePage','taskSettingsPage','taskSettingsDuration','btnOpenTaskPage','btnTaskBack','btnCancelTask','panelTitle',
    'actionKindTrigger','actionKindValue','actionKindMenu',
    'editTaskMin','editTaskSec','btnSaveTaskDuration','taskDurationNote',
    'createActionEnabled','createActionKind','createActionCommand','createActionCommandField','createActionDelay',
    'createActionKindTrigger','createActionKindValue',
    'phonePage','btnOpenPhonePage','phoneEnabled','phoneHideContent','phoneConfigNote',
    'btnPhoneScan','phoneDevices','btnPhoneDisconnect','phoneStatus','phoneSupportNote','phoneAccessNote',
    'notificationsSettings','notificationsEnabled',
    'notificationDisplaySeconds','notificationListLimit','btnSaveNotifications','notificationsConfigNote','btnTestNotification','btnPhoneNotificationSettings',
    'webhookPage','btnOpenWebhookPage','webhookNavStatus','webhookEnabled','webhookPort','webhookScopeLocal','webhookScopeLan',
    'webhookPublicBaseUrl','webhookPublicNote','btnRevealWebhookEndpoint','webhookScopeNote','webhookPhase','webhookStatusText','webhookActivity','webhookEndpoint','btnCopyWebhookEndpoint','webhookToken',
    'btnRevealWebhookToken','btnCopyWebhookToken','btnRotateWebhookToken','btnSaveWebhook','webhookConfigNote','btnTestWebhook',
    'relayEnabled','relayServiceUrl','relayConnectionKey','relayKeyNote','btnSaveRelay','relayConfigNote','relayPhase','relayStatusText','relayActivity','relayEndpoint','btnRevealRelayEndpoint','btnCopyRelayEndpoint','relayCopyNote',
    'webhookCopyNote','webhookTestNote','webhookCurlExample','webhookPowerShellExample','webhookLanAddresses','webhookNotificationNote','btnWebhookNotifications'
  ].map(id => [id, $('#'+id)]));

  // Register features once; child pages inherit their feature's menu item.
  const panelRoutes = {
    timer:{element:'settingsPage',title:'倒计时',menu:'btnOpenTimerPage'},
    webhook:{element:'webhookPage',title:'Webhook',menu:'btnOpenWebhookPage'},
    phone:{element:'phonePage',title:'手机通知',menu:'btnOpenPhonePage'},
    preferences:{element:'preferencesPage',title:'通用设置',menu:'btnOpenPreferencesPage'},
    create:{element:'taskCreatePage',title:'新增任务',parent:'timer'},
    task:{element:'taskSettingsPage',title:'任务设置',parent:'timer'}
  };
  const panelRoot = page => panelRoutes[page].parent || page;

  const currentTask = () => S.tasks.find(t => t.id === S.current_id);
  // A saved selection chooses the next task; only a started timer occupies the island.
  const clockIdle = () => completedIdle || !timerStarted;
  const pad = n => String(Math.floor(n)).padStart(2,'0');
  const seconds = ms => Math.max(0, Math.ceil(ms / 1000));
  function fmtHMS(ms) {
    const s = seconds(ms);
    return pad(s / 3600)+':'+pad((s % 3600) / 60)+':'+pad(s % 60);
  }
  function fmtMS(ms) {
    const s = seconds(ms), h = Math.floor(s / 3600);
    return h ? h+':'+pad((s % 3600) / 60)+':'+pad(s % 60) : pad(s / 60)+':'+pad(s % 60);
  }
  function durLabel(sec) {
    const parts = [];
    if (sec >= 3600) parts.push(Math.floor(sec / 3600)+' 小时');
    if (sec % 3600 >= 60) parts.push(Math.floor(sec % 3600 / 60)+' 分');
    if (sec % 60 || !parts.length) parts.push(sec % 60+' 秒');
    return parts.join(' ');
  }
  const motionPreference = window.matchMedia('(prefers-reduced-motion: reduce)');
  const reducedMotion = () => S.settings.reduceMotion || motionPreference.matches;

  const phoneText=(value,max)=>typeof value==='string'?value.slice(0,max):'';

  function reconcileNotifications() {
    if(isPanel)return;
    notificationCenter?.configure(S.notifications);
    if(!S.phone.enabled || phoneStatus.supported===false || phoneStatus.notificationAccess===false)notificationCenter?.clearSource('phone');
    else if(S.phone.hideContent)notificationCenter?.redactSource('phone');
  }
  function renderNotificationsPanel() {
    if(!isPanel)return;
    if(!notificationsDraftDirty && !notificationsConfigPending){
      el.notificationsEnabled.checked=S.notifications.enabled;
      el.notificationDisplaySeconds.value=S.notifications.displaySeconds;
      el.notificationListLimit.value=S.notifications.listLimit;
    }
    for(const node of [el.notificationsEnabled,el.notificationDisplaySeconds,el.notificationListLimit,el.btnSaveNotifications])node.disabled=!!notificationsConfigPending;
    el.btnTestNotification.disabled=!S.notifications.enabled || !!notificationsConfigPending;
  }
  function saveNotificationsConfig() {
    if(!isPanel || notificationsConfigPending)return;
    const displaySeconds=inputValue(el.notificationDisplaySeconds),listLimit=inputValue(el.notificationListLimit);
    if(displaySeconds===null)return showError(el.notificationsConfigNote,'停留时间请输入 1–30 之间的整数秒');
    if(listLimit===null)return showError(el.notificationsConfigNote,'列表数量请输入 1–10 之间的整数');
    const settings={enabled:el.notificationsEnabled.checked,displaySeconds,listLimit};
    notificationsConfigPending={settings};notificationsDraftDirty=true;renderNotificationsPanel();
    el.notificationsConfigNote.textContent='正在保存…';el.notificationsConfigNote.classList.remove('is-error');
    send({type:'notificationsConfigure',settings});
  }
  window.__notificationsConfigResult=payload=>{
    if(!payload || typeof payload!=='object')return;
    if(payload.ok) {S.notifications=normalizedNotifications(payload.settings);notificationsDraftDirty=false;}
    notificationsConfigPending=null;renderNotificationsPanel();reconcileNotifications();
    if(isPanel){el.notificationsConfigNote.textContent=phoneText(payload.message,500)||(payload.ok?'设置已保存':'保存失败，请重试');el.notificationsConfigNote.classList.toggle('is-error',!payload.ok);}
  };
  window.__notificationEvent=payload=>{
    if(!isPanel)notificationCenter?.receive(payload);
  };
  const relayDeliveries=new Set();
  window.__relayNotification=payload=>{
    if(isPanel||!S.notifications.enabled||!notificationCenter||!payload||typeof payload!=='object')return false;
    const validId=value=>typeof value==='string'&&value.length>0&&!/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(value)&&new TextEncoder().encode(value).length<=256;
    if(!validId(payload.deliveryId))return false;
    const notification=payload.notification;
    if(!notification||typeof notification!=='object'||!['posted','removed'].includes(notification.type)||!validId(notification.id))return false;
    if(['app','title','body'].some(name=>hasOwn(notification,name)&&typeof notification[name]!=='string'))return false;
    if(notification.type==='posted'&&![notification.title,notification.body].some(value=>typeof value==='string'&&value.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,' ').trim()))return false;
    if(relayDeliveries.has(payload.deliveryId))return true;
    try{window.__notificationEvent({...notification,source:'webhook'});}catch{return false;}
    relayDeliveries.add(payload.deliveryId);
    while(relayDeliveries.size>200)relayDeliveries.delete(relayDeliveries.values().next().value);
    return true;
  };
  window.__notificationState=()=>notificationCenter?.getState();
  function webhookText(value,max=500) {
    return typeof value==='string'?value.replace(/[\u0000-\u001f\u007f-\u009f]/g,' ').slice(0,max):'';
  }
  function updateWebhookToken(value) {
    if(typeof value!=='string')return;
    webhookToken=/^[A-Za-z0-9_-]{16,256}$/.test(value)?value:'';
    webhookTokenVisible=false;webhookEndpointVisible=false;
    el.webhookCopyNote.textContent='';
  }
  function relayEndpoint() {
    return relayStatus.phase==='connected' && S.relay.enabled && S.relay.serviceUrl && relayTokenOrigin===S.relay.serviceUrl && relayWebhookToken?
      S.relay.serviceUrl+'/api/webhook/'+relayWebhookToken:'';
  }
  function renderRelayPanel() {
    if(!isPanel)return;
    const busy=!!relayConfigPending;
    if(!relayDraftDirty&&!busy){el.relayEnabled.checked=S.relay.enabled;el.relayServiceUrl.value=S.relay.serviceUrl;}
    for(const node of [el.relayEnabled,el.relayServiceUrl,el.relayConnectionKey,el.btnSaveRelay])node.disabled=busy;
    el.relayConnectionKey.placeholder=relayHasConnectionKey?'已保存；留空继续使用':'粘贴服务器提供的 64 位连接密钥';
    el.relayKeyNote.textContent=relayHasConnectionKey?'连接密钥已保存；留空表示保留；更换服务地址时，请重新填写对应密钥。':'连接密钥由服务器提供，只用于此程序连接服务器。';
    const phases={disabled:'未连接',connecting:'正在连接',connected:'已连接',reconnecting:'正在重连',error:'连接失败'};
    const phase=relayStatus.phase;
    el.relayPhase.textContent=phases[phase]||'未连接';el.relayPhase.dataset.phase=phase;
    el.relayStatusText.textContent=relayStatus.message || (phase==='connected'?'服务器连接正常，可将下方专属地址填到外部系统。':phase==='disabled'?'填写服务地址和连接密钥，保存后由程序自动连接。':phase==='error'?'请检查服务器地址和连接密钥后重试。':'正在建立安全连接，请保持程序运行。');
    const date=new Date(relayStatus.lastReceivedAt||NaN),last=Number.isFinite(date.getTime())?date.toLocaleTimeString('zh-CN',{hour12:false}):'尚未收到';
    el.relayActivity.textContent='已接收 '+relayStatus.acceptedCount+' 条 · 最近消息 '+last;
    const endpoint=relayEndpoint();
    el.relayEndpoint.value=endpoint;el.relayEndpoint.type=relayEndpointVisible?'text':'password';
    el.btnRevealRelayEndpoint.textContent=relayEndpointVisible?'隐藏':'显示';el.btnRevealRelayEndpoint.setAttribute('aria-pressed',String(relayEndpointVisible));
    el.btnRevealRelayEndpoint.disabled=busy||!endpoint;el.btnCopyRelayEndpoint.disabled=busy||!endpoint;
    el.btnSaveRelay.textContent=busy?'正在保存…':el.relayEnabled.checked?'保存并连接':'保存设置';
    if(S.relay.enabled)el.webhookNavStatus.textContent=phase==='connected'?'服务器已连接':phases[phase]||'正在连接';
  }
  function markRelayDraft() {
    if(relayConfigPending)return;
    relayDraftDirty=true;
    el.relayServiceUrl.setAttribute('aria-invalid','false');el.relayConnectionKey.setAttribute('aria-invalid','false');
    el.relayConfigNote.textContent='尚未保存';el.relayConfigNote.classList.remove('is-error');renderRelayPanel();
  }
  function saveRelayConfig() {
    if(!isPanel||relayConfigPending)return;
    const enabled=el.relayEnabled.checked,serviceUrl=publicWebhookOrigin(el.relayServiceUrl.value),connectionKey=el.relayConnectionKey.value.trim();
    const invalidUrl=serviceUrl===null || (enabled&&!serviceUrl);
    el.relayServiceUrl.setAttribute('aria-invalid',String(invalidUrl));
    if(invalidUrl)return showError(el.relayConfigNote,'服务地址请输入 HTTPS 域名，可带端口，不要包含路径、查询参数或账号密码');
    const invalidKey=connectionKey?!/^[0-9a-f]{64}$/i.test(connectionKey):enabled&&(!relayHasConnectionKey||serviceUrl!==S.relay.serviceUrl);
    el.relayConnectionKey.setAttribute('aria-invalid',String(invalidKey));
    if(invalidKey)return showError(el.relayConfigNote,'请输入服务器提供的 64 位十六进制连接密钥');
    const settings={enabled,serviceUrl};if(connectionKey)settings.connectionKey=connectionKey;
    const requestId=++webhookSequence,pending={requestId,settings:{enabled,serviceUrl},timeout:null};
    relayConfigPending=pending;relayDraftDirty=true;
    pending.timeout=setTimeout(()=>{
      if(relayConfigPending!==pending)return;
      relayConfigPending=null;showError(el.relayConfigNote,'未收到保存结果，请检查连接状态后重试。');renderRelayPanel();send({type:'relayStatus'});
    },12000);
    el.relayConfigNote.textContent='正在保存…';el.relayConfigNote.classList.remove('is-error');renderRelayPanel();
    send({type:'relayConfigure',settings,requestId});
  }
  window.__relayStatus=payload=>{
    if(!isPanel||!payload||typeof payload!=='object')return;
    const revision=Number.isSafeInteger(payload.tokenRevision)&&payload.tokenRevision>=0?payload.tokenRevision:null;
    if(revision!==null && relayTokenRevision!==null && revision<relayTokenRevision)return;
    if(revision!==null && revision!==relayTokenRevision){
      relayTokenRevision=revision;relayWebhookToken='';relayTokenOrigin='';relayTokenQueried=false;relayEndpointVisible=false;
    }
    const nextPhase=['disabled','connecting','connected','reconnecting','error'].includes(payload.phase)?payload.phase:'disabled';
    if(nextPhase!=='connected'||relayStatus.phase!=='connected'){relayWebhookToken='';relayTokenOrigin='';relayTokenQueried=false;relayEndpointVisible=false;}
    if(payload.settings){
      const settings=normalizedRelay(payload.settings);
      if(settings.serviceUrl!==S.relay.serviceUrl||(relayTokenOrigin&&settings.serviceUrl!==relayTokenOrigin)||!settings.enabled){relayWebhookToken='';relayTokenOrigin='';relayTokenQueried=false;relayEndpointVisible=false;}
      S.relay=settings;
    }
    if(typeof payload.hasConnectionKey==='boolean')relayHasConnectionKey=payload.hasConnectionKey;
    if(hasOwn(payload,'webhookToken')){
      relayWebhookToken=typeof payload.webhookToken==='string'&&/^[0-9a-f]{64}$/i.test(payload.webhookToken)?payload.webhookToken:'';
      relayTokenOrigin=relayWebhookToken?S.relay.serviceUrl:'';
      relayEndpointVisible=false;el.relayCopyNote.textContent='';
    }
    relayStatus={phase:['disabled','connecting','connected','reconnecting','error'].includes(payload.phase)?payload.phase:'disabled',
      message:webhookText(payload.message),acceptedCount:Number.isSafeInteger(payload.acceptedCount)&&payload.acceptedCount>=0?payload.acceptedCount:0,
      lastReceivedAt:typeof payload.lastReceivedAt==='number'||typeof payload.lastReceivedAt==='string'?payload.lastReceivedAt:null};
    renderWebhookPanel();
    if(relayStatus.phase==='connected'&&!relayWebhookToken&&!relayTokenQueried){relayTokenQueried=true;send({type:'relayStatus'});}
  };
  window.__relayConfigResult=payload=>{
    if(!isPanel||!payload||!relayConfigPending||payload.requestId!==relayConfigPending.requestId)return;
    const pending=relayConfigPending;clearTimeout(pending.timeout);relayConfigPending=null;
    if(payload.ok){
      const settings=normalizedRelay(payload.settings||pending.settings);
      if(settings.serviceUrl!==S.relay.serviceUrl||(relayTokenOrigin&&settings.serviceUrl!==relayTokenOrigin)||!settings.enabled){relayWebhookToken='';relayTokenOrigin='';relayTokenQueried=false;relayEndpointVisible=false;}
      S.relay=settings;relayWebhookToken='';relayTokenOrigin='';relayTokenQueried=false;relayEndpointVisible=false;relayDraftDirty=false;el.relayConnectionKey.value='';
      if(typeof payload.hasConnectionKey==='boolean')relayHasConnectionKey=payload.hasConnectionKey;
    }
    el.relayConfigNote.textContent=webhookText(payload.message)||(payload.ok?'设置已保存，连接状态见上方。':'保存失败，请重试');
    el.relayConfigNote.classList.toggle('is-error',!payload.ok);renderWebhookPanel();send({type:'relayStatus'});
  };
  function webhookBaseEndpoint() {
    if(S.webhook.publicBaseUrl)return S.webhook.publicBaseUrl+'/api/webhook';
    const local='http://127.0.0.1:'+S.webhook.port+'/api/webhook';
    if(S.webhook.scope==='lan' && webhookStatus.lanAddresses.length){
      const address=webhookStatus.lanAddresses[0];
      if(/^(?:\d{1,3}\.){3}\d{1,3}$/.test(address) && address.split('.').every(part=>Number(part)<=255))return 'http://'+address+':'+S.webhook.port+'/api/webhook';
    }
    try{
      const url=new URL(webhookStatus.endpoint);
      if(url.protocol==='http:' && url.hostname==='127.0.0.1' && url.pathname==='/api/webhook' && !url.username && !url.password && !url.search && !url.hash)return url.href;
    }catch{}
    return local;
  }
  function webhookEndpoint() {return webhookToken?webhookBaseEndpoint()+'/'+webhookToken:'';}
  function webhookScopeNote() {
    const scope=webhookDraftDirty?webhookDraftScope:S.webhook.scope;
    const port=Number(el.webhookPort.value);
    const changeNeedsRestart=webhookStatus.phase==='listening' && scope!==S.webhook.scope && port===S.webhook.port;
    const hint=scope==='lan'?'同一局域网的设备可访问；只在信任的网络开启。':'仅此电脑上的应用和脚本可以访问。';
    return hint+(changeNeedsRestart?' 切换范围前，请先关闭服务并保存，或同时更换端口。':'');
  }
  function renderWebhookPanel() {
    if(!isPanel)return;
    const busy=!!webhookConfigPending;
    if(!webhookDraftDirty && !busy){
      el.webhookEnabled.checked=S.webhook.enabled;
      el.webhookPort.value=S.webhook.port;
      el.webhookPublicBaseUrl.value=S.webhook.publicBaseUrl;
      webhookDraftScope=S.webhook.scope;
    }
    for(const node of [el.webhookEnabled,el.webhookPort,el.webhookPublicBaseUrl,el.webhookScopeLocal,el.webhookScopeLan,el.btnSaveWebhook,el.btnRotateWebhookToken])node.disabled=busy;
    for(const [node,scope] of [[el.webhookScopeLocal,'local'],[el.webhookScopeLan,'lan']]){
      const selected=webhookDraftScope===scope;
      node.setAttribute('aria-pressed',String(selected));node.classList.toggle('is-active',selected);
    }
    el.webhookScopeNote.textContent=webhookScopeNote();
    const phases={disabled:'已关闭',listening:'正在接收',error:'启动失败'};
    const phase=webhookStatus.phase;
    el.webhookNavStatus.textContent=phases[phase] || '已关闭';
    el.webhookPhase.textContent=phases[phase] || '已关闭';
    el.webhookPhase.dataset.phase=phase;
    el.webhookStatusText.textContent=webhookStatus.message || (phase==='listening'?'外部消息将展示在通知框中。':phase==='error'?'请调整设置后重新保存。':'保存并开启后，即可接收外部消息。');
    const count=webhookStatus.acceptedCount;
    const date=new Date(webhookStatus.lastReceivedAt || NaN);
    const last=Number.isFinite(date.getTime())?date.toLocaleTimeString('zh-CN',{hour12:false}):'尚未收到';
    el.webhookActivity.textContent='已接收 '+count+' 条 · 最近消息 '+last;
    const endpoint=webhookEndpoint();
    el.webhookEndpoint.value=endpoint;
    el.webhookEndpoint.type=webhookEndpointVisible?'text':'password';
    el.webhookEndpoint.placeholder='保存设置或生成令牌后获得专属地址';
    el.btnRevealWebhookEndpoint.textContent=webhookEndpointVisible?'隐藏':'显示';
    el.btnRevealWebhookEndpoint.setAttribute('aria-pressed',String(webhookEndpointVisible));
    el.btnRevealWebhookEndpoint.disabled=busy || !webhookToken;
    el.btnCopyWebhookEndpoint.disabled=busy || !webhookToken;
    el.webhookPublicNote.textContent=S.webhook.publicBaseUrl?'已填写公网入口；请确认服务器 HTTPS 反向代理与 SSH 反向隧道已连接到本机，并保持程序运行。':'可先用本机地址；公网入口可连接到仅本机监听的服务，填写地址不会自动建立公网连接。';
    el.webhookLanAddresses.hidden=S.webhook.scope!=='lan';
    el.webhookLanAddresses.textContent=webhookStatus.lanAddresses.length?
      '可用局域网 IP：'+webhookStatus.lanAddresses.join('、')+'。其他设备请使用这台电脑的局域网地址。':
      '未检测到局域网地址；其他设备访问时，请将 127.0.0.1 替换为这台电脑的局域网 IP。';
    el.webhookToken.type=webhookTokenVisible?'text':'password';
    el.webhookToken.value=webhookToken;
    el.webhookToken.placeholder='保存设置或生成令牌后显示';
    el.btnRevealWebhookToken.textContent=webhookTokenVisible?'隐藏':'显示';
    el.btnRevealWebhookToken.setAttribute('aria-pressed',String(webhookTokenVisible));
    el.btnRevealWebhookToken.disabled=busy || !webhookToken;
    el.btnCopyWebhookToken.disabled=busy || !webhookToken;
    el.btnRotateWebhookToken.textContent=webhookToken?'重新生成':'生成令牌';
    el.webhookNotificationNote.hidden=S.notifications.enabled;
    el.btnTestWebhook.disabled=busy || !!webhookTestPending || phase!=='listening' || !S.notifications.enabled;
    renderRelayPanel();
    const json=JSON.stringify({msg_type:'text',content:{text:'部署完成'}});
    el.webhookCurlExample.textContent="curl -X POST 'YOUR_WEBHOOK_URL' \\\n  -H 'Content-Type: application/json' \\\n  --data-raw '"+json+"'";
    el.webhookPowerShellExample.textContent="$body = @{ msg_type = 'text'; content = @{ text = '部署完成' } } | ConvertTo-Json\nInvoke-RestMethod -Method Post -Uri 'YOUR_WEBHOOK_URL' -ContentType 'application/json; charset=utf-8' -Body ([System.Text.Encoding]::UTF8.GetBytes($body))";
  }
  function markWebhookDraft() {
    if(webhookConfigPending)return;
    webhookDraftDirty=true;
    el.webhookPort.setAttribute('aria-invalid','false');
    el.webhookPublicBaseUrl.setAttribute('aria-invalid','false');
    el.webhookConfigNote.textContent='尚未保存';
    el.webhookConfigNote.classList.remove('is-error');
    renderWebhookPanel();
  }
  function requestWebhookStatus() {
    if(isPanel){send({type:'webhookStatus'});send({type:'relayStatus'});}
  }
  function startWebhookMutation(kind,settings) {
    const requestId=++webhookSequence;
    const pending={requestId,kind,settings,timeout:null};
    webhookConfigPending=pending;
    pending.timeout=setTimeout(()=>{
      if(webhookConfigPending!==pending)return;
      webhookConfigPending=null;
      showError(el.webhookConfigNote,'未收到保存结果，请检查服务状态后重试。');
      renderWebhookPanel();requestWebhookStatus();
    },12000);
    renderWebhookPanel();
    el.webhookConfigNote.classList.remove('is-error');
    el.webhookConfigNote.textContent=kind==='rotate'?'正在生成新令牌…':'正在保存…';
    send(kind==='rotate'?{type:'webhookRotateToken',requestId}:{type:'webhookConfigure',settings,requestId});
  }
  function saveWebhookConfig() {
    if(!isPanel || webhookConfigPending)return;
    const port=inputValue(el.webhookPort);
    if(port===null)return showError(el.webhookConfigNote,'端口请输入 1024–65535 之间的整数');
    const publicBaseUrl=publicWebhookOrigin(el.webhookPublicBaseUrl.value);
    el.webhookPublicBaseUrl.setAttribute('aria-invalid',String(publicBaseUrl===null));
    if(publicBaseUrl===null)return showError(el.webhookConfigNote,'公网入口请输入 HTTPS 域名，可带端口，不要包含路径、查询参数或账号密码');
    webhookDraftDirty=true;
    startWebhookMutation('configure',{enabled:el.webhookEnabled.checked,scope:webhookDraftScope,port,publicBaseUrl});
  }
  function rotateWebhookToken() {
    if(!isPanel || webhookConfigPending)return;
    startWebhookMutation('rotate');
  }
  async function copyWebhookValue(value,field,label,note=el.webhookCopyNote) {
    if(!value)return;
    let copied=false;
    try{
      if(navigator.clipboard?.writeText){await navigator.clipboard.writeText(value);copied=true;}
    }catch{}
    if(!copied){
      const active=document.activeElement,copy=document.createElement('textarea');
      copy.value=value;copy.readOnly=true;copy.setAttribute('aria-hidden','true');
      copy.style.cssText='position:fixed;left:-9999px;top:0;opacity:0;';
      document.body.append(copy);
      try{copy.select();copied=!!document.execCommand('copy');}catch{}
      finally{copy.remove();active?.focus?.({preventScroll:true});}
    }
    if(!copied && field.type!=='password'){field.focus();field.select();}
    note.textContent=copied?label+'已复制':label+'无法自动复制，请手动选择复制。';
    note.classList.toggle('is-error',!copied);
  }
  function sendWebhookTest() {
    if(!isPanel || webhookConfigPending || webhookTestPending || webhookStatus.phase!=='listening' || !S.notifications.enabled)return;
    const requestId=++webhookSequence,pending={requestId,timeout:null};
    webhookTestPending=pending;
    pending.timeout=setTimeout(()=>{
      if(webhookTestPending!==pending)return;
      webhookTestPending=null;renderWebhookPanel();
      showError(el.webhookTestNote,'测试请求未及时返回，请检查服务是否仍在运行。');
    },12000);
    el.webhookTestNote.textContent='正在通过 HTTP 发送测试消息…';
    el.webhookTestNote.classList.remove('is-error');renderWebhookPanel();
    send({type:'webhookTest',requestId});
  }
  window.__webhookStatus=payload=>{
    if(!isPanel || !payload || typeof payload!=='object')return;
    if(payload.settings)S.webhook=normalizedWebhook(payload.settings);
    if(hasOwn(payload,'token'))updateWebhookToken(payload.token);
    webhookStatus={
      phase:['disabled','listening','error'].includes(payload.phase)?payload.phase:'disabled',
      message:webhookText(payload.message),endpoint:webhookText(payload.endpoint,256),
      lanAddresses:Array.isArray(payload.lanAddresses)?payload.lanAddresses.filter(address=>typeof address==='string' && /^(?:\d{1,3}\.){3}\d{1,3}$/.test(address) && address.split('.').every(part=>Number(part)<=255)).slice(0,16):[],
      acceptedCount:Number.isSafeInteger(payload.acceptedCount)&&payload.acceptedCount>=0?payload.acceptedCount:0,
      lastReceivedAt:typeof payload.lastReceivedAt==='number'||typeof payload.lastReceivedAt==='string'?payload.lastReceivedAt:null
    };
    renderWebhookPanel();
  };
  window.__webhookConfigResult=payload=>{
    if(!isPanel || !payload || !webhookConfigPending || payload.requestId!==webhookConfigPending.requestId)return;
    const pending=webhookConfigPending;clearTimeout(pending.timeout);webhookConfigPending=null;
    if(payload.ok){
      S.webhook=normalizedWebhook(payload.settings || pending.settings || S.webhook);
      if(pending.kind==='configure')webhookDraftDirty=false;
      if(hasOwn(payload,'token'))updateWebhookToken(payload.token);
    }
    el.webhookConfigNote.textContent=webhookText(payload.message) || (payload.ok?(pending.kind==='rotate'?'新令牌已生成，旧令牌已失效。':'设置已保存'):'保存失败，请重试');
    el.webhookConfigNote.classList.toggle('is-error',!payload.ok);
    renderWebhookPanel();requestWebhookStatus();
  };
  window.__webhookTestResult=payload=>{
    if(!isPanel || !payload || !webhookTestPending || payload.requestId!==webhookTestPending.requestId)return;
    clearTimeout(webhookTestPending.timeout);webhookTestPending=null;
    el.webhookTestNote.textContent=webhookText(payload.message) || (payload.ok?'测试消息已通过 HTTP 送达。':'发送失败，请检查服务设置。');
    el.webhookTestNote.classList.toggle('is-error',!payload.ok);
    renderWebhookPanel();requestWebhookStatus();
  };


  function renderPhonePanel() {
    if(!isPanel)return;
    const unsupported=platform==='macos' || phoneStatus.supported===false,busy=!!phoneConfigPending;
    if(!busy){el.phoneEnabled.checked=S.phone.enabled;el.phoneHideContent.checked=S.phone.hideContent;}
    for(const node of [el.phoneEnabled,el.phoneHideContent])node.disabled=unsupported || busy;
    el.phoneSupportNote.textContent=unsupported?'本版手机通知仅支持 Windows + Android。':phoneStatus.supported===null?'正在检查此电脑的蓝牙支持…':'';
    const phases={disabled:'同步已关闭',idle:'等待连接',scanning:'正在扫描设备…',connecting:'正在连接…',connected:'已连接',reconnecting:'正在重新连接…',error:'连接失败',unsupported:'此设备不支持手机通知'};
    const phase=!S.phone.enabled?'disabled':phoneStatus.phase;
    const name=phoneStatus.deviceName || S.phone.deviceName;
    el.phoneNavStatus.textContent=unsupported?'暂不支持':!S.phone.enabled?'未开启':phases[phase] || '等待连接';
    el.phoneStatus.textContent=(phases[phase] || '等待连接')+(name && phase==='connected'?' · '+name:'')+(phoneStatus.message && S.phone.enabled?' · '+phoneStatus.message:'');
    el.phoneAccessNote.textContent=S.phone.enabled && phoneStatus.notificationAccess===false?'请在 Android 手机端允许通知访问。':'';
    const ready=!unsupported && phoneStatus.supported===true && S.phone.enabled && !busy;
    el.btnPhoneScan.disabled=!ready || ['scanning','connecting','reconnecting'].includes(phase);
    el.btnPhoneScan.textContent=phase==='scanning'?'扫描中…':'扫描设备';
    el.btnPhoneDisconnect.hidden=!S.phone.deviceAddress && !phoneStatus.deviceAddress && phase!=='connected' && phase!=='connecting' && phase!=='reconnecting';
    el.btnPhoneDisconnect.disabled=unsupported || busy;
    el.phoneDevices.replaceChildren();
    for(const device of phoneStatus.devices || []){
      const li=document.createElement('li');li.className='phone-device';
      const info=document.createElement('span');info.className='phone-device__info';
      const label=document.createElement('span');label.className='phone-device__name';label.textContent=device.name || 'Android 手机';
      const address=document.createElement('span');address.className='phone-device__address';address.textContent=device.address;
      const button=document.createElement('button');button.className='btn btn--sm';button.dataset.phoneAddress=device.address;
      const connected=phase==='connected' && device.address===phoneStatus.deviceAddress;
      button.textContent=connected?'已连接':'连接';button.disabled=!ready || connected || ['connecting','reconnecting'].includes(phase);
      button.addEventListener('click',()=>send({type:'phoneConnect',address:device.address}));
      info.append(label,address);li.append(info,button);el.phoneDevices.append(li);
    }
  }
  function savePhoneConfig() {
    if(!isPanel || phoneConfigPending || platform==='macos' || phoneStatus.supported===false)return;
    const settings={enabled:el.phoneEnabled.checked,displaySeconds:S.phone.displaySeconds,hideContent:el.phoneHideContent.checked};
    phoneConfigPending={previous:{...S.phone}};
    S.phone=normalizedPhone({...S.phone,...settings});renderPhonePanel();
    el.phoneConfigNote.classList.remove('is-error');el.phoneConfigNote.textContent='正在保存…';
    send({type:'phoneConfigure',settings});
  }
  window.__phoneStatus=payload=>{
    if(!payload || typeof payload!=='object')return;
    const wasConnected=phoneStatus.phase==='connected';
    phoneStatus={...phoneStatus,...payload,supported:platform==='macos'?false:payload.supported===true,
      message:phoneText(payload.message,500),deviceName:phoneText(payload.deviceName,128),deviceAddress:phoneText(payload.deviceAddress,128),
      devices:Array.isArray(payload.devices)?payload.devices.slice(0,32).filter(device=>device && typeof device.address==='string').map(device=>({address:phoneText(device.address,128),name:phoneText(device.name,128)})):[]};
    if(phoneStatus.notificationAccess===false || (wasConnected && ['reconnecting','error','disabled','idle'].includes(phoneStatus.phase)))notificationCenter?.clearSource('phone');
    renderPhonePanel();reconcileNotifications();
  };
  window.__phoneConfigResult=payload=>{
    if(!payload || typeof payload!=='object')return;
    S.phone=normalizedPhone(payload.settings || phoneConfigPending?.previous || S.phone);
    phoneConfigPending=null;
    renderPhonePanel();reconcileNotifications();
    if(isPanel){el.phoneConfigNote.textContent=phoneText(payload.message,500) || (payload.ok?'设置已保存':'保存失败');el.phoneConfigNote.classList.toggle('is-error',!payload.ok);}
  };
  window.__phoneNotification=payload=>{
    if(isPanel || !payload || !S.phone.enabled || phoneStatus.supported!==true || phoneStatus.notificationAccess!==true || phoneStatus.phase!=='connected')return;
    notificationCenter?.receive({...payload,source:'phone',title:S.phone.hideContent?'':payload.title,body:S.phone.hideContent?'':payload.body});
  };

  function buildDial() {
    if (isPanel) return;
    const NS = 'http://www.w3.org/2000/svg';
    for (let i = 0; i < 60; i++) {
      const major = i % 5 === 0, quarter = i % 15 === 0;
      const a = i / 60 * Math.PI * 2, r = quarter ? 128 : major ? 132 : 135;
      const line = document.createElementNS(NS,'line');
      for (const [key,val] of Object.entries({
        x1:170+r*Math.sin(a), y1:170-r*Math.cos(a),
        x2:170+140*Math.sin(a), y2:170-140*Math.cos(a)
      })) line.setAttribute(key, val.toFixed(2));
      line.setAttribute('class','tick'+(quarter?' tick--hour':major?' tick--major':''));
      el.ticks.appendChild(line);
    }
    for (let h = 1; h <= 12; h++) {
      const a = h / 12 * Math.PI * 2, label = document.createElementNS(NS,'text');
      label.setAttribute('x',(170+118*Math.sin(a)).toFixed(2));
      label.setAttribute('y',(170-118*Math.cos(a)).toFixed(2));
      label.setAttribute('class','hour-label');
      label.textContent = h;
      el.hourMarks.appendChild(label);
    }
  }
  function renderTime(now = new Date(),forceProgress=false) {
    const clock = clockIdle();
    const wallTime = pad(now.getHours())+':'+pad(now.getMinutes())+':'+pad(now.getSeconds());
    const showClock = clock && S.settings.showIdleClock;
    const digits = clock?(showClock?wallTime:'等待开始'):fmtHMS(remain);
    const compact = clock?(showClock?wallTime:''):fmtMS(remain);
    if (el.readoutDigits.textContent!==digits) el.readoutDigits.textContent=digits;
    if (el.compactTime.textContent!==compact) el.compactTime.textContent=compact;
    if (isPanel) return;
    const fraction = total>0?Math.max(0,Math.min(1,remain/total)):0;
    const dialVisible = requestedOpen && el.island.classList.contains('is-open') && !effectActive;
    if (forceProgress || dialVisible) {
      const offset = String(678.584*(1-fraction));
      if (el.dialProgress.style.strokeDashoffset!==offset) el.dialProgress.style.strokeDashoffset=offset;
    }
    if (forceProgress || !dialVisible) {
      const offset = String(59.7*(1-fraction));
      if (el.miniRing.style.strokeDashoffset!==offset) el.miniRing.style.strokeDashoffset=offset;
    }
  }
  function renderState() {
    const clock = clockIdle();
    el.island.classList.toggle('is-clock',clock);
    el.island.classList.toggle('is-hide-idle-clock',clock && !S.settings.showIdleClock);
    const task = currentTask();
    const taskName = !clock && task ? (runId && runTaskId===task.id && runTaskName ? runTaskName : task.name) : '';
    el.readoutTask.hidden = !taskName;
    el.readoutTask.textContent = taskName;
    el.readoutTask.title = taskName;
    el.readoutChip.hidden = !done || clock;
    el.readoutChip.textContent = done && !clock ? '时间到' : '';
    el.island.classList.remove('is-running','is-done','is-idle');
    el.island.classList.add(clock?'is-idle':done?'is-done':running?'is-running':'is-idle');
    el.btnToggle.innerHTML = running
      ? '<svg viewBox="0 0 24 24" class="ico"><rect x="7" y="5" width="3.6" height="14" rx="1.4" fill="currentColor"/><rect x="13.4" y="5" width="3.6" height="14" rx="1.4" fill="currentColor"/></svg>'
      : '<svg viewBox="0 0 24 24" class="ico"><path d="M8 5.5v13l11-6.5z" fill="currentColor"/></svg>';
    el.btnToggle.setAttribute('aria-label',running?'暂停倒计时':done?'再来一次':'开始倒计时');
    el.btnToggle.title = running?'暂停':done?'再来一次':'开始';
    el.btnStart.textContent = running?'暂停':done?'再来一次':timerStarted?'继续':'开始';
    if (isPanel) el.timerNavStatus.textContent=running?'正在计时':done?'已完成':timerStarted?'已暂停':'准备开始';
  }
  function renderTasks() {
    el.taskList.replaceChildren();
    if (!S.tasks.length) {
      const empty = document.createElement('li');
      empty.className = 'task-empty'; empty.textContent = '暂无任务，添加一个专注目标';
      el.taskList.appendChild(empty);
    }
    for (const task of S.tasks) {
      const li = document.createElement('li');
      li.className = 'task'+(task.id===S.current_id?' is-active':'');
      const select = document.createElement('button');
      select.className = 'task__select';
      select.innerHTML = '<span class="task__dot"></span><span class="task__name"></span><span class="task__dur"></span>';
      $('.task__name',select).textContent = task.name;
      $('.task__dur',select).textContent = durLabel(task.sec);
      select.title = task.name+' · '+durLabel(task.sec);
      select.setAttribute('aria-pressed',String(task.id===S.current_id));
      select.addEventListener('click',()=>send({type:'selectTask',id:task.id}));
      const remove = document.createElement('button');
      remove.className = 'task__del'; remove.textContent = '×';
      remove.setAttribute('aria-label','删除任务 '+task.name); remove.title = '删除';
      remove.addEventListener('click',()=>send({type:'removeTask',id:task.id}));
      const edit=document.createElement('button');
      edit.className='task__edit';edit.dataset.taskId=task.id;
      edit.setAttribute('aria-label','设置任务 '+task.name);edit.title='任务设置';
      edit.innerHTML='<svg viewBox="0 0 24 24" class="ico" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="m15 5 4 4M5 19l4-1 11-11a2.8 2.8 0 0 0-4-4L5 14z"/></svg>';
      edit.addEventListener('click',e=>{e.stopPropagation();openTaskSettings(task.id);});
      li.append(select,edit,remove); el.taskList.appendChild(li);
    }
    el.btnClear.disabled = !S.tasks.length;
  }
  function normalizedAction(value) {
    const action={...defaultCompletionAction,...value};
    return {enabled:!!action.enabled,kind:hasOwn(actionKinds,action.kind)?action.kind:defaultCommandKind,
      command:typeof action.command==='string'?action.command:'',
      delaySec:Number.isInteger(action.delaySec)&&action.delaySec>=0&&action.delaySec<=300?action.delaySec:10};
  }
  function editingTask() {return S.tasks.find(task=>task.id===editingTaskId);}
  function kindEditor(creating=false) {
    const prefix=creating?'createAction':'action';
    return {creating,select:el[prefix+'Kind'],trigger:el[prefix+'KindTrigger'],value:el[prefix+'KindValue'],
      commandField:el[prefix+'CommandField'],command:el[prefix+'Command'],labelId:prefix+'KindLabel'};
  }
  function initializeActionKinds() {
    if (!isPanel) return;
    // Both select values remain available for faithful display of imported tasks.
    // The visible menu only offers commands executable on this platform.
    for (const editor of [kindEditor(),kindEditor(true)]) {
      for (const option of editor.select.options) option.textContent=actionOptionLabels[option.value];
      editor.select.value=defaultCommandKind;showKindFields(editor);
    }
    const commandOption=$('[data-action-kind="command"]',el.actionKindMenu);
    commandOption.dataset.actionKind=defaultCommandKind;
    commandOption.id='actionKindOption-'+defaultCommandKind;
    $('span',commandOption).textContent=actionOptionLabels[defaultCommandKind];
    if (platform==='macos') $('[data-action-kind="lock"]',el.actionKindMenu)?.remove();
  }
  function showKindFields(editor) {
    const kind=editor.select.value,shell=kind==='shell',script=isScriptKind(kind);
    editor.commandField.hidden=!script;
    editor.value.textContent=editor.select.selectedOptions[0]?.textContent || actionOptionLabels[defaultCommandKind];
    const label=shell?(platform==='macos'?'Shell 命令（zsh）':'macOS Shell 命令（zsh）'):
      platform==='windows'?'PowerShell 命令':'Windows PowerShell 命令';
    $('span',editor.commandField).textContent=label;
    editor.command.placeholder=shell?'open -a TextEdit':'Start-Process notepad.exe';
    editor.command.setAttribute('aria-label',(editor.creating?'新任务 ':'')+label);
    const foreign=script && kind!==defaultCommandKind;
    $('small',editor.commandField).textContent=(foreign?(shell?'此命令仅适用于 macOS。':'此命令仅适用于 Windows。'):'')+(platform==='macos'?'工作目录为用户主目录（HOME）。':'工作目录为程序所在文件夹。');
    if (kindMenuOpen && activeKindEditor?.select===editor.select) updateKindMenuSelection(editor);
  }
  function updateKindMenuSelection(editor) {
    $$('[data-action-kind]',el.actionKindMenu).forEach(option=>
      option.setAttribute('aria-selected',String(option.dataset.actionKind===editor.select.value)));
  }
  function showActionFields() {showKindFields(kindEditor());}
  function showCreateActionFields() {showKindFields(kindEditor(true));}
  function resetCreateAction() {
    el.createActionEnabled.checked=false;el.createActionKind.value=defaultCommandKind;
    el.createActionCommand.value='';el.createActionDelay.value=10;
    el.createActionCommand.setAttribute('aria-invalid','false');el.createActionDelay.setAttribute('aria-invalid','false');
    showCreateActionFields();
  }
  function readCreateAction() {
    const enabled=el.createActionEnabled.checked,kind=el.createActionKind.value;
    const command=el.createActionCommand.value,delaySec=inputValue(el.createActionDelay);
    if (!hasOwn(actionKinds,kind)) {showError(el.taskNote,'请选择有效的执行类型');return null;}
    el.createActionDelay.setAttribute('aria-invalid',String(delaySec===null));
    if (delaySec===null) {showError(el.taskNote,'结束动作延迟请输入 0–300 之间的整数秒');return null;}
    const invalid=command.length>4096 || command.includes(String.fromCharCode(0)) || (enabled && isScriptKind(kind) && !command.trim());
    el.createActionCommand.setAttribute('aria-invalid',String(invalid));
    if (invalid) {showError(el.taskNote,'启用命令时请输入 1–4096 个字符，不能包含空字符');return null;}
    return {enabled,kind,command,delaySec};
  }
  function setPanelPage(page,{focus=true}={}) {
    if (!isPanel || !hasOwn(panelRoutes,page)) return;
    if (page==='task' && !editingTask()) return;
    closeActionKindMenu();
    const previous=panelPage,route=panelRoutes[page],root=panelRoot(page),revision=++panelNavigationRevision;
    panelScrollPositions.set(previous,el[panelRoutes[previous].element].scrollTop);
    // Move focus off the outgoing view before marking it inaccessible.
    if (page!==previous && el[panelRoutes[previous].element].contains(document.activeElement)) document.activeElement.blur();
    panelPage=page;
    for (const [name,entry] of Object.entries(panelRoutes)) {
      const node=el[entry.element],active=page===name;
      node.classList.toggle('is-active',active);node.inert=!active;
      node.setAttribute('aria-hidden',String(!active));
    }
    for (const button of $$('[data-panel-page]',el.panelNav)) {
      const active=button.dataset.panelPage===root;
      button.classList.toggle('is-active',active);
      if (active) button.setAttribute('aria-current','page');else button.removeAttribute('aria-current');
      const entry=panelRoutes[button.dataset.panelPage];
      if (entry) button.setAttribute('aria-controls',entry.element);
    }
    el.panelTitle.textContent=route.title;
    el.btnTaskBack.hidden=!route.parent;
    el.btnTaskBack.setAttribute('aria-label',route.parent?'返回'+panelRoutes[root].title:'返回');
    if (page!=='task') editingTaskId='';
    el[route.element].scrollTop=panelScrollPositions.get(page) || 0;
    if (page==='task') {renderTaskDuration();renderActionConfig();}
    renderActionStatus();renderPhonePanel();
    if(page!=='webhook'){webhookTokenVisible=false;webhookEndpointVisible=false;relayEndpointVisible=false;}
    renderWebhookPanel();
    if(page==='webhook')requestWebhookStatus();
    if (!focus) return;
    // Returning from a task restores its initiating control and list position.
    const returning=page==='timer' && panelRoutes[previous].parent==='timer';
    // Resolve the target after layout: a state update can rebuild the task list
    // between navigation and this frame. Ignore callbacks from earlier routes.
    requestAnimationFrame(()=>{
      if (revision!==panelNavigationRevision || panelPage!==page) return;
      const active=document.activeElement;
      // A user may already have chosen an input before this frame runs.
      if(el[route.element].contains(active) && active.matches('input,textarea,select,button,a[href],[contenteditable="true"],[tabindex]:not([tabindex="-1"])') && !active.disabled) return;
      const target=page==='create'?(pendingTaskCreate?el.btnTaskBack:el.inTaskName):
        page==='task'?(taskDurationPending.has(editingTaskId)?el.btnTaskBack:el.editTaskMin):
        returning?$$('.task__edit',el.taskList).find(button=>button.dataset.taskId===settingsReturnTaskId) || el.btnOpenTaskPage:
        el[panelRoutes[root].menu];
      target.focus({preventScroll:true});
    });
  }
  function openNotificationSettings() {
    setPanelPage('preferences',{focus:false});
    el.notificationsSettings.scrollIntoView({block:'start',behavior:'instant'});
    (el.notificationsEnabled.disabled?el.notificationsSettings:el.notificationsEnabled).focus({preventScroll:true});
  }
  function setTaskPage(show) {
    if (show) settingsReturnTaskId='';
    setPanelPage(show?'create':'timer');
  }
  function openTaskSettings(taskId) {
    if (!S.tasks.some(task=>task.id===taskId)) return;
    editingTaskId=taskId;settingsReturnTaskId=taskId;panelScrollPositions.set('task',0);
    setPanelPage('task');
  }
  function reconcileTaskEditors() {
    const ids=new Set(S.tasks.map(task=>task.id));
    for (const drafts of [actionDrafts,actionPending,taskDurationDrafts,taskDurationPending]) for (const id of drafts.keys()) if(!ids.has(id))drafts.delete(id);
    if (actionDraftScope && !ids.has(actionDraftScope)) actionDraftScope=null;
    if (panelPage==='task' && !ids.has(editingTaskId)) setPanelPage('timer');
  }
  function setTaskCreateBusy(busy) {
    if (busy && kindMenuOpen && activeKindEditor?.creating) closeActionKindMenu();
    for (const input of [el.inTaskName,el.inTaskMin,el.inTaskSec,el.btnAddTask,
      el.createActionEnabled,el.createActionKind,el.createActionCommand,el.createActionDelay,el.createActionKindTrigger]) input.disabled=busy;
    el.btnAddTask.textContent=busy?'创建中…':'创建任务';
  }
  function setKindMenuIndex(index) {
    const options=$$('[data-action-kind]',el.actionKindMenu);
    kindMenuIndex=(index+options.length)%options.length;
    options.forEach((option,i)=>option.classList.toggle('is-active',i===kindMenuIndex));
    activeKindEditor?.trigger.setAttribute('aria-activedescendant',options[kindMenuIndex].id);
    options[kindMenuIndex].scrollIntoView({block:'nearest'});
  }
  function openActionKindMenu(editor=kindEditor()) {
    if (!isPanel || editor.trigger.disabled || panelPage!==(editor.creating?'create':'task')) return;
    if (kindMenuOpen) closeActionKindMenu();
    clearTimeout(kindMenuTimer);cancelAnimationFrame(kindMenuFrame);
    activeKindEditor=editor;kindMenuOpen=true;el.actionKindMenu.hidden=false;el.actionKindMenu.inert=false;
    editor.trigger.setAttribute('aria-expanded','true');el.actionKindMenu.setAttribute('aria-labelledby',editor.labelId);
    updateKindMenuSelection(editor);
    const rect=editor.trigger.getBoundingClientRect(),margin=12,gap=6;
    const width=Math.min(innerWidth-margin*2,Math.max(rect.width,252));
    el.actionKindMenu.style.width=width+'px';
    el.actionKindMenu.style.maxHeight=Math.min(240,innerHeight-margin*2)+'px';
    const height=el.actionKindMenu.offsetHeight;
    const below=innerHeight-rect.bottom-margin-gap,above=rect.top-margin-gap;
    const useBelow=below>=height || below>=above;
    const space=Math.max(64,useBelow?below:above);
    el.actionKindMenu.style.maxHeight=Math.min(240,space)+'px';
    const shownHeight=el.actionKindMenu.offsetHeight;
    el.actionKindMenu.style.left=Math.max(margin,Math.min(innerWidth-width-margin,rect.left))+'px';
    el.actionKindMenu.style.top=Math.max(margin,Math.min(innerHeight-shownHeight-margin,useBelow?rect.bottom+gap:rect.top-shownHeight-gap))+'px';
    el.actionKindMenu.dataset.side=useBelow?'below':'above';
    setKindMenuIndex(Math.max(0,$$('[data-action-kind]',el.actionKindMenu).findIndex(option=>option.dataset.actionKind===editor.select.value)));
    kindMenuFrame=requestAnimationFrame(()=>{if(kindMenuOpen)el.actionKindMenu.classList.add('is-open');});
  }
  function closeActionKindMenu(focus=false) {
    if (!el.actionKindMenu) return;
    kindMenuOpen=false;cancelAnimationFrame(kindMenuFrame);clearTimeout(kindMenuTimer);
    const trigger=activeKindEditor?.trigger;
    trigger?.setAttribute('aria-expanded','false');trigger?.removeAttribute('aria-activedescendant');
    el.actionKindMenu.inert=true;el.actionKindMenu.classList.remove('is-open');
    kindMenuTimer=setTimeout(()=>{if(!kindMenuOpen)el.actionKindMenu.hidden=true;},reducedMotion()?0:160);
    if (focus && trigger && !trigger.disabled) trigger.focus({preventScroll:true});
  }
  function chooseActionKind(value) {
    if (!kindMenuOpen || !activeKindEditor || activeKindEditor.trigger.disabled || !hasOwn(actionKinds,value)) return;
    const select=activeKindEditor.select;
    select.value=value;
    select.dispatchEvent(new Event('input',{bubbles:true}));
    select.dispatchEvent(new Event('change',{bubbles:true}));
    closeActionKindMenu(true);
  }
  function bindActionKindMenu() {
    for (const editor of [kindEditor(),kindEditor(true)]) {
      editor.trigger.addEventListener('click',()=>kindMenuOpen && activeKindEditor?.select===editor.select?closeActionKindMenu():openActionKindMenu(editor));
      editor.trigger.addEventListener('keydown',e=>{
        if (e.isComposing || editor.trigger.disabled) return;
        const count=$$('[data-action-kind]',el.actionKindMenu).length;
        if (e.key==='ArrowDown' || e.key==='ArrowUp') {
          e.preventDefault();
          if (!kindMenuOpen) openActionKindMenu(editor);
          else setKindMenuIndex(kindMenuIndex+(e.key==='ArrowDown'?1:-1));
        } else if (e.key==='Home' || e.key==='End') {
          e.preventDefault();if(!kindMenuOpen)openActionKindMenu(editor);setKindMenuIndex(e.key==='Home'?0:count-1);
        } else if (e.key==='Enter' || e.key===' ') {
          e.preventDefault();
          if (!kindMenuOpen) openActionKindMenu(editor);
          else chooseActionKind($$('[data-action-kind]',el.actionKindMenu)[kindMenuIndex].dataset.actionKind);
        } else if (e.key==='Tab') closeActionKindMenu();
      });
    }
    el.actionKindMenu.addEventListener('pointerdown',e=>e.preventDefault());
    el.actionKindMenu.addEventListener('click',e=>{
      const option=e.target.closest('[data-action-kind]');if(option)chooseActionKind(option.dataset.actionKind);
    });
    el.actionKindMenu.addEventListener('pointermove',e=>{
      const option=e.target.closest('[data-action-kind]');
      if(option) setKindMenuIndex($$('[data-action-kind]',el.actionKindMenu).indexOf(option));
    });
    document.addEventListener('pointerdown',e=>{
      if(kindMenuOpen && !el.actionKindMenu.contains(e.target) && !activeKindEditor?.trigger.contains(e.target))closeActionKindMenu();
    });
    // Both editors share this body-level surface, clear of either scroll viewport.
    for (const page of [el.settingsPage,el.taskCreatePage,el.taskSettingsPage]) page.addEventListener('scroll',()=>{if(kindMenuOpen)closeActionKindMenu();});
    window.addEventListener('resize',()=>{if(kindMenuOpen)closeActionKindMenu();});
    window.addEventListener('blur',()=>{if(kindMenuOpen)closeActionKindMenu();});
    document.addEventListener('visibilitychange',()=>{if(document.hidden && kindMenuOpen)closeActionKindMenu();});
  }
  function renderTaskDuration() {
    if (!isPanel || panelPage!=='task') return;
    const task=editingTask();if(!task)return;
    const draft=taskDurationDrafts.get(task.id),busy=taskDurationPending.has(task.id);
    const minutes=String(draft?draft.minutes:Math.floor(task.sec/60));
    const secs=String(draft?draft.seconds:task.sec%60);
    if (el.editTaskMin.value!==minutes) el.editTaskMin.value=minutes;
    if (el.editTaskSec.value!==secs) el.editTaskSec.value=secs;
    el.editTaskMin.setAttribute('aria-invalid',String(!!draft?.minInvalid));
    el.editTaskSec.setAttribute('aria-invalid',String(!!draft?.secInvalid));
    for (const node of [el.editTaskMin,el.editTaskSec,el.btnSaveTaskDuration]) node.disabled=busy;
    el.btnSaveTaskDuration.textContent=busy?'保存中…':'保存时长';
    el.taskDurationNote.textContent=busy?'正在保存…':draft?.note || '';
    el.taskDurationNote.classList.toggle('is-error',!busy && !!draft?.error);
  }
  function rememberTaskDuration() {
    const task=editingTask();if(panelPage!=='task' || !task || taskDurationPending.has(task.id))return;
    taskDurationDrafts.set(task.id,{minutes:el.editTaskMin.value,seconds:el.editTaskSec.value,note:'尚未保存'});
    renderTaskDuration();
  }
  function saveTaskDuration() {
    const task=editingTask();if(panelPage!=='task' || !task || taskDurationPending.has(task.id))return;
    const values=[el.editTaskMin,el.editTaskSec].map(inputValue),sec=values[0]*60+values[1];
    const draft={minutes:el.editTaskMin.value,seconds:el.editTaskSec.value,
      minInvalid:values[0]===null,secInvalid:values[1]===null};
    if(values.includes(null) || sec<1 || sec>MAX_SEC) {
      draft.error=true;draft.note=values.includes(null)?'请输入整数：分 0–5999，秒 0–59':'任务时长应为 1 秒至 99 小时 59 分 59 秒';
      taskDurationDrafts.set(task.id,draft);renderTaskDuration();return;
    }
    taskDurationDrafts.set(task.id,draft);
    const requestId=++taskDurationSequence;
    taskDurationPending.set(task.id,{requestId,sec});renderTaskDuration();
    send({type:'setTaskDuration',taskId:task.id,sec,requestId});
  }
  function renderActionConfig() {
    if (!isPanel || panelPage!=='task') return;
    const task=editingTask();if(!task)return;
    const scope=task.id,changed=scope!==actionDraftScope,draft=actionDrafts.get(scope);
    el.actionScope.textContent=task.name;el.taskSettingsDuration.textContent='专注时长 · '+durLabel(task.sec);
    if (changed || !draft) {
      const action=draft || normalizedAction(task.completionAction);
      el.actionEnabled.checked=action.enabled;el.actionKind.value=action.kind;
      el.actionCommand.value=action.command;el.actionDelay.value=action.delaySec;
      el.actionCommand.setAttribute('aria-invalid','false');el.actionDelay.setAttribute('aria-invalid','false');
    }
    if (changed) {closeActionKindMenu();el.actionConfigNote.textContent='';el.actionConfigNote.classList.remove('is-error');}
    actionDraftScope=scope;showActionFields();
    el.btnSaveAction.disabled=actionPending.has(scope);
    el.btnSaveAction.textContent=actionPending.has(scope)?'保存中…':'保存配置';
  }
  function rememberActionDraft() {
    const scope=editingTask()?.id;if(panelPage!=='task' || !scope)return;
    actionDrafts.set(scope,{enabled:el.actionEnabled.checked,kind:el.actionKind.value,
      command:el.actionCommand.value,delaySec:el.actionDelay.value,revision:++actionDraftRevision});
    el.actionConfigNote.textContent='尚未保存';el.actionConfigNote.classList.remove('is-error');
    showActionFields();
  }
  function saveCompletionAction() {
    const scope=editingTask()?.id;if(panelPage!=='task' || !scope)return;
    const kind=el.actionKind.value,command=el.actionCommand.value;
    const enabled=el.actionEnabled.checked,delaySec=inputValue(el.actionDelay);
    if (!hasOwn(actionKinds,kind)) return showError(el.actionConfigNote,'请选择有效的执行类型');
    if (delaySec===null) return showError(el.actionConfigNote,'延迟请输入 0–300 之间的整数秒');
    const commandInvalid=isScriptKind(kind) && ((enabled && !command.trim()) || command.length>4096 || command.includes(String.fromCharCode(0)));
    el.actionCommand.setAttribute('aria-invalid',String(commandInvalid));
    if (commandInvalid) return showError(el.actionConfigNote,'启用命令时请输入 1–4096 个字符，不能包含空字符');
    if (actionPending.has(scope)) return;
    const action={enabled,kind,command,delaySec};
    actionPending.set(scope,{action,revision:actionDrafts.get(scope)?.revision || 0});
    renderActionConfig();
    el.actionConfigNote.textContent='正在保存…';el.actionConfigNote.classList.remove('is-error');
    send({type:'setCompletionAction',taskId:scope,action});
  }
  function renderActionStatus() {
    if (!isPanel) return;
    const phase=actionStatus.phase,visible=phase!=='idle';
    const phases={armed:'已准备',pending:'等待执行',running:'执行中',success:'已完成',error:'执行失败',cancelled:'已取消'};
    const remaining=Number(actionStatus.remainingSec);
    const phaseText=phase==='pending'&&Number.isFinite(remaining)?Math.max(0,Math.ceil(remaining))+' 秒后执行':phases[phase]||'';
    for (const node of [el.panelAction]) {
      node.hidden=!visible || (node===el.panelAction && (panelPage!=='task' || !editingTaskId || actionStatus.taskId!==editingTaskId));node.dataset.phase=phase;
      $('.action-status__label',node).textContent=String(actionStatus.label || '结束后执行');
      $('.action-status__phase',node).textContent=phaseText;
      const message=String(actionStatus.message || '');
      $('.action-status__message',node).textContent=message;node.title=message;
      const button=$('.action-status__cancel',node);
      button.hidden=!['armed','pending'].includes(phase) || !actionStatus.runId;
      button.disabled=false;
    }
  }
  function cancelCompletionAction(event) {
    event.stopPropagation();
    if (!actionStatus.runId || !['armed','pending'].includes(actionStatus.phase)) return;
    if (event.currentTarget===el.btnCancelPanelAction && (panelPage!=='task' || actionStatus.taskId!==editingTaskId))return;
    event.currentTarget.disabled=true;
    send({type:'cancelCompletionAction',runId:actionStatus.runId});
  }
  function nextRunId() {
    const sequence=++runSequence;
    if (typeof window.crypto?.randomUUID==='function') return window.crypto.randomUUID();
    // Identifiers are not credentials: timestamp plus monotonic sequence also
    // works in an older WebView that does not expose randomUUID on inline HTML.
    const origin=Math.round(performance.timeOrigin*1000).toString(36);
    return Date.now().toString(36)+'-'+origin+'-'+sequence.toString(36);
  }

  function renderPanel() {
    if (!isPanel) return;
    el.durNote.classList.remove('is-error');
    el.durNote.textContent = '当前时长 '+durLabel(S.duration_sec);
    $$('.preset').forEach(p=>p.classList.toggle('is-active',Number(p.dataset.min)*60===S.duration_sec));
    // Keep the user's unfinished duration edit while changing unrelated preferences.
    if (!durationDraftDirty) {
      el.inH.value = Math.floor(S.duration_sec/3600);
      el.inM.value = Math.floor(S.duration_sec%3600/60);
      el.inS.value = S.duration_sec%60;
    }
    for (const [id,key] of Object.entries({
      swHands:'showHands',swSecond:'showSecond',swIdleClock:'showIdleClock',swEyes:'showIdleEyes',swSound:'sound',
      swNotify:'notify',swTop:'alwaysOnTop',swMotion:'reduceMotion'
    })) el[id].checked = !!S.settings[key];
    el.swSecond.disabled = !S.settings.showHands;
    // Position and duration edits are independent of unrelated state broadcasts.
    if (!topOffsetDraftDirty) el.inTopOffset.value = S.settings.topOffset;
    renderTasks();reconcileTaskEditors();renderTaskDuration();renderActionConfig();renderActionStatus();
  }
  function renderAll() {
    renderState(); renderTime(); renderPanel();renderPhonePanel();renderNotificationsPanel();renderWebhookPanel();reconcileNotifications();
    el.island.classList.toggle('is-hide-hands',!S.settings.showHands);
    document.body.classList.toggle('reduce-motion',!!S.settings.reduceMotion);
    if (!isPanel) scheduleClock();
  }
  function publishTimer(force = false) {
    if (isPanel) return;
    const taskId=runId?runTaskId:(currentTask()?.id || '');
    const key = [runId,taskId,running,done,timerStarted,completedIdle,seconds(remain),total].join(':');
    if (force || key !== lastTimerMessage) {
      lastTimerMessage = key;
      send({type:'timerState',runId,taskId,running,done,started:timerStarted,idleAfterCompletion:completedIdle,remainingMs:remain,totalMs:total});
    }
  }
  function stopTick() { clearInterval(tickTimer); tickTimer = null; }
  function cancelEffect() {
    effectGeneration++;
    clearTimeout(effectTimer);effectTimer=null;
    if (effectListener) el.expanded.removeEventListener('animationend',effectListener);
    effectListener=null;
    el.island.classList.remove('is-cracking','is-finishing');
    el.fx.replaceChildren();
    if (effectActive) {
      effectActive=false;
      requestViewport({type:'setEffect',active:false},DIAL_SIZE,DIAL_SIZE,()=>{
        // Reset may cancel completion before its first region ACK. Once Rust
        // restores the dial region, reveal the requested dial as well.
        if (requestedOpen) showOpen();
      });
      // The companion acquires its own native ACK after this restore command.
      // A subsequent close may cancel the dial ACK, but must not leave it suspended.
      notificationCenter?.suspend(false);
    }
  }
  function cancelCompletionIdle() {
    clearTimeout(completionIdleTimer);completionIdleTimer=null;completionIdleAt=0;++completionIdleGeneration;
  }
  function reconcileCompletionIdle() {
    if (!isPanel && done && !completedIdle && completionIdleAt && Date.now()>=completionIdleAt) returnToCompletedIdle();
  }
  function resumeView() {
    sampleTime();reconcileCompletionIdle();scheduleClock();
  }
  function returnToCompletedIdle() {
    if (isPanel || !done || completedIdle) return;
    cancelCompletionIdle();completedIdle=true;
    // Keep runId, completion facts and pending native actions intact: this is
    // presentation only, unlike reset(). Closing cancels any stale effect ACK.
    cancelEffect();renderTime();renderState();closeIsland();scheduleClock();publishTimer(true);notificationCenter?.syncMain();
  }
  function reset() {
    if (isPanel) return;
    cancelCompletionIdle();completedIdle=false;
    cancelEffect(); stopTick();
    running = false; done = false; timerStarted = false; runId='';runTaskId='';runTaskName='';
    total = S.duration_sec*1000; remain = total;
    renderTime(); renderState(); publishTimer(true);scheduleClock();
  }
  function sampleTime() {
    if (!running) return;
    remain = Math.max(0,deadline-Date.now());
    renderTime();
    if (!remain) finish(); else publishTimer();
  }
  function start() {
    if (isPanel || running) return;
    cancelCompletionIdle();completedIdle=false;
    if (done || remain<=0) reset();
    if (!runId) {runId=nextRunId();runTaskId=currentTask()?.id || '';runTaskName=currentTask()?.name || '自由专注';}
    running = true; done = false; timerStarted = true; deadline = Date.now()+remain;
    tickTimer = setInterval(sampleTime,80);
    renderTime(); renderState(); publishTimer(true);scheduleClock();
  }
  function pause() {
    if (isPanel || !running) return;
    sampleTime();
    if (!running) return;
    running = false; stopTick(); renderState(); publishTimer(true);
  }
  function toggle() { if (!isPanel) running ? pause() : start(); }
  function finish() {
    running = false; done = true; remain = 0; stopTick();
    cancelCompletionIdle();completedIdle=false;
    completionIdleAt=Date.now()+10000;
    const generation=completionIdleGeneration,finishedRun=runId;
    completionIdleTimer=setTimeout(()=>{
      if(generation===completionIdleGeneration && done && runId===finishedRun) reconcileCompletionIdle();
    },10000);
    renderTime(); renderState(); publishTimer(true);
    crack();
    send({type:'timerDone',runId,taskId:runTaskId,task:runTaskName || currentTask()?.name || '自由专注'});
  }

  const GEO = window.__GEO__ || {};
  const nativeViewport = !isPanel && Number(GEO.dial)>0 && hasNativeBridge();
  const DIAL_SIZE = Number(GEO.dial)||340, EFFECT_SIZE = Number(GEO.effect)||580;
  let viewportSequence = 0, viewportPending = null, requestedOpen = false;
  let shapeGeneration = 0, closeListener = null, effectListener = null;
  let clockFrame = null, clockWake = null;

  let idleEyesActive = false, idlePageActive = true;
  let idleCycleTimer = null, idleCycleEyes = false, idleCycleAt = 0;
  let idleEyesFollowing = false, idleEyesFollowUntil = 0;
  const idleEyesTimers = new Set();
  const randomBetween = (min,max) => min+Math.random()*(max-min);
  function idleEyesEligible() {
    return !isPanel && idlePageActive && !!el.idleEyes && S.settings.showIdleEyes && clockIdle() && !requestedOpen &&
      !effectActive && !document.hidden && !reducedMotion();
  }
  function stopIdleEyes() {
    stopIdleFollow();
    if (!idleEyesActive && !idleEyesTimers.size) return;
    for (const timer of idleEyesTimers) clearTimeout(timer);
    idleEyesTimers.clear();idleEyesActive=false;
    el.island.classList.remove('is-idle-eyes');
    el.idleEyes.classList.remove('is-blinking');
    el.idleEyes.style.removeProperty('--gaze-x');
    el.idleEyes.style.removeProperty('--gaze-y');
  }
  function queueIdleEyes(action,delay) {
    const timer=setTimeout(()=>{
      idleEyesTimers.delete(timer);
      // Every queued action rechecks eligibility, including delayed blinks.
      if (!idleEyesEligible()) {syncIdleEyes();return;}
      action();
    },delay);
    idleEyesTimers.add(timer);
    return timer;
  }
  function setIdleGaze(x,y) {
    el.idleEyes.style.setProperty('--gaze-x',Math.max(-4,Math.min(4,x)).toFixed(2)+'px');
    el.idleEyes.style.setProperty('--gaze-y',Math.max(-2.5,Math.min(2.5,y)).toFixed(2)+'px');
  }
  function stopIdleFollow() {
    if (!idleEyesFollowing) return;
    idleEyesFollowing=false;idleEyesFollowUntil=0;
    el.idleEyes.classList.remove('is-following');
    send({type:'watchCursor',enabled:false});
  }
  function followIdleCursor() {
    const duration=randomBetween(1800,3200);
    idleEyesFollowing=true;idleEyesFollowUntil=Date.now()+duration;
    el.idleEyes.classList.add('is-following');
    send({type:'watchCursor',enabled:true});
    queueIdleEyes(()=>{stopIdleFollow();scheduleIdleFollow();},duration);
  }
  function scheduleIdleFollow(initial=false) {
    // A first glance also fits inside the ten-second eye slot in mixed mode.
    queueIdleEyes(followIdleCursor,initial?randomBetween(3000,6000):randomBetween(10000,22000));
  }
  window.__cursorPosition=(x,y)=>{
    // Native samples are global-pointer coordinates converted to this fixed
    // canvas. Late samples must never revive a cancelled or expired phase.
    if (!idleEyesFollowing || !idleEyesActive || !idleEyesEligible() ||
        Date.now()>=idleEyesFollowUntil || !Number.isFinite(x) || !Number.isFinite(y)) return;
    const bounds=el.idleEyes.getBoundingClientRect();
    const dx=x-bounds.left-bounds.width/2,dy=y-bounds.top-bounds.height/2;
    const distance=Math.max(180,Math.hypot(dx,dy));
    setIdleGaze(dx/distance*4,dy/distance*2.5);
  };
  function moveIdleEyes() {
    queueIdleEyes(()=>{
      if (!idleEyesFollowing) setIdleGaze(randomBetween(-4,4),randomBetween(-2.5,2.5));
      moveIdleEyes();
    },randomBetween(650,1300));
  }
  function blinkIdleEyes() {
    const blink=()=>{
      el.idleEyes.classList.add('is-blinking');
      queueIdleEyes(()=>el.idleEyes.classList.remove('is-blinking'),220);
    };
    queueIdleEyes(()=>{
      blink();
      if (Math.random()<.2) queueIdleEyes(blink,340);
      blinkIdleEyes();
    },randomBetween(1500,3000));
  }
  function stopIdleCycle() {
    clearTimeout(idleCycleTimer);idleCycleTimer=null;idleCycleEyes=false;idleCycleAt=0;
  }
  function queueIdleCycle() {
    clearTimeout(idleCycleTimer);
    idleCycleTimer=setTimeout(()=>{
      idleCycleTimer=null;syncIdleEyes();
    },Math.max(0,idleCycleAt-Date.now()));
  }
  function syncIdleEyes() {
    if (!idleEyesEligible()) {stopIdleCycle();stopIdleEyes();return;}
    if (S.settings.showIdleClock) {
      // Both enabled: clock first, then eyes, ten seconds each. Clock ticks and
      // unrelated settings refreshes must not reset this independent schedule.
      const now=Date.now();
      if (!idleCycleAt) {idleCycleEyes=false;idleCycleAt=now+10000;}
      if (now>=idleCycleAt) {
        const slots=Math.floor((now-idleCycleAt)/10000)+1;
        if (slots%2) idleCycleEyes=!idleCycleEyes;
        idleCycleAt+=slots*10000;
      }
      queueIdleCycle();
      if (!idleCycleEyes) {stopIdleEyes();return;}
    } else stopIdleCycle();
    if (idleEyesActive) return;
    idleEyesActive=true;
    el.island.classList.add('is-idle-eyes');
    moveIdleEyes();blinkIdleEyes();scheduleIdleFollow(true);
  }


  function cancelViewport() {
    if (!viewportPending) return;
    cancelAnimationFrame(viewportPending.frame);
    clearTimeout(viewportPending.timeout);
    viewportPending = null;
  }
  function viewportMatches(request) {
    return !nativeViewport || (request.acknowledged &&
      Math.abs(innerWidth-request.width)<=2 && Math.abs(innerHeight-request.height)<=2);
  }
  function checkViewport() {
    const request=viewportPending;
    if (!request || request.frame!==null || !viewportMatches(request)) return;
    request.frame=requestAnimationFrame(()=>{
      request.frame=null;
      if (viewportPending!==request || !viewportMatches(request)) return;
      clearTimeout(request.timeout);viewportPending=null;
      request.ready();
    });
  }
  function requestViewport(message,width,height,ready=()=>{}) {
    cancelViewport();
    // The native WebView now keeps one 580px canvas and global origin for every
    // shape. Rust changes only its visible window region: pill, dial or effect.
    // Matching dimensions alone cannot prove that the region has been applied;
    // wait for this request's ACK before starting a CSS transition.
    const request={
      id:++viewportSequence,
      width:nativeViewport?EFFECT_SIZE:width,
      height:nativeViewport?EFFECT_SIZE:height,
      acknowledged:!nativeViewport,ready,frame:null,timeout:null
    };
    viewportPending=request;
    send(nativeViewport?{...message,requestId:request.id}:message);
    if (nativeViewport) {
      request.timeout=setTimeout(()=>{
        if (viewportPending!==request) return;
        if (viewportMatches(request)) checkViewport();
        else {
          cancelViewport();
          send({type:'frontendError',message:'Native canvas/region ACK timed out: request '+request.id+' ('+request.width+'×'+request.height+')'});
        }
      },2000);
    } else checkViewport();
  }
  function requestNotificationLayout(layout,ready=()=>{},failed=()=>{}) {
    if(noticeViewportPending)clearTimeout(noticeViewportPending.timeout);
    const request={id:0,ready,timeout:null,attempts:0};noticeViewportPending=request;
    const attempt=()=>{
      request.id=++viewportSequence;++request.attempts;
      send({type:'setNotificationLayout',...layout,requestId:request.id});
      if(!nativeViewport){noticeViewportPending=null;ready();return;}
      request.timeout=setTimeout(()=>{
        if(noticeViewportPending!==request)return;
        // Retry once with a fresh identity; an obsolete ACK cannot reveal stale UI.
        if(request.attempts<2){attempt();return;}
        noticeViewportPending=null;failed();
        send({type:'frontendError',message:'Notification layout ACK timed out: '+request.id});
      },2000);
    };
    attempt();
  }
  window.__viewportReady=requestId=>{
    if(noticeViewportPending?.id===Number(requestId)){const request=noticeViewportPending;clearTimeout(request.timeout);noticeViewportPending=null;request.ready();return;}
    if (viewportPending?.id!==Number(requestId)) return;
    viewportPending.acknowledged=true;
    checkViewport();
  };
  // A resize can finish initial canvas setup, but never substitutes for an ACK.
  window.addEventListener('resize',checkViewport);

  function animateHands() {
    return !isPanel && requestedOpen && el.island.classList.contains('is-open') &&
      S.settings.showHands && !effectActive && !document.hidden;
  }
  function tickClock(forceHands=false) {
    const d = new Date();
    if (forceHands || animateHands()) {
      const sec = d.getSeconds()+d.getMilliseconds()/1000;
      const min = d.getMinutes()+sec/60, hour = d.getHours()%12+min/60;
      // A single CSS pivot rotates each hand; no SVG transform attribute is used.
      el.handHour.style.transform='rotate('+hour*30+'deg)';
      el.handMinute.style.transform='rotate('+min*6+'deg)';
      el.handSecond.style.transform='rotate('+sec*6+'deg)';
    }
    const secondDisplay=S.settings.showSecond?'':'none';
    if (el.handSecond.style.display!==secondDisplay) el.handSecond.style.display=secondDisplay;
    if (clockIdle()) renderTime(d);
  }
  function scheduleClock() {
    cancelAnimationFrame(clockFrame); clearTimeout(clockWake);
    clockFrame = null; clockWake = null;
    if (isPanel) return;
    syncIdleEyes();tickClock();
    if (animateHands()) {
      const frame = () => {
        clockFrame = null;
        if (!animateHands()) {scheduleClock();return;}
        tickClock();
        clockFrame = requestAnimationFrame(frame);
      };
      clockFrame = requestAnimationFrame(frame);
    } else if (clockIdle() && S.settings.showIdleClock && !document.hidden) {
      // No permanent animation loop for a collapsed or hidden clock.
      clockWake = setTimeout(scheduleClock,1000-Date.now()%1000+5);
    }
  }
  const isOpen = () => requestedOpen;
  function cancelClose() {
    clearTimeout(closeTimer);closeTimer=null;
    if (closeListener) el.island.removeEventListener('transitionend',closeListener);
    closeListener = null;
  }
  function showOpen(instant=false) {
    if (instant) el.island.classList.add('is-finishing');
    el.island.classList.add('is-open');
    el.island.setAttribute('aria-expanded','true');
    el.expanded.inert = false;
    renderTime(new Date(),true);scheduleClock();
  }
  function openIsland(instant=false) {
    if (isPanel) return;
    cancelClose(); requestedOpen = true;notificationCenter?.syncMain();
    syncIdleEyes();
    const generation = ++shapeGeneration;
    requestViewport({type:'setShape',open:true},DIAL_SIZE,DIAL_SIZE,()=>{
      if (generation===shapeGeneration && requestedOpen) showOpen(instant);
    });
  }
  function closeIsland() {
    if (isPanel || !requestedOpen || effectActive) return;
    cancelClose(); cancelViewport();
    requestedOpen = false;notificationCenter?.syncMain();
    const generation = ++shapeGeneration, wasOpen = el.island.classList.contains('is-open');
    el.island.classList.remove('is-open');
    el.island.setAttribute('aria-expanded','false');
    el.expanded.inert = true;scheduleClock();
    const finished = () => {
      if (generation!==shapeGeneration || requestedOpen) return;
      cancelClose();
      requestViewport({type:'setShape',open:false},Number(GEO.pillW)||132,Number(GEO.pillH)||38);
    };
    if (!wasOpen) {finished();return;}
    closeListener = event => {
      if (event.target===$(':scope > .island__surface > .island__glass',el.island) && event.propertyName==='clip-path') finished();
    };
    el.island.addEventListener('transitionend',closeListener);
    closeTimer = setTimeout(finished,reducedMotion()?80:620);
  }

  const CRACK = [[50,0],[47.5,8],[53,16],[46.5,26],[52.5,34],[47.5,44],[53,54],[46.5,64],[52.5,72],[48,82],[50.5,92],[50,100]];
  function handGeometry() {
    return [el.handHour,el.handMinute,el.handSecond].map(hand=>{
      // Compare the fully composed hand matrix with the dial matrix: this also
      // catches an accidental second pivot or any inherited scale/translation.
      const dial=hand.ownerSVGElement;
      const matrix=dial.getScreenCTM().inverse().multiply(hand.getScreenCTM());
      const rect=hand.querySelector('rect');
      const center=new DOMPoint(rect.x.baseVal.value+rect.width.baseVal.value/2,rect.y.baseVal.value+rect.height.baseVal.value).matrixTransform(matrix);
      return Math.hypot(center.x-170,center.y-170);
    });
  }
  function completeEffect() {
    if (!effectActive) return;
    clearTimeout(effectTimer);effectTimer=null;
    if (effectListener) el.expanded.removeEventListener('animationend',effectListener);
    effectListener=null;
    el.island.classList.remove('is-cracking','is-finishing');
    el.fx.replaceChildren(); effectActive=false;
    requestViewport({type:'setEffect',active:false},DIAL_SIZE,DIAL_SIZE);
    notificationCenter?.suspend(false);
    scheduleClock();
    send({type:'animationDone'});
    if (selftesting) {
      tickClock(true);
      const offsets = handGeometry(), ok = offsets.every(d=>d<0.000001);
      send({type:'selftestResult',ok,message:'三针基座到圆心距离: '+offsets.map(n=>n.toFixed(8)).join(', ')});
      selftesting=false;
    }
  }
  function crack() {
    cancelEffect();cancelClose();
    effectActive=true;notificationCenter?.suspend(true);requestedOpen=true;++shapeGeneration;
    const generation=effectGeneration;
    scheduleClock();
    // One native resize goes straight to the effect viewport. Keep the current
    // visible surface until the new viewport is ready to draw the full dial.
    requestViewport({type:'setEffect',active:true},EFFECT_SIZE,EFFECT_SIZE,()=>{
      if (generation!==effectGeneration || !effectActive) return;
      showOpen(true);tickClock(true);renderTime(new Date(),true);
      if (reducedMotion()) {effectTimer=setTimeout(completeEffect,150);return;}
      const fragment=document.createDocumentFragment();
      const wrap=document.createElement('div');wrap.className='crack';
      const left=document.createElement('div'),right=document.createElement('div');
      left.className='crack__piece crack__piece--l';right.className='crack__piece crack__piece--r';
      left.style.clipPath='polygon('+[[0,0],...CRACK,[0,100]].map(p=>p[0]+'% '+p[1]+'%').join(',')+')';
      right.style.clipPath='polygon('+[[100,0],[100,100],...CRACK.slice().reverse()].map(p=>p[0]+'% '+p[1]+'%').join(',')+')';
      for (const side of [left,right]) {
        const surface=document.createElement('div');surface.className='crack__surface';
        for (const original of [$('.island__glass',el.island),el.expanded]) {
          const clone=original.cloneNode(true);
          clone.removeAttribute('id');clone.inert=true;
          $$('[id]',clone).forEach(node=>node.removeAttribute('id'));
          surface.appendChild(clone);
        }
        side.appendChild(surface);
      }
      const seam=document.createElementNS('http://www.w3.org/2000/svg','svg');
      seam.setAttribute('viewBox','0 0 340 340');seam.setAttribute('class','crack__seam');
      const points=CRACK.map(p=>p[0]*3.4+','+p[1]*3.4).join(' ');
      seam.innerHTML='<polyline points="'+points+'" fill="none" stroke="#E8C268" stroke-width="10" stroke-linejoin="round"/><polyline points="'+points+'" fill="none" stroke="#FFF" stroke-width="3" stroke-linejoin="round"/>';
      const flash=document.createElement('div');flash.className='crack__flash';
      const shock=document.createElement('div');shock.className='shock';
      wrap.append(left,right,seam,flash,shock);fragment.appendChild(wrap);
      for (let i=0;i<10;i++) {
        const ray=document.createElement('div');ray.className='ray';
        ray.style.setProperty('--a',(i*36+6)+'deg');fragment.appendChild(ray);
      }
      for (let i=0;i<22;i++) {
        const spark=document.createElement('div');spark.className='spark';
        const angle=i/22*Math.PI*2,distance=100+(i%5)*18;
        spark.style.setProperty('--dx',Math.cos(angle)*distance+'px');
        spark.style.setProperty('--dy',Math.sin(angle)*distance+'px');fragment.appendChild(spark);
      }
      el.fx.replaceChildren(fragment);
      requestAnimationFrame(()=>{
        if (generation!==effectGeneration || !effectActive) return;
        effectListener=event=>{
          if (event.target===el.expanded && event.animationName==='surfaceReturn') completeEffect();
        };
        el.expanded.addEventListener('animationend',effectListener);
        el.island.classList.add('is-cracking');
        effectTimer=setTimeout(completeEffect,1700);
      });
    });
  }

  function bindIsland() {
    if (isPanel) return;
    el.expanded.inert = true;
    el.island.addEventListener('click',e=>{
      e.stopPropagation();
      if (done && !completedIdle) returnToCompletedIdle();
      else if (!effectActive) isOpen()?closeIsland():openIsland();
    });
    el.island.addEventListener('contextmenu',e=>{
      e.preventDefault(); e.stopPropagation(); send({type:'togglePanel'});
    });
    el.island.addEventListener('mouseenter',()=>{reconcileCompletionIdle();send({type:'hover',over:true});});
    el.island.addEventListener('mouseleave',()=>send({type:'hover',over:false}));
    el.btnToggle.addEventListener('click',e=>{e.stopPropagation();toggle();});
    el.btnReset.addEventListener('click',e=>{e.stopPropagation();reset();});
    document.addEventListener('keydown',e=>{
      if(e.defaultPrevented)return;
      if (e.key==='Escape') closeIsland();
      if (e.key==='Enter' && e.target===el.island) {e.preventDefault(); if(done && !completedIdle)returnToCompletedIdle();else if(!effectActive)isOpen()?closeIsland():openIsland();}
      if (e.key===' ' && !e.target.matches('input,button')) {e.preventDefault();toggle();}
    });
    document.addEventListener('visibilitychange',resumeView);
    motionPreference.addEventListener('change',()=>{syncIdleEyes();notificationCenter?.syncMain();});
    window.addEventListener('pagehide',()=>{idlePageActive=false;stopIdleCycle();stopIdleEyes();});
    window.addEventListener('pageshow',()=>{idlePageActive=true;resumeView();});
    window.addEventListener('focus',resumeView);
  }
  function inputValue(node) {
    const value = Number(node.value);
    const min = Number(node.min || 0), max = Number(node.max || MAX_SEC);
    const valid = node.value.trim()!=='' && Number.isInteger(value) && value>=min && value<=max;
    node.setAttribute('aria-invalid',String(!valid));
    return valid ? value : null;
  }
  function showError(node,text) {node.textContent=text;node.classList.add('is-error');}
  function bindPanel() {
    if (!isPanel) return;
    $('#panelDragHandle').addEventListener('pointerdown',e=>{
      if (e.pointerType!=='mouse' || e.button!==0 ||
          e.target.closest('button,input,select,textarea,a,label,[role="button"],[contenteditable]')) return;
      e.preventDefault();
      send({type:'dragPanel'});
    });
    el.presets.addEventListener('click',e=>{
      const button = e.target.closest('.preset');
      if (button) { durationDraftDirty=false; send({type:'setDuration',sec:Number(button.dataset.min)*60}); }
    });
    el.btnApplyCustom.addEventListener('click',()=>{
      const values = [el.inH,el.inM,el.inS].map(inputValue);
      if (values.includes(null)) return showError(el.durNote,'请输入整数：时 0–99，分和秒 0–59');
      const sec = values[0]*3600+values[1]*60+values[2];
      if (!sec) return showError(el.durNote,'请输入大于 0 的时长');
      durationDraftDirty=false; send({type:'setDuration',sec});
    });
    el.inTopOffset.addEventListener('input',()=>{
      topOffsetDraftDirty=true;
      el.inTopOffset.setAttribute('aria-invalid','false');
      el.topOffsetNote.classList.remove('is-error');
      el.topOffsetNote.textContent='默认 20 px，超出屏幕时自动贴合可用区域。';
    });
    el.btnApplyTopOffset.addEventListener('click',()=>{
      const value=inputValue(el.inTopOffset);
      if (value===null) return showError(el.topOffsetNote,'请输入 0–1000 的整数像素值');
      S.settings.topOffset=value;topOffsetDraftDirty=false;
      el.inTopOffset.value=value;
      el.topOffsetNote.classList.remove('is-error');
      el.topOffsetNote.textContent='已应用 '+value+' px；超出屏幕时自动贴合可用区域。';
      send({type:'updateSettings',settings:{...S.settings}});
    });
    el.inTopOffset.addEventListener('keydown',e=>{
      if (e.key==='Enter' && !e.isComposing && !e.repeat) {
        e.preventDefault();el.btnApplyTopOffset.click();
      }
    });
    el.panelNav.addEventListener('click',event=>{
      const button=event.target.closest('button[data-panel-page]');
      if (button && el.panelNav.contains(button)) setPanelPage(button.dataset.panelPage);
    });
    el.panelNav.addEventListener('keydown',event=>{
      if(event.isComposing || !['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
      const buttons=$$('button[data-panel-page]:not(:disabled)',el.panelNav);
      const index=buttons.indexOf(document.activeElement);
      if(index<0)return;
      event.preventDefault();
      const next=event.key==='Home'?0:event.key==='End'?buttons.length-1:
        (index+(['ArrowUp','ArrowLeft'].includes(event.key)?-1:1)+buttons.length)%buttons.length;
      buttons[next].focus();
    });
    setPanelPage(panelPage,{focus:false});
    el.relayEnabled.addEventListener('change',markRelayDraft);
    for(const node of [el.relayServiceUrl,el.relayConnectionKey]){
      node.addEventListener('input',markRelayDraft);
      node.addEventListener('keydown',event=>{if(event.key==='Enter'&&!event.isComposing&&!event.repeat){event.preventDefault();saveRelayConfig();}});
    }
    el.btnSaveRelay.addEventListener('click',saveRelayConfig);
    el.btnRevealRelayEndpoint.addEventListener('click',()=>{relayEndpointVisible=!relayEndpointVisible;renderRelayPanel();});
    el.btnCopyRelayEndpoint.addEventListener('click',()=>copyWebhookValue(el.relayEndpoint.value,el.relayEndpoint,'外部 Webhook 地址',el.relayCopyNote));
    const hideRelayEndpoint=()=>{relayEndpointVisible=false;el.relayEndpoint.type='password';el.btnRevealRelayEndpoint.textContent='显示';el.btnRevealRelayEndpoint.setAttribute('aria-pressed','false');};
    window.addEventListener('blur',hideRelayEndpoint);window.addEventListener('pagehide',hideRelayEndpoint);
    el.webhookEnabled.addEventListener('change',markWebhookDraft);
    el.webhookPort.addEventListener('input',markWebhookDraft);
    el.webhookPublicBaseUrl.addEventListener('input',markWebhookDraft);
    el.webhookPublicBaseUrl.addEventListener('keydown',event=>{if(event.key==='Enter'&&!event.isComposing&&!event.repeat){event.preventDefault();saveWebhookConfig();}});
    el.webhookPort.addEventListener('keydown',event=>{if(event.key==='Enter'&&!event.isComposing&&!event.repeat){event.preventDefault();saveWebhookConfig();}});
    for(const [button,scope] of [[el.webhookScopeLocal,'local'],[el.webhookScopeLan,'lan']]){
      button.addEventListener('click',()=>{if(webhookConfigPending)return;webhookDraftScope=scope;markWebhookDraft();});
      button.addEventListener('keydown',event=>{
        if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key) || webhookConfigPending)return;
        event.preventDefault();
        const next=event.key==='Home'?el.webhookScopeLocal:event.key==='End'?el.webhookScopeLan:scope==='local'?el.webhookScopeLan:el.webhookScopeLocal;
        next.click();next.focus();
      });
    }
    el.btnSaveWebhook.addEventListener('click',saveWebhookConfig);
    el.btnRotateWebhookToken.addEventListener('click',rotateWebhookToken);
    el.btnRevealWebhookToken.addEventListener('click',()=>{webhookTokenVisible=!webhookTokenVisible;renderWebhookPanel();});
    el.btnCopyWebhookToken.addEventListener('click',()=>copyWebhookValue(webhookToken,el.webhookToken,'令牌'));
    el.btnCopyWebhookEndpoint.addEventListener('click',()=>copyWebhookValue(el.webhookEndpoint.value,el.webhookEndpoint,'Webhook 地址'));
    el.btnRevealWebhookEndpoint.addEventListener('click',()=>{webhookEndpointVisible=!webhookEndpointVisible;renderWebhookPanel();});
    el.btnTestWebhook.addEventListener('click',sendWebhookTest);
    el.btnWebhookNotifications.addEventListener('click',openNotificationSettings);
    const hideWebhookToken=()=>{webhookTokenVisible=false;webhookEndpointVisible=false;el.webhookEndpoint.type='password';el.btnRevealWebhookEndpoint.textContent='显示';el.btnRevealWebhookEndpoint.setAttribute('aria-pressed','false');if(el.webhookToken)el.webhookToken.type='password';if(el.btnRevealWebhookToken){el.btnRevealWebhookToken.textContent='显示';el.btnRevealWebhookToken.setAttribute('aria-pressed','false');}};
    window.addEventListener('blur',hideWebhookToken);window.addEventListener('pagehide',hideWebhookToken);

    el.btnPhoneNotificationSettings.addEventListener('click',openNotificationSettings);
    el.notificationsEnabled.addEventListener('change',()=>{notificationsDraftDirty=true;saveNotificationsConfig();});
    for(const node of [el.notificationDisplaySeconds,el.notificationListLimit]){
      node.addEventListener('input',()=>{notificationsDraftDirty=true;node.setAttribute('aria-invalid','false');el.notificationsConfigNote.textContent='尚未保存';el.notificationsConfigNote.classList.remove('is-error');});
      node.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.isComposing&&!e.repeat){e.preventDefault();saveNotificationsConfig();}});
    }
    el.btnSaveNotifications.addEventListener('click',saveNotificationsConfig);
    el.btnTestNotification.addEventListener('click',()=>send({type:'notificationTest'}));
    for(const input of [el.phoneEnabled,el.phoneHideContent])input.addEventListener('change',savePhoneConfig);
    el.btnPhoneScan.addEventListener('click',()=>send({type:'phoneScan'}));
    el.btnPhoneDisconnect.addEventListener('click',()=>send({type:'phoneDisconnect'}));
    el.btnOpenTaskPage.addEventListener('click',()=>setTaskPage(true));
    el.btnTaskBack.addEventListener('click',()=>setTaskPage(false));
    el.btnCancelTask.addEventListener('click',()=>setTaskPage(false));
    bindActionKindMenu();
    el.btnAddTask.addEventListener('click',()=>{
      if (pendingTaskCreate) return;
      const name = el.inTaskName.value.replace(/[\u0000-\u001f\u007f-\u009f]/g,'').trim(), values = [el.inTaskMin,el.inTaskSec].map(inputValue);
      if (!name) {showError(el.taskNote,'请输入任务名称');el.inTaskName.focus();return;}
      if (values.includes(null)) return showError(el.taskNote,'请输入整数：分 0–5999，秒 0–59');
      const sec = values[0]*60+values[1];
      if (!sec || sec>MAX_SEC) return showError(el.taskNote,'任务时长应为 1 秒至 99 小时 59 分 59 秒');
      const completionAction=readCreateAction();if(!completionAction)return;
      const requestId=++taskCreateSequence;
      pendingTaskCreate={requestId};setTaskCreateBusy(true);
      el.taskNote.textContent = '正在创建…'; el.taskNote.classList.remove('is-error');
      send({type:'addTask',name,sec,completionAction,requestId});
    });
    for (const node of [el.inH,el.inM,el.inS]) node.addEventListener('input',()=>{durationDraftDirty=true;});
    for (const node of [el.inH,el.inM,el.inS]) node.addEventListener('keydown',e=>{
      if (e.key==='Enter') el.btnApplyCustom.click();
    });
    for (const node of [el.inTaskName,el.inTaskMin,el.inTaskSec]) node.addEventListener('keydown',e=>{
      if (e.key==='Enter' && !e.isComposing && !e.repeat) {e.preventDefault();el.btnAddTask.click();}
    });
    for (const node of [el.actionEnabled,el.actionKind,el.actionCommand,el.actionDelay]) node.addEventListener('input',rememberActionDraft);
    el.actionKind.addEventListener('change',showActionFields);
    el.createActionKind.addEventListener('change',showCreateActionFields);
    showCreateActionFields();
    el.btnSaveAction.addEventListener('click',saveCompletionAction);
    for (const node of [el.editTaskMin,el.editTaskSec]) {
      node.addEventListener('input',rememberTaskDuration);
      node.addEventListener('keydown',e=>{
        if(e.key==='Enter' && !e.isComposing && !e.repeat){e.preventDefault();saveTaskDuration();}
      });
    }
    el.btnSaveTaskDuration.addEventListener('click',saveTaskDuration);
    el.btnCancelPanelAction.addEventListener('click',cancelCompletionAction);
    el.btnStart.addEventListener('click',()=>send({type:'toggleTimer'}));
    el.btnReset2.addEventListener('click',()=>send({type:'resetTimer'}));
    el.btnClear.addEventListener('click',()=>send({type:'clearTasks'}));
    el.btnClose.addEventListener('click',()=>{closeActionKindMenu();send({type:'hidePanel'});});
    document.addEventListener('keydown',e=>{
      if(e.key!=='Escape' || e.isComposing || e.defaultPrevented)return;
      e.preventDefault();
      if(kindMenuOpen)closeActionKindMenu(true);
      else if(panelRoutes[panelPage].parent)setPanelPage(panelRoutes[panelPage].parent);
      else send({type:'hidePanel'});
    });
    for (const [id,key] of Object.entries({
      swHands:'showHands',swSecond:'showSecond',swIdleClock:'showIdleClock',swEyes:'showIdleEyes',swSound:'sound',
      swNotify:'notify',swTop:'alwaysOnTop',swMotion:'reduceMotion'
    })) el[id].addEventListener('change',()=>{
      S.settings[key] = el[id].checked;
      send({type:'updateSettings',settings:{...S.settings}});
    });
  }

  window.__applyState = (state,resetTimer=false) => {
    if (!state) return;
    const previousDuration = S.duration_sec,previousTaskId = S.current_id;
    S = {...S,...state,settings:{...S.settings,...state.settings},phone:normalizedPhone({...S.phone,...state.phone}),notifications:normalizedNotifications({...S.notifications,...state.notifications}),webhook:normalizedWebhook({...S.webhook,...state.webhook}),relay:normalizedRelay({...S.relay,...state.relay})};
    S.duration_sec = duration(S.duration_sec);
    if (resetTimer || S.duration_sec!==previousDuration || S.current_id!==previousTaskId) {
      durationDraftDirty=false;
      if (!isPanel) reset();else completedIdle=false;
    }
    renderAll();
  };
  window.__taskDurationResult = payload => {
    if (!isPanel || !payload) return;
    const pending=taskDurationPending.get(payload.taskId);
    if (!pending || pending.requestId!==payload.requestId) return;
    taskDurationPending.delete(payload.taskId);
    const task=S.tasks.find(task=>task.id===payload.taskId);if(!task)return;
    if (payload.ok) {
      task.sec=pending.sec;taskDurationDrafts.delete(task.id);
    } else {
      const draft=taskDurationDrafts.get(task.id) || {minutes:String(Math.floor(pending.sec/60)),seconds:String(pending.sec%60)};
      taskDurationDrafts.set(task.id,{...draft,error:true,note:String(payload.message || '保存失败，请重试')});
    }
    if(panelPage==='task' && editingTaskId===task.id) {
      renderTaskDuration();renderActionConfig();
      if(payload.ok)el.taskDurationNote.textContent=String(payload.message || '时长已保存');
    }
  };
  window.__taskCreateResult = payload => {
    if (!isPanel || !pendingTaskCreate || !payload || payload.requestId!==pendingTaskCreate.requestId) return;
    // Native persistence, not an unrelated state sync, acknowledges this draft.
    pendingTaskCreate=null;setTaskCreateBusy(false);
    if (!payload.ok) {showError(el.taskNote,String(payload.message || '创建失败，请重试'));return;}
    el.inTaskName.value='';resetCreateAction();el.taskNote.textContent='';el.taskNote.classList.remove('is-error');
    el.taskCreatePage.scrollTop=0;panelScrollPositions.set('create',0);
    // A late response cannot move the user away from the settings page.
    if (panelPage==='create') setTaskPage(false);
  };
  window.__applyTimer = payload => {
    if (!isPanel || !payload) return;
    running=!!payload.running;done=!!payload.done;
    remain=Math.max(0,Number(payload.remainingMs)||0);total=Math.max(1,Number(payload.totalMs)||1);
    timerStarted=payload.started ?? (running || done || remain<total);
    completedIdle=!!payload.idleAfterCompletion && done;
    runId=typeof payload.runId==='string'?payload.runId:'';runTaskId=typeof payload.taskId==='string'?payload.taskId:'';
    renderTime();renderState();
  };
  window.__actionConfigResult = payload => {
    if (!isPanel || !payload) return;
    const scope=payload.taskId;if(typeof scope!=='string' || !scope)return;
    const pending=actionPending.get(scope);actionPending.delete(scope);
    if (payload.ok && pending) {
      const task=S.tasks.find(task=>task.id===scope);
      if (task) task.completionAction={...pending.action};
      if ((actionDrafts.get(scope)?.revision || 0)===pending.revision) actionDrafts.delete(scope);
    }
    if (panelPage!=='task' || scope!==editingTaskId || !editingTask()) return;
    renderActionConfig();
    el.actionConfigNote.textContent=String(payload.message || (payload.ok?'已保存，下次开始生效':'保存失败'));
    el.actionConfigNote.classList.toggle('is-error',!payload.ok);
  };
  window.__actionStatus = payload => {
    if (!payload || !['idle','armed','pending','running','success','error','cancelled'].includes(payload.phase)) return;
    actionStatus={...payload,runId:typeof payload.runId==='string'?payload.runId:'',taskId:typeof payload.taskId==='string'?payload.taskId:''};
    renderActionStatus();
  };
  window.__fromRust = command => {
    if (isPanel) return;
    if (command==='toggleTimer') toggle();
    else if (command==='resetTimer') reset();
    else if (command==='syncTimer') {reconcileCompletionIdle();publishTimer(true);}
  };
  window.__isOpen = isOpen;
  window.__selftestOpen = () => openIsland();
  window.__selftestPanel = () => send({type:'togglePanel'});
  window.__selftestCycle = () => {
    if (isPanel) return;
    openIsland();S.duration_sec=3;reset();renderAll();selftesting=true;start();
  };
  window.__checkHandGeometry = handGeometry;

  if(!isPanel){
    notificationCenter=window.createNotificationCenter({sendLayout:requestNotificationLayout,mainOpen:()=>requestedOpen,closeMain:closeIsland,reducedMotion,onPresenceChange:scheduleClock});
    notificationCenter.bind();
  }
  initializeActionKinds();buildDial();renderAll();bindIsland();bindPanel();
  if (!isPanel) {scheduleClock();publishTimer(true);}
  send({type:'pageReady',view:isPanel?'panel':'island'});
  if(isPanel)requestWebhookStatus();
})();
