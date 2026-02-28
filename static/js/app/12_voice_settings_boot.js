// ───────────────────────────────────────────────────────────────────────────────
// Voice events (WebRTC audio)
// ───────────────────────────────────────────────────────────────────────────────
socket.on("voice_dm_invite", ({ sender, call_id }) => {
  if (!VOICE_ENABLED) return;
  if (!sender || !call_id) return;
  openPrivateChat(sender);
  VOICE_STATE.dmCalls.set(sender, { call_id, peer: sender, pc: null, remoteEl: null, state: "incoming", muted: false, isCaller: false });
  voiceDmUi(sender, { statusText: `Incoming call from ${sender}`, mode: "incoming" });
  toast(`🎤 Incoming voice call from ${sender}`, "info");
  maybeBrowserNotify("Voice call", `Incoming call from ${sender}`);
});

socket.on("voice_dm_accept", async ({ sender, call_id }) => {
  const peer = sender;
  const call = VOICE_STATE.dmCalls.get(peer);
  if (!call || call.call_id !== call_id || !call.isCaller) return;
  try {
    voiceDmUi(peer, { statusText: "Connecting…", mode: "calling" });
    const pc = call.pc;
    if (!pc) return;
    const offer = await pc.createOffer({ offerToReceiveAudio: true });
    await pc.setLocalDescription(offer);
    socket.emit("voice_dm_offer", { to: peer, call_id, offer: pc.localDescription });
  } catch (e) {
    console.error(e);
    voiceDmCleanup(peer, e?.message || "Offer failed");
  }
});

socket.on("voice_dm_decline", ({ sender, call_id, reason }) => {
  const peer = sender;
  const call = VOICE_STATE.dmCalls.get(peer);
  if (!call || call.call_id !== call_id) return;
  voiceDmCleanup(peer, reason || "Declined");
  toast(`🎤 Call declined by ${peer}`, "warn");
});

socket.on("voice_dm_end", ({ sender, call_id, reason }) => {
  const peer = sender;
  const call = VOICE_STATE.dmCalls.get(peer);
  if (!call || call.call_id !== call_id) return;
  voiceDmCleanup(peer, reason || "Ended");
  toast(`🎤 Call ended (${peer})`, "info");
});

socket.on("voice_dm_offer", async ({ sender, call_id, offer }) => {
  const peer = sender;
  const call = VOICE_STATE.dmCalls.get(peer);
  if (!call || call.call_id !== call_id) return;
  try {
    if (!call.pc) {
      // If user accepted, pc exists. If they didn't, auto-decline.
      voiceDeclineDmCall(peer, "Not accepted");
      return;
    }
    await call.pc.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await call.pc.createAnswer();
    await call.pc.setLocalDescription(answer);
    socket.emit("voice_dm_answer", { to: peer, call_id, answer: call.pc.localDescription });
    call.state = "active";
    voiceDmUi(peer, { statusText: "Connected", mode: "active", muteLabel: "Mute" });
  } catch (e) {
    console.error(e);
    voiceDmCleanup(peer, e?.message || "Offer handling failed");
  }
});

socket.on("voice_dm_answer", async ({ sender, call_id, answer }) => {
  const peer = sender;
  const call = VOICE_STATE.dmCalls.get(peer);
  if (!call || call.call_id !== call_id) return;
  try {
    await call.pc.setRemoteDescription(new RTCSessionDescription(answer));
    call.state = "active";
    voiceDmUi(peer, { statusText: "Connected", mode: "active", muteLabel: VOICE_STATE.micMuted ? "Unmute" : "Mute" });
  } catch (e) {
    console.error(e);
    voiceDmCleanup(peer, e?.message || "Answer failed");
  }
});

socket.on("voice_dm_ice", async ({ sender, call_id, candidate }) => {
  const peer = sender;
  const call = VOICE_STATE.dmCalls.get(peer);
  if (!call || call.call_id !== call_id || !call.pc || !candidate) return;
  try { await call.pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch {}
});

// Room voice roster + signaling
socket.on("voice_room_roster", ({ room, users, limit }) => {
  if (!VOICE_ENABLED) return;
  if (!VOICE_STATE.room.joined || VOICE_STATE.room.name !== room) return;
  const roster = Array.isArray(users) ? users : [];
  const limN = (limit !== undefined && limit !== null) ? Number(limit) : VOICE_MAX_ROOM_PEERS;
  const limText = (Number.isFinite(limN) && limN > 0) ? String(limN) : "∞";
  voiceRoomUi({ show: true, statusText: `Voice connected (${roster.length}/${limText})`, joinVisible: false, leaveVisible: false, muteVisible: false });
    voiceUpdateRoomVoiceButton();
  for (const p of roster) {
    if (!p || p === currentUser) continue;
    voiceRoomEnsurePeer(room, p);
  }
});

socket.on("voice_room_user_joined", ({ room, username }) => {
  if (!VOICE_ENABLED) return;
  if (!VOICE_STATE.room.joined || VOICE_STATE.room.name !== room) return;
  if (!username || username === currentUser) return;
  voiceRoomEnsurePeer(room, username);
  voiceRoomUi({ show: true, joinVisible: false, leaveVisible: true, muteVisible: true });
});

socket.on("voice_room_user_left", ({ room, username }) => {
  if (!VOICE_ENABLED) return;
  if (!VOICE_STATE.room.joined || VOICE_STATE.room.name !== room) return;
  if (!username) return;
  const obj = VOICE_STATE.room.peers.get(username);
  if (obj) {
    try { obj.pc?.close(); } catch {}
    try { obj.remoteEl?.remove(); } catch {}
    VOICE_STATE.room.peers.delete(username);
  }
});

// Server can forcibly disconnect users from voice when an admin lowers the room voice limit.
socket.on("voice_room_forced_leave", ({ room, reason, limit }) => {
  if (!VOICE_ENABLED) return;
  if (!VOICE_STATE.room.joined || VOICE_STATE.room.name !== room) return;
  const r = (reason ? String(reason) : "").trim();
  const lim = (limit === undefined || limit === null) ? null : Number(limit);
  const limText = (lim && Number.isFinite(lim) && lim > 0) ? ` (limit=${lim})` : "";
  toast(`🎤 Disconnected from voice${limText}${r ? ": " + r : ""}`, "warn");
  // Server already updated its roster; do not emit voice_room_leave again.
  voiceLeaveRoom(r ? `Disconnected: ${r}` : "Disconnected", false);
});

socket.on("voice_room_offer", async ({ room, sender, offer }) => {
  if (!VOICE_ENABLED) return;
  if (!VOICE_STATE.room.joined || VOICE_STATE.room.name !== room) return;
  const peer = sender;
  if (!peer || peer === currentUser) return;
  voiceRoomEnsurePeer(room, peer);
  const obj = VOICE_STATE.room.peers.get(peer);
  if (!obj || !obj.pc) return;
  try {
    await obj.pc.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await obj.pc.createAnswer();
    await obj.pc.setLocalDescription(answer);
    socket.emit("voice_room_answer", { room, to: peer, answer: obj.pc.localDescription });
  } catch (e) {
    console.warn("voice room offer failed", e);
  }
});

socket.on("voice_room_answer", async ({ room, sender, answer }) => {
  if (!VOICE_ENABLED) return;
  if (!VOICE_STATE.room.joined || VOICE_STATE.room.name !== room) return;
  const peer = sender;
  const obj = VOICE_STATE.room.peers.get(peer);
  if (!obj || !obj.pc) return;
  try { await obj.pc.setRemoteDescription(new RTCSessionDescription(answer)); } catch {}
});

socket.on("voice_room_ice", async ({ room, sender, candidate }) => {
  if (!VOICE_ENABLED) return;
  if (!VOICE_STATE.room.joined || VOICE_STATE.room.name !== room) return;
  const peer = sender;
  const obj = VOICE_STATE.room.peers.get(peer);
  if (!obj || !obj.pc || !candidate) return;
  try { await obj.pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch {}
});

// ───────────────────────────────────────────────────────────────────────────────
// Settings modal
// ───────────────────────────────────────────────────────────────────────────────
function openSettings() {
  const modal = $("settingsModal");
  if (!modal) return;

  $("setDarkMode").checked = !!UIState.prefs.darkMode;
  const at = $("setAccentTheme");
  if (at) at.value = String(UIState.prefs.accentTheme || "default");
  $("setPopupNotif").checked = !!UIState.prefs.popupNotif;
  $("setSoundNotif").checked = !!UIState.prefs.soundNotif;

  const mt = $("setMissedToast");
  if (mt) mt.checked = !!UIState.prefs.missedToast;
  const sp = $("setSavePmLocal");
  if (sp) sp.checked = !!UIState.prefs.savePmLocal;

  const slider = $("setRoomFontSize");
  if (slider) {
    // Populate + preview current setting
    slider.value = String(UIState.prefs.roomFontSize ?? 12);
    applyRoomFontSize(slider.value);
    // Track what to revert to if the user closes without saving.
    modal.dataset.prevRoomFontSize = String(UIState.prefs.roomFontSize ?? 12);
  }

  modal.classList.remove("hidden");
}

function closeSettings() {
  // If user closes without saving, revert any live preview.
  const modal = $("settingsModal");
  const prev = modal?.dataset?.prevRoomFontSize;
  if (prev) applyRoomFontSize(prev);
  $("settingsModal")?.classList.add("hidden");
}

async function requestNotifPermissionIfNeeded() {
  if (!("Notification" in window)) return;
  if (Notification.permission === "default") {
    try { await Notification.requestPermission(); } catch {}
  }
}

function saveSettings() {
  UIState.prefs.darkMode = $("setDarkMode").checked;
  const at = $("setAccentTheme");
  UIState.prefs.accentTheme = at ? String(at.value || "default") : String(UIState.prefs.accentTheme || "default");
  if (!["default","blue","purple"].includes(UIState.prefs.accentTheme)) UIState.prefs.accentTheme = "default";
  UIState.prefs.popupNotif = $("setPopupNotif").checked;
  UIState.prefs.soundNotif = $("setSoundNotif").checked;

  const mt = $("setMissedToast");
  UIState.prefs.missedToast = mt ? !!mt.checked : true;
  const sp = $("setSavePmLocal");
  UIState.prefs.savePmLocal = sp ? !!sp.checked : false;

  const slider = $("setRoomFontSize");
  if (slider) {
    UIState.prefs.roomFontSize = clampInt(slider.value, 10, 22, 12);
    Settings.set("roomFontSize", UIState.prefs.roomFontSize);
    applyRoomFontSize(UIState.prefs.roomFontSize);
    const modal = $("settingsModal");
    if (modal) modal.dataset.prevRoomFontSize = String(UIState.prefs.roomFontSize);
  }

  Settings.set("darkMode", UIState.prefs.darkMode);
  Settings.set("accentTheme", UIState.prefs.accentTheme);
  Settings.set("popupNotif", UIState.prefs.popupNotif);
  Settings.set("soundNotif", UIState.prefs.soundNotif);
  Settings.set("missedToast", UIState.prefs.missedToast);
  Settings.set("savePmLocal", UIState.prefs.savePmLocal);

  setThemeFromPrefs();

  if (UIState.prefs.popupNotif) requestNotifPermissionIfNeeded();

  toast("✅ Settings saved", "ok");
  closeSettings();
}

// ───────────────────────────────────────────────────────────────────────────────
// Boot
// ───────────────────────────────────────────────────────────────────────────────
function setMyPresence(opts = {}) {
  const presence = opts.presence ?? $("meStatus")?.value ?? "online";
  // If custom_status key is present, we send it; otherwise we leave it unchanged.
  const payload = { presence };
  if (Object.prototype.hasOwnProperty.call(opts, "custom_status")) {
    payload.custom_status = opts.custom_status;
  }
  socket.emit("set_my_presence", payload, (res) => {
    if (res && res.success) {
      toast("✅ Status updated", "ok");
    } else {
      toast(`❌ ${res?.error || "Status update failed"}`, "error");
    }
  });
}

function saveMyCustomStatus() {
  const presence = $("meStatus")?.value ?? "online";
  const custom_status = $("meCustomStatus")?.value ?? "";
  socket.emit("set_my_presence", { presence, custom_status }, (res) => {
    if (res && res.success) {
      toast("✅ Status updated", "ok");
    } else {
      toast(`❌ ${res?.error || "Status update failed"}`, "error");
    }
  });
}

document.addEventListener("DOMContentLoaded", async () => {
  // Username in dock
  $("meName").textContent = currentUser;

  // Theme
  setThemeFromPrefs();

  // Apply room text size preference
  applyRoomFontSize(UIState.prefs.roomFontSize);

  // Tabs
  $("tabFriends")?.addEventListener("click", () => setActiveTab("friends"));
  $("tabGroups")?.addEventListener("click", () => setActiveTab("groups"));

  // Search
  $("dockSearch")?.addEventListener("input", (e) => applyDockSearchFilter(e.target.value));
  // Presence controls
  $("meStatus")?.addEventListener("change", () => {
    const presence = $("meStatus")?.value ?? "online";
    setMyPresence({ presence });
  });
  $("btnSetMyStatus")?.addEventListener("click", () => saveMyCustomStatus());
  $("meCustomStatus")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      saveMyCustomStatus();
    }
  });
  $("meCustomStatus")?.addEventListener("blur", () => saveMyCustomStatus());


  // Buttons
  $("btnAddFriend")?.addEventListener("click", addFriend);
  $("friendUser")?.addEventListener("keydown", (e) => { if (e.key === "Enter") addFriend(); });
  $("btnCreateGroup")?.addEventListener("click", createGroup);
  $("btnJoinGroup")?.addEventListener("click", joinGroupById);
  $("btnRefreshGroupInvites")?.addEventListener("click", refreshGroupInvites);

  $("btnSettings")?.addEventListener("click", openSettings);
  $("btnSaveSettings")?.addEventListener("click", saveSettings);
  $("btnCloseSettings")?.addEventListener("click", closeSettings);

  $("btnDownloadPmHistory")?.addEventListener("click", downloadPmHistory);
  $("btnClearPmHistory")?.addEventListener("click", clearPmHistory);

  // DM E2EE controls
  $("btnUnlockDM")?.addEventListener("click", () => {
    try { showUnlockModal(); } catch {}
  });
  $("btnLockDM")?.addEventListener("click", () => {
    try {
      window.myPrivateCryptoKey = null;
      UIState.unlockSkipped = true;
      sessionStorage.removeItem("echochat_dm_pwd");
      sessionStorage.removeItem("echochat_dm_pwd_set_at");
    } catch {}
    toast("🔒 Private messages locked for this tab", "info");
  });

  // Live preview of room text size inside Settings
  $("setRoomFontSize")?.addEventListener("input", (e) => applyRoomFontSize(e.target.value));

  // Render rooms immediately if server gave them
  if (Array.isArray(window.INIT_ROOMS)) renderRooms(window.INIT_ROOMS);

  // Auto-unlock private messages using the main login password stored in sessionStorage (per-tab).
  // This removes the "second login" prompt for DMs.
  try {
    await tryAutoUnlockPrivateMessages("");
  } catch (_e) {
    // Non-fatal: user can still use rooms; DMs will show as locked.
  }

  // Ensure a valid access token after long idle / hard refresh.
  // We use the refresh token cookie (HttpOnly) + csrf_refresh_token cookie.
  try {
    await refreshAccessToken();
  } catch (e) {
    const msg = (e && (e.message || e.toString())) || "";
    // If the server/network is temporarily down, do NOT bounce users to /login.
    // We'll stay in-app and let Socket.IO reconnect automatically.
    if (/network error/i.test(msg)) {
      setConnBanner("connecting", "⚠️ Server unreachable — reconnecting…");
    } else {
      // Refresh token likely expired/cleared → real auth failure.
      await bestEffortLogoutThenRedirect("refresh_failed");
      return;
    }
  }



  let socketConnectRetried = false;

  async function recoverSocketAuth(trigger) {
    if (AUTH_RECOVERY_IN_PROGRESS) return;
    AUTH_RECOVERY_IN_PROGRESS = true;
    try {
      await refreshAccessToken();
      // Restart the transport so the server sees the fresh access cookie.
      try { socket.disconnect(); } catch (_e) {}
      try { socket.connect(); } catch (_e) {}
    } catch (_e) {
      await bestEffortLogoutThenRedirect(trigger || 'auth_required');
    } finally {
      AUTH_RECOVERY_IN_PROGRESS = false;
    }
  }

  // Server can emit this when a JWT expires inside an event handler.
  socket.on('auth_error', async (_payload) => {
    await recoverSocketAuth('auth_required');
  });
  socket.on("connect_error", async (err) => {
    const msg = (err && (err.message || err.toString())) || "";

    // Auth-related connect errors: try a single refresh, then force login.
    if (/expired|unauthoriz|401/i.test(msg)) {
      if (!socketConnectRetried) {
        socketConnectRetried = true;
        await recoverSocketAuth('auth_required');
        return;
      }
      await bestEffortLogoutThenRedirect('auth_required');
      return;
    }

    // Non-auth connect errors (server down / blocked / CORS): stay in-app.
    setConnBanner("connect_error", "⚠️ Can't reach server — retrying…");
  });

  socket.connect();

  // Yahoo-style room browser on the left.
  initRoomBrowser().catch(() => {});

  // Keep the access token fresh while the app is open.
  // Keep-alive: refresh ~every 22 minutes (below the 30-minute access TTL).
  setInterval(() => {
    refreshAccessToken().catch(() => {});
  }, 22 * 60 * 1000);

  // If the tab was suspended (sleep/background), refresh on focus/visibility.
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      refreshAccessToken().catch((e) => {
        const msg = (e && (e.message || e.toString())) || "";
        if (/network error/i.test(msg)) {
          setConnBanner("connecting", "⚠️ Server unreachable — reconnecting…");
        } else {
          bestEffortLogoutThenRedirect("refresh_failed").catch(() => {
            window.location.href = "/login?reason=refresh_failed";
          });
        }
      });
    }
  });

  window.addEventListener("offline", () => {
    // Browser detected network loss.
    setConnBanner("offline", "📡 Offline — waiting for network…", { spinner: false, showRetry: false });
  });

  window.addEventListener("online", () => {
    // Network is back; attempt an immediate reconnect.
    setConnBanner("reconnecting", "🔁 Network back — reconnecting…");
    tryReconnectNow("online");
  });

  // Initial data (after socket connect)
});

// Connection hooks
if (socket && socket.io) {
  // Socket.IO Manager-level reconnection events (v4)
  socket.io.on("reconnect_attempt", (attempt) => {
    const n = Number(attempt || 0) || 0;
    EC_CONN_ATTEMPT = n;
    setConnBanner("reconnecting", `🔁 Reconnecting… (attempt ${n})`);
  });
  socket.io.on("reconnect_error", (_err) => {
    setConnBanner("reconnecting", "⚠️ Reconnect failed — retrying…");
  });
  socket.io.on("reconnect_failed", () => {
    setConnBanner("reconnect_failed", "❌ Could not reconnect. Click Retry.", { spinner: false, showRetry: true });
  });
}


let EC_RESTORE_IN_PROGRESS = false;

// On reconnect, re-join the last room and (optionally) re-join room voice.
// This fixes: server restart / Wi‑Fi blip → user stays on /chat but loses room membership.
async function restoreLastRoomAndVoice() {
  if (EC_RESTORE_IN_PROGRESS) return;
  EC_RESTORE_IN_PROGRESS = true;
  try {
    let lastRoom = "";
    try {
      lastRoom = String(UIState?.currentRoom || sessionStorage.getItem("echochat_last_room") || "").trim();
    } catch (e) {
      lastRoom = String(UIState?.currentRoom || "").trim();
    }

    const voiceWanted = (() => {
      try { return sessionStorage.getItem("echochat_voice_room_joined") === "1"; } catch (e) { return false; }
    })();
    const voiceRoom = (() => {
      try { return String(sessionStorage.getItem("echochat_voice_room") || "").trim(); } catch (e) { return ""; }
    })();

    if (!lastRoom) return;

    const res = await joinRoom(lastRoom, { silent: true, restore: true });
    if (res?.success && voiceWanted && voiceRoom && voiceRoom === lastRoom) {
      // Reset local voice state on reconnect so we re-announce to the server and rebuild peers.
      try {
        if (VOICE_STATE?.room?.joined && VOICE_STATE.room.name === lastRoom) {
          voiceLeaveRoom("Reconnecting", false);
        }
      } catch (e) {}
      await voiceJoinRoom(lastRoom, { silent: true, restore: true });
    }
  } catch (e) {
    console.warn("restoreLastRoomAndVoice failed", e);
  } finally {
    EC_RESTORE_IN_PROGRESS = false;
  }
}

socket.on("connect", () => {
  const first = !EC_HAS_EVER_CONNECTED;
  EC_HAS_EVER_CONNECTED = true;

  if (first) toast("✅ Connected", "ok");
  else toast("🔁 Reconnected", "ok", 2600);

  hideConnBanner();

  getRooms();
  getFriends();
  getPendingFriendRequests();
  getBlockedUsers();

  // Missed (offline) PM summary on login
  MISSED_SUMMARY_TOAST_ARMED = first;
  socket.emit("get_missed_pm_summary");

  // Presence (server addition)
  socket.emit("get_friend_presence");
  socket.emit("get_my_presence");
  refreshMyGroups();

  // Re-join last room/voice after transient reconnects.
  if (!first) restoreLastRoomAndVoice();
});

socket.on("disconnect", (reason) => {
  // Transient disconnects happen (server restarts, Wi‑Fi blips, sleep/wake).
  // Keep the user in-app; only redirect on real auth failure or explicit logout.
  if (AUTH_RECOVERY_IN_PROGRESS) return;
  if (reason === "io client disconnect") return;

  const r = String(reason || "disconnect");
  setConnBanner("disconnected", `🔌 Disconnected (${r}) — reconnecting…`);

  // If the server disconnected us, Socket.IO won't auto-reconnect until we call connect().
  if (r === "io server disconnect") {
    tryReconnectNow("io_server_disconnect");
  }
});


// Missed PM summary from server
socket.on("missed_pm_summary", ({ items }) => {
  const list = Array.isArray(items) ? items : [];
  UIState.missedPmSummary = list;
  renderMissedPmList(list);

  const total = list.reduce((acc, it) => acc + (Number(it?.count ?? 0) || 0), 0);
  if (MISSED_SUMMARY_TOAST_ARMED && UIState.prefs.missedToast && total > 0) {
    toast(`📨 You have ${total} missed PM(s)`, "info");
    maybeBrowserNotify("Missed private messages", `You have ${total} missed PM(s).`);
  }
  MISSED_SUMMARY_TOAST_ARMED = false;
});


// Friend request ping
socket.on("friend_request", ({ from }) => {
  toast(`🎉 Friend request from ${from}`, "info");
  maybeBrowserNotify("Friend request", `From: ${from}`);
  getPendingFriendRequests();
});
