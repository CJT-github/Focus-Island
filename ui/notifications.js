/* Focus Island: a source-neutral, memory-only notification companion. */
(() => {
  'use strict';
  const CAPACITY = 200, GAP = 20, MOTION_MS = 420, MAIN_MOTION_MS = 650;
  const EASING = 'cubic-bezier(.22,.8,.25,1)';
  const DEFAULTS = {enabled:true, displaySeconds:5, listLimit:5};
  const controls = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;
  const invalidIdentity = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;
  const encoder = new TextEncoder();
  const text = (value, maximum) => {
    if (typeof value !== 'string') return '';
    return value.replace(controls,' ').slice(0,maximum).replace(/[\ud800-\udbff]$/,'').trim();
  };
  const identity = (value, maximum) => typeof value === 'string' && value.length > 0 &&
    !invalidIdentity.test(value) && encoder.encode(value).length <= maximum ? value : '';
  const boundedInteger = (value, fallback, maximum) =>
    Number.isInteger(value) && value >= 1 && value <= maximum ? value : fallback;
  const titleFor = message => message?.source === 'webhook' &&
    message.title === '新消息' && message.body ? '' : message?.title || '';
  const setText = (node,value) => {
    if (node.textContent === value) return false;
    node.textContent = value;
    return true;
  };
  const setAttribute = (node,name,value) => {
    if (node.getAttribute(name) !== value) node.setAttribute(name,value);
  };

  window.createNotificationCenter = function createNotificationCenter(options = {}) {
    const messages = new Map(), rows = new Map(), animations = new Set();
    let settings = {...DEFAULTS}, bound = false, suspended = false, listOpen = false;
    let previewKey = '', displayedPreviewKey = '', previewStarted = 0, previewUntil = 0;
    let mode = 'none', renderedMode = 'none', requestedKey = '', layoutRevision = 0;
    let hasLayoutRequest = false, mainSafetyUntil = 0;
    let expiryTimer = null, settleTimer = null;
    let cachedListHeight = 0, listDirty = true, safeListHeight = 0;
    let lastMainOpen = !!options.mainOpen?.(), lastPresence = false, dom;
    const mainOpen = () => !!options.mainOpen?.();
    const noMotion = () => !!options.reducedMotion?.();
    const messageKey = (source,id) => JSON.stringify([source,id]);
    const currentMode = () => {
      if (!settings.enabled || suspended || !messages.size) return 'none';
      if (listOpen) return 'list';
      return previewKey && messages.has(previewKey) && Date.now() < previewUntil ? 'preview' : 'count';
    };

    function cancelAnimation() {
      clearTimeout(settleTimer);
      settleTimer = null;
      for (const animation of animations) animation.cancel();
      animations.clear();
    }

    function animate(node,keyframes,duration = MOTION_MS,done) {
      if (typeof node.animate !== 'function') {
        done?.();
        return;
      }
      const animation = node.animate(keyframes,{duration,easing:EASING,fill:'none'});
      animations.add(animation);
      animation.onfinish = () => {
        animations.delete(animation);
        done?.();
      };
    }

    function notifyPresence() {
      const present = settings.enabled && !suspended && messages.size > 0;
      if (present === lastPresence) return;
      lastPresence = present;
      options.onPresenceChange?.(present);
    }

    function geometry(targetMode) {
      const open = mainOpen();
      const width = targetMode === 'preview' ? (open ? 196 : 280) : 44;
      const primaryWidth = open ? 340 : 132;
      const anchor = (window.innerHeight - 340) / 2;
      return {
        open, width, primaryWidth, anchor,
        shift: targetMode === 'none' ? 0 : -(width + GAP) / 2,
        left: (window.innerWidth + primaryWidth - width + GAP) / 2,
        listLeft: (window.innerWidth - 380) / 2
      };
    }

    function renderPreview() {
      if (messages.has(previewKey)) displayedPreviewKey = previewKey;
      // Keep outgoing text through its fade; withdrawn/private content is still removed immediately.
      const message = messages.get(displayedPreviewKey);
      const title = titleFor(message);
      const body = message?.body === title ? '' : message?.body || '';
      setText(dom.app,message?.app || '通知');
      setText(dom.title,title);
      setText(dom.body,body);
      const layout = title && body ? 'detail' : body ? 'body' : title ? 'single' : 'source';
      if (dom.preview.dataset.layout !== layout) dom.preview.dataset.layout = layout;
      setText(dom.count,String(messages.size));
      setText(dom.listCount,String(messages.size));
      setAttribute(dom.companion,'aria-label','查看 ' + messages.size + ' 条通知');
      setAttribute(dom.companion,'aria-expanded',String(listOpen));
    }

    function createRow(key) {
      const row = document.createElement('li');
      row.className = 'notice-item';
      row.dataset.noticeKey = key;
      const label = document.createElement('label');
      label.className = 'notice-check';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.dataset.noticeKey = key;
      checkbox.addEventListener('change',() => {
        if (!checkbox.checked) return;
        // Resolve the current position: a reused row may have moved since it was created.
        const index = Array.prototype.indexOf.call(dom.items.children,row);
        remove(key);
        if (listOpen) {
          const controls = dom.items.querySelectorAll('input[type="checkbox"]');
          controls[Math.max(0,Math.min(index,controls.length - 1))]?.focus({preventScroll:true});
        } else if (messages.size) dom.companion.focus({preventScroll:true});
      });
      const mark = document.createElement('span');
      mark.className = 'notice-check-mark';
      mark.setAttribute('aria-hidden','true');
      label.append(checkbox,mark);
      const copy = document.createElement('div');
      copy.className = 'notice-item-copy';
      const app = document.createElement('span');
      app.className = 'notice-item-app';
      const title = document.createElement('strong');
      title.className = 'notice-item-title';
      const body = document.createElement('span');
      body.className = 'notice-item-body';
      copy.append(title,body);
      row.append(label,copy,app);
      return {row,checkbox,app,title,body};
    }

    function renderList() {
      // Preserve both DOM identity and scroll position when only the queue count changes.
      const visible = Array.from(messages.entries()).slice(0,settings.listLimit);
      const keep = new Set(visible.map(([key]) => key));
      const scrollTop = dom.items.scrollTop;
      let changed = false;
      for (const [key,record] of rows) {
        if (keep.has(key)) continue;
        record.row.remove();
        rows.delete(key);
        changed = true;
      }
      visible.forEach(([key,message],index) => {
        let record = rows.get(key);
        if (!record) {
          record = createRow(key);
          rows.set(key,record);
          changed = true;
        }
        changed = setText(record.app,message.app || '通知') || changed;
        changed = setText(record.title,titleFor(message)) || changed;
        changed = setText(record.body,message.body) || changed;
        setAttribute(record.checkbox,'aria-label','关闭通知：' + (message.title || message.app || '通知'));
        if (dom.items.children[index] !== record.row) {
          dom.items.insertBefore(record.row,dom.items.children[index] || null);
          changed = true;
        }
      });
      if (changed) {
        listDirty = true;
        dom.items.scrollTop = scrollTop;
      }
    }

    function listHeight() {
      if (!listOpen) return 0;
      if (listDirty || !cachedListHeight) {
        // Measure synchronously, then keep the old safe height until the native ACK.
        const previousMaximum = dom.list.style.maxHeight;
        dom.list.style.maxHeight = '280px';
        const height = dom.list.getBoundingClientRect().height;
        cachedListHeight = Math.min(280, Math.max(1,Math.ceil(height || 52 + Math.min(messages.size,settings.listLimit) * 54)));
        dom.list.style.maxHeight = previousMaximum;
        listDirty = false;
      }
      return cachedListHeight;
    }

    function sendLayout(layout,callback) {
      hasLayoutRequest = true;
      const revision = layoutRevision;
      const failed = () => {
        if (revision === layoutRevision) requestedKey = '';
      };
      if (typeof options.sendLayout === 'function') options.sendLayout(layout,callback,failed);
      else callback?.();
    }

    function scheduleExpiry() {
      clearTimeout(expiryTimer);
      expiryTimer = null;
      if (currentMode() !== 'preview') return;
      expiryTimer = setTimeout(wake,Math.max(1,previewUntil - Date.now()));
    }

    function setGeometry(targetMode,geo,immediate) {
      document.body.classList.toggle('notice-no-motion',immediate);
      document.body.classList.toggle('has-notices',targetMode !== 'none');
      document.body.classList.toggle('notice-list-open',targetMode === 'list');
      dom.island.style.setProperty('--notification-shift',geo.shift + 'px');
      dom.companion.style.left = geo.left + 'px';
      dom.companion.style.top = geo.anchor + 'px';
      dom.companion.style.width = geo.width + 'px';
      dom.companion.style.opacity = '';
      dom.list.style.left = geo.listLeft + 'px';
      dom.list.style.top = (geo.anchor + 50) + 'px';
      dom.list.style.width = '380px';
      dom.companion.classList.toggle('is-preview',targetMode === 'preview');
      dom.companion.classList.toggle('is-count',targetMode !== 'preview');
    }

    function finishVisual(targetMode) {
      cancelAnimation();
      dom.companion.dataset.phase = 'settled';
      dom.bridge.dataset.phase = 'settled';
      dom.bridge.hidden = true;
      dom.companion.hidden = targetMode === 'none';
      dom.preview.hidden = targetMode !== 'preview';
      dom.count.hidden = targetMode === 'preview' || targetMode === 'none';
      for (const panel of [dom.preview,dom.count]) {
        panel.style.transform = '';
        panel.style.opacity = '';
        panel.style.width = '';
        panel.style.clipPath = '';
      }
      dom.surface.style.transform = '';
      dom.surface.style.opacity = '';
      if (targetMode === 'none') {
        dom.list.hidden = true;
        document.body.classList.remove('has-notices','notice-list-open');
      }
    }

    function settle(targetMode,geo,revision,height) {
      if (revision !== layoutRevision) return;
      finishVisual(targetMode);
      sendLayout({mode:targetMode,mainOpen:geo.open,listHeight:height},() => {});
    }

    function snapshot() {
      const visible = !dom.companion.hidden;
      const panel = node => ({
        visible:visible && !node.hidden,
        rect:node.getBoundingClientRect(),
        opacity:visible && !node.hidden ? Number(getComputedStyle(node).opacity) : 0
      });
      return {
        visible,
        surface:dom.surface.getBoundingClientRect(),
        opacity:visible ? Number(getComputedStyle(dom.surface).opacity) : 0,
        mainTransform:getComputedStyle(dom.island).transform,
        mainRight:dom.island.getBoundingClientRect().left + 170 + (lastMainOpen ? 170 : 66),
        preview:panel(dom.preview),count:panel(dom.count)
      };
    }

    function movePanel(node,before,visible,shell,revision) {
      if (!visible && !before.visible) {
        node.hidden = true;
        return;
      }
      node.hidden = false;
      if (!visible && before.rect.width > 0) node.style.width = before.rect.width + 'px';
      const destination = node.getBoundingClientRect();
      const startX = before.visible ? before.rect.left - destination.left : 0;
      const endX = visible ? 0 : shell.endLeft + shell.endWidth / 2 -
        (destination.left + destination.width / 2);
      const startOpacity = before.visible ? before.opacity : 0;
      const frame = (progress,opacity) => {
        const x = startX + (endX - startX) * progress;
        const shellLeft = shell.startLeft + (shell.endLeft - shell.startLeft) * progress;
        const shellWidth = shell.startWidth + (shell.endWidth - shell.startWidth) * progress;
        const left = Math.max(0,shellLeft + 7 - destination.left - x);
        const right = Math.max(0,destination.left + x + destination.width - shellLeft - shellWidth + 7);
        return {
          transform:'translateX(' + x + 'px)',
          clipPath:'inset(0px ' + right + 'px 0px ' + left + 'px)',
          opacity,offset:progress
        };
      };
      const end = frame(1,visible ? 1 : 0);
      node.style.opacity = String(end.opacity);
      node.style.transform = end.transform;
      node.style.clipPath = end.clipPath;
      // The text clip follows the surface's exact interpolation without per-frame JS
      // or text scaling. It also contains an outgoing wide preview during contraction.
      const frames = [frame(0,startOpacity)];
      if (!visible) frames.push(frame(0.24,0));
      else if (!before.visible) frames.push(frame(0.72,0));
      frames.push(end);
      animate(node,frames,MOTION_MS,() => {
        if (revision !== layoutRevision || visible) return;
        node.hidden = true;
        node.style.width = '';
        node.style.transform = '';
        node.style.clipPath = '';
      });
    }

    function showGeometry(targetMode,geo,instant,revision,height) {
      const before = snapshot();
      const previousMode = renderedMode;
      cancelAnimation();
      if (geo.open !== lastMainOpen) mainSafetyUntil = Date.now() + MAIN_MOTION_MS;
      setGeometry(targetMode,geo,instant);
      dom.list.hidden = targetMode !== 'list';
      dom.list.style.visibility = '';
      dom.list.style.maxHeight = '280px';
      safeListHeight = height;
      renderedMode = targetMode;
      lastMainOpen = geo.open;
      if (instant) {
        mainSafetyUntil = 0;
        finishVisual(targetMode);
        return;
      }
      const firstAppearance = !before.visible && targetMode !== 'none';
      const disappearing = targetMode === 'none';
      const phase = disappearing || (previousMode === 'preview' && targetMode !== 'preview') ? 'collapsing' : 'splitting';
      dom.companion.hidden = false;
      dom.companion.dataset.phase = phase;
      const mainTarget = getComputedStyle(dom.island).transform;
      if (before.mainTransform !== mainTarget) {
        animate(dom.island,[{transform:before.mainTransform},{transform:mainTarget}]);
      }
      const initialWidth = before.visible ? before.surface.width : 28;
      const initialLeft = before.visible ? before.surface.left : before.mainRight - 20;
      const endWidth = disappearing ? 26 : geo.width;
      const endLeft = disappearing ? window.innerWidth / 2 + geo.primaryWidth / 2 - 20 : geo.left;
      const startTransform = 'translateX(' + (initialLeft - geo.left) + 'px) scaleX(' + (initialWidth / geo.width) + ')';
      const endTransform = 'translateX(' + (endLeft - geo.left) + 'px) scaleX(' + (endWidth / geo.width) + ')';
      dom.surface.style.transform = endTransform;
      dom.surface.style.opacity = disappearing ? '0' : '1';
      animate(dom.surface,[
        {transform:startTransform,opacity:firstAppearance ? 0.25 : before.opacity},
        {transform:endTransform,opacity:disappearing ? 0 : 1}
      ]);
      // Clear any outgoing fixed width before measuring the new text layout.
      dom.preview.style.width = '';
      dom.count.style.width = '';
      dom.preview.style.transform = '';
      dom.count.style.transform = '';
      dom.preview.hidden = targetMode !== 'preview' && !before.preview.visible;
      dom.count.hidden = (targetMode === 'preview' || disappearing) && !before.count.visible;
      const shell = {startLeft:initialLeft,startWidth:initialWidth,endLeft,endWidth};
      movePanel(dom.preview,before.preview,targetMode === 'preview',shell,revision);
      movePanel(dom.count,before.count,targetMode !== 'preview' && !disappearing,shell,revision);
      // A short-lived neck follows the primary edge; it fades before the islands separate.
      dom.bridge.hidden = !(firstAppearance || disappearing) || targetMode === 'list';
      dom.bridge.dataset.phase = phase;
      if (!dom.bridge.hidden) {
        const finalLeft = window.innerWidth / 2 + geo.shift + geo.primaryWidth / 2 - 6;
        dom.bridge.style.left = finalLeft + 'px';
        dom.bridge.style.top = (geo.anchor + 8) + 'px';
        dom.bridge.style.width = (GAP + 12) + 'px';
        dom.bridge.style.opacity = '0';
        animate(dom.bridge,[
          {transform:'translateX(' + (before.mainRight - 6 - finalLeft) + 'px) scaleX(.2) scaleY(.8)',opacity:0,offset:0},
          {transform:'translateX(' + ((before.mainRight - 6 - finalLeft) * 0.6) + 'px) scaleX(.65) scaleY(.7)',opacity:0.65,offset:0.18},
          {transform:'translateX(0px) scaleX(1) scaleY(.28)',opacity:0,offset:0.66},
          {transform:'translateX(0px) scaleX(1) scaleY(.1)',opacity:0,offset:1}
        ]);
      }
      settleTimer = setTimeout(() => settle(targetMode,geo,revision,height),
        Math.max(MOTION_MS,mainSafetyUntil - Date.now()));
    }

    function reconcile(force = false,immediate = false) {
      if (!bound) return;
      mode = currentMode();
      renderPreview();
      if (listOpen || rows.size) renderList();
      if (mode !== 'list') {
        dom.list.hidden = true;
        dom.list.style.visibility = '';
        safeListHeight = 0;
      } else if (dom.list.hidden) {
        dom.list.hidden = false;
        dom.list.style.visibility = 'hidden';
        listDirty = true;
      }
      const geo = geometry(mode);
      const height = mode === 'list' ? listHeight() : 0;
      if (mode === 'list' && renderedMode === 'list' && safeListHeight && height > safeListHeight) {
        dom.list.style.maxHeight = safeListHeight + 'px';
      }
      const nextKey = [mode,geo.open,geo.width,height,geo.anchor,geo.left,geo.listLeft,noMotion()].join(':');
      if (!force && requestedKey === nextKey) {
        scheduleExpiry();
        notifyPresence();
        return;
      }
      if (!hasLayoutRequest && mode === 'none' && renderedMode === 'none') {
        requestedKey = nextKey;
        setGeometry(mode,geo,true);
        finishVisual(mode);
        scheduleExpiry();
        notifyPresence();
        return;
      }
      requestedKey = nextKey;
      const revision = ++layoutRevision;
      // Keep the current visual interpolation alive while the next native region is pending.
      clearTimeout(settleTimer);
      settleTimer = null;
      const instant = immediate || noMotion();
      if (immediate && mode === 'none') {
        cancelAnimation();
        setGeometry(mode,geo,true);
        finishVisual(mode);
        renderedMode = mode;
        lastMainOpen = geo.open;
        mainSafetyUntil = 0;
        sendLayout({mode,mainOpen:geo.open,listHeight:height},() => {});
      } else {
        const targetMode = mode;
        sendLayout({mode:instant ? targetMode : 'transition',mainOpen:geo.open,listHeight:height},() => {
          if (revision !== layoutRevision) return;
          if (currentMode() !== targetMode || mainOpen() !== geo.open) {
            reconcile(true);
            return;
          }
          showGeometry(targetMode,geo,instant,revision,height);
        });
      }
      scheduleExpiry();
      notifyPresence();
    }

    function wake() {
      if (previewUntil && Date.now() >= previewUntil) {
        previewKey = '';
        previewStarted = previewUntil = 0;
      }
      reconcile();
    }

    function remove(key) {
      if (!messages.delete(key)) return;
      if (previewKey === key) previewKey = '', previewStarted = previewUntil = 0;
      if (!messages.size) listOpen = false;
      reconcile();
    }

    function toggleList() {
      if (!settings.enabled || suspended || !messages.size) return;
      listOpen = !listOpen;
      previewKey = '';
      previewStarted = previewUntil = 0;
      if (listOpen) options.closeMain?.();
      reconcile();
    }

    function closeList() {
      if (!listOpen) return;
      listOpen = false;
      reconcile();
      dom.companion.focus({preventScroll:true});
    }

    function configure(value = {}) {
      settings = {
        enabled:typeof value.enabled === 'boolean' ? value.enabled : settings.enabled,
        displaySeconds:boundedInteger(value.displaySeconds,DEFAULTS.displaySeconds,30),
        listLimit:boundedInteger(value.listLimit,DEFAULTS.listLimit,10)
      };
      if (!settings.enabled) {
        messages.clear();
        previewKey = '';
        previewStarted = previewUntil = 0;
        listOpen = false;
        reconcile(true,true);
        return;
      }
      if (previewKey) previewUntil = previewStarted + settings.displaySeconds * 1000;
      wake();
    }

    function receive(event) {
      if (!settings.enabled || !event || typeof event !== 'object') return;
      const source = identity(event.source,80);
      const id = identity(event.id,256);
      if (!source || !id) return;
      const key = messageKey(source,id);
      if (event.type === 'removed') {
        remove(key);
        return;
      }
      if (event.type !== 'posted') return;
      const existing = messages.has(key);
      messages.set(key,{
        source,id,app:text(event.app || event.package,80),
        title:text(event.title,256),body:text(event.body,2048),
        time:Number.isFinite(event.time) ? event.time : Date.now()
      });
      while (messages.size > CAPACITY) messages.delete(messages.keys().next().value);
      if (!listOpen && !suspended && !existing) {
        previewKey = key;
        previewStarted = Date.now();
        previewUntil = previewStarted + settings.displaySeconds * 1000;
      }
      wake();
    }

    function clearSource(source) {
      if (!identity(source,80)) return;
      for (const [key,message] of messages) if (message.source === source) messages.delete(key);
      if (!messages.has(previewKey)) previewKey = '', previewStarted = previewUntil = 0;
      if (!messages.size) listOpen = false;
      reconcile();
    }

    function redactSource(source) {
      if (!identity(source,80)) return;
      for (const message of messages.values()) {
        if (message.source === source) message.title = '', message.body = '';
      }
      reconcile();
    }

    function suspend(value) {
      if (suspended === !!value) return;
      suspended = !!value;
      if (suspended) {
        listOpen = false;
        previewKey = '';
        previewStarted = previewUntil = 0;
      }
      reconcile(true,suspended);
    }

    function bind() {
      if (bound) return true;
      const byId = id => document.getElementById(id);
      dom = {
        island:byId('island'),companion:byId('noticeCompanion'),surface:byId('noticeSurface'),preview:byId('noticePreview'),
        app:byId('noticeApp'),title:byId('noticeTitle'),body:byId('noticeBody'),count:byId('noticeCount'),
        bridge:byId('noticeBridge'),list:byId('noticeList'),listCount:byId('noticeListCount'),
        closeList:byId('btnCloseNoticeList'),items:byId('noticeItems')
      };
      if (Object.values(dom).some(node => !node)) return false;
      bound = true;
      dom.companion.addEventListener('click',event => {event.preventDefault();event.stopPropagation();toggleList();});
      dom.closeList.addEventListener('click',event => {event.preventDefault();event.stopPropagation();closeList();});
      dom.list.addEventListener('click',event => event.stopPropagation());
      document.addEventListener('keydown',event => {
        if (event.key !== 'Escape' || !listOpen) return;
        event.preventDefault();
        event.stopPropagation();
        closeList();
      },true);
      document.addEventListener('visibilitychange',wake);
      window.addEventListener('focus',wake);
      window.addEventListener('pageshow',wake);
      window.addEventListener('resize',() => {listDirty = true;reconcile();});
      reconcile();
      return true;
    }

    function getState() {
      return {
        mode:currentMode(),renderedMode,count:messages.size,listOpen,suspended,
        activeId:messages.get(previewKey)?.id || '',settings:{...settings},
        items:Array.from(messages.values(),message => ({...message}))
      };
    }

    function syncMain() {
      if (mainOpen() && listOpen) listOpen = false;
      reconcile();
    }

    return {bind,configure,receive,clearSource,redactSource,syncMain,
      suspend,getState};
  };
})();
