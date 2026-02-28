// ───────────────────────────────────────────────────────────────────────────────

// ───────────────────────────────────────────────────────────────────────────────
// Embedded room pane (left side)
// ───────────────────────────────────────────────────────────────────────────────
function getRoomEmbedEl() {
  const el = $("roomEmbed");
  if (!el) return null;
  if (!el._ym) {
    el._ym = {
      titleEl: $("roomEmbedTitle"),
      log: $("roomEmbedLog"),
      input: $("roomEmbedInput"),
      emojiBtn: $("roomEmbedEmojiBtn"),
      send: $("roomEmbedSend"),
      torrentBtn: $("roomEmbedTorrentBtn"),
      gifBtn: $("roomEmbedGifBtn"),
      torrentInput: $("roomEmbedTorrentInput")
    };
  }
  return el;
}

function showRoomEmbed(room) {
  const pane = getRoomEmbedEl();
  const ph = $("sitePlaceholder");
  if (!pane) return null;

  UIState.roomEmbedRoom = room || null;

  if (room) {
    ph?.classList.add("hidden");
    pane.classList.remove("hidden");
    if (pane._ym?.titleEl) pane._ym.titleEl.textContent = `Room — ${room}`;
  } else {
    pane.classList.add("hidden");
    ph?.classList.remove("hidden");
    if (pane._ym?.titleEl) pane._ym.titleEl.textContent = "Room —";
  }

  return pane;
}


// ─────────────────────────────────────────────────────────────────────────────
// Yahoo-style Room Browser (left selection screen)
// ─────────────────────────────────────────────────────────────────────────────

const ROOM_BROWSER = {
  catalog: null,
  selectedCategory: null,
  selectedSubcategory: null,
  counts: new Map(),
  customRooms: [],
  inviteRoom: null,
  started: false,
};

function rbHasUI() {
  return !!($('rbCategoryTree') && $('rbOfficialRooms') && $('rbCustomRooms'));
}

async function rbLoadCatalog() {
  const resp = await fetchWithAuth('/api/room_catalog', { method: 'GET' }, { retryOn401: true });
  if (!resp || resp.status === 0) return { version: 2, categories: [] };
  try {
    const j = await resp.json();
    if (j && Array.isArray(j.categories)) return j;
  } catch {}
  return { version: 2, categories: [] };
}

async function rbLoadCounts() {
  const resp = await fetchWithAuth('/api/rooms', { method: 'GET' }, { retryOn401: true });
  if (!resp || resp.status === 0) return;
  try {
    const j = await resp.json();
    const rows = Array.isArray(j) ? j : (Array.isArray(j?.rooms) ? j.rooms : []);
    const m = new Map();
    (rows || []).forEach((r) => {
      const name = r?.name;
      const count = (r?.count ?? r?.member_count ?? 0);
      if (name) m.set(String(name), Number(count || 0) || 0);
    });
    ROOM_BROWSER.counts = m;
  } catch {}
}

async function rbLoadCustomRooms() {
  const c = ROOM_BROWSER.selectedCategory;
  const s = ROOM_BROWSER.selectedSubcategory;
  if (!c || !s) { ROOM_BROWSER.customRooms = []; return; }
  const qs = new URLSearchParams({ category: c, subcategory: s });
  const resp = await fetchWithAuth(`/api/custom_rooms?${qs.toString()}`, { method: 'GET' }, { retryOn401: true });
  if (!resp || resp.status === 0) return;
  try {
    const j = await resp.json();
    ROOM_BROWSER.customRooms = Array.isArray(j.rooms) ? j.rooms : [];
  } catch {
    ROOM_BROWSER.customRooms = [];
  }
}

function rbSetSelectionLabel() {
  const el = $('rbSelectionLabel');
  if (!el) return;
  if (!ROOM_BROWSER.selectedCategory || !ROOM_BROWSER.selectedSubcategory) {
    el.textContent = 'Select a category/subcategory…';
  } else {
    el.textContent = `${ROOM_BROWSER.selectedCategory} › ${ROOM_BROWSER.selectedSubcategory}`;
  }
}

function rbRoomsForSelection() {
  const cat = ROOM_BROWSER.selectedCategory;
  const sub = ROOM_BROWSER.selectedSubcategory;
  if (!ROOM_BROWSER.catalog || !cat || !sub) return [];
  const c = (ROOM_BROWSER.catalog.categories || []).find((x) => (x.name || '') === cat);
  if (!c) return [];
  const sObj = (c.subcategories || []).find((x) => (x.name || '') === sub);
  if (!sObj) return [];
  return Array.isArray(sObj.rooms) ? sObj.rooms : [];
}

function rbMakeRoomLi(roomName, { isCustom = false, meta = null } = {}) {
  const li = document.createElement('li');
  li.dataset.room = roomName;

  const left = document.createElement('div');
  left.className = 'rbItemLeft';
  const nm = document.createElement('div');
  nm.className = 'rbItemName';
  nm.textContent = roomName;
  const mt = document.createElement('div');
  mt.className = 'rbItemMeta';
  const cnt = ROOM_BROWSER.counts.get(roomName) || (meta ? Number(meta.member_count || 0) : 0) || 0;

  const flags = [];
  if (meta && meta.is_private) flags.push('🔒');
  if (meta && meta.is_18_plus) flags.push('🔞');
  if (meta && meta.is_nsfw) flags.push('⚠️');
  mt.textContent = `${cnt} online${flags.length ? '  ' + flags.join(' ') : ''}`;
  left.appendChild(nm);
  left.appendChild(mt);

  const right = document.createElement('div');
  right.className = 'rbBtns';

  const badge = document.createElement('span');
  badge.className = 'rbBadge';
  badge.textContent = String(cnt);

  const joinBtn = document.createElement('button');
  joinBtn.className = 'rbJoinBtn';
  joinBtn.textContent = 'Join';
  joinBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    joinRoom(roomName);
  });

  right.appendChild(badge);
  right.appendChild(joinBtn);

  if (isCustom && meta && meta.is_private && meta.created_by === currentUser) {
    const invBtn = document.createElement('button');
    invBtn.className = 'rbJoinBtn';
    invBtn.title = 'Invite user';
    invBtn.textContent = 'Invite';
    invBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      rbOpenInviteModal(roomName);
    });
    right.appendChild(invBtn);
  }

  li.appendChild(left);
  li.appendChild(right);
  li.addEventListener('dblclick', () => joinRoom(roomName));
  return li;
}

function rbRenderCategoryTree() {
  const ul = $('rbCategoryTree');
  if (!ul) return;
  ul.innerHTML = '';

  const cats = (ROOM_BROWSER.catalog && ROOM_BROWSER.catalog.categories) ? ROOM_BROWSER.catalog.categories : [];
  cats.forEach((c) => {
    const cName = String(c.name || '').trim();
    if (!cName) return;

    const header = document.createElement('li');
    header.className = 'rbCatHeader';
    header.style.cursor = 'default';
    header.style.opacity = '0.9';
    header.textContent = cName;
    ul.appendChild(header);

    (c.subcategories || []).forEach((s) => {
      const sName = String(s.name || '').trim();
      if (!sName) return;
      const li = document.createElement('li');
      li.dataset.category = cName;
      li.dataset.subcategory = sName;
      li.textContent = `↳ ${sName}`;
      const active = (ROOM_BROWSER.selectedCategory === cName && ROOM_BROWSER.selectedSubcategory === sName);
      if (active) li.classList.add('active');
      li.addEventListener('click', async () => {
        ROOM_BROWSER.selectedCategory = cName;
        ROOM_BROWSER.selectedSubcategory = sName;
        rbRenderCategoryTree();
        await rbRefreshLists();
      });
      ul.appendChild(li);
    });
  });
}

function rbRenderRoomLists() {
  const off = $('rbOfficialRooms');
  const cust = $('rbCustomRooms');
  if (!off || !cust) return;

  off.innerHTML = '';
  cust.innerHTML = '';
  rbSetSelectionLabel();

  const officialRooms = rbRoomsForSelection();
  if (!officialRooms.length) {
    const li = document.createElement('li');
    li.style.cursor = 'default';
    li.innerHTML = `<div class="rbItemLeft"><div class="rbItemName muted">No rooms</div></div>`;
    off.appendChild(li);
  } else {
    officialRooms.forEach((r) => off.appendChild(rbMakeRoomLi(r)));
  }

  const customRooms = ROOM_BROWSER.customRooms || [];
  if (!customRooms.length) {
    const li = document.createElement('li');
    li.style.cursor = 'default';
    li.innerHTML = `<div class="rbItemLeft"><div class="rbItemName muted">No custom rooms</div><div class="rbItemMeta muted">Use “Create Room” to make one.</div></div>`;
    cust.appendChild(li);
  } else {
    customRooms.forEach((r) => {
      if (!r || !r.name) return;
      cust.appendChild(rbMakeRoomLi(String(r.name), { isCustom: true, meta: r }));
    });
  }
}

async function rbRefreshLists() {
  await rbLoadCounts();
  await rbLoadCustomRooms();
  rbRenderRoomLists();
}

function rbOpenModal(id) {
  const el = $(id);
  if (el) el.classList.remove('hidden');
}
function rbCloseModal(id) {
  const el = $(id);
  if (el) el.classList.add('hidden');
}

function rbPopulateCreateRoomSelects() {
  const catSel = $('crCategory');
  const subSel = $('crSubcategory');
  if (!catSel || !subSel) return;
  catSel.innerHTML = '';
  subSel.innerHTML = '';

  const cats = (ROOM_BROWSER.catalog && ROOM_BROWSER.catalog.categories) ? ROOM_BROWSER.catalog.categories : [];
  cats.forEach((c) => {
    const opt = document.createElement('option');
    opt.value = c.name;
    opt.textContent = c.name;
    catSel.appendChild(opt);
  });

  const setSubs = () => {
    subSel.innerHTML = '';
    const catName = catSel.value;
    const c = cats.find((x) => x.name === catName);
    (c?.subcategories || []).forEach((s) => {
      const opt = document.createElement('option');
      opt.value = s.name;
      opt.textContent = s.name;
      subSel.appendChild(opt);
    });
  };

  catSel.addEventListener('change', setSubs);
  setSubs();

  try {
    if (ROOM_BROWSER.selectedCategory) catSel.value = ROOM_BROWSER.selectedCategory;
    setSubs();
    if (ROOM_BROWSER.selectedSubcategory) subSel.value = ROOM_BROWSER.selectedSubcategory;
  } catch {}
}

function rbOpenCreateRoomModal() {
  rbPopulateCreateRoomSelects();
  $('crName') && ($('crName').value = '');
  $('cr18') && ($('cr18').checked = false);
  $('crNSFW') && ($('crNSFW').checked = false);
  try {
    const radios = document.querySelectorAll('input[name="crVis"]');
    radios.forEach((r) => { r.checked = (r.value === 'public'); });
  } catch {}
  rbOpenModal('createRoomModal');
}

async function rbCreateRoom() {
  const name = ($('crName')?.value || '').trim();
  const category = ($('crCategory')?.value || '').trim();
  const subcategory = ($('crSubcategory')?.value || '').trim();
  const is_18_plus = !!$('cr18')?.checked;
  const is_nsfw = !!$('crNSFW')?.checked;
  let is_private = false;
  try {
    const sel = document.querySelector('input[name="crVis"]:checked');
    is_private = (sel && sel.value === 'private');
  } catch {}

  if (!name) { toast('⚠️ Room name required', 'warn'); return; }

  const payload = { name, category, subcategory, is_private, is_18_plus, is_nsfw };
  const resp = await fetchWithAuth('/api/custom_rooms', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  }, { retryOn401: true });

  if (!resp || resp.status === 0) { toast('❌ Network error', 'error'); return; }
  if (resp.status >= 400) {
    let msg = 'Create failed';
    try { const j = await resp.json(); if (j && j.error) msg = j.error; } catch {}
    toast(`❌ ${msg}`, 'error');
    return;
  }
  toast(`✅ Room created: ${name}`, 'ok');
  rbCloseModal('createRoomModal');
  ROOM_BROWSER.selectedCategory = category;
  ROOM_BROWSER.selectedSubcategory = subcategory;
  rbRenderCategoryTree();
  await rbRefreshLists();
}

function rbOpenInviteModal(roomName) {
  ROOM_BROWSER.inviteRoom = roomName;
  const lab = $('irRoomLabel');
  if (lab) lab.textContent = `Room: ${roomName}`;
  const inp = $('irUser');
  if (inp) inp.value = '';
  rbOpenModal('inviteRoomModal');
}

async function rbSendInvite() {
  const room = ROOM_BROWSER.inviteRoom;
  const invitee = ($('irUser')?.value || '').trim();
  if (!room || !invitee) { toast('⚠️ Room + username required', 'warn'); return; }

  const resp = await fetchWithAuth('/api/custom_rooms/invite', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ room, invitee })
  }, { retryOn401: true });

  if (!resp || resp.status === 0) { toast('❌ Network error', 'error'); return; }
  if (resp.status >= 400) {
    let msg = 'Invite failed';
    try { const j = await resp.json(); if (j && j.error) msg = j.error; } catch {}
    toast(`❌ ${msg}`, 'error');
    return;
  }
  toast(`✅ Invited ${invitee}`, 'ok');
  rbCloseModal('inviteRoomModal');
}

async function initRoomBrowser() {
  if (ROOM_BROWSER.started) return;
  if (!rbHasUI()) return;
  ROOM_BROWSER.started = true;

  ROOM_BROWSER.catalog = await rbLoadCatalog();

  try {
    if (!ROOM_BROWSER.selectedCategory || !ROOM_BROWSER.selectedSubcategory) {
      const c0 = (ROOM_BROWSER.catalog.categories || [])[0];
      const s0 = (c0 && (c0.subcategories || [])[0]) || null;
      if (c0 && s0) {
        ROOM_BROWSER.selectedCategory = c0.name;
        ROOM_BROWSER.selectedSubcategory = s0.name;
      }
    }
  } catch {}

  rbRenderCategoryTree();
  await rbRefreshLists();

  $('btnOpenCreateRoom')?.addEventListener('click', rbOpenCreateRoomModal);
  $('btnCloseCreateRoom')?.addEventListener('click', () => rbCloseModal('createRoomModal'));
  $('btnCreateRoom')?.addEventListener('click', rbCreateRoom);
  $('crNSFW')?.addEventListener('change', () => {
    if ($('crNSFW')?.checked) $('cr18').checked = true;
  });

  $('btnCloseInviteRoom')?.addEventListener('click', () => rbCloseModal('inviteRoomModal'));
  $('btnInviteRoom')?.addEventListener('click', rbSendInvite);
  $('irUser')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); rbSendInvite(); }
  });

  setInterval(() => {
    rbRefreshLists().catch(() => {});
  }, 15_000);
}

function openRoomEmbedded(room) {
  const pane = showRoomEmbed(room);
  if (!pane) return;

  // Bind emoticons picker for the embedded room composer
  if (pane._ym?.emojiBtn && pane._ym?.input) {
    bindEmojiButton(pane._ym.emojiBtn, pane._ym.input);
  }
  // Bind GIF picker for the embedded room composer
  if (pane._ym?.gifBtn) {
    pane._ym.gifBtn.onclick = () => {
      const roomNow = UIState.roomEmbedRoom || UIState.currentRoom;
      if (!roomNow) return toast("⚠️ Join a room first", "warn");
      openGifPicker(async (url) => {
        try {
          const clean = _gifFallbackUrl(url) || url;
          const msg = `gif:${clean}`;
          const res = await sendRoomTo(roomNow, msg);
          if (!res?.success) toast(`❌ ${res?.error || "Send failed"}`, "error");
        } catch (e) {
          console.error(e);
          toast(`❌ Send failed: ${e?.message || e}`, "error");
        }
      });
    };
  }

  // Reset log for this join (pre-alpha behavior)
  if (pane._ym?.log) pane._ym.log.innerHTML = "";
  if (pane._ym) pane._ym.msgIndex = new Map();
  appendLine(pane, "System:", "You are now chatting in this room.");

  // Wire send
  const sendFn = async () => {
    const msg = pane._ym?.input?.value?.trim() || "";
    if (!msg) return;

    // Magnet paste → render as torrent card in room chat
    if (isMagnetText(msg)) {
      const pm = parseMagnet(msg);
      if (!pm) return toast("⚠️ Invalid magnet link", "warn");
      try {
        // IMPORTANT (UX): do NOT block sending on tracker scrape.
        // Torrent cards already self-refresh swarm stats asynchronously.
        const swarm = { seeds: null, leechers: null, completed: null };
        const wire = {
          _ec: "torrent",
          scope: "room",
          room,
          name: pm.name || "Magnet",
          infohash: pm.infohash,
          magnet: pm.magnet,
          total_size: 0,
          seeds: swarm.seeds,
          leechers: swarm.leechers,
          completed: swarm.completed,
          trackers: pm.trackers || [],
          comment: "",
          created_by: "",
          creation_date: ""
        };
        sendRoomTo(room, JSON.stringify(wire)).then((res) => {
          if (res?.success) {
            if (pane._ym?.input) pane._ym.input.value = "";
          } else {
            toast(`❌ ${res?.error || "Send failed"}`, "error");
          }
        });
      } catch (e) {
        console.error(e);
        toast("❌ Could not send magnet", "error");
      }
      return;
    }

    sendRoomTo(room, msg).then((res) => {
      if (res?.success) {
        // Don't append locally; we wait for the server broadcast so we get
        // the authoritative message_id (needed for reactions).
        if (pane._ym?.input) pane._ym.input.value = "";
      } else {
        toast(`❌ ${res?.error || "Send failed"}`, "error");
      }
    });
  };

  if (pane._ym?.send) pane._ym.send.onclick = sendFn;
  if (pane._ym?.input) {
    pane._ym.input.onkeydown = (e) => {
      if (e.key === "Enter") sendFn();
    };

    // Torrent share (room)
    if (pane._ym?.torrentBtn && pane._ym?.torrentInput) {
      pane._ym.torrentBtn.onclick = () => pane._ym.torrentInput.click();
      pane._ym.torrentInput.onchange = async () => {
        const f = pane._ym.torrentInput.files && pane._ym.torrentInput.files[0];
        pane._ym.torrentInput.value = "";
        if (!f) return;
        if (!isTorrentName(f.name)) {
          toast("⚠️ Room share currently supports .torrent files only", "warn");
          return;
        }
        try {
          // Parse + scrape
          const ab = await f.arrayBuffer();
          const u8 = new Uint8Array(ab);
          const parsed = parseTorrentBytes(u8);
          const infohash = parsed.infoSlice ? await sha1HexFromBytes(parsed.infoSlice) : "";
          const magnet = infohash ? buildMagnet(infohash, parsed.name, parsed.trackers) : "";
          // IMPORTANT (UX): do NOT block sending on tracker scrape.
          // Torrent cards already self-refresh swarm stats asynchronously.
          const swarm = { seeds: null, leechers: null, completed: null };

          // Upload .torrent so room members can download it
          const fd = new FormData();
          fd.append("file", new Blob([u8], { type: "application/x-bittorrent" }), f.name);
          const upResp = await fetchWithAuth("/api/torrents/upload", { method: "POST", body: fd });
          const upData = await upResp.json().catch(() => null);
          if (!upResp.ok || !upData?.success) throw new Error(upData?.error || "Upload failed");

          const torrent_id = upData.torrent_id;
          const download_url = `/api/torrents/${encodeURIComponent(torrent_id)}/download`;

          const wire = {
            _ec: "torrent",
            scope: "room",
            room,
            torrent_id,
            download_url,
            file_name: f.name,
            name: parsed.name || f.name,
            infohash,
            magnet,
            total_size: parsed.total_size || 0,
            seeds: swarm.seeds,
            leechers: swarm.leechers,
            completed: swarm.completed,
            trackers: parsed.trackers || [],
            comment: parsed.comment || "",
            created_by: parsed.created_by || "",
            creation_date: parsed.creation_date || ""
          };

          sendRoomTo(room, JSON.stringify(wire)).then((res) => {
            if (!res?.success) toast(`❌ ${res?.error || "Send failed"}`, "error");
          });
        } catch (e) {
          console.error(e);
          toast(`❌ Torrent share failed: ${e?.message || e}`, "error");
        }
      };
    }

    pane._ym.input.focus();
  }

  // Leave button
  const btnLeave = $("btnRoomEmbedLeave");
  if (btnLeave) btnLeave.onclick = () => leaveRoom();

  // Voice (room) controls — one-button toggle (Yahoo style)
  const btnVoice = $("btnRoomEmbedVoice");
  if (btnVoice) {
    btnVoice.onclick = async () => {
      try {
        if (VOICE_STATE.room.joined && VOICE_STATE.room.name === room) {
          voiceLeaveRoom("Left voice", true);
          voiceUpdateRoomVoiceButton();
          return;
        }
        voiceSetMute(false); // hands‑free by default
        const res = await voiceJoinRoom(room, { silent: true });
        if (!res?.success) {
          toast(`❌ ${res?.error || "Voice join failed"}`, "error");
        }
        voiceUpdateRoomVoiceButton();
      } catch (e) {
        console.error(e);
        toast(`❌ Voice error: ${e?.message || e}`, "error");
      }
    };

    // Right-click toggles mic mute (global)
    btnVoice.oncontextmenu = (ev) => {
      try {
        ev.preventDefault();
        if (!VOICE_STATE.micStream) return false;
        const muted = !VOICE_STATE.micMuted;
        voiceSetMute(muted);
        voiceRoomUi({ muteLabel: muted ? "Unmute" : "Mute" });
        voiceUpdateRoomVoiceButton();
        toast(muted ? "🔇 Mic muted" : "🎤 Mic unmuted", "info");
      } catch (e) {}
      return false;
    };
  }

  // Hide legacy room voice bar buttons (kept for compatibility)
  const bVJoin = $("btnRoomEmbedVoiceJoin");
  if (bVJoin) bVJoin.style.display = "none";
  const bVLeave = $("btnRoomEmbedVoiceLeave");
  if (bVLeave) bVLeave.style.display = "none";
  const bVMute = $("btnRoomEmbedVoiceMute");
  if (bVMute) bVMute.style.display = "none";

// Default voice UI for this room
  voiceRoomUi({ show: false, statusText: "Not connected", joinVisible: false, leaveVisible: false, muteVisible: false, muteLabel: "Mute" });
  voiceUpdateRoomVoiceButton();


  // Apply any known room policy state (locked/read-only/slowmode)
  try { applyRoomPolicyToView(room, pane, getRoomPolicy(room)); } catch {}

  return pane;
}

function getActiveRoomView(room) {
  if (UIState.roomEmbedRoom === room) {
    return getRoomEmbedEl();
  }
  const win = UIState.windows.get("room:" + room);
  return win || null;
}

// Rooms
// ───────────────────────────────────────────────────────────────────────────────
function renderRooms(rooms) {
  const ul = $("roomList");
  if (!ul) return;

  // Allow callers (like room policy updates) to re-render without having to
  // pass the rooms list each time.
  if (Array.isArray(rooms)) UIState.roomsCache = rooms;
  const list = Array.isArray(rooms) ? rooms : (Array.isArray(UIState.roomsCache) ? UIState.roomsCache : []);

  ul.innerHTML = "";

  if (!list || list.length === 0) {
    const li = document.createElement("li");
    li.dataset.name = "none";
    li.innerHTML = `<div class="liLeft"><span class="presDot offline"></span><span class="liName muted">No rooms</span></div>`;
    ul.appendChild(li);
    return;
  }

  list.forEach(r => {
    const name = (r && (r.name || r.room_id)) || String(r);
    const desc = (r && r.description) ? `(${r.description})` : "";

    const li = document.createElement("li");
    li.dataset.name = name;

    const pol = getRoomPolicy(name);
    const policyIcons = pol ? `${pol.locked ? " 🔒" : ""}${pol.readonly ? " 📝" : ""}${(Number(pol.slowmode_seconds||0) > 0) ? " 🐢" : ""}` : "";

    const left = document.createElement("div");
    left.className = "liLeft";
    left.innerHTML = `<span class="presDot offline"></span><span class="liName">${escapeHtml(name)}${policyIcons} <span class="muted">${escapeHtml(desc)}</span></span>`;

    const actions = document.createElement("div");
    actions.className = "liActions";

    const joinBtn = document.createElement("button");
    joinBtn.className = "iconBtn";
    joinBtn.textContent = "🚪";
    joinBtn.title = "Join";
    joinBtn.onclick = () => joinRoom(name);

    actions.appendChild(joinBtn);

    li.appendChild(left);
    li.appendChild(actions);
    li.ondblclick = () => joinRoom(name);

    ul.appendChild(li);
  });
}

function getRooms() {
  // If we have server-rendered initial rooms, show instantly:
  if (Array.isArray(window.INIT_ROOMS) && window.INIT_ROOMS.length > 0) {
    renderRooms(window.INIT_ROOMS);
  }
  socket.emit("get_rooms");
}

socket.on("room_list", (data) => {
  if (!data || !Array.isArray(data.rooms)) {
    toast("❌ Failed to fetch rooms", "error");
    return;
  }
  renderRooms(data.rooms);
});


// Live room policy state (locked/read-only/slowmode)
socket.on("room_policy_state", (payload) => {
  try {
    const room = payload?.room;
    if (!room) return;
    upsertRoomPolicy(room, {
      locked: !!payload.locked,
      readonly: !!payload.readonly,
      slowmode_seconds: Number(payload.slowmode_seconds || 0),
      can_send: payload.can_send !== undefined ? !!payload.can_send : true,
      can_override_lock: !!payload.can_override_lock,
      can_override_readonly: !!payload.can_override_readonly,
      block_reason: payload.block_reason || null,
      set_by: payload.set_by || null,
      ts: payload.ts || null,
    });
  } catch (e) {
    console.warn('room_policy_state handler failed', e);
  }
});

socket.on("room_forced_leave", (payload) => {
  try {
    const room = payload?.room;
    if (!room) return;
    const reason = payload?.reason || 'removed';
    forceLeaveRoomUI(room, reason);
  } catch (e) {
    console.warn('room_forced_leave handler failed', e);
  }
});

socket.on("admin_kick", (payload) => {
  try {
    if (!payload) return;
    const room = payload.room;
    const who = payload.username;
    if (who && String(who) === String(currentUser) && room) {
      forceLeaveRoomUI(room, 'kicked');
    } else if (room && who) {
      toast(`👢 ${who} was kicked from ${room}`, 'warn', 4200);
    }
  } catch {}
});

function bestEffortForceLogout(payload) {
  try {
    const who = payload?.username;
    if (who && currentUser && String(who) !== String(currentUser)) return;

    const reason = String(payload?.reason || payload?.message || "Signed out");
    try { sessionStorage.setItem("echochat_logout_reason", reason); } catch (e) {}
    try { socket.disconnect(); } catch (e) {}
    window.location.href = "/logout";
  } catch (e) {
    try { window.location.href = "/logout"; } catch (_e) {}
  }
}

socket.on("force_logout", (payload) => bestEffortForceLogout(payload));
socket.on("admin_force_logout", (payload) => bestEffortForceLogout(payload));


socket.on("slowmode_state", (payload) => {
  try {
    const room = payload?.room;
    const sec = Number(payload?.seconds || 0);
    if (room) upsertRoomPolicy(room, { slowmode_seconds: sec });
  } catch {}
});

socket.on("global_announcement", (payload) => {
  const msg = String(payload?.message || '').trim();
  if (!msg) return;
  toast(`📣 ${msg}`, 'info', 6500);
});

function joinRoom(room, opts) {
  opts = opts || {};
  const silent = !!opts.silent;
  const restore = !!opts.restore;

  if (!room) return Promise.resolve({ success: false, error: "missing_room" });

  // If switching rooms while in voice, cleanly leave voice first.
  if (VOICE_STATE?.room?.joined && VOICE_STATE.room.name && VOICE_STATE.room.name !== room) {
    voiceLeaveRoom("Switching rooms", true);
  }

  return new Promise((resolve) => {
    socket.emit("join", { room }, async (res) => {
      if (res && res.success) {
        UIState.currentRoom = room;
        const roomToJoin = $("roomToJoin");
        if (roomToJoin) roomToJoin.value = room;

        // Persist for reconnect/session restore (per-tab).
        try {
          sessionStorage.setItem("echochat_last_room", String(room));
          sessionStorage.setItem("echochat_last_room_set_at", String(Date.now()));
        } catch (e) {}

        if (!silent && !restore) toast(`🚪 Joined room: ${room}`, "ok");
        openRoomEmbedded(room);

        // If the server returned room history, render it now (ciphertext stays E2EE; client decrypts locally).
        try {
          const hist = Array.isArray(res?.history) ? res.history : [];
          const view = getActiveRoomView(room);
          if (view && hist.length) {
            view._ym.log.innerHTML = "";
            view._ym.msgIndex = new Map();

            for (const item of hist) {
              const payload = { room, ...item };

              // Decrypt room envelope history if applicable.
              if (payload.cipher && typeof payload.cipher === "string" && payload.cipher.startsWith(ROOM_ENVELOPE_PREFIX)) {
                try {
                  const dec = await decryptRoomEnvelope(payload.cipher);
                  if (dec) payload.message = dec;
                } catch (e) {
                  // Leave as placeholder if decryption fails.
                }
              }

              appendRoomMessage(view, payload);
            }

            appendLine(view, "System:", "History loaded.");
          }
        } catch (e) {
          // ignore
        }

        getUsersInRoom(room);
        resolve(res);
      } else {
        if (!silent && !restore) toast(`❌ Failed to join room: ${res?.error || room}`, "error");
        resolve(res || { success: false, error: res?.error || "join_failed" });
      }
    });
  });
}


function leaveRoom() {
  const room = UIState.currentRoom;
  if (!room) return toast("⚠️ Not in a room", "warn");

  if (VOICE_STATE?.room?.joined && VOICE_STATE.room.name === room) {
    voiceLeaveRoom("Left room", true);
  }

  socket.emit("leave", { room }, (res) => {
    if (res && res.success) {
      toast(`👋 Left room: ${room}`, "warn");
      UIState.currentRoom = null;
      // Clear restore targets when the user intentionally leaves.
      try {
        sessionStorage.removeItem("echochat_last_room");
        sessionStorage.removeItem("echochat_last_room_set_at");
        sessionStorage.removeItem("echochat_voice_room");
        sessionStorage.removeItem("echochat_voice_room_joined");
      } catch (e) {}
      $("roomToJoin").value = "";
      $("userList").innerHTML = "";
      setRoomUsersCount(0);
      showRoomEmbed(null);

    } else {
      toast(`❌ Failed to leave room`, "error");
    }
  });
}

let _roomUsersWaiters = [];

function getUsersInRoom(room = UIState.currentRoom) {
  // Server requires an explicit room name.
  if (!room) {
    setRoomUsersCount(0);
    const ul = $("userList");
    if (ul) {
      ul.innerHTML = "";
      const li = document.createElement("li");
      li.dataset.name = "none";
      li.innerHTML = `<div class="liLeft"><span class="presDot offline"></span><span class="liName muted">Join a room to see users</span></div>`;
      ul.appendChild(li);
    }
    return;
  }

  socket.emit("get_users_in_room", { room }, () => {
    // Server responds via "room_users" event.
  });
}

// Promise helper used for room E2EE (needs a fresh member list).
function requestRoomUsers(room = UIState.currentRoom, timeoutMs = 1500) {
  return new Promise((resolve, reject) => {
    if (!room) return resolve([]);
    const t = setTimeout(() => {
      // Remove this waiter if it is still pending
      _roomUsersWaiters = _roomUsersWaiters.filter(w => w !== waiter);
      reject(new Error("room_users timeout"));
    }, timeoutMs);

    const waiter = (users) => {
      clearTimeout(t);
      resolve(Array.isArray(users) ? users : []);
    };

    _roomUsersWaiters.push(waiter);
    socket.emit("get_users_in_room", { room }, () => {});
  });
}

socket.on("room_users", (users) => {
  try {
    const room = UIState.currentRoom;
    if (room) UIState.roomUsers.set(room, Array.isArray(users) ? users : []);
    const waiters = _roomUsersWaiters.slice();
    _roomUsersWaiters = [];
    waiters.forEach(w => { try { w(users); } catch {} });
  } catch {}
  const ul = $("userList");
  if (!ul) return;
  ul.innerHTML = "";
  if (!Array.isArray(users) || users.length === 0) {
    setRoomUsersCount(0);
    const li = document.createElement("li");
    li.dataset.name = "none";
    li.innerHTML = `<div class="liLeft"><span class="presDot offline"></span><span class="liName muted">No users</span></div>`;
    ul.appendChild(li);
    return;
  }

  setRoomUsersCount(users.length);

  users.forEach(u => {
    const li = document.createElement("li");
    li.dataset.name = u;

    const left = document.createElement("div");
    left.className = "liLeft";
    left.innerHTML = `<span class="presDot online"></span><span class="liName">${escapeHtml(u)}</span>`;

    const actions = document.createElement("div");
    actions.className = "liActions";

    const chatBtn = document.createElement("button");
    chatBtn.className = "iconBtn";
    chatBtn.textContent = "💬";
    chatBtn.title = "PM";
    chatBtn.onclick = () => openPrivateChat(u);

    actions.appendChild(chatBtn);

    li.appendChild(left);
    li.appendChild(actions);
    li.ondblclick = () => openPrivateChat(u);

    ul.appendChild(li);
  });
});

// ───────────────────────────────────────────────────────────────────────────────
// Room policy live state (locked/read-only/slowmode)

function getRoomPolicy(room) {
  if (!room) return null;
  return UIState.roomPolicy.get(String(room)) || null;
}

function policyLabel(policy) {
  if (!policy) return "";
  const parts = [];
  if (policy.locked) parts.push("🔒 Locked");
  if (policy.readonly) parts.push("📝 Read-only");
  const slow = Number(policy.slowmode_seconds || 0);
  if (slow > 0) parts.push(`🐢 Slowmode: ${slow}s`);
  let out = parts.join(" · ");
  if (!policy.can_send && out) out += " · You cannot post";
  if (!policy.can_send && !out) out = "You cannot post";
  return out;
}

function ensureWindowPolicyBanner(winEl) {
  if (!winEl) return null;
  const existing = winEl.querySelector('.ym-policy');
  if (existing) return existing;
  const log = winEl.querySelector('.ym-log');
  if (!log) return null;
  const div = document.createElement('div');
  div.className = 'ym-policy hidden';
  div.setAttribute('aria-live', 'polite');
  div.setAttribute('aria-atomic', 'true');
  log.parentElement.insertBefore(div, log);
  return div;
}

function applyRoomPolicyToView(room, viewEl, policy) {
  if (!room || !viewEl) return;
  const p = policy || getRoomPolicy(room);
  if (!p) {
    const b = viewEl.id === 'roomEmbed' ? $('roomEmbedPolicy') : ensureWindowPolicyBanner(viewEl);
    if (b) b.classList.add('hidden');
    return;
  }

  const banner = viewEl.id === 'roomEmbed' ? $('roomEmbedPolicy') : ensureWindowPolicyBanner(viewEl);
  if (banner) {
    const label = policyLabel(p);
    if (label) {
      banner.textContent = label;
      banner.classList.remove('hidden');
    } else {
      banner.textContent = '';
      banner.classList.add('hidden');
    }
  }

  const canSend = !!p.can_send;
  const ym = viewEl._ym || {};
  const controls = [ym.input, ym.send, ym.gifBtn, ym.emojiBtn, ym.torrentBtn, ym.fileBtn].filter(Boolean);
  for (const el of controls) {
    try { el.disabled = !canSend; } catch {}
  }
  if (ym.input) {
    const reason = String(p.block_reason || '').toLowerCase();
    if (!canSend) {
      if (reason.includes('read')) ym.input.placeholder = 'Room is read-only';
      else if (reason.includes('lock')) ym.input.placeholder = 'Room is locked';
      else ym.input.placeholder = 'Posting disabled';
    } else {
      ym.input.placeholder = 'Type a message…';
    }
  }
}

function upsertRoomPolicy(room, policy) {
  if (!room || !policy) return;
  const key = String(room);
  const prev = UIState.roomPolicy.get(key) || {};
  const merged = { ...prev, ...policy, room: key };
  UIState.roomPolicy.set(key, merged);

  if (UIState.roomEmbedRoom === key) {
    const pane = $('roomEmbed');
    if (pane) applyRoomPolicyToView(key, pane, merged);
  }

  const win = UIState.windows.get('room:' + key);
  if (win) applyRoomPolicyToView(key, win, merged);

  try { renderRooms(); } catch {}
}

function forceLeaveRoomUI(room, why) {
  const r = String(room || '');
  if (!r) return;

  if (UIState.roomEmbedRoom === r) {
    try { showRoomEmbed(null); } catch {}
    UIState.roomEmbedRoom = null;
  }

  try {
    const id = 'room:' + r;
    if (UIState.windows.has(id)) closeWindow(id);
  } catch {}

  if (UIState.currentRoom === r) {
    // If we were in room voice, leave it as well.
    try {
      if (VOICE_STATE?.room?.joined && VOICE_STATE.room.name === r) {
        voiceLeaveRoom("Removed", true);
      }
    } catch (e) {} 
    UIState.currentRoom = null;
    // Clear restore targets if we were removed from the active room.
    try {
      sessionStorage.removeItem("echochat_last_room");
      sessionStorage.removeItem("echochat_last_room_set_at");
      sessionStorage.removeItem("echochat_voice_room");
      sessionStorage.removeItem("echochat_voice_room_joined");
    } catch (e) {}
    const roomToJoin = $('roomToJoin');
    if (roomToJoin) roomToJoin.value = '';
    const ul = $('userList');
    if (ul) ul.innerHTML = '';
    setRoomUsersCount(0);
  }

  toast(`🚫 Removed from ${r}${why ? `: ${why}` : ''}`, 'warn', 5200);
}


function openRoomWindow(room) {
  const id = "room:" + room;
  const win = createWindow({ id, title: `Room — ${room}`, kind: "room" });
  if (!win) return;

  // Replace the default "Send" behavior with room send_message
  win._ym.send.onclick = () => {
    const msg = win._ym.input.value.trim();
    if (!msg) return;
    sendRoomTo(room, msg).then((res) => {
      if (res?.success) {
        // Don't append locally; we wait for server broadcast so we get message_id
        win._ym.input.value = "";
      } else {
        toast(`❌ ${res?.error || "Send failed"}`, "error");
      }
    });
  };

  // Add a one-time hint line
  appendLine(win, "System:", "You are now chatting in this room.");
  bringToFront(win);
  return win;
}

// When someone sends a room message:
socket.on("chat_message", async (payload) => {
  if (!payload) return;
  const room = payload.room || UIState.currentRoom;
  if (!room) return;

  // If this is an encrypted room envelope, try to decrypt for display.
  let msgForUi = payload.message;
  if (payload.cipher && typeof payload.cipher === "string" && payload.cipher.startsWith(ROOM_ENVELOPE_PREFIX)) {
    if (HAS_WEBCRYPTO && window.myPrivateCryptoKey) {
      try {
        msgForUi = await decryptRoomEnvelope(window.myPrivateCryptoKey, payload.cipher);
      } catch (e) {
        console.error(e);
        msgForUi = "🔒 Encrypted message";
      }
    } else {
      msgForUi = "🔒 Encrypted message (unlock to read)";
    }
    payload = { ...payload, message: msgForUi, encrypted: true };
  }

  const view = getActiveRoomView(room);
  if (!view) return;

  appendRoomMessage(view, { ...payload, room });

  const username = payload.username;
  const message = payload.message;
  // If message is not from me, show a toast
  if (username && username !== currentUser) {
    toast(`💬 ${username} in ${room}`, "info");
    maybeBrowserNotify("Room message", `${username}: ${message}`);
  }
});

// Reaction count updates for a message
socket.on("message_reactions", (payload) => {
  const room = payload?.room || UIState.currentRoom;
  const messageId = payload?.message_id;
  const counts = payload?.counts || {};
  if (!room || !messageId) return;

  const view = getActiveRoomView(room);
  if (!view) return;
  const msgEl = _findMsgEl(view, messageId);
  if (!msgEl) return;
  const rx = msgEl.querySelector(".msgReactions");
  _renderReactionPills(rx, counts);
});

// Room notifications (join/leave messages)
socket.on("notification", (payload) => {
  // payload can be {room, message} or sometimes string
  if (typeof payload === "string") {
    toast(payload, "info");
    return;
  }
  const room = payload?.room || null;
  const message = payload?.message || "";
  if (message) toast(message, "info");

  if (room && UIState.currentRoom === room) {
    const view = getActiveRoomView(room);
    if (view) appendLine(view, "System:", message);
    // Keep the right-dock "Users in current room" list fresh.
    // Server does not push roster updates except on request.
    getUsersInRoom(room);
  }
});

