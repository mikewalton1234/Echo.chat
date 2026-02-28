// ───────────────────────────────────────────────────────────────────────────────
// Groups (HTTP endpoints + Socket.IO group room join)
// ───────────────────────────────────────────────────────────────────────────────
async function apiJson(url, opts = {}) {
  const resp = await fetchWithAuth(url, {
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
    ...opts,
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(data?.error || data?.msg || "Request failed");
  return data;
}

async function refreshMyGroups() {
  const ul = $("groupList");
  if (!ul) return;
  ul.innerHTML = "";

  try {
    const data = await apiJson("/api/groups/mine", { method: "GET" });
    const groups = data.groups || [];
    if (groups.length === 0) {
      const li = document.createElement("li");
      li.dataset.name = "none";
      li.innerHTML = `<div class="liLeft"><span class="presDot offline"></span><span class="liName muted">No groups yet</span></div>`;
      ul.appendChild(li);
      return;
    }

    groups.forEach(g => {
      const li = document.createElement("li");
      li.dataset.name = g.group_name || String(g.id);

      const left = document.createElement("div");
      left.className = "liLeft";
      left.innerHTML = `<span class="presDot offline"></span><span class="liName">${escapeHtml(g.group_name)} <span class="muted">(#${g.id})</span></span>`;

      const actions = document.createElement("div");
      actions.className = "liActions";

      const openBtn = document.createElement("button");
      openBtn.className = "iconBtn";
      openBtn.textContent = "💬";
      openBtn.title = "Open";
      openBtn.onclick = () => openGroupWindow(String(g.id), g.group_name);

      const inviteBtn = document.createElement("button");
      inviteBtn.className = "iconBtn";
      inviteBtn.textContent = "➕";
      inviteBtn.title = "Invite user";
      inviteBtn.onclick = async () => {
        const u = prompt("Invite which username?");
        if (!u) return;
        try {
          await apiJson(`/api/groups/${encodeURIComponent(g.id)}/invite`, { method: "POST", body: JSON.stringify({ to_user: u.trim() }) });
          toast("✅ Invite sent", "ok");
          await refreshGroupInvites();
        } catch (e) {
          toast(`❌ ${e.message}`, "error");
        }
      };

      const leaveBtn = document.createElement("button");
      leaveBtn.className = "iconBtn";
      leaveBtn.textContent = "🚪";
      leaveBtn.title = "Leave group";
      leaveBtn.onclick = async () => {
        if (!confirm(`Leave group "${g.group_name}"?`)) return;
        try {
          await apiJson(`/api/groups/${encodeURIComponent(g.id)}/leave`, { method: "POST", body: JSON.stringify({}) });
          toast("Left group", "info");
          await refreshMyGroups();
        } catch (e) {
          toast(`❌ ${e.message}`, "error");
        }
      };

      actions.appendChild(openBtn);
      actions.appendChild(inviteBtn);
      actions.appendChild(leaveBtn);

      li.appendChild(left);
      li.appendChild(actions);
      li.ondblclick = () => openGroupWindow(String(g.id), g.group_name);

      ul.appendChild(li);
    });
  } catch (e) {
    console.error(e);
    const li = document.createElement("li");
    li.dataset.name = "error";
    li.innerHTML = `<div class="liLeft"><span class="presDot busy"></span><span class="liName muted">Could not load groups</span></div>`;
    ul.appendChild(li);
  }
}

async function refreshGroupInvites() {
  const ul = $("groupInviteList");
  if (!ul) return;
  ul.innerHTML = "";

  try {
    const data = await apiJson("/api/groups/invites", { method: "GET" });
    const invites = data.invites || [];
    if (invites.length === 0) {
      const li = document.createElement("li");
      li.dataset.name = "none";
      li.innerHTML = `<div class="liLeft"><span class="presDot offline"></span><span class="liName muted">No invites</span></div>`;
      ul.appendChild(li);
      return;
    }

    invites.forEach(inv => {
      const li = document.createElement("li");
      li.dataset.name = `${inv.group_name || inv.group_id}`;

      const left = document.createElement("div");
      left.className = "liLeft";
      left.innerHTML = `<span class="presDot offline"></span><span class="liName">${escapeHtml(inv.group_name)} <span class="muted">(#${inv.group_id})</span></span>`;

      const actions = document.createElement("div");
      actions.className = "liActions";

      const from = document.createElement("span");
      from.className = "muted";
      from.textContent = ` from ${inv.from_user}`;
      left.appendChild(from);

      const acceptBtn = document.createElement("button");
      acceptBtn.className = "iconBtn";
      acceptBtn.textContent = "✅";
      acceptBtn.title = "Accept";
      acceptBtn.onclick = async () => {
        try {
          await apiJson(`/api/groups/${encodeURIComponent(inv.group_id)}/accept`, { method: "POST", body: JSON.stringify({}) });
          toast("✅ Joined group", "ok");
          await refreshGroupInvites();
          await refreshMyGroups();
        } catch (e) {
          toast(`❌ ${e.message}`, "error");
        }
      };

      const declineBtn = document.createElement("button");
      declineBtn.className = "iconBtn";
      declineBtn.textContent = "❌";
      declineBtn.title = "Decline";
      declineBtn.onclick = async () => {
        try {
          await apiJson(`/api/groups/${encodeURIComponent(inv.group_id)}/decline`, { method: "POST", body: JSON.stringify({}) });
          toast("Declined", "info");
          await refreshGroupInvites();
        } catch (e) {
          toast(`❌ ${e.message}`, "error");
        }
      };

      actions.appendChild(acceptBtn);
      actions.appendChild(declineBtn);

      li.appendChild(left);
      li.appendChild(actions);
      ul.appendChild(li);
    });
  } catch (e) {
    toast(`❌ ${e.message}`, "error");
  }
}


async function createGroup() {
  const name = $("groupCreateName")?.value.trim();
  if (!name) return toast("⚠️ Enter a group name", "warn");

  try {
    const res = await apiJson("/api/groups", { method: "POST", body: JSON.stringify({ name }) });
    toast(`✅ Group created (#${res.group_id})`, "ok");
    $("groupCreateName").value = "";
    await refreshMyGroups();
  } catch (e) {
    toast(`❌ ${e.message}`, "error");
  }
}

async function joinGroupById() {
  const id = $("groupJoinId")?.value.trim();
  if (!id) return toast("⚠️ Enter invite group ID", "warn");

  try {
    await apiJson(`/api/groups/${encodeURIComponent(id)}/join`, { method: "POST", body: JSON.stringify({}) });
    toast(`✅ Joined group #${id}`, "ok");
    $("groupJoinId").value = "";
    await refreshMyGroups();
  } catch (e) {
    toast(`❌ ${e.message}`, "error");
  }
}


// ───────────────────────────────────────────────────────────────────────────────
// Group history pagination (Load older)
// ───────────────────────────────────────────────────────────────────────────────
const GROUP_HISTORY_PAGE_SIZE = 200;

function groupMsgId(m) {
  const v = (m && (m.message_id ?? m.messageId ?? m.id)) ?? null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function groupHistState(win) {
  if (!win) return { oldestId: null, loading: false, done: true };
  if (!win._groupHist) win._groupHist = { oldestId: null, loading: false, done: false };
  return win._groupHist;
}

function updateGroupOlderUI(win) {
  const st = groupHistState(win);
  const btn = win?._ym?.groupOlderBtn;
  const hint = win?._ym?.groupOlderHint;
  if (!btn) return;
  btn.disabled = !!st.loading || !!st.done || !st.oldestId;
  if (hint) hint.textContent = st.loading ? "Loading…" : (st.done ? "No more" : "Older");
}

function ensureGroupHistoryToolbar(win, groupId) {
  if (!win || !win._ym?.log) return;
  if (win._ym.groupOlderBtn) return;

  const body = win.querySelector('.ym-body');
  if (!body) return;

  const bar = document.createElement('div');
  bar.className = 'ym-toolbar ym-groupToolbar';

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'ym-toolBtn';
  btn.title = 'Load older messages';
  btn.textContent = '⬆';

  const hint = document.createElement('span');
  hint.className = 'ym-toolHint';
  hint.textContent = 'Older';

  bar.appendChild(btn);
  bar.appendChild(hint);

  body.insertBefore(bar, win._ym.log);

  win._ym.groupOlderBtn = btn;
  win._ym.groupOlderHint = hint;
  btn.onclick = () => loadOlderGroupHistory(win, groupId);

  updateGroupOlderUI(win);
}

async function groupHistoryItemToText(m) {
  const isEnc = !!m?.is_encrypted || m?.is_encrypted === 1 || m?.is_encrypted === true;
  const cipher = (m && typeof m.cipher === 'string') ? m.cipher : null;
  let msgForUi = String(m?.message ?? '');

  const candidate = cipher || msgForUi;
  if (candidate && typeof candidate === 'string' && candidate.startsWith(GROUP_ENVELOPE_PREFIX)) {
    if (HAS_WEBCRYPTO && window.myPrivateCryptoKey) {
      try {
        msgForUi = await decryptGroupEnvelope(window.myPrivateCryptoKey, candidate);
      } catch (e) {
        console.error(e);
        msgForUi = '🔒 Encrypted message';
      }
    } else {
      msgForUi = '🔒 Encrypted message (unlock to read)';
    }
  } else if (isEnc && !cipher) {
    msgForUi = '🔒 Encrypted message';
  }
  return msgForUi;
}

function makeYmLine(who, text) {
  const line = document.createElement('div');
  line.className = 'ym-line';
  const tag = document.createElement('span');
  tag.className = 'tag';
  tag.textContent = who;
  line.appendChild(tag);
  line.appendChild(document.createTextNode(' ' + text));
  return line;
}

async function appendGroupHistory(win, hist) {
  const log = win?._ym?.log;
  if (!log) return;
  const id = String(win?._ym?.id || "");
  const gid = id.startsWith("group:") ? Number(id.split(":")[1]) : null;

  for (const m of (hist || [])) {
    const sender = String(m?.sender || "?");
    const msgForUi = await groupHistoryItemToText(m);

    let parsed = null;
    if (typeof msgForUi === "string") {
      const s = msgForUi.trim();
      if (s.startsWith("{") && s.endsWith("}")) {
        try { parsed = JSON.parse(s); } catch { parsed = null; }
      }
    }

    if (parsed && typeof parsed === "object" && parsed.kind === "file" && parsed.file_id) {
      if (!parsed.group_id && gid) parsed.group_id = gid;
      log.appendChild(makeFileLineElement(`${sender}:`, parsed, { peer: gid ? `group:${gid}` : null, direction: "in" }));
    } else {
      log.appendChild(makeYmLine(`${sender}:`, msgForUi));
    }
  }
}

async function insertGroupHistoryAtTop(win, hist) {
  const log = win?._ym?.log;
  if (!log) return;

  const id = String(win?._ym?.id || "");
  const gid = id.startsWith("group:") ? Number(id.split(":")[1]) : null;

  const beforeH = log.scrollHeight;
  const beforeTop = log.scrollTop;

  const frag = document.createDocumentFragment();
  for (const m of (hist || [])) {
    const sender = String(m?.sender || "?");
    const msgForUi = await groupHistoryItemToText(m);

    let parsed = null;
    if (typeof msgForUi === "string") {
      const s = msgForUi.trim();
      if (s.startsWith("{") && s.endsWith("}")) {
        try { parsed = JSON.parse(s); } catch { parsed = null; }
      }
    }

    if (parsed && typeof parsed === "object" && parsed.kind === "file" && parsed.file_id) {
      if (!parsed.group_id && gid) parsed.group_id = gid;
      frag.appendChild(makeFileLineElement(`${sender}:`, parsed, { peer: gid ? `group:${gid}` : null, direction: "in" }));
    } else {
      frag.appendChild(makeYmLine(`${sender}:`, msgForUi));
    }
  }

  log.insertBefore(frag, log.firstChild);

  const afterH = log.scrollHeight;
  log.scrollTop = beforeTop + (afterH - beforeH);
}

function updateOldestId(win, hist) {
  const st = groupHistState(win);
  const ids = (hist || []).map(groupMsgId).filter((x) => x !== null);
  if (ids.length) {
    const minId = Math.min(...ids);
    st.oldestId = (st.oldestId === null || st.oldestId === undefined) ? minId : Math.min(st.oldestId, minId);
  }
}

function loadOlderGroupHistory(win, groupId) {
  const st = groupHistState(win);
  if (st.loading || st.done) return;
  if (!st.oldestId) {
    st.done = true;
    updateGroupOlderUI(win);
    return;
  }

  st.loading = true;
  updateGroupOlderUI(win);

  socket.emit('get_group_history', { group_id: Number(groupId), before_id: st.oldestId, limit: GROUP_HISTORY_PAGE_SIZE }, async (res) => {
    st.loading = false;
    if (!res?.success) {
      updateGroupOlderUI(win);
      toast('❌ Could not load older messages', 'error');
      return;
    }

    const hist = Array.isArray(res.history) ? res.history : [];
    if (!hist.length) {
      st.done = true;
      updateGroupOlderUI(win);
      return;
    }

    await insertGroupHistoryAtTop(win, hist);
    updateOldestId(win, hist);
    if (hist.length < GROUP_HISTORY_PAGE_SIZE) st.done = true;
    updateGroupOlderUI(win);
  });
}

function openGroupWindow(groupId, title) {
  const id = "group:" + groupId;
  const win = createWindow({ id, title: `Group — ${title} (#${groupId})`, kind: "group" });
  if (!win) return;

  // Group: add history toolbar + paging state
  ensureGroupHistoryToolbar(win, groupId);
  const _gst = groupHistState(win);
  _gst.loading = false;
  _gst.done = false;
  updateGroupOlderUI(win);

  // Join Socket.IO room for group chat
  socket.emit("join_group_chat", { group_id: groupId }, (res) => {
    if (res?.success) {
      if (Array.isArray(res.members)) UIState.groupMembers.set(Number(groupId), res.members);

      // Render history (ciphertext-only safe). If history exists, replace the
      // default "Window opened" line to avoid clutter.
      const hist = Array.isArray(res.history) ? res.history : [];
      if (win._ym?.log && hist.length) {
        win._ym.log.innerHTML = "";
        (async () => {
          await appendGroupHistory(win, hist);
          const st = groupHistState(win);
          st.done = false;
          updateOldestId(win, hist);
          if (hist.length < GROUP_HISTORY_PAGE_SIZE) st.done = true;
          updateGroupOlderUI(win);
          appendLine(win, "System:", "Joined group chat.");
        })();
      } else {
        const st = groupHistState(win);
        st.oldestId = null;
        st.done = true;
        updateGroupOlderUI(win);
        appendLine(win, "System:", "Joined group chat.");
      }
    }
  });

  win._ym.send.onclick = () => {
    const msg = win._ym.input.value.trim();
    if (!msg) return;

    sendGroupTo(groupId, msg).then((res) => {
      if (res?.success) {
        appendLine(win, "You:", msg);
        win._ym.input.value = "";
      } else {
        toast("❌ Group send failed", "error");
      }
    }).catch((e) => {
      console.error(e);
      toast(`❌ Group send failed: ${e?.message || e}`, "error");
    });
  };


  // Group GIF button (send without polluting the input field)
  if (win._ym?.gifBtn) {
    win._ym.gifBtn.onclick = () => {
      openGifPicker((url) => {
        const clean = _gifFallbackUrl(url) || url;
          const msg = `gif:${clean}`;
        sendGroupTo(groupId, msg).then((res) => {
          if (res?.success) {
            appendLine(win, "You:", msg);
          } else {
            toast(`❌ ${res?.error || "Group GIF send failed"}`, "error");
          }
        }).catch((e) => {
          console.error(e);
          toast(`❌ Group GIF send failed: ${e?.message || e}`, "error");
        });
      });
    };
  }

  // Group file button (E2EE + server ciphertext storage)
  if (win._ym?.fileBtn && win._ym?.fileInput) {
    win._ym.fileBtn.onclick = () => win._ym.fileInput.click();
    win._ym.fileInput.onchange = async () => {
      try {
        const f = win._ym.fileInput.files?.[0];
        win._ym.fileInput.value = "";
        if (!f) return;

        const payload = await sendGroupFileTo(groupId, f, { win });
        if (payload) {
          appendDmPayload(win, "You:", payload, { peer: `group:${groupId}`, direction: "out" });
        }
      } catch (e) {
        console.error(e);
        toast(`❌ Group file send failed: ${e?.message || e}`, "error");
      }
    };
  }

  bringToFront(win);
  return win;
}

socket.on("group_message", async (payload) => {
  if (!payload) return;
  const group_id = payload.group_id;
  const sender = payload.sender;
  const win = UIState.windows.get("group:" + String(group_id));
  if (!win) return;

  let msgForUi = payload.message;

  const cipher = payload.cipher || payload.message;
  if (cipher && typeof cipher === "string" && cipher.startsWith(GROUP_ENVELOPE_PREFIX)) {
    if (HAS_WEBCRYPTO && window.myPrivateCryptoKey) {
      try {
        msgForUi = await decryptGroupEnvelope(window.myPrivateCryptoKey, cipher);
      } catch (e) {
        console.error(e);
        msgForUi = "🔒 Encrypted message";
      }
    } else {
      msgForUi = "🔒 Encrypted message (unlock to read)";
    }
  }

  let parsed = null;
  if (typeof msgForUi === "string") {
    const s = msgForUi.trim();
    if (s.startsWith("{") && s.endsWith("}")) {
      try { parsed = JSON.parse(s); } catch { parsed = null; }
    }
  }

  if (parsed && typeof parsed === "object" && parsed.kind === "file" && parsed.file_id) {
    if (!parsed.group_id) parsed.group_id = Number(group_id);
    appendDmPayload(win, `${sender}:`, parsed, { peer: `group:${group_id}`, direction: "in" });
  } else if (parsed && typeof parsed === "object" && parsed.kind === "torrent") {
    appendDmPayload(win, `${sender}:`, parsed, { peer: `group:${group_id}`, direction: "in" });
  } else {
    appendLine(win, `${sender}:`, msgForUi);
  }

  if (sender && sender !== currentUser) {
    const notifText = (parsed && parsed.kind === "file")
      ? `📎 ${parsed?.name || "file"}`
      : (parsed && parsed.kind === "torrent")
        ? "🧲 Torrent"
        : `${msgForUi}`;
    toast(`👥 ${sender} in group #${group_id}`, "info");
    maybeBrowserNotify("Group message", `${sender}: ${notifText}`);
  }
});

