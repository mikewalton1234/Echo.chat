#!/usr/bin/env python3
"""admin_panel_inject.py

Server-side injection for the *admin-only* control panel.

Design goals:
  - Nothing in static end-user assets (chat.html / chat.js / chat.css) needs to contain admin UI.
  - Admin UI is delivered only when the server is rendering /chat for an admin user.
  - Admin UI calls existing /admin/* endpoints (RBAC-protected) using fetch(..., credentials:'include').

Security notes:
  - The HTML/JS/CSS is injected only when users.is_admin is TRUE.
  - All privileged actions still require valid access JWT + RBAC permission checks.
  - The panel auto-refreshes access tokens via /token/refresh if a request returns 401.
"""

from __future__ import annotations

def build_admin_injection_snippet() -> str:
    """Return a single HTML snippet containing the admin panel CSS + JS."""

    css = r"""

/* EchoChat Admin Panel — injected (admin only) */
/* v3: cleaner, more professional UI + better UX (drag, pin, max, toasts) */

#ecAdminPanel{
  --ecap-bg: rgba(12,14,18,.88);
  --ecap-bg2: rgba(18,21,28,.92);
  --ecap-border: rgba(255,255,255,.10);
  --ecap-border2: rgba(255,255,255,.14);
  --ecap-text: #eaf0ff;
  --ecap-muted: rgba(234,240,255,.72);
  --ecap-accent: rgba(124,179,255,1);
  --ecap-danger: rgba(255,84,84,1);
  --ecap-warn: rgba(255,199,107,1);
  --ecap-ok: rgba(120,255,170,1);

  position:fixed;
  top:16px; right:16px;
  width:520px;
  max-width:calc(100vw - 32px);
  max-height:calc(100vh - 32px);

  background: linear-gradient(180deg, var(--ecap-bg2), var(--ecap-bg));
  color:var(--ecap-text);

  border:1px solid var(--ecap-border);
  border-radius:16px;
  box-shadow: 0 18px 55px rgba(0,0,0,.55);

  font: 13px/1.35 system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,Arial,sans-serif;
  z-index:999999;
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);

  overflow:hidden;
}

/* Hidden (persisted “closed”) state — can be toggled back with a hotkey */
#ecAdminPanel.ecap-hidden{ display:none !important; }

#ecAdminPanel *{ box-sizing:border-box; }
#ecAdminPanel ::selection{ background: rgba(124,179,255,.25); }

#ecAdminPanel .ecap-head{
  display:flex;
  align-items:center;
  justify-content:space-between;
  gap:10px;
  padding:10px 10px 8px 12px;
  user-select:none;
  border-bottom:1px solid rgba(255,255,255,.08);
  cursor:move;
}

#ecAdminPanel.ecap-pinned .ecap-head{ cursor:default; }

#ecAdminPanel .ecap-titleRow{ display:flex; align-items:center; gap:10px; min-width:0; }
#ecAdminPanel .ecap-dot{
  width:9px; height:9px; border-radius:999px;
  background: rgba(255,255,255,.25);
  box-shadow: 0 0 0 2px rgba(0,0,0,.35) inset;
  flex:0 0 auto;
}
#ecAdminPanel .ecap-dot.ok{ background: rgba(120,255,170,.85); }
#ecAdminPanel .ecap-dot.bad{ background: rgba(255,84,84,.85); }
#ecAdminPanel .ecap-title{
  font-weight:750;
  letter-spacing:.2px;
  white-space:nowrap;
  overflow:hidden;
  text-overflow:ellipsis;
}
#ecAdminPanel .ecap-subtitle{
  font-size:11px;
  color:var(--ecap-muted);
  white-space:nowrap;
  overflow:hidden;
  text-overflow:ellipsis;
  margin-top:1px;
}
#ecAdminPanel .ecap-titleBlock{ min-width:0; }
#ecAdminPanel .ecap-headBtns{ display:flex; gap:6px; align-items:center; flex:0 0 auto; }

#ecAdminPanel .ecap-btn,
#ecAdminPanel .ecap-iconBtn{
  background: rgba(255,255,255,.07);
  color: var(--ecap-text);
  border: 1px solid var(--ecap-border);
  border-radius: 12px;
  padding: 7px 10px;
  cursor:pointer;
  transition: transform .06s ease, background .12s ease, border-color .12s ease;
}
#ecAdminPanel .ecap-iconBtn{
  padding: 7px 9px;
  min-width: 36px;
  text-align:center;
}
#ecAdminPanel .ecap-btn:hover,
#ecAdminPanel .ecap-iconBtn:hover{ background: rgba(255,255,255,.11); border-color: var(--ecap-border2); }
#ecAdminPanel .ecap-btn:active,
#ecAdminPanel .ecap-iconBtn:active{ transform: translateY(1px); }

#ecAdminPanel .ecap-btn.primary{ border-color: rgba(124,179,255,.35); }
#ecAdminPanel .ecap-btn.danger,
#ecAdminPanel .ecap-iconBtn.danger{ border-color: rgba(255,84,84,.35); }

#ecAdminPanel .ecap-btn[disabled],
#ecAdminPanel .ecap-iconBtn[disabled]{ opacity:.55; cursor:not-allowed; transform:none; }

#ecAdminPanel input, #ecAdminPanel select, #ecAdminPanel textarea{
  width:100%;
  padding:9px 10px;
  border-radius:12px;
  background: rgba(255,255,255,.06);
  border: 1px solid rgba(255,255,255,.10);
  color: var(--ecap-text);
  outline:none;
}
#ecAdminPanel textarea{ min-height:64px; resize:vertical; }

#ecAdminPanel input:focus-visible,
#ecAdminPanel select:focus-visible,
#ecAdminPanel textarea:focus-visible,
#ecAdminPanel .ecap-btn:focus-visible,
#ecAdminPanel .ecap-iconBtn:focus-visible{
  box-shadow: 0 0 0 3px rgba(124,179,255,.22);
  border-color: rgba(124,179,255,.45);
}

#ecAdminPanel .ecap-body{
  padding: 10px 12px 12px;
  overflow:auto;
  max-height: calc(100vh - 72px);
}

/*
  Autosizing / layout improvements
  - In maximized mode, make the active section + its primary list stretch to fill the panel.
  - Prevents a large “blank area” under short lists (e.g., Audit tab) when the panel is tall.
*/
#ecAdminPanel.ecap-max{
  display:flex;
  flex-direction:column;
}
#ecAdminPanel.ecap-max .ecap-body{
  display:flex;
  flex-direction:column;
  flex: 1 1 auto;
  min-height: 0;
  overflow:hidden;
}
#ecAdminPanel.ecap-max .ecap-tabs{ flex: 0 0 auto; }
#ecAdminPanel.ecap-max .ecap-toastStack{ flex: 0 0 auto; }
#ecAdminPanel.ecap-max .ecap-section.active{
  display:flex;
  flex-direction:column;
  flex: 1 1 auto;
  min-height: 0;
  overflow:auto;
}

/* Utility classes used by sections that should stretch in max mode */
#ecAdminPanel.ecap-max .ecap-fill{ flex: 1 1 auto; min-height: 0; }
#ecAdminPanel.ecap-max .ecap-fillCol{ display:flex; flex-direction:column; }
#ecAdminPanel.ecap-max .ecap-fillScroll{
  flex: 1 1 auto;
  min-height: 0;
  overflow:auto;
  max-height:none !important;
}

#ecAdminPanel .ecap-tabs{
  display:flex;
  gap:6px;
  margin: 0 0 10px;
  flex-wrap:wrap;
}
#ecAdminPanel .ecap-tab{
  flex:1 1 30%;
  border-radius:12px;
  padding: 8px 10px;
  border:1px solid rgba(255,255,255,.10);
  background: rgba(255,255,255,.05);
  cursor:pointer;
  display:flex;
  gap:8px;
  align-items:center;
  justify-content:center;
}
#ecAdminPanel .ecap-tab .ico{ opacity:.95; }
#ecAdminPanel .ecap-tab.active{
  background: rgba(124,179,255,.12);
  border-color: rgba(124,179,255,.28);
}

#ecAdminPanel .ecap-section{ display:none; }
#ecAdminPanel .ecap-section.active{ display:block; }

#ecAdminPanel .ecap-grid2{ display:grid; grid-template-columns:1fr 1fr; gap:10px; }
#ecAdminPanel .ecap-grid3{ display:grid; grid-template-columns:1fr 1fr 1fr; gap:10px; }
#ecAdminPanel .ecap-row{ display:flex; gap:8px; align-items:center; margin:8px 0; }
#ecAdminPanel .ecap-row > *{ flex:1; }
#ecAdminPanel .tight{ flex:0 0 auto; }
#ecAdminPanel .ecap-hr{ height:1px; background:rgba(255,255,255,.08); margin:12px 0; }

#ecAdminPanel .ecap-card{
  border:1px solid rgba(255,255,255,.10);
  background: rgba(0,0,0,.18);
  border-radius:14px;
  padding: 10px;
  margin: 10px 0;
}
#ecAdminPanel .ecap-card h4{
  margin:0 0 8px 0;
  font-size: 12px;
  letter-spacing:.22px;
  opacity:.95;
}
#ecAdminPanel .ecap-muted{ color: var(--ecap-muted); font-size: 11px; }
#ecAdminPanel .ecap-kv{ display:grid; grid-template-columns: 1fr auto; gap: 7px 10px; }
#ecAdminPanel .ecap-k{ color: var(--ecap-muted); }
#ecAdminPanel .ecap-v{ font-weight: 750; }

#ecAdminPanel .ecap-statGrid{ display:grid; grid-template-columns: 1fr 1fr 1fr; gap:10px; }
#ecAdminPanel .ecap-stat{
  border:1px solid rgba(255,255,255,.10);
  background: rgba(255,255,255,.04);
  border-radius:14px;
  padding:10px;
  min-height:54px;
}
#ecAdminPanel .ecap-stat .lbl{ color: var(--ecap-muted); font-size: 11px; }
#ecAdminPanel .ecap-stat .val{ font-weight: 780; font-size: 14px; margin-top:3px; }

#ecAdminPanel .ecap-list{
  max-height: 210px;
  overflow:auto;
  border-radius: 14px;
  border:1px solid rgba(255,255,255,.10);
  background: rgba(0,0,0,.18);
}
#ecAdminPanel .ecap-item{
  display:flex; align-items:center; justify-content:space-between; gap:10px;
  padding: 9px 10px;
  border-bottom:1px solid rgba(255,255,255,.06);
}
#ecAdminPanel .ecap-item:last-child{ border-bottom:none; }
#ecAdminPanel .ecap-item:hover{ background: rgba(255,255,255,.04); }

#ecAdminPanel .ecap-pill{
  display:inline-flex; align-items:center; gap:6px;
  padding: 2px 9px;
  border-radius:999px;
  border:1px solid rgba(255,255,255,.14);
  font-size: 11px;
  color: rgba(234,240,255,.92);
}
#ecAdminPanel .ecap-pill.ok{ border-color: rgba(120,255,170,.35); }
#ecAdminPanel .ecap-pill.warn{ border-color: rgba(255,199,107,.35); }
#ecAdminPanel .ecap-pill.bad{ border-color: rgba(255,84,84,.35); }

#ecAdminPanel .ecap-actions{ display:flex; flex-wrap:wrap; gap:6px; }

#ecAdminPanel .ecap-drop{
  border:1px dashed rgba(255,255,255,.22);
  border-radius:14px;
  padding:10px;
  background: rgba(255,255,255,.03);
}
#ecAdminPanel .ecap-drop.dragover{
  background: rgba(124,179,255,.10);
  border-color: rgba(124,179,255,.35);
}

#ecAdminPanel .ecap-log{
  max-height: 150px;
  overflow:auto;
  padding: 10px;
  border-radius: 14px;
  background: rgba(0,0,0,.28);
  border: 1px solid rgba(255,255,255,.08);
  font-family: ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;
  font-size: 11px;
  color: rgba(234,240,255,.88);
  white-space: pre-wrap;
}

#ecAdminPanel .ecap-toastStack{
  position: sticky;
  top: 0;
  display:flex;
  flex-direction:column;
  gap:6px;
  margin: 0 0 10px;
  z-index: 1;
}
#ecAdminPanel .ecap-toast{
  border-radius: 14px;
  border:1px solid rgba(255,255,255,.12);
  background: rgba(0,0,0,.22);
  padding: 8px 10px;
  display:flex;
  align-items:flex-start;
  justify-content:space-between;
  gap:10px;
}
#ecAdminPanel .ecap-toast .tmsg{ color: rgba(234,240,255,.92); }
#ecAdminPanel .ecap-toast .tmeta{ color: var(--ecap-muted); font-size: 11px; margin-top:2px; }
#ecAdminPanel .ecap-toast.ok{ border-color: rgba(120,255,170,.25); }
#ecAdminPanel .ecap-toast.warn{ border-color: rgba(255,199,107,.25); }
#ecAdminPanel .ecap-toast.err{ border-color: rgba(255,84,84,.25); }
#ecAdminPanel .ecap-toast .x{ opacity:.8; cursor:pointer; padding:0 6px; }

#ecAdminPanel.ecap-mini .ecap-body{ display:none; }
#ecAdminPanel.ecap-mini{ height:52px !important; max-height:52px !important; }

#ecAdminPanel.ecap-max{
  width: 740px;
  height: calc(100vh - 32px);
}
#ecAdminPanel.ecap-max .ecap-body{ max-height: none; height: calc(100vh - 72px); }

@media (max-width: 520px){
  #ecAdminPanel{ right:10px; left:10px; width:auto; max-width:none; }
}

"""

    js = r"""

(function(){
  if (!window || !document) return;
  if (!window.IS_ADMIN) return;

  const STATE_KEY = 'ecap_state_v3';
  const state = (()=>{
    try{ return JSON.parse(localStorage.getItem(STATE_KEY)||'{}') || {}; }catch(_){ return {}; }
  })();
  function saveState(){ try{ localStorage.setItem(STATE_KEY, JSON.stringify(state)); }catch(_){ } }

  // Panel reference + recovery helpers (prevents “blank panel” and allows hotkey reopen)
  let panelRef = null;
  function getPanel(){ return panelRef || document.getElementById('ecAdminPanel'); }

  function ensurePanel(){
    let p = document.getElementById('ecAdminPanel');
    if (!p){
      buildPanel();
      p = document.getElementById('ecAdminPanel');
    }
    // If panel exists but looks incomplete, rebuild it.
    if (p && (!p.querySelector('.ecap-head') || !p.querySelector('.ecap-tabs'))){
      try{ p.remove(); }catch(_){}
      buildPanel();
      p = document.getElementById('ecAdminPanel');
    }
    panelRef = p;
    return p;
  }

  function showPanel(opts){
    const p = ensurePanel();
    if (!p) return null;
    p.classList.remove('ecap-hidden');
    state.closed = false;

    // If it was minimized, it can look “blank” — un-minimize when showing via hotkey.
    if (opts && opts.unmini){
      p.classList.remove('ecap-mini');
      p.style.height = '';
      p.style.maxHeight = '';
      state.mini = false;
    }

    // If it ended up off-screen, reset to default position.
    try{
      const r = p.getBoundingClientRect();
      const pad = 12;
      const vw = window.innerWidth || document.documentElement.clientWidth || 0;
      const vh = window.innerHeight || document.documentElement.clientHeight || 0;
      const offscreen = (r.right < pad) || (r.left > vw - pad) || (r.bottom < pad) || (r.top > vh - pad);
      if (offscreen){
        p.style.left = '';
        p.style.top = '';
        p.style.right = '16px';
        state.left = undefined;
        state.top = undefined;
      }
    }catch(_){}

    saveState();
    return p;
  }

  function hidePanel(){
    const p = getPanel();
    if (!p) return;
    p.classList.add('ecap-hidden');
    state.closed = true;
    saveState();
  }

  function togglePanel(){
    const p = ensurePanel();
    if (!p) return;
    const nowHidden = p.classList.toggle('ecap-hidden');
    state.closed = nowHidden;
    saveState();
    if (!nowHidden){
      // Ensure it doesn't look blank when reopening
      showPanel({unmini:true});
    }
  }

  function resetPanel(){
    try{ localStorage.removeItem(STATE_KEY); }catch(_){}
    try{ const p = document.getElementById('ecAdminPanel'); if (p) p.remove(); }catch(_){}
    panelRef = null;
    try{ buildPanel(); }catch(e){ console.error(e); }
    showPanel({unmini:true});
  }

  // Hotkeys:
  // - Ctrl+Alt+P toggles the admin panel (re-open even after “close”)
  // - Ctrl+Alt+Shift+P resets panel state + rebuilds (fixes “blank/bugged” panels)
  document.addEventListener('keydown', (e)=>{
    try{
      const k = (e && e.key ? String(e.key) : '').toLowerCase();
      if (e && e.ctrlKey && e.altKey && e.shiftKey && k === 'p'){
        e.preventDefault();
        resetPanel();
        return;
      }
      if (e && e.ctrlKey && e.altKey && k === 'p'){
        e.preventDefault();
        togglePanel();
        return;
      }
    }catch(_){}
  }, true);

  // Debug helpers (optional)
  window.ECAP = window.ECAP || {};
  window.ECAP.show = ()=>showPanel({unmini:true});
  window.ECAP.hide = hidePanel;
  window.ECAP.toggle = togglePanel;
  window.ECAP.reset = resetPanel;

  const logLines = [];
  function log(msg){
    const s = `[admin] ${new Date().toISOString()} ${msg}`;
    logLines.push(s);
    if (logLines.length > 200) logLines.shift();
    const el = document.querySelector('#ecAdminPanel .ecap-log');
    if (el) el.textContent = logLines.join('\n');
  }

  function getCookie(name){
    const parts = (`; ${document.cookie}`).split(`; ${name}=`);
    if (parts.length === 2) return parts.pop().split(';').shift();
    return null;
  }

  function fmtUptime(sec){
    sec = Math.max(0, parseInt(sec||0, 10)||0);
    const d = Math.floor(sec/86400); sec -= d*86400;
    const h = Math.floor(sec/3600); sec -= h*3600;
    const m = Math.floor(sec/60); sec -= m*60;
    const parts = [];
    if (d) parts.push(`${d}d`);
    if (h || d) parts.push(`${h}h`);
    if (m || h || d) parts.push(`${m}m`);
    parts.push(`${sec}s`);
    return parts.join(' ');
  }

  function debounce(fn, ms){
    let t = null;
    return (...args)=>{
      if (t) clearTimeout(t);
      t = setTimeout(()=>fn(...args), ms);
    };
  }

  async function refreshAccessToken(){
    try{
      const csrf = getCookie('csrf_refresh_token');
      const headers = csrf ? {'X-CSRF-TOKEN': csrf} : {};
      const r = await fetch('/token/refresh', {method:'POST', credentials:'include', headers});
      if (!r.ok) return false;
      const j = await r.json().catch(()=>({}));
      return !!(j && (j.ok === true || j.status === 'ok' || j.success === true));
    }catch(_){
      return false;
    }
  }

  function _altAdminUrl(u){
    try{
      if (typeof u !== 'string') return null;
      if (u.startsWith('/api/admin/')) return '/admin/' + u.slice('/api/admin/'.length);
      if (u.startsWith('/admin/')) return '/api/admin/' + u.slice('/admin/'.length);
      return null;
    }catch(_){
      return null;
    }
  }

  async function adminFetch(url, opts){
    let u = url;
    const options = Object.assign({credentials:'include'}, opts||{});
    const method = (options.method || 'GET').toUpperCase();

    if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
      options.headers = options.headers || {};
      if (!options.headers['X-CSRF-TOKEN']) {
        const csrf = getCookie('csrf_access_token');
        if (csrf) options.headers['X-CSRF-TOKEN'] = csrf;
      }
    }

    let r = await fetch(u, options);

    if (r.status === 404){
      const alt = _altAdminUrl(u);
      if (alt){
        const r2 = await fetch(alt, options);
        if (r2.status !== 404){
          log(`INFO endpoint fallback: ${u} -> ${alt} (${r2.status})`);
          u = alt;
          r = r2;
        }
      }
    }

    if (r.status === 401){
      const ok = await refreshAccessToken();
      if (ok) r = await fetch(u, options);
    }
    return r;
  }

  function _normalizeOk(j, httpOk){
    try{
      if (!j || typeof j !== 'object') j = {};
      // If server doesn't return {ok:true}, treat HTTP 2xx as success.
      if (j.ok === undefined){
        if (j.status === 'ok' || j.success === true) j.ok = true;
        else j.ok = !!httpOk;
      }
      return j;
    }catch(_){
      return {ok: !!httpOk};
    }
  }

  async function getJSON(url){
    const r = await adminFetch(url, {method:'GET'});
    const j = await r.json().catch(()=>null);
    if (!r.ok){
      const e = (j && (j.error || j.message)) ? (j.error || j.message) : `HTTP ${r.status}`;
      log(`ERROR ${r.status} GET ${url} :: ${e}`);
      return {ok:false, error:e, _status:r.status, _url:url};
    }
    return _normalizeOk(j, r.ok);
  }

  async function postForm(url, data){
    const fd = new FormData();
    for (const [k,v] of Object.entries(data||{})) fd.append(k, v);
    const r = await adminFetch(url, {method:'POST', body: fd});
    const j = await r.json().catch(()=>null);
    if (!r.ok){
      const e = (j && (j.error || j.message)) ? (j.error || j.message) : `HTTP ${r.status}`;
      log(`ERROR ${r.status} POST ${url} :: ${e}`);
      return {ok:false, error:e, _status:r.status, _url:url};
    }
    return _normalizeOk(j, r.ok);
  }

  async function postJSON(url, obj){
    const r = await adminFetch(url, {
      method:'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify(obj||{})
    });
    const j = await r.json().catch(()=>null);
    if (!r.ok){
      const e = (j && (j.error || j.message)) ? (j.error || j.message) : `HTTP ${r.status}`;
      log(`ERROR ${r.status} POST ${url} :: ${e}`);
      return {ok:false, error:e, _status:r.status, _url:url};
    }
    return _normalizeOk(j, r.ok);
  }

  function el(tag, attrs){
    const n = document.createElement(tag);
    if (attrs){
      for (const [k,v] of Object.entries(attrs)){
        if (k === 'class') n.className = v;
        else if (k === 'html') n.innerHTML = v;
        else if (k === 'text') n.textContent = v;
        else n.setAttribute(k, String(v));
      }
    }
    return n;
  }

  function safe(s){
    return (s === null || s === undefined) ? '' : String(s);
  }

  function buildPanel(){
    const panel = el('div', {id:'ecAdminPanel'});
    if (state.max && !state.mini) panel.classList.add('ecap-max');
    if (state.mini) panel.classList.add('ecap-mini');
    if (state.pinned) panel.classList.add('ecap-pinned');

    // Restore position only if not pinned.
    if (!state.pinned && state.left !== undefined && state.top !== undefined){
      panel.style.left = `${state.left}px`;
      panel.style.top = `${state.top}px`;
      panel.style.right = 'auto';
    }

    const head = el('div', {class:'ecap-head'});

    const titleRow = el('div', {class:'ecap-titleRow'});
    const dot = el('div', {class:'ecap-dot', title:'API status'});
    const titleBlock = el('div', {class:'ecap-titleBlock'});
    const title = el('div', {class:'ecap-title', text:'EchoChat Admin'});
    const subtitle = el('div', {class:'ecap-subtitle', text:'Admin-only controls (RBAC + JWT)'});
    titleBlock.appendChild(title);
    titleBlock.appendChild(subtitle);
    titleRow.appendChild(dot);
    titleRow.appendChild(titleBlock);

    const btns = el('div', {class:'ecap-headBtns'});
    const btnRefresh = el('button', {class:'ecap-iconBtn', title:'Refresh', text:'⟳'});
    const btnPin = el('button', {class:'ecap-iconBtn', title:'Pin/Unpin', text:'📌'});
    const btnMax = el('button', {class:'ecap-iconBtn', title:'Maximize', text:'⛶'});
    const btnMini = el('button', {class:'ecap-iconBtn', title:'Minimize', text:'▁'});
    const btnClose = el('button', {class:'ecap-iconBtn danger', title:'Close', text:'✕'});
    btns.appendChild(btnRefresh);
    btns.appendChild(btnPin);
    btns.appendChild(btnMax);
    btns.appendChild(btnMini);
    btns.appendChild(btnClose);

    head.appendChild(titleRow);
    head.appendChild(btns);

    const body = el('div', {class:'ecap-body'});
    const toastStack = el('div', {class:'ecap-toastStack', id:'ecapToastStack'});
    body.appendChild(toastStack);

    const tabs = el('div', {class:'ecap-tabs'});
    const tabNames = [
      ['dash','📊','Dashboard'],
      ['users','👤','Users'],
      ['rooms','🏷️','Rooms'],
      ['settings','⚙️','Settings'],
      ['audit','🧾','Audit']
    ];
    const tabEls = {};
    for (const [key, ico, label] of tabNames){
      const t = el('button', {class:'ecap-tab', type:'button', html:`<span class="ico">${ico}</span><span>${label}</span>`});
      tabs.appendChild(t);
      tabEls[key] = t;
    }

    const secDash = el('div', {class:'ecap-section', 'data-sec':'dash'});
    const secUsers = el('div', {class:'ecap-section', 'data-sec':'users'});
    const secRooms = el('div', {class:'ecap-section', 'data-sec':'rooms'});
    const secSettings = el('div', {class:'ecap-section', 'data-sec':'settings'});
    const secAudit = el('div', {class:'ecap-section', 'data-sec':'audit'});

    body.appendChild(tabs);
    body.appendChild(secDash);
    body.appendChild(secUsers);
    body.appendChild(secRooms);
    body.appendChild(secSettings);
    body.appendChild(secAudit);

    panel.appendChild(head);
    panel.appendChild(body);
    document.body.appendChild(panel);
    panelRef = panel;

    function toast(type, msg, meta, ms){
      const st = document.getElementById('ecapToastStack');
      if (!st) return;
      const t = el('div', {class:`ecap-toast ${type||''}`});
      t.innerHTML = `<div style="min-width:0">
        <div class="tmsg" style="font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${safe(msg)}</div>
        <div class="tmeta" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${safe(meta||'')}</div>
      </div>
      <div class="x" title="Dismiss">✕</div>`;
      t.querySelector('.x').addEventListener('click', ()=>t.remove());
      st.prepend(t);
      const ttl = (ms === undefined || ms === null) ? 3200 : ms;
      if (ttl > 0) setTimeout(()=>{ try{ t.remove(); }catch(_){ } }, ttl);
    }

    function setTab(key){
      for (const [k, t] of Object.entries(tabEls)) t.classList.toggle('active', k===key);
      secDash.classList.toggle('active', key==='dash');
      secUsers.classList.toggle('active', key==='users');
      secRooms.classList.toggle('active', key==='rooms');
      secSettings.classList.toggle('active', key==='settings');
      secAudit.classList.toggle('active', key==='audit');
      state.tab = key;
      saveState();
    }
    for (const [k,t] of Object.entries(tabEls)) t.addEventListener('click', ()=>setTab(k));
    setTab(state.tab || 'dash');

    // Buttons: stop drag initiation
    [btnRefresh, btnPin, btnMax, btnMini, btnClose].forEach(b=>{
      b.addEventListener('pointerdown', e=>e.stopPropagation());
    });

    btnMini.addEventListener('click', ()=>{
      const willMini = !panel.classList.contains('ecap-mini');
      if (willMini){
        // If we're maximized, collapse cleanly (otherwise you get a huge blank box).
        state._preMiniWasMax = panel.classList.contains('ecap-max');
        if (state._preMiniWasMax){
          panel.classList.remove('ecap-max');
          state.max = false;
        }
        panel.classList.add('ecap-mini');
        // Ensure compact height even if other rules linger.
        panel.style.height = '52px';
        panel.style.maxHeight = '52px';
      } else {
        panel.classList.remove('ecap-mini');
        panel.style.height = '';
        panel.style.maxHeight = '';
        if (state._preMiniWasMax){
          panel.classList.add('ecap-max');
          state.max = true;
        }
        state._preMiniWasMax = false;
      }
      state.mini = panel.classList.contains('ecap-mini');
      saveState();
    });

    btnMax.addEventListener('click', ()=>{
      // If minimized, un-minimize first (otherwise it looks blank / broken).
      if (panel.classList.contains('ecap-mini')){
        panel.classList.remove('ecap-mini');
        panel.style.height = '';
        panel.style.maxHeight = '';
        state.mini = false;
      }
      panel.classList.toggle('ecap-max');
      state.max = panel.classList.contains('ecap-max');
      saveState();
    });

    btnPin.addEventListener('click', ()=>{
      state.pinned = !state.pinned;
      panel.classList.toggle('ecap-pinned', !!state.pinned);
      if (state.pinned){
        // reset to default position
        panel.style.left = '';
        panel.style.top = '';
        panel.style.right = '16px';
        panel.style.position = 'fixed';
      }
      saveState();
    });

    btnClose.addEventListener('click', ()=>{ hidePanel(); });

    if (state.closed){
      // Start hidden, but keep the panel fully initialised so it can be reopened via hotkey.
      panel.classList.add('ecap-hidden');
    }

    // drag (disabled when pinned)
    let dragging=false, offX=0, offY=0;
    head.addEventListener('pointerdown', (e)=>{
      if (e.button !== 0) return;
      if (state.pinned) return;
      if (e.target && e.target.closest && e.target.closest('button')) return;
      dragging=true;
      const r = panel.getBoundingClientRect();
      offX = e.clientX - r.left;
      offY = e.clientY - r.top;
      head.setPointerCapture(e.pointerId);
    });
    head.addEventListener('pointermove', (e)=>{
      if (!dragging) return;
      const x = Math.max(8, Math.min(window.innerWidth - panel.offsetWidth - 8, e.clientX - offX));
      const y = Math.max(8, Math.min(window.innerHeight - panel.offsetHeight - 8, e.clientY - offY));
      panel.style.left = x + 'px';
      panel.style.top = y + 'px';
      panel.style.right = 'auto';
    });
    head.addEventListener('pointerup', ()=>{
      if (!dragging) return;
      dragging=false;
      const r = panel.getBoundingClientRect();
      state.left = Math.round(r.left);
      state.top = Math.round(r.top);
      saveState();
    });

    // Shared target user
    let targetUser = null;
    function setTargetUser(u, opts){
      targetUser = (u||'').trim() || null;
      const t = document.getElementById('ecapTargetUser');
      if (t) t.textContent = targetUser || '(none)';
      const i = document.getElementById('ecapTargetInput');
      if (i && (opts && opts.syncInput)) i.value = targetUser || '';
      if (opts && opts.loadDetail && targetUser){
        loadUserDetail(targetUser);
      }
    }

    // DASHBOARD
    secDash.innerHTML = `
      <div class="ecap-card">
        <h4>Overview</h4>
        <div class="ecap-statGrid" style="margin-top:8px">
          <div class="ecap-stat"><div class="lbl">Online</div><div class="val" id="ecapStatOnline">—</div></div>
          <div class="ecap-stat"><div class="lbl">Registered</div><div class="val" id="ecapStatUsers">—</div></div>
          <div class="ecap-stat"><div class="lbl">Rooms</div><div class="val" id="ecapStatRooms">—</div></div>
          <div class="ecap-stat"><div class="lbl">Sessions</div><div class="val" id="ecapStatSessions">—</div></div>
          <div class="ecap-stat"><div class="lbl">Uptime</div><div class="val" id="ecapStatUptime">—</div></div>
          <div class="ecap-stat"><div class="lbl">Postgres</div><div class="val" id="ecapStatPg">—</div></div>
        </div>

        <div class="ecap-row" style="margin-top:10px">
          <div class="ecap-pill warn">Server time: <b id="ecapStatNow" style="font-weight:750">—</b></div>
          <div class="ecap-pill">Voice rooms: <b id="ecapVoiceRooms" style="font-weight:750">—</b></div>
          <div class="ecap-pill">Voice users: <b id="ecapVoiceUsers" style="font-weight:750">—</b></div>
        </div>

        <div class="ecap-grid2" style="margin-top:10px">
          <div class="ecap-card" style="margin:0">
            <h4>Voice cap</h4>
            <div class="ecap-muted">0 (or empty) = unlimited. Lowering the cap disconnects random users to meet the limit.</div>
            <div class="ecap-row" style="margin-top:10px">
              <input id="ecapVoiceMax" placeholder="0 = unlimited" inputmode="numeric" />
              <button id="ecapVoiceApply" class="ecap-btn primary tight" type="button">Apply</button>
            </div>
          </div>
          <div class="ecap-card" style="margin:0">
            <h4>Feature snapshot</h4>
            <div id="ecapFeaturePills" class="ecap-actions"></div>
            <div class="ecap-muted" style="margin-top:8px">Edits are in the Settings tab (super-admin).</div>
          </div>
        </div>
      </div>

      <div class="ecap-card">
        <h4>Live roster</h4>
        <div class="ecap-muted">Click a username to load details.</div>
        <div id="ecapOnlineList" class="ecap-actions" style="margin-top:10px"></div>
        <div class="ecap-hr"></div>

        <div class="ecap-drop" id="ecapDrop">
          <div style="font-weight:750">🎯 Target user</div>
          <div class="ecap-muted" style="margin-top:4px">Drag-and-drop a username from the UI, or type it below.</div>
          <div style="margin-top:10px">Current: <span id="ecapTargetUser" style="font-weight:780">(none)</span></div>
          <div class="ecap-row" style="margin-top:10px">
            <input id="ecapTargetInput" placeholder="username" />
            <button id="ecapTargetLoad" class="ecap-btn primary tight" type="button">Load</button>
          </div>
        </div>
      </div>

      <div class="ecap-card">
        <h4>Admin log</h4>
        <div class="ecap-log"></div>
      </div>
    `;

    const drop = secDash.querySelector('#ecapDrop');
    drop.addEventListener('dragover', (e)=>{ e.preventDefault(); drop.classList.add('dragover'); });
    drop.addEventListener('dragleave', ()=> drop.classList.remove('dragover'));
    drop.addEventListener('drop', (e)=>{
      e.preventDefault(); drop.classList.remove('dragover');
      const u = e.dataTransfer.getData('text/plain') || '';
      if (u) {
        setTargetUser(u, {syncInput:true, loadDetail:true});
        setTab('users');
        toast('ok', 'Target selected', u);
        log(`target set (drop): ${u}`);
      }
    });

    secDash.querySelector('#ecapTargetLoad').addEventListener('click', ()=>{
      const u = (secDash.querySelector('#ecapTargetInput').value || '').trim();
      if (!u) return toast('warn','Missing username','Enter a username first');
      setTargetUser(u, {syncInput:true, loadDetail:true});
      setTab('users');
    });

    async function refreshVoiceSettings(){
      const j = await getJSON('/admin/settings/voice');
      if (j && j.ok){
        const v = String(j.voice_max_room_peers ?? 0);
        const inp = secDash.querySelector('#ecapVoiceMax');
        if (inp) inp.value = v;
      }
    }

    secDash.querySelector('#ecapVoiceApply').addEventListener('click', async ()=>{
      let v = 0;
      try{ v = parseInt((secDash.querySelector('#ecapVoiceMax').value||'').trim() || '0', 10); }catch(_){ v = 0; }
      if (!isFinite(v) || v < 0) v = 0;
      secDash.querySelector('#ecapVoiceMax').value = String(v);

      const j = await postForm('/admin/settings/voice', {voice_max_room_peers: v});
      if (j && j.ok){
        log(`voice limit set: ${j.voice_max_room_peers} (kicked=${j.kicked||0})`);
        toast('ok', 'Voice limit updated', `cap=${j.voice_max_room_peers || 'unlimited'} • kicked=${j.kicked||0}`);
        refreshVoiceSettings();
        refreshStats();
      } else {
        toast('err', 'Voice update failed', j && j.error ? j.error : 'unknown');
      }
    });

    // USERS
    secUsers.innerHTML = `
      <div class="ecap-card">
        <h4>User search</h4>
        <div class="ecap-row">
          <input id="ecapUserQuery" placeholder="Search username / email / id…" />
          <select id="ecapUserMode" class="tight" title="Match mode">
            <option value="contains">contains</option>
            <option value="prefix">prefix</option>
            <option value="exact">exact</option>
            <option value="email">email</option>
            <option value="id">id</option>
          </select>
          <button id="ecapUserSearchBtn" class="ecap-btn tight" type="button">Search</button>
        </div>

        <div class="ecap-row">
          <label class="ecap-pill tight"><input id="ecapUserOnlineOnly" type="checkbox" style="width:auto" /> online</label>
          <label class="ecap-pill tight"><input id="ecapUserAdminsOnly" type="checkbox" style="width:auto" /> admins</label>
          <select id="ecapUserStatus" class="tight" title="Account status">
            <option value="any">any status</option>
            <option value="active">active</option>
            <option value="deactivated">deactivated</option>
          </select>
          <span class="ecap-muted tight">Click a row to load.</span>
        </div>

        <div class="ecap-list" id="ecapUserResults"></div>
      </div>

      <div class="ecap-card">
        <h4>Selected user</h4>
        <div class="ecap-row">
          <input id="ecapSelUser" placeholder="username" />
          <button id="ecapLoadUser" class="ecap-btn primary tight" type="button">Load</button>
        </div>

        <div id="ecapUserSummary" class="ecap-grid2"></div>

        <div class="ecap-hr"></div>

        <div class="ecap-muted">Actions</div>
        <div class="ecap-grid2" style="margin-top:8px">
          <div class="ecap-card" style="margin:0">
            <h4>Session</h4>
            <div class="ecap-actions" id="ecapActSession"></div>
          </div>
          <div class="ecap-card" style="margin:0">
            <h4>Account</h4>
            <div class="ecap-actions" id="ecapActAccount"></div>
          </div>
          <div class="ecap-card" style="margin:0">
            <h4>Security</h4>
            <div class="ecap-actions" id="ecapActSecurity"></div>
          </div>
          <div class="ecap-card" style="margin:0">
            <h4>Moderation</h4>
            <div class="ecap-actions" id="ecapActMod"></div>
          </div>
        </div>

        <div class="ecap-muted" style="margin-top:10px">Some actions require super-admin or specific permissions.</div>
      </div>

      <details class="ecap-card">
        <summary style="cursor:pointer;font-weight:750">Create user</summary>
        <div class="ecap-muted" style="margin-top:6px">Requires super-admin.</div>
        <div class="ecap-row" style="margin-top:10px">
          <input id="ecapCreateUser" placeholder="username" />
          <input id="ecapCreateEmail" placeholder="email (optional)" />
        </div>
        <div class="ecap-row">
          <input id="ecapCreatePass" placeholder="password" type="password" />
          <label class="ecap-pill tight"><input id="ecapCreateIsAdmin" type="checkbox" style="width:auto" /> admin</label>
          <button id="ecapCreateBtn" class="ecap-btn primary tight" type="button">Create</button>
        </div>
      </details>
    `;

    const qInp = secUsers.querySelector('#ecapUserQuery');
    const qMode = secUsers.querySelector('#ecapUserMode');
    const qOnline = secUsers.querySelector('#ecapUserOnlineOnly');
    const qAdmins = secUsers.querySelector('#ecapUserAdminsOnly');
    const qStatus = secUsers.querySelector('#ecapUserStatus');
    const resBox = secUsers.querySelector('#ecapUserResults');
    const selInp = secUsers.querySelector('#ecapSelUser');
    const summaryBox = secUsers.querySelector('#ecapUserSummary');

    const actSession = secUsers.querySelector('#ecapActSession');
    const actAccount = secUsers.querySelector('#ecapActAccount');
    const actSecurity = secUsers.querySelector('#ecapActSecurity');
    const actMod = secUsers.querySelector('#ecapActMod');

    // Create user controls (super-admin)
    const cuUser = secUsers.querySelector('#ecapCreateUser');
    const cuEmail = secUsers.querySelector('#ecapCreateEmail');
    const cuPass = secUsers.querySelector('#ecapCreatePass');
    const cuIsAdmin = secUsers.querySelector('#ecapCreateIsAdmin');
    const cuBtn = secUsers.querySelector('#ecapCreateBtn');
    if (cuBtn) cuBtn.addEventListener('click', async ()=>{
      const username = (cuUser?.value||'').trim();
      const password = (cuPass?.value||'').trim();
      const email = (cuEmail?.value||'').trim();
      const is_admin = cuIsAdmin?.checked ? '1' : '0';
      if (!username || !password) return toast('warn','Missing fields','Username + password required');
      const j = await postForm('/admin/create_user', {username, password, email, is_admin});
      if (j && j.ok){
        log(`created user ${username} (admin=${is_admin})`);
        toast('ok','User created', username);
        cuPass.value = '';
        runSearch();
      } else {
        toast('err','Create user failed', j && j.error ? j.error : 'unknown');
      }
    });

    function badgeHTML(u){
      const pills = [];
      if (u.online) pills.push('<span class="ecap-pill ok">online</span>');
      if (u.is_admin) pills.push('<span class="ecap-pill warn">admin</span>');
      if (u.status && u.status !== 'active') pills.push('<span class="ecap-pill bad">'+safe(u.status)+'</span>');
      return pills.join(' ');
    }

    function renderSearchResults(users){
      resBox.innerHTML = '';
      if (!users || !users.length){
        resBox.innerHTML = '<div class="ecap-item"><span class="ecap-muted">No results</span></div>';
        return;
      }
      for (const u of users){
        const row = el('div', {class:'ecap-item'});
        row.innerHTML = `<div style="min-width:0">
          <div style="font-weight:780;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${safe(u.username)}</div>
          <div class="ecap-muted" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${safe(u.email||'')}</div>
        </div>
        <div style="display:flex;gap:8px;align-items:center;flex:0 0 auto">
          ${badgeHTML(u)}
          <button class="ecap-btn tight" type="button">Load</button>
        </div>`;
        const btn = row.querySelector('button');
        btn.addEventListener('click', (e)=>{
          e.stopPropagation();
          setTargetUser(u.username, {syncInput:true, loadDetail:true});
          toast('info','Loaded', u.username);
        });
        row.addEventListener('click', ()=>{
          setTargetUser(u.username, {syncInput:true, loadDetail:true});
        });
        resBox.appendChild(row);
      }
    }

    async function runSearch(){
      const q = (qInp.value||'').trim();
      const mode = qMode.value || 'contains';
      const online = qOnline.checked ? '1':'0';
      const admins = qAdmins.checked ? '1':'0';
      const status = qStatus.value || 'any';
      const qs = new URLSearchParams({q, mode, online, admins, status, limit:'60'}).toString();
      const j = await getJSON('/admin/user_search?'+qs);
      if (j && j.users) renderSearchResults(j.users);
    }

    const runSearchDebounced = debounce(runSearch, 220);
    qInp.addEventListener('input', runSearchDebounced);
    qMode.addEventListener('change', runSearch);
    qOnline.addEventListener('change', runSearch);
    qAdmins.addEventListener('change', runSearch);
    qStatus.addEventListener('change', runSearch);
    secUsers.querySelector('#ecapUserSearchBtn').addEventListener('click', runSearch);
    qInp.addEventListener('keydown', (e)=>{
      if (e.key === 'Enter'){ e.preventDefault(); runSearch(); }
    });

    secUsers.querySelector('#ecapLoadUser').addEventListener('click', ()=>{
      const u = (selInp.value||'').trim();
      if (!u) return toast('warn','Missing username','Enter a username');
      setTargetUser(u, {syncInput:true, loadDetail:true});
    });

    async function loadUserDetail(u){
      if (!u) return;
      selInp.value = u;

      const j = await getJSON('/admin/user_detail/' + encodeURIComponent(u));
      if (!j || !j.user){
        summaryBox.innerHTML = '<div class="ecap-muted">Not found.</div>';
        [actSession,actAccount,actSecurity,actMod].forEach(x=>x.innerHTML='');
        return;
      }
      renderUserDetail(j);
    }

    function kv(label, value){
      const d = el('div', {class:'ecap-stat'});
      d.innerHTML = `<div class="lbl">${safe(label)}</div><div class="val" style="font-size:13px">${safe(value || '—')}</div>`;
      return d;
    }

    function renderUserDetail(payload){
      const u = payload.user || {};
      const roles = (payload.roles || []).join(', ') || '—';
      const sanctions = payload.sanctions || [];
      const quota = payload.quota ? `${payload.quota.messages_per_hour}/hr` : '—';
      const lastSeen = u.last_seen ? new Date(u.last_seen).toLocaleString() : '—';
      const created = u.created_at ? new Date(u.created_at).toLocaleString() : '—';
      const counts = payload.counts || {};

      summaryBox.innerHTML = '';
      summaryBox.appendChild(kv('Email', u.email || '—'));
      summaryBox.appendChild(kv('Status', u.status || '—'));
      summaryBox.appendChild(kv('Online', u.online ? 'yes' : 'no'));
      summaryBox.appendChild(kv('Last seen', lastSeen));
      summaryBox.appendChild(kv('Created', created));
      summaryBox.appendChild(kv('2FA', u.two_factor_enabled ? 'enabled' : 'off'));
      summaryBox.appendChild(kv('Roles', roles));
      summaryBox.appendChild(kv('Quota', quota));
      summaryBox.appendChild(kv('Friends', String(counts.friends ?? '—')));
      summaryBox.appendChild(kv('Groups', String(counts.groups ?? '—')));
      summaryBox.appendChild(kv('Sanctions', String(sanctions.length)));

      [actSession,actAccount,actSecurity,actMod].forEach(x=>x.innerHTML='');

      function addAction(group, label, fn, css){
        const b = el('button', {class:`ecap-btn tight ${css||''}`, text:label, type:'button'});
        b.addEventListener('click', fn);
        group.appendChild(b);
      }

      const username = u.username;

      addAction(actSession, 'Force logout', async ()=>{
        const j = await postForm('/admin/force_logout/' + encodeURIComponent(username), {});
        if (j && j.ok){ log(`revoked tokens for ${username}`); toast('ok','User logged out', username); }
        else toast('err','Force logout failed', j && j.error ? j.error : 'unknown');
      });

      addAction(actAccount, 'Deactivate', async ()=>{
        if (!confirm(`Deactivate ${username}?`)) return;
        const j = await postForm('/admin/deactivate_user/' + encodeURIComponent(username), {});
        if (j && j.ok){ log(`deactivated ${username}`); toast('ok','Deactivated', username); loadUserDetail(username); }
        else toast('err','Deactivate failed', j && j.error ? j.error : 'unknown');
      }, 'danger');

      addAction(actAccount, 'Delete', async ()=>{
        if (!confirm(`DELETE ${username}? This cannot be undone.`)) return;
        const j = await postForm('/admin/delete_user/' + encodeURIComponent(username), {});
        if (j && j.ok){ log(`deleted ${username}`); toast('ok','Deleted', username, 4500); }
        else toast('err','Delete failed', j && j.error ? j.error : 'unknown', 5200);
      }, 'danger');

      addAction(actSecurity, 'Reset password', async ()=>{
        const pw = prompt('New password (min 8):') || '';
        if (pw.length < 8) return toast('warn','Password too short','Minimum 8 characters');
        const j = await postForm('/admin/reset_password/' + encodeURIComponent(username), {new_password: pw});
        if (j && j.ok){ log(`reset pw for ${username}`); toast('ok','Password reset', username); }
        else toast('err','Reset password failed', j && j.error ? j.error : 'unknown');
      }, 'primary');

      addAction(actSecurity, 'Set recovery PIN', async ()=>{
        const pin = (prompt('New 4-digit PIN:')||'').trim();
        if (!/^\d{4}$/.test(pin)) return toast('warn','Invalid PIN','PIN must be 4 digits');
        const j = await postForm('/admin/set_recovery_pin', {username, recovery_pin: pin});
        if (j && j.ok){ log(`set PIN for ${username}`); toast('ok','PIN updated', username); }
        else toast('err','PIN update failed', j && j.error ? j.error : 'unknown');
      });

      addAction(actSecurity, 'Revoke 2FA', async ()=>{
        if (!confirm(`Revoke 2FA for ${username}?`)) return;
        const j = await postForm('/admin/revoke_2fa/' + encodeURIComponent(username), {});
        if (j && j.ok){ log(`2FA revoked ${username}`); toast('ok','2FA revoked', username); loadUserDetail(username); }
        else toast('err','Revoke 2FA failed', j && j.error ? j.error : 'unknown');
      });

      addAction(actMod, 'Suspend', async ()=>{
        const mins = parseInt((prompt('Suspend minutes (default 60):')||'60').trim(),10) || 60;
        const reason = prompt('Reason (optional):') || '';
        const j = await postForm('/admin/suspend_user/' + encodeURIComponent(username), {minutes: mins, reason});
        if (j && j.ok){ log(`suspended ${username} for ${mins}m`); toast('ok','Suspended', `${username} • ${mins}m`); loadUserDetail(username); }
        else toast('err','Suspend failed', j && j.error ? j.error : 'unknown');
      });

      addAction(actMod, 'Mute', async ()=>{
        const mins = parseInt((prompt('Mute minutes (default 15):')||'15').trim(),10) || 15;
        const reason = prompt('Reason (optional):') || '';
        const j = await postForm('/admin/mute_user/' + encodeURIComponent(username), {minutes: mins, reason});
        if (j && j.ok){ log(`muted ${username} for ${mins}m`); toast('ok','Muted', `${username} • ${mins}m`); loadUserDetail(username); }
        else toast('err','Mute failed', j && j.error ? j.error : 'unknown');
      });

      addAction(actMod, 'Set quota', async ()=>{
        const q = parseInt((prompt('Messages per hour:')||'0').trim(),10);
        if (!isFinite(q) || q < 0) return toast('warn','Invalid number','Quota must be >= 0');
        const j = await postForm('/admin/set_user_quota/' + encodeURIComponent(username), {messages_per_hour: q});
        if (j && j.ok){ log(`quota ${username}=${q}`); toast('ok','Quota updated', `${username} • ${q}/hr`); loadUserDetail(username); }
        else toast('err','Quota update failed', j && j.error ? j.error : 'unknown');
      });

      addAction(actMod, 'Set status', async ()=>{
        const status = (prompt('Presence status (online/away/dnd/offline):')||'').trim();
        const custom_status = (prompt('Custom status (optional):')||'').trim();
        if (!status) return;
        const j = await postForm('/admin/set_user_status/' + encodeURIComponent(username), {presence_status: status, custom_status});
        if (j && j.ok){ log(`status set ${username}=${status}`); toast('ok','Status updated', `${username} • ${status}`); loadUserDetail(username); }
        else toast('err','Status update failed', j && j.error ? j.error : 'unknown');
      });

      addAction(actMod, 'Assign role', async ()=>{
        const role = (prompt('Role name (e.g. admin, moderator, viewer):')||'').trim();
        if (!role) return;
        const j = await postForm('/admin/assign_role/' + encodeURIComponent(username), {role});
        if (j && j.ok){ log(`role assigned ${username} -> ${role}`); toast('ok','Role assigned', `${username} • ${role}`); loadUserDetail(username); }
        else toast('err','Assign role failed', j && j.error ? j.error : 'unknown');
      });

      addAction(actMod, 'Shadowban', async ()=>{
        const reason = prompt('Reason (optional):') || '';
        const j = await postForm('/admin/shadowban_user/' + encodeURIComponent(username), {reason});
        if (j && j.ok){ log(`shadowban ${username}`); toast('ok','Shadowbanned', username); loadUserDetail(username); }
        else toast('err','Shadowban failed', j && j.error ? j.error : 'unknown');
      });

      toast('info', 'User loaded', username);
    }

    // ROOMS
    secRooms.innerHTML = `
      <div class="ecap-card">
        <h4>Rooms</h4>
        <div class="ecap-row">
          <button id="ecapRoomsReload" class="ecap-btn tight" type="button">Reload</button>
          <input id="ecapRoomFilter" placeholder="Filter rooms…" />
        </div>
        <div class="ecap-list" id="ecapRoomList"></div>
      </div>

      <div class="ecap-card">
        <h4>Kick / ban user from room</h4>
        <div class="ecap-row">
          <input id="ecapKRUser" placeholder="username" />
          <input id="ecapKRRoom" placeholder="room" />
        </div>
        <div class="ecap-actions">
          <button id="ecapKickBtn" class="ecap-btn tight" type="button">Kick</button>
          <button id="ecapRoomBanBtn" class="ecap-btn danger tight" type="button">Room ban</button>
        </div>
      </div>

      <div class="ecap-card">
        <h4>Broadcast</h4>
        <textarea id="ecapBroadcast" placeholder="Global announcement…"></textarea>
        <div class="ecap-row">
          <button id="ecapBroadcastBtn" class="ecap-btn primary tight" type="button">Send broadcast</button>
        </div>
      </div>
    `;

    const roomList = secRooms.querySelector('#ecapRoomList');
    const roomFilter = secRooms.querySelector('#ecapRoomFilter');
    let roomsCache = [];

    function renderRooms(){
      const f = (roomFilter.value||'').trim().toLowerCase();
      roomList.innerHTML = '';
      const list = (roomsCache || []).filter(r => !f || safe(r.name).toLowerCase().includes(f));
      if (!list.length){
        roomList.innerHTML = '<div class="ecap-item"><span class="ecap-muted">No rooms</span></div>';
        return;
      }
      for (const r of list){
        const row = el('div', {class:'ecap-item'});
        const pills = [];
        if (r.locked) pills.push('<span class="ecap-pill bad">locked</span>');
        if (r.readonly) pills.push('<span class="ecap-pill warn">readonly</span>');
        if (r.slowmode_sec && Number(r.slowmode_sec) > 0) pills.push(`<span class="ecap-pill">slow ${Number(r.slowmode_sec)}s</span>`);
        if (r.is_custom) pills.push('<span class="ecap-pill">custom</span>');
        if (r.is_custom && r.is_private) pills.push('<span class="ecap-pill warn">private</span>');
        const online = (r && (r.online_count ?? r.online ?? r.members_online));
        const dbCount = (r && (r.member_count ?? r.members ?? r.count));
        const onlineNum = Number(online);
        const dbNum = Number(dbCount);
        const showOnline = Number.isFinite(onlineNum);
        const showDb = Number.isFinite(dbNum);

        let sub = '';
        if (showOnline){
          sub = `online: ${safe(String(Math.max(0, onlineNum|0)))}`;
          // If the persisted counter exists and differs, show it subtly for diagnostics.
          if (showDb && (dbNum|0) !== (onlineNum|0)){
            sub += ` • db: ${safe(String(Math.max(0, dbNum|0)))}`;
          }
        } else {
          sub = `members: ${safe(String(Math.max(0, (dbNum|0) || 0)))}`;
        }

        const delBtn = r.is_custom ? '<button class="ecap-btn danger tight" data-act="del" type="button">Delete</button>' : '';

        row.innerHTML = `<div style="min-width:0">
          <div style="font-weight:780;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${safe(r.name)}</div>
          <div class="ecap-muted">${sub}</div>
        </div>
        <div style="display:flex;gap:6px;align-items:center;flex:0 0 auto">
          ${pills.join(' ')}
          <button class="ecap-btn tight" data-act="lock" type="button">${r.locked ? 'Unlock':'Lock'}</button>
          <button class="ecap-btn tight" data-act="ro" type="button">${r.readonly ? 'Writable':'Read-only'}</button>
          <button class="ecap-btn tight" data-act="sm" type="button">Slow</button>
          ${delBtn}
          <button class="ecap-btn danger tight" data-act="clear" type="button">Clear</button>
        </div>`;

        row.querySelector('[data-act="lock"]').addEventListener('click', async (e)=>{
          e.stopPropagation();
          const j = await postForm((r.locked ? '/admin/unlock_room/' : '/admin/lock_room/') + encodeURIComponent(r.name), {});
          if (j && j.ok){ log(`room ${r.name} lock=${!r.locked}`); toast('ok','Room updated', r.name); refreshRooms(); }
          else toast('err','Room update failed', j && j.error ? j.error : 'unknown');
        });
        row.querySelector('[data-act="ro"]').addEventListener('click', async (e)=>{
          e.stopPropagation();
          const j = await postForm('/admin/set_room_readonly/' + encodeURIComponent(r.name), {readonly: r.readonly ? '0':'1'});
          if (j && j.ok){ log(`room ${r.name} readonly=${!r.readonly}`); toast('ok','Room updated', r.name); refreshRooms(); }
          else toast('err','Room update failed', j && j.error ? j.error : 'unknown');
        });
        row.querySelector('[data-act="sm"]').addEventListener('click', async (e)=>{
          e.stopPropagation();
          const cur = Number(r.slowmode_sec || 0) || 0;
          const raw = prompt(`Slowmode seconds for ${r.name} (0 disables):`, String(cur));
          if (raw === null) return;
          const seconds = Math.max(0, Math.min(3600, parseInt(String(raw).trim()||'0',10) || 0));
          const j = await postForm('/admin/set_room_slowmode/' + encodeURIComponent(r.name), {seconds: String(seconds)});
          if (j && j.ok){ log(`room slowmode ${r.name}=${seconds}`); toast('ok','Slowmode updated', `${r.name} • ${seconds}s`); refreshRooms(); }
          else toast('err','Slowmode update failed', j && j.error ? j.error : 'unknown');
        });
        row.querySelector('[data-act="clear"]').addEventListener('click', async (e)=>{
          e.stopPropagation();
          if (!confirm(`Clear messages in ${r.name}?`)) return;
          const j = await postForm('/admin/clear_room/' + encodeURIComponent(r.name), {});
          if (j && j.ok){ log(`cleared room ${r.name}`); toast('ok','Room cleared', r.name); }
          else toast('err','Clear failed', j && j.error ? j.error : 'unknown');
        });
        const delEl = row.querySelector('[data-act="del"]');
        if (delEl){
          delEl.addEventListener('click', async (e)=>{
            e.stopPropagation();
            if (!confirm(`Delete room "${r.name}"? This cannot be undone.`)) return;
            const reason = prompt('Reason (optional):') || '';
            const j = await postForm('/admin/rooms/delete/' + encodeURIComponent(r.name), {reason});
            if (j && j.ok){ log(`deleted room ${r.name}`); toast('ok','Room deleted', r.name, 4500); refreshRooms(); }
            else toast('err','Delete failed', (j && (j.message || j.error)) ? (j.message || j.error) : 'unknown');
          });
        }

        row.addEventListener('click', ()=>{
          secRooms.querySelector('#ecapKRRoom').value = r.name;
        });
        roomList.appendChild(row);
      }
    }

    async function refreshRooms(){
      const j = await getJSON('/admin/rooms/list');
      if (j && j.rooms){
        roomsCache = j.rooms || [];
        renderRooms();
      }
    }

    secRooms.querySelector('#ecapRoomsReload').addEventListener('click', refreshRooms);
    roomFilter.addEventListener('input', debounce(renderRooms, 80));
    refreshRooms();

    secRooms.querySelector('#ecapKickBtn').addEventListener('click', async ()=>{
      const username = (secRooms.querySelector('#ecapKRUser').value||'').trim();
      const room = (secRooms.querySelector('#ecapKRRoom').value||'').trim();
      if (!username || !room) return toast('warn','Missing fields','Enter username + room');
      const j = await postForm('/admin/kick_from_room', {username, room});
      if (j && j.ok){ log(`kicked ${username} from ${room}`); toast('ok','Kicked', `${username} • ${room}`); }
      else toast('err','Kick failed', j && j.error ? j.error : 'unknown');
    });

    secRooms.querySelector('#ecapRoomBanBtn').addEventListener('click', async ()=>{
      const username = (secRooms.querySelector('#ecapKRUser').value||'').trim();
      const room = (secRooms.querySelector('#ecapKRRoom').value||'').trim();
      if (!username || !room) return toast('warn','Missing fields','Enter username + room');
      const reason = prompt('Ban reason (optional):') || '';
      const j = await postForm('/admin/ban_from_room', {username, room, reason});
      if (j && j.ok){ log(`room ban ${username} in ${room}`); toast('ok','Room-banned', `${username} • ${room}`); }
      else toast('err','Room ban failed', j && j.error ? j.error : 'unknown');
    });

    secRooms.querySelector('#ecapBroadcastBtn').addEventListener('click', async ()=>{
      const msg = (secRooms.querySelector('#ecapBroadcast').value||'').trim();
      if (!msg) return toast('warn','Missing message','Enter a broadcast message');
      const j = await postForm('/admin/global_broadcast', {message: msg});
      if (j && j.ok){
        log(`broadcast delivered=${j.delivered||0}`);
        toast('ok','Broadcast sent', `delivered=${j.delivered||0}`, 4500);
        secRooms.querySelector('#ecapBroadcast').value='';
      } else {
        toast('err','Broadcast failed', j && j.error ? j.error : 'unknown', 5200);
      }
    });

    // SETTINGS
    secSettings.innerHTML = `
      <div class="ecap-card">
        <h4>General settings (super-admin)</h4>
        <div class="ecap-muted">Persists to settings file. Some changes require clients to reload or a server restart.</div>
        <div class="ecap-hr"></div>
        <div class="ecap-grid2" id="ecapSettingsForm"></div>
        <div class="ecap-hr"></div>
        <div class="ecap-row">
          <button id="ecapSettingsReload" class="ecap-btn tight" type="button">Reload</button>
          <button id="ecapSettingsApply" class="ecap-btn primary tight" type="button">Apply</button>
        </div>
      </div>

      <div class="ecap-card" style="margin-top:10px">
        <h4>GIFs (GIPHY) (super-admin)</h4>
        <div class="ecap-muted">GIF search uses a server-side proxy. If the key is missing, the GIF modal shows an error. The key is stored in the server settings file.</div>
        <div class="ecap-hr"></div>
        <div class="ecap-grid2">
          <div class="ecap-card" style="margin:0">
            <div class="ecap-muted">API key</div>
            <div class="ecap-row" style="margin-top:10px">
              <input id="ecapGiphyKey" type="password" placeholder="Paste GIPHY key…" />
              <button id="ecapGiphyShow" class="ecap-btn tight" type="button">Show</button>
            </div>
            <div class="ecap-muted" style="margin-top:8px">Status: <b id="ecapGiphyKeyStatus" style="font-weight:780">—</b></div>
          </div>
          <div class="ecap-card" style="margin:0">
            <div class="ecap-muted">Search policy</div>
            <div class="ecap-row" style="margin-top:10px">
              <input id="ecapGiphyRating" placeholder="pg-13" />
              <input id="ecapGiphyLang" placeholder="en" />
              <input id="ecapGiphyLimit" inputmode="numeric" placeholder="24" />
            </div>
            <div class="ecap-muted" style="margin-top:8px">rating / language / default limit</div>
          </div>
        </div>
        <div class="ecap-hr"></div>
        <div class="ecap-row">
          <button id="ecapGiphyReload" class="ecap-btn tight" type="button">Reload</button>
          <button id="ecapGiphyApply" class="ecap-btn primary tight" type="button">Apply</button>
        </div>
      </div>

      <div class="ecap-card" style="margin-top:10px">
        <h4>Anti-abuse (super-admin)</h4>
        <div class="ecap-muted">Updates apply immediately on server. Be careful with very low windows/limits.</div>
        <div class="ecap-hr"></div>
        <div class="ecap-grid2" id="ecapAntiForm"></div>
        <div class="ecap-hr"></div>
        <div class="ecap-row">
          <button id="ecapAntiReload" class="ecap-btn tight" type="button">Reload</button>
          <button id="ecapAntiApply" class="ecap-btn primary tight" type="button">Apply</button>
        </div>
      </div>
    `;

    const settingsForm = secSettings.querySelector('#ecapSettingsForm');
    let settingsCache = null;

    function makeField(label, id, type, hint){
      const c = el('div', {class:'ecap-card', style:'margin:0'});
      const h = hint ? `<div class="ecap-muted" style="margin-top:6px">${safe(hint)}</div>` : '';
      if (type === 'bool'){
        c.innerHTML = `<div style="display:flex;align-items:center;justify-content:space-between;gap:10px">
          <div style="min-width:0">
            <div class="ecap-muted">${safe(label)}</div>
          </div>
          <input id="${id}" type="checkbox" style="width:auto" />
        </div>${h}`;
      } else if (type === 'text'){
        c.innerHTML = `<div class="ecap-muted">${safe(label)}</div><input id="${id}" placeholder="" />${h}`;
      } else {
        c.innerHTML = `<div class="ecap-muted">${safe(label)}</div><input id="${id}" inputmode="numeric" placeholder="" />${h}`;
      }
      return c;
    }

    async function loadGeneralSettings(){
      const j = await getJSON('/admin/settings/general');
      settingsCache = (j && j.settings) ? j.settings : null;
      settingsForm.innerHTML = '';
      if (!settingsCache){
        settingsForm.innerHTML = '<div class="ecap-muted">Not available (requires super-admin).</div>';
        return;
      }
      const fields = [
        ['Voice enabled','set_voice_enabled','bool',''],
        ['P2P file enabled','set_p2p_file_enabled','bool',''],
        ['Giphy enabled','set_giphy_enabled','bool',''],
        ['Disable file transfer (global)','set_disable_file_transfer_globally','bool',''],
        ['Disable group files (global)','set_disable_group_files_globally','bool',''],
        ['Require DM E2EE','set_require_dm_e2ee','bool',''],
        ['Allow plaintext DM fallback','set_allow_plaintext_dm_fallback','bool',''],
        ['Max message length (chars)','set_max_message_length','int',''],
        ['Max attachment size (bytes)','set_max_attachment_size','int',''],
        ['Max DM file bytes','set_max_dm_file_bytes','int',''],
        ['Max group upload bytes','set_max_group_upload_bytes','int',''],
        ['Group msg rate limit','set_group_msg_rate_limit','int','messages per window'],
        ['Group msg window seconds','set_group_msg_rate_window_sec','int',''],

        // Background cleanup / TTL
        ['Custom room idle hours (public)','set_custom_room_idle_hours','int','Empty custom rooms are auto-deleted after this many hours'],
        ['Custom room idle hours (private)','set_custom_private_room_idle_hours','int','Private rooms are usually more ephemeral (default 24h)'],
        ['Janitor interval (seconds)','set_janitor_interval_seconds','int','How often cleanup runs (10..3600)']
      ];
      for (const [label,key,typ,hint] of fields){
        const id = key;
        settingsForm.appendChild(makeField(label, id, typ, hint));
        const realKey = key.replace('set_','');
        const v = settingsCache[realKey];
        const inp = secSettings.querySelector('#'+id);
        if (!inp) continue;
        if (typ === 'bool') inp.checked = !!v;
        else inp.value = (v === null || v === undefined) ? '' : String(v);
      }
    }

    async function applyGeneralSettings(){
      if (!settingsCache) return toast('warn','Not available','Requires super-admin');
      const payload = {};
      function grabBool(key){
        const id = 'set_'+key;
        const elx = secSettings.querySelector('#'+id);
        if (!elx) return;
        payload[key] = !!elx.checked;
      }
      function grabInt(key){
        const id = 'set_'+key;
        const elx = secSettings.querySelector('#'+id);
        if (!elx) return;
        const v = (elx.value||'').trim();
        if (v === '') return;
        payload[key] = parseInt(v,10);
      }

      ['voice_enabled','p2p_file_enabled','giphy_enabled','disable_file_transfer_globally','disable_group_files_globally','require_dm_e2ee','allow_plaintext_dm_fallback'].forEach(grabBool);
      ['max_message_length','max_attachment_size','max_dm_file_bytes','max_group_upload_bytes','group_msg_rate_limit','group_msg_rate_window_sec','custom_room_idle_hours','custom_private_room_idle_hours','janitor_interval_seconds'].forEach(grabInt);

      const j = await postJSON('/admin/settings/general', payload);
      if (j && j.ok){
        log(`settings patch persisted=${j.persisted}`);
        toast('ok','Settings applied', `persisted=${j.persisted}`);
        loadGeneralSettings();
        refreshStats();
      } else {
        toast('err','Settings apply failed', j && j.error ? j.error : 'unknown', 5200);
      }
    }

    secSettings.querySelector('#ecapSettingsReload').addEventListener('click', loadGeneralSettings);
    secSettings.querySelector('#ecapSettingsApply').addEventListener('click', applyGeneralSettings);
    loadGeneralSettings();

    // GIF SETTINGS (GIPHY)
    const giphyKeyInput = secSettings.querySelector('#ecapGiphyKey');
    const giphyShowBtn = secSettings.querySelector('#ecapGiphyShow');
    const giphyStatus = secSettings.querySelector('#ecapGiphyKeyStatus');
    const giphyRating = secSettings.querySelector('#ecapGiphyRating');
    const giphyLang = secSettings.querySelector('#ecapGiphyLang');
    const giphyLimit = secSettings.querySelector('#ecapGiphyLimit');

    async function loadGifSettings(){
      const j = await getJSON('/admin/settings/gifs');
      if (!j || !j.ok){
        if (giphyStatus) giphyStatus.textContent = 'unavailable';
        return;
      }
      if (giphyStatus) giphyStatus.textContent = j.has_key ? 'set' : 'missing';
      if (giphyRating) giphyRating.value = String(j.giphy_rating || 'pg-13');
      if (giphyLang) giphyLang.value = String(j.giphy_lang || 'en');
      if (giphyLimit) giphyLimit.value = String(j.giphy_default_limit || 24);
      if (giphyKeyInput) giphyKeyInput.value = '';
    }

    async function applyGifSettings(){
      const payload = {};
      if (giphyRating) payload.giphy_rating = (giphyRating.value||'').trim() || 'pg-13';
      if (giphyLang) payload.giphy_lang = (giphyLang.value||'').trim() || 'en';
      if (giphyLimit){
        const v = (giphyLimit.value||'').trim();
        if (v !== '') payload.giphy_default_limit = parseInt(v,10);
      }
      if (giphyKeyInput){
        const k = (giphyKeyInput.value||'').trim();
        if (k !== '') payload.giphy_api_key = k;
      }
      const j = await postJSON('/admin/settings/gifs', payload);
      if (j && j.ok){
        toast('ok','GIF settings saved', `persisted=${j.persisted} key=${j.has_key?'set':'missing'}`);
        loadGifSettings();
        refreshStats();
      } else {
        toast('err','GIF settings failed', (j && j.error) ? j.error : 'unknown', 5200);
      }
    }

    if (giphyShowBtn && giphyKeyInput){
      giphyShowBtn.addEventListener('click', ()=>{
        const isPw = giphyKeyInput.type === 'password';
        giphyKeyInput.type = isPw ? 'text' : 'password';
        giphyShowBtn.textContent = isPw ? 'Hide' : 'Show';
      });
    }

    secSettings.querySelector('#ecapGiphyReload')?.addEventListener('click', loadGifSettings);
    secSettings.querySelector('#ecapGiphyApply')?.addEventListener('click', applyGifSettings);
    loadGifSettings();

    // ANTI-ABUSE SETTINGS
    const antiForm = secSettings.querySelector('#ecapAntiForm');
    let antiCache = null;

    async function loadAntiAbuseSettings(){
      const j = await getJSON('/admin/settings/antiabuse');
      antiCache = (j && j.settings) ? j.settings : null;
      antiForm.innerHTML = '';
      if (!antiCache){
        antiForm.innerHTML = '<div class="ecap-muted">Not available (requires super-admin).</div>';
        return;
      }
      const fields = [
        ['Room msg rate limit','anti_room_msg_rate_limit','text','Format: "N@seconds" (example 20@10)'],
        ['Room msg window seconds','anti_room_msg_rate_window_sec','int',''],
        ['DM msg rate limit','anti_dm_msg_rate_limit','text','Format: "N@seconds"'],
        ['DM msg window seconds','anti_dm_msg_rate_window_sec','int',''],
        ['File offer rate limit','anti_file_offer_rate_limit','text','Format: "N@seconds"'],
        ['File offer window seconds','anti_file_offer_rate_window_sec','int',''],
        ['Default room slowmode (sec)','anti_room_slowmode_default_sec','int',''],
        ['Strikes before auto-mute','anti_antiabuse_strikes_before_mute','int',''],
        ['Strike window (sec)','anti_antiabuse_strike_window_sec','int',''],
        ['Auto-mute minutes','anti_antiabuse_auto_mute_minutes','int',''],
        ['Join rate limit','anti_room_join_rate_limit','text','Format: "N@seconds"'],
        ['Join window seconds','anti_room_join_rate_window_sec','int',''],
        ['Room create rate limit','anti_room_create_rate_limit','text','Format: "N@seconds"'],
        ['Room create window seconds','anti_room_create_rate_window_sec','int',''],
        ['Allow users to create rooms','anti_allow_user_create_rooms','bool',''],
        ['Max room name length','anti_max_room_name_length','int',''],
        ['Friend request rate limit','anti_friend_req_rate_limit','text','Format: "N@seconds"'],
        ['Friend request window seconds','anti_friend_req_rate_window_sec','int',''],
        ['Friend unique targets max','anti_friend_req_unique_targets_max','int',''],
        ['Friend unique targets window','anti_friend_req_unique_targets_window_sec','int',''],
        ['Max links per message','anti_max_links_per_message','int',''],
        ['Max magnets per message','anti_max_magnets_per_message','int',''],
        ['Max mentions per message','anti_max_mentions_per_message','int',''],
        ['Dup msg window (sec)','anti_dup_msg_window_sec','int',''],
        ['Dup msg max repeats','anti_dup_msg_max','int',''],
        ['Dup msg min length','anti_dup_msg_min_length','int',''],
        ['Normalize dup compare','anti_dup_msg_normalize','bool','Lowercase + collapse spaces']
      ];

      for (const [label,key,typ,hint] of fields){
        antiForm.appendChild(makeField(label, key, typ, hint));
        const realKey = key.replace('anti_','');
        const v = antiCache[realKey];
        const inp = secSettings.querySelector('#'+key);
        if (!inp) continue;
        if (typ === 'bool') inp.checked = !!v;
        else inp.value = (v === null || v === undefined) ? '' : String(v);
      }
    }

    async function applyAntiAbuseSettings(){
      if (!antiCache) return toast('warn','Not available','Requires super-admin');
      const payload = {};
      function grabBool(realKey){
        const id = 'anti_'+realKey;
        const elx = secSettings.querySelector('#'+id);
        if (!elx) return;
        payload[realKey] = !!elx.checked;
      }
      function grabInt(realKey){
        const id = 'anti_'+realKey;
        const elx = secSettings.querySelector('#'+id);
        if (!elx) return;
        const v = (elx.value||'').trim();
        if (v === '') return;
        payload[realKey] = parseInt(v,10);
      }
      function grabText(realKey){
        const id = 'anti_'+realKey;
        const elx = secSettings.querySelector('#'+id);
        if (!elx) return;
        const v = (elx.value||'').trim();
        if (v === '') return;
        payload[realKey] = v;
      }

      ['allow_user_create_rooms','dup_msg_normalize'].forEach(grabBool);
      [
        'room_msg_rate_window_sec','dm_msg_rate_window_sec','file_offer_rate_window_sec','room_slowmode_default_sec',
        'antiabuse_strikes_before_mute','antiabuse_strike_window_sec','antiabuse_auto_mute_minutes',
        'room_join_rate_window_sec','room_create_rate_window_sec','max_room_name_length',
        'friend_req_rate_window_sec','friend_req_unique_targets_max','friend_req_unique_targets_window_sec',
        'max_links_per_message','max_magnets_per_message','max_mentions_per_message',
        'dup_msg_window_sec','dup_msg_max','dup_msg_min_length'
      ].forEach(grabInt);
      [
        'room_msg_rate_limit','dm_msg_rate_limit','file_offer_rate_limit','room_join_rate_limit','room_create_rate_limit','friend_req_rate_limit'
      ].forEach(grabText);

      const j = await postJSON('/admin/settings/antiabuse', payload);
      if (j && j.ok){
        log(`antiabuse patch persisted=${j.persisted}`);
        toast('ok','Anti-abuse applied', `persisted=${j.persisted}`);
        loadAntiAbuseSettings();
      } else {
        toast('err','Anti-abuse apply failed', j && j.error ? j.error : 'unknown', 5200);
      }
    }

    secSettings.querySelector('#ecapAntiReload').addEventListener('click', loadAntiAbuseSettings);
    secSettings.querySelector('#ecapAntiApply').addEventListener('click', applyAntiAbuseSettings);
    loadAntiAbuseSettings();

    // AUDIT
    secAudit.innerHTML = `
      <div class="ecap-card ecap-fill ecap-fillCol" style="gap:8px">
        <h4>Audit log</h4>
        <div class="ecap-row">
          <input id="ecapAuditQ" placeholder="Filter (actor, action, target, details)…" />
          <button id="ecapAuditRefresh" class="ecap-btn tight" type="button">Refresh</button>
        </div>
        <div class="ecap-list ecap-fillScroll" id="ecapAuditList"></div>
      </div>
    `;

    const auditQ = secAudit.querySelector('#ecapAuditQ');
    const auditList = secAudit.querySelector('#ecapAuditList');

    async function refreshAudit(){
      const q = (auditQ.value||'').trim();
      const qs = new URLSearchParams({q, limit:'80'}).toString();
      const j = await getJSON('/admin/audit/recent?'+qs);
      auditList.innerHTML = '';
      const ev = (j && j.events) ? j.events : [];
      if (!ev.length){
        auditList.innerHTML = '<div class="ecap-item"><span class="ecap-muted">No events</span></div>';
        return;
      }
      for (const e of ev){
        const row = el('div', {class:'ecap-item'});
        const ts = e.timestamp ? new Date(e.timestamp).toLocaleString() : '';
        const details = safe(e.details || '');
        row.innerHTML = `<div style="min-width:0">
          <div style="font-weight:750;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${safe(e.action)} <span class="ecap-muted">(${safe(ts)})</span></div>
          <div class="ecap-muted" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">actor: ${safe(e.actor)} • target: ${safe(e.target || '—')}</div>
          <div class="ecap-muted" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${details}</div>
        </div>`;
        auditList.appendChild(row);
      }
    }
    secAudit.querySelector('#ecapAuditRefresh').addEventListener('click', refreshAudit);
    auditQ.addEventListener('input', debounce(refreshAudit, 260));
    refreshAudit();

    // Make user list items draggable (best-effort; external DOM)
    function enableDraggableUsers(){
      const lists = [document.getElementById('userList'), document.getElementById('friendsList')].filter(Boolean);
      for (const ul of lists){
        ul.querySelectorAll('li').forEach(li=>{
          if (li.getAttribute('data-ecap-draggable') === '1') return;
          const text = (li.textContent||'').trim();
          if (!text) return;
          li.setAttribute('draggable','true');
          li.setAttribute('data-ecap-draggable','1');
          li.addEventListener('dragstart', (e)=>{
            e.dataTransfer.setData('text/plain', text.split('\n')[0].trim());
          });
        });
      }
    }
    setInterval(enableDraggableUsers, 1500);

    // Stats refresh
    async function refreshStats(){
      const j = await getJSON('/admin/stats');
      if (!j || j.ok === false){
        dot.classList.remove('ok'); dot.classList.add('bad');
        toast('err','Admin API unavailable', (j && j.error) ? j.error : 'unknown', 5200);
        return;
      }
      dot.classList.remove('bad'); dot.classList.add('ok');

      const set = (id, val)=>{ const n = document.getElementById(id); if (n) n.textContent = String(val ?? '—'); };
      set('ecapStatOnline', j.online_users ?? '—');
      set('ecapStatUsers', j.registered_users ?? '—');
      set('ecapStatRooms', j.rooms ?? '—');
      set('ecapStatSessions', j.connected_sessions ?? (j.online_usernames ? j.online_usernames.length : '—'));
      set('ecapStatUptime', j.uptime_seconds != null ? fmtUptime(j.uptime_seconds) : '—');
      set('ecapStatPg', j.postgres_version ?? '—');
      set('ecapStatNow', j.server_time ?? '—');

      const vRooms = document.getElementById('ecapVoiceRooms');
      const vUsers = document.getElementById('ecapVoiceUsers');
      if (vRooms) vRooms.textContent = String(j.voice_rooms ?? '—');
      if (vUsers) vUsers.textContent = String(j.voice_total_users ?? '—');

      // Online list
      const onlineWrap = document.getElementById('ecapOnlineList');
      if (onlineWrap){
        onlineWrap.innerHTML = '';
        const users = (j.online_usernames || []).slice(0, 24);
        if (!users.length){
          onlineWrap.innerHTML = '<span class="ecap-muted">No live roster available.</span>';
        } else {
          for (const u of users){
            const b = el('button', {class:'ecap-btn tight', text:u, type:'button'});
            b.addEventListener('click', ()=>{
              setTargetUser(u, {syncInput:true, loadDetail:true});
              setTab('users');
            });
            onlineWrap.appendChild(b);
          }
          if (j.online_usernames.length > users.length){
            const more = el('span', {class:'ecap-muted', text:`+${j.online_usernames.length-users.length} more`});
            onlineWrap.appendChild(more);
          }
        }
      }

      // Feature pills
      const pillWrap = document.getElementById('ecapFeaturePills');
      if (pillWrap){
        pillWrap.innerHTML = '';
        const snap = j.settings_snapshot || {};
        const mk = (label, ok, cls)=>{
          const s = el('span', {class:`ecap-pill ${cls || (ok?'ok':'bad')}`, text: label});
          pillWrap.appendChild(s);
        };
        mk(`voice ${snap.voice_enabled ? 'on':'off'}`, !!snap.voice_enabled);
        mk(`giphy ${snap.giphy_enabled ? 'on':'off'}`, !!snap.giphy_enabled);
        mk(`p2p ${snap.p2p_file_enabled ? 'on':'off'}`, !!snap.p2p_file_enabled);
        if (snap.voice_max_room_peers != null){
          const lim = snap.voice_max_room_peers ? snap.voice_max_room_peers : '∞';
          mk(`voice cap ${lim}`, true, 'warn');
        }
      }
    }

    btnRefresh.addEventListener('click', ()=>{
      refreshStats();
      refreshRooms();
      refreshAudit();
      runSearch();
      refreshVoiceSettings();
      toast('info','Refreshed','Stats + lists updated');
      log('manual refresh');
    });

    refreshVoiceSettings();
    refreshStats();
    setInterval(refreshStats, 15000);

    // keep Users tab in sync if dashboard input changes
    const dashTargetInput = secDash.querySelector('#ecapTargetInput');
    dashTargetInput.addEventListener('input', ()=>{
      const u = (dashTargetInput.value||'').trim();
      if (u) setTargetUser(u, {syncInput:false, loadDetail:false});
    });

    // Initial population
    runSearch();

    log('admin panel injected (v3)');
    toast('ok','Admin panel ready', 'v3 UI loaded');
  }

  function boot(){
    try{ buildPanel(); }catch(e){ console.error(e); }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();

"""

    snippet = (
        "\n<!-- EchoChat Admin Panel (server-injected; admin-only) -->\n"
        f"<style id=\"ecAdminCss\">{css}</style>\n"
        f"<script id=\"ecAdminJs\">{js}</script>\n"
    )
    return snippet

def inject_admin_panel(html: str) -> str:
    """Inject the admin panel snippet into the provided HTML document."""
    snippet = build_admin_injection_snippet()
    lower = html.lower()
    marker = "</head>"
    idx = lower.rfind(marker)
    if idx == -1:
        return html + snippet
    return html[:idx] + snippet + html[idx:]