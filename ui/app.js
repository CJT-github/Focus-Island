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
    settings:{showHands:true,showSecond:true,showIdleClock:true,showIdleEyes:false,sound:true,notify:false,alwaysOnTop:true,reduceMotion:false}
  };
  let S = {...defaults, ...window.__STATE__};
  S.settings = {...defaults.settings, ...S.settings};
  const MAX_SEC = 359999;
  const duration = value => Math.min(MAX_SEC, Math.max(1, Math.trunc(Number(value) || 1500)));
  S.duration_sec = duration(S.duration_sec);
  let remain = S.duration_sec * 1000, total = remain;
  let running = false, done = false, timerStarted = false, deadline = 0, tickTimer = null;
  let lastTimerMessage = '', closeTimer = null, effectTimer = null, effectActive = false;
  let effectGeneration = 0, selftesting = false, durationDraftDirty = false;
  let runId = '', runTaskId = '', runTaskName = '', runSequence = 0;
  let actionDraftScope = null, actionDraftRevision = 0;
  const actionDrafts = new Map(), actionPending = new Map();
  let actionStatus = {phase:'idle',runId:''};
  let panelPage = 'settings', editingTaskId = '', settingsReturnTaskId = '', settingsScrollTop = 0, pendingTaskCreate = null;
  let taskCreateSequence = Date.now(), activeKindEditor = null;
  let kindMenuOpen = false, kindMenuIndex = 0, kindMenuTimer = null, kindMenuFrame = null;

  const el = Object.fromEntries([
    'island','compactTime','idleEyes','readoutTask','readoutDigits','readoutChip','miniRing','dialProgress',
    'handHour','handMinute','handSecond','ticks','hourMarks','fx','btnToggle','btnReset',
    'taskList','presets','inH','inM','inS','durNote','inTaskName','inTaskMin','inTaskSec','taskNote',
    'swHands','swSecond','swIdleClock','swEyes','swSound','swNotify','swTop','swMotion',
    'btnClose','btnStart','btnReset2','btnClear','btnAddTask','btnApplyCustom','expanded',
    'actionScope','actionEnabled','actionKind','actionCommand','actionCommandField','actionDelay','btnSaveAction','actionConfigNote',
    'islandAction','panelAction','btnCancelIslandAction','btnCancelPanelAction',
    'settingsPage','taskCreatePage','taskSettingsPage','taskSettingsDuration','btnOpenTaskPage','btnTaskBack','btnCancelTask','panelTitle',
    'actionKindTrigger','actionKindValue','actionKindMenu',
    'createActionEnabled','createActionKind','createActionCommand','createActionCommandField','createActionDelay',
    'createActionKindTrigger','createActionKindValue'
  ].map(id => [id, $('#'+id)]));

  const currentTask = () => S.tasks.find(t => t.id === S.current_id);
  // A selected task takes priority; free timers retain their result until reset.
  const clockIdle = () => !currentTask() && !timerStarted;
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
    el.readoutTask.textContent = clock ? (S.settings.showIdleClock?'当前时间':'待机') : currentTask()?.name || '自由专注';
    el.readoutChip.textContent = clock ? (S.tasks.length ? '等待专注' : '暂无任务') : done ? '时间到' : running ? '专注中' : timerStarted ? '已暂停' : '准备开始';
    el.island.classList.remove('is-running','is-done','is-idle');
    el.island.classList.add(done?'is-done':running?'is-running':'is-idle');
    el.btnToggle.innerHTML = running
      ? '<svg viewBox="0 0 24 24" class="ico"><rect x="7" y="5" width="3.6" height="14" rx="1.4" fill="currentColor"/><rect x="13.4" y="5" width="3.6" height="14" rx="1.4" fill="currentColor"/></svg>'
      : '<svg viewBox="0 0 24 24" class="ico"><path d="M8 5.5v13l11-6.5z" fill="currentColor"/></svg>';
    el.btnToggle.setAttribute('aria-label',running?'暂停倒计时':'开始倒计时');
    el.btnToggle.title = running?'暂停':'开始';
    el.btnStart.textContent = running?'暂停':done?'再来一次':timerStarted?'继续':'开始';
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
  function setPanelPage(page) {
    if (!isPanel || !['settings','create','task'].includes(page)) return;
    if (page==='task' && !editingTask()) return;
    closeActionKindMenu();
    if (panelPage==='settings' && page!=='settings') settingsScrollTop=el.settingsPage.scrollTop;
    panelPage=page;
    for (const [node,name] of [[el.settingsPage,'settings'],[el.taskCreatePage,'create'],[el.taskSettingsPage,'task']]) {
      const active=page===name;node.classList.toggle('is-active',active);node.inert=!active;
      node.setAttribute('aria-hidden',String(!active));
    }
    el.panelTitle.textContent=page==='create'?'新增任务':page==='task'?'任务设置':'设置';
    el.btnTaskBack.hidden=page==='settings';
    if (page==='settings') {editingTaskId='';el.settingsPage.scrollTop=settingsScrollTop;}
    if (page==='task') renderActionConfig();
    renderActionStatus();
    requestAnimationFrame(()=>{
      if (panelPage!==page) return;
      const target=page==='create'?(pendingTaskCreate?el.btnTaskBack:el.inTaskName):page==='task'?el.actionEnabled:
        $$('.task__edit',el.taskList).find(button=>button.dataset.taskId===settingsReturnTaskId) || el.btnOpenTaskPage;
      target.focus({preventScroll:true});
    });
  }
  function setTaskPage(show) {
    if (show) settingsReturnTaskId='';
    setPanelPage(show?'create':'settings');
  }
  function openTaskSettings(taskId) {
    if (!S.tasks.some(task=>task.id===taskId)) return;
    editingTaskId=taskId;settingsReturnTaskId=taskId;el.taskSettingsPage.scrollTop=0;
    setPanelPage('task');
  }
  function reconcileTaskEditors() {
    const ids=new Set(S.tasks.map(task=>task.id));
    for (const drafts of [actionDrafts,actionPending]) for (const id of drafts.keys()) if(!ids.has(id))drafts.delete(id);
    if (actionDraftScope && !ids.has(actionDraftScope)) actionDraftScope=null;
    if (panelPage==='task' && !ids.has(editingTaskId)) setPanelPage('settings');
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
    const phase=actionStatus.phase,visible=phase!=='idle';
    const phases={armed:'已准备',pending:'等待执行',running:'执行中',success:'已完成',error:'执行失败',cancelled:'已取消'};
    const remaining=Number(actionStatus.remainingSec);
    const phaseText=phase==='pending'&&Number.isFinite(remaining)?Math.max(0,Math.ceil(remaining))+' 秒后执行':phases[phase]||'';
    for (const node of [el.islandAction,el.panelAction]) {
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
    renderTasks();reconcileTaskEditors();renderActionConfig();renderActionStatus();
  }
  function renderAll() {
    renderState(); renderTime(); renderPanel();
    el.island.classList.toggle('is-hide-hands',!S.settings.showHands);
    document.body.classList.toggle('reduce-motion',!!S.settings.reduceMotion);
    if (!isPanel) scheduleClock();
  }
  function publishTimer(force = false) {
    if (isPanel) return;
    const taskId=runId?runTaskId:(currentTask()?.id || '');
    const key = [runId,taskId,running,done,timerStarted,seconds(remain),total].join(':');
    if (force || key !== lastTimerMessage) {
      lastTimerMessage = key;
      send({type:'timerState',runId,taskId,running,done,started:timerStarted,remainingMs:remain,totalMs:total});
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
    }
  }
  function reset() {
    if (isPanel) return;
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
  let idleCycleTimer = null, idleCycleEyes = false;
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
    clearTimeout(idleCycleTimer);idleCycleTimer=null;idleCycleEyes=false;
  }
  function queueIdleCycle() {
    idleCycleTimer=setTimeout(()=>{
      idleCycleEyes=!idleCycleEyes;
      queueIdleCycle();
      syncIdleEyes();
    },10000);
  }
  function syncIdleEyes() {
    if (!idleEyesEligible()) {stopIdleCycle();stopIdleEyes();return;}
    if (S.settings.showIdleClock) {
      // Both enabled: clock first, then eyes, ten seconds each. Clock ticks and
      // unrelated settings refreshes must not reset this independent schedule.
      if (idleCycleTimer===null) {idleCycleEyes=false;queueIdleCycle();}
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
  window.__viewportReady=requestId=>{
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
    cancelClose(); requestedOpen = true;
    syncIdleEyes();
    const generation = ++shapeGeneration;
    requestViewport({type:'setShape',open:true},DIAL_SIZE,DIAL_SIZE,()=>{
      if (generation===shapeGeneration && requestedOpen) showOpen(instant);
    });
  }
  function closeIsland() {
    if (isPanel || !requestedOpen || effectActive) return;
    cancelClose(); cancelViewport();
    requestedOpen = false;
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
    effectActive=true;requestedOpen=true;++shapeGeneration;
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
      e.stopPropagation(); if (!effectActive) isOpen()?closeIsland():openIsland();
    });
    el.island.addEventListener('contextmenu',e=>{
      e.preventDefault(); e.stopPropagation(); send({type:'togglePanel'});
    });
    el.island.addEventListener('mouseenter',()=>send({type:'hover',over:true}));
    el.island.addEventListener('mouseleave',()=>send({type:'hover',over:false}));
    el.btnToggle.addEventListener('click',e=>{e.stopPropagation();toggle();});
    el.btnReset.addEventListener('click',e=>{e.stopPropagation();reset();});
    el.btnCancelIslandAction.addEventListener('click',cancelCompletionAction);
    document.addEventListener('keydown',e=>{
      if (e.key==='Escape') closeIsland();
      if (e.key==='Enter' && e.target===el.island) {e.preventDefault(); isOpen()?closeIsland():openIsland();}
      if (e.key===' ' && !e.target.matches('input,button')) {e.preventDefault();toggle();}
    });
    document.addEventListener('visibilitychange',()=>{sampleTime();scheduleClock();});
    motionPreference.addEventListener('change',syncIdleEyes);
    window.addEventListener('pagehide',()=>{idlePageActive=false;stopIdleCycle();stopIdleEyes();});
    window.addEventListener('pageshow',()=>{idlePageActive=true;syncIdleEyes();});
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
    el.btnCancelPanelAction.addEventListener('click',cancelCompletionAction);
    el.btnStart.addEventListener('click',()=>send({type:'toggleTimer'}));
    el.btnReset2.addEventListener('click',()=>send({type:'resetTimer'}));
    el.btnClear.addEventListener('click',()=>send({type:'clearTasks'}));
    el.btnClose.addEventListener('click',()=>{closeActionKindMenu();send({type:'hidePanel'});});
    document.addEventListener('keydown',e=>{
      if(e.key!=='Escape' || e.isComposing || e.defaultPrevented)return;
      e.preventDefault();
      if(kindMenuOpen)closeActionKindMenu(true);
      else if(panelPage!=='settings')setPanelPage('settings');
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
    const previousDuration = S.duration_sec;
    S = {...S,...state,settings:{...S.settings,...state.settings}};
    S.duration_sec = duration(S.duration_sec);
    if (resetTimer || S.duration_sec!==previousDuration) durationDraftDirty=false;
    if (!isPanel && (resetTimer || S.duration_sec!==previousDuration)) reset();
    renderAll();
  };
  window.__taskCreateResult = payload => {
    if (!isPanel || !pendingTaskCreate || !payload || payload.requestId!==pendingTaskCreate.requestId) return;
    // Native persistence, not an unrelated state sync, acknowledges this draft.
    pendingTaskCreate=null;setTaskCreateBusy(false);
    if (!payload.ok) {showError(el.taskNote,String(payload.message || '创建失败，请重试'));return;}
    el.inTaskName.value='';resetCreateAction();el.taskNote.textContent='';el.taskNote.classList.remove('is-error');
    el.taskCreatePage.scrollTop=0;
    // A late response cannot move the user away from the settings page.
    if (panelPage==='create') setTaskPage(false);
  };
  window.__applyTimer = payload => {
    if (!isPanel || !payload) return;
    running=!!payload.running;done=!!payload.done;
    remain=Math.max(0,Number(payload.remainingMs)||0);total=Math.max(1,Number(payload.totalMs)||1);
    timerStarted=payload.started ?? (running || done || remain<total);
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
    else if (command==='syncTimer') publishTimer(true);
  };
  window.__isOpen = isOpen;
  window.__selftestOpen = () => openIsland();
  window.__selftestPanel = () => send({type:'togglePanel'});
  window.__selftestCycle = () => {
    if (isPanel) return;
    openIsland();S.duration_sec=3;reset();renderAll();selftesting=true;start();
  };
  window.__checkHandGeometry = handGeometry;

  initializeActionKinds();buildDial();renderAll();bindIsland();bindPanel();
  if (!isPanel) {scheduleClock();publishTimer(true);}
  send({type:'pageReady',view:isPanel?'panel':'island'});
})();
