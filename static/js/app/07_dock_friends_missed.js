// ───────────────────────────────────────────────────────────────────────────────
// Dock tabs + search
// ───────────────────────────────────────────────────────────────────────────────
function setActiveTab(tab) {
  UIState.activeTab = tab;
  if (tab === "groups") { try { refreshMyGroups(); refreshGroupInvites(); } catch (e) {} }

  ["friends", "groups"].forEach(t => {
    $("tab" + t[0].toUpperCase() + t.slice(1))?.classList.toggle("active", t === tab);
    $("panel" + t[0].toUpperCase() + t.slice(1))?.classList.toggle("hidden", t !== tab);
  });
}

function applyDockSearchFilter(query) {
  const q = (query || "").toLowerCase();
  // Only filter items that live inside the dock panels.
  // The in-room user list is rendered next to the embedded room chat.
  const lists = ["friendsList", "groupList"];
  lists.forEach(id => {
    const ul = $(id);
    if (!ul) return;
    [...ul.children].forEach(li => {
      const name = (li.dataset?.name || li.textContent || "").toLowerCase();
      li.style.display = name.includes(q) ? "" : "none";
    });
  });
}

function setRoomUsersCount(n) {
  const el = $("roomUsersCount");
  if (!el) return;
  const v = Number(n || 0);
  el.textContent = String(isFinite(v) ? v : 0);
}

// ───────────────────────────────────────────────────────────────────────────────
// Friends / Requests / Blocks
// ───────────────────────────────────────────────────────────────────────────────
function getFriends() {
  socket.emit("get_friends", {}, (res) => {
    if (res && Array.isArray(res.friends)) updateFriendsListUI(res.friends);
  });
}

function getPendingFriendRequests() {
  socket.emit("get_pending_friend_requests");
}

function getBlockedUsers() {
  socket.emit("get_blocked_users");
}

function addFriend() {
  const friend = $("friendUser")?.value.trim();
  if (!friend) return toast("⚠️ Enter a username", "warn");

  socket.emit("send_friend_request", { to_username: friend }, (res) => {
    if (res && res.success) {
      toast(`✅ Friend request sent to ${friend}`, "ok");
      $("friendUser").value = "";
      getPendingFriendRequests();
      getFriends();
    } else {
      toast(`❌ ${res?.error || "Failed to send request"}`, "error");
    }
  });
}

function updateFriendsListUI(friends) {
  const ul = $("friendsList");
  if (!ul) return;
  ul.innerHTML = "";

  if (!friends || friends.length === 0) {
    const li = document.createElement("li");
    li.dataset.name = "empty";
    li.innerHTML = `<div class="liLeft"><span class="presDot offline"></span><span class="liName muted">No friends yet</span></div>`;
    ul.appendChild(li);
    return;
  }

  friends.forEach(friend => {    const p = UIState.presence.get(friend);
    const online = (p && typeof p === "object") ? !!p.online : !!p;
    const presence = (p && typeof p === "object") ? (p.presence || (online ? "online" : "offline")) : (online ? "online" : "offline");
    const customStatus = (p && typeof p === "object") ? (p.custom_status || "") : "";

    const li = document.createElement("li");
    li.dataset.name = friend;

    const left = document.createElement("div");
    left.className = "liLeft";

    const dot = document.createElement("span");
    let dotState = "offline";
    if (online) {
      dotState = (presence === "busy") ? "busy" : ((presence === "away") ? "away" : "online");
    }
    dot.className = "presDot " + dotState;

    const name = document.createElement("span");
    name.className = "liName";
    name.textContent = friend;

    left.appendChild(dot);
    left.appendChild(name);

    if (customStatus) {
      const st = document.createElement("span");
      st.className = "liStatus";
      st.textContent = customStatus;
      left.appendChild(st);
    }

    const actions = document.createElement("div");
    actions.className = "liActions";

    const chatBtn = document.createElement("button");
    chatBtn.className = "iconBtn";
    chatBtn.title = "Chat";
    chatBtn.textContent = "💬";
    chatBtn.onclick = () => openPrivateChat(friend);

    const blockBtn = document.createElement("button");
    blockBtn.className = "iconBtn";
    blockBtn.title = "Block";
    blockBtn.textContent = "🚫";
    blockBtn.onclick = () => socket.emit("block_user", { username: friend }, (res) => {
      toast(res?.success ? `🚫 Blocked ${friend}` : `❌ Block failed`, res?.success ? "ok" : "error");
      getBlockedUsers();
    });

    actions.appendChild(chatBtn);
    actions.appendChild(blockBtn);

    li.appendChild(left);
    li.appendChild(actions);

    // Classic behavior: double-click opens chat window
    li.ondblclick = () => openPrivateChat(friend);

    ul.appendChild(li);
  });

  // Keep missed list dots in sync with presence updates.
  renderMissedPmList(UIState.missedPmSummary);
}

// ───────────────────────────────────────────────────────────────────────────────
// Missed (offline) PM notifications
// - Only counts messages received while you were offline.
// - Clicking an item opens the DM window and pulls all currently missed PMs
//   from that sender (ciphertext-only from the server).
// ───────────────────────────────────────────────────────────────────────────────
let MISSED_SUMMARY_TOAST_ARMED = false;

function renderMissedPmList(items) {
  const ul = $("missedPmList");
  if (!ul) return;
  ul.innerHTML = "";

  const list = Array.isArray(items) ? items : [];
  if (!list.length) {
    const li = document.createElement("li");
    li.dataset.name = "empty";
    li.innerHTML = `<div class="liLeft"><span class="presDot offline"></span><span class="liName muted">No missed messages</span></div>`;
    ul.appendChild(li);
    return;
  }

  for (const it of list) {
    const sender = it?.sender;
    const count = Number(it?.count ?? 0) || 0;
    if (!sender || count <= 0) continue;

    const p = UIState.presence.get(sender);
    const online = (p && typeof p === "object") ? !!p.online : !!p;
    const presence = (p && typeof p === "object") ? (p.presence || (online ? "online" : "offline")) : (online ? "online" : "offline");

    const li = document.createElement("li");
    li.dataset.name = sender;

    const left = document.createElement("div");
    left.className = "liLeft";

    const dot = document.createElement("span");
    let dotState = "offline";
    if (online) {
      dotState = (presence === "busy") ? "busy" : ((presence === "away") ? "away" : "online");
    }
    dot.className = "presDot " + dotState;

    const name = document.createElement("span");
    name.className = "liName";
    name.textContent = sender;

    const badge = document.createElement("span");
    badge.className = "liBadge";
    badge.textContent = String(count);

    left.appendChild(dot);
    left.appendChild(name);
    li.appendChild(left);
    li.appendChild(badge);

    li.onclick = () => openMissedPmFrom(sender);
    li.ondblclick = () => openMissedPmFrom(sender);

    ul.appendChild(li);
  }
}

async function openMissedPmFrom(sender) {
  if (!sender) return;

  const win = openPrivateChat(sender) || UIState.windows.get("dm:" + sender);
  const w = UIState.windows.get("dm:" + sender);
  if (w) ensureDmHistoryRendered(w, sender);

  // Peek first so we don't consume anything we can't decrypt/render.
  const res = await new Promise((resolve) => {
    socket.emit("fetch_offline_pms", { from_user: sender, peek: true }, (r) => resolve(r));
  });

  if (!res || !res.success) {
    toast(`❌ ${res?.error || "Failed to load missed messages"}`, "error");
    return;
  }

  const msgs = Array.isArray(res.messages) ? res.messages : [];
  if (!msgs.length) {
    toast(`No missed messages from ${sender}`, "info");
    return;
  }

  let privKey = null;
  let processed = 0;
  let failed = 0;
  const ackIds = [];

  for (const m of msgs) {
    const cipher = m?.cipher;
    const msgId = m?.id;
    const ts = (typeof m?.ts === "number") ? m.ts : null;
    if (!cipher || !msgId) continue;

    try {
      let plaintext;

      if (typeof cipher === "string" && cipher.startsWith(PM_PLAINTEXT_PREFIX)) {
        plaintext = unwrapPlainDm(cipher);
      } else {
        // Encrypted — need private key unlocked.
        if (!privKey) privKey = await ensurePrivateKeyUnlocked();
        if (typeof cipher === "string" && cipher.startsWith(PM_ENVELOPE_PREFIX)) {
          plaintext = await decryptHybridEnvelope(privKey, cipher);
        } else {
          plaintext = await decryptLegacyRSA(privKey, cipher);
        }
      }

      const payload = parseDmPayload(plaintext);
      const ww = UIState.windows.get("dm:" + sender);
      if (ww) appendDmPayload(ww, `${sender}:`, payload, { peer: sender, direction: "in" });

      const histText = (payload.kind === "file")
        ? `📎 ${payload.name} (${humanBytes(payload.size)})`
        : (payload.kind === "torrent")
          ? `🧲 ${payload?.t?.name || payload?.t?.infohash || "Torrent"}`
          : payload.text;

      addPmHistory(sender, "in", histText, ts);
      processed += 1;
      ackIds.push(msgId);
    } catch (e) {
      failed += 1;
      console.warn("Missed PM decrypt failed", e);
    }
  }

  // Ack only messages we actually processed.
  if (ackIds.length) {
    await new Promise((resolve) => {
      socket.emit("ack_offline_pms", { ids: ackIds }, () => resolve(true));
    });
  }

  if (processed) toast(`📥 Loaded ${processed} missed PM(s) from ${sender}`, "ok");
  if (failed) toast(`⚠️ ${failed} missed PM(s) could not be decrypted yet`, "warn", 4200);
}


socket.on("pending_friend_requests", (requests) => {
  const ul = $("pendingRequestsList");
  if (!ul) return;
  ul.innerHTML = "";

  if (!requests || requests.length === 0) {
    const li = document.createElement("li");
    li.dataset.name = "none";
    li.innerHTML = `<div class="liLeft"><span class="presDot offline"></span><span class="liName muted">None</span></div>`;
    ul.appendChild(li);
    return;
  }

  requests.forEach(from_user => {
    const li = document.createElement("li");
    li.dataset.name = from_user;

    const left = document.createElement("div");
    left.className = "liLeft";
    left.innerHTML = `<span class="presDot offline"></span><span class="liName">${escapeHtml(from_user)}</span>`;

    const actions = document.createElement("div");
    actions.className = "liActions";

    const yes = document.createElement("button");
    yes.className = "iconBtn";
    yes.textContent = "✅";
    yes.title = "Accept";
    yes.onclick = () => socket.emit("accept_friend_request", { from_user }, (res) => {
      if (res?.success) toast("✅ Friend request accepted", "ok");
      else toast("❌ Could not accept request", "error");
      getPendingFriendRequests();
      getFriends();
    });

    const no = document.createElement("button");
    no.className = "iconBtn";
    no.textContent = "✖";
    no.title = "Reject";
    no.onclick = () => socket.emit("reject_friend_request", { from_user }, (res) => {
      if (res?.success) toast("Rejected", "warn");
      else toast("❌ Could not reject request", "error");
      getPendingFriendRequests();
    });

    actions.appendChild(yes);
    actions.appendChild(no);

    li.appendChild(left);
    li.appendChild(actions);

    ul.appendChild(li);
  });
});

socket.on("blocked_users_list", (users) => {
  const ul = $("blockedUsersList");
  if (!ul) return;
  ul.innerHTML = "";

  if (!users || users.length === 0) {
    const li = document.createElement("li");
    li.dataset.name = "none";
    li.innerHTML = `<div class="liLeft"><span class="presDot offline"></span><span class="liName muted">None</span></div>`;
    ul.appendChild(li);
    return;
  }

  users.forEach(u => {
    const li = document.createElement("li");
    li.dataset.name = u;

    const left = document.createElement("div");
    left.className = "liLeft";
    left.innerHTML = `<span class="presDot busy"></span><span class="liName">${escapeHtml(u)}</span>`;

    const actions = document.createElement("div");
    actions.className = "liActions";

    const unblock = document.createElement("button");
    unblock.className = "iconBtn";
    unblock.textContent = "↩";
    unblock.title = "Unblock";
    unblock.onclick = () => socket.emit("unblock_user", { username: u }, (res) => {
      toast(res?.success ? `Unblocked ${u}` : "❌ Unblock failed", res?.success ? "ok" : "error");
      getBlockedUsers();
    });

    actions.appendChild(unblock);

    li.appendChild(left);
    li.appendChild(actions);
    ul.appendChild(li);
  });
});

// Presence updates (server addition; falls back gracefully if not present)
socket.on("friends_presence", (payload) => {
  if (!payload || !Array.isArray(payload)) return;
  UIState.presence.clear();
  payload.forEach((row) => {
    if (!row) return;
    if (typeof row === "string") {
      UIState.presence.set(row, { online: false, presence: "offline", custom_status: "", last_seen: null });
      return;
    }
    if (!row.username) return;
    const online = !!row.online;
    const presence = row.presence || (online ? "online" : "offline");
    const custom_status = row.custom_status || "";
    const last_seen = row.last_seen || null;
    UIState.presence.set(row.username, { online, presence, custom_status, last_seen });
  });
  // Refresh UI using the current list if available
  getFriends();
});

socket.on("friend_presence_update", (p) => {
  if (!p || !p.username) return;
  const online = !!p.online;
  const presence = p.presence || (online ? "online" : "offline");
  const custom_status = p.custom_status || "";
  const last_seen = p.last_seen || null;
  UIState.presence.set(p.username, { online, presence, custom_status, last_seen });
  getFriends();
});

socket.on("my_presence", (p) => {
  if (!p) return;
  const sel = $("meStatus");
  if (sel && p.presence) sel.value = p.presence;
  const inp = $("meCustomStatus");
  if (inp) inp.value = (p.custom_status || "");
});

