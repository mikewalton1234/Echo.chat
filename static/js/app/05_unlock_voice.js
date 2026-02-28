// ───────────────────────────────────────────────────────────────────────────────
// Unlock private key (E2EE) — modal-based
// ───────────────────────────────────────────────────────────────────────────────
const PM_ENVELOPE_PREFIX = "EC1:";
const PM_PLAINTEXT_PREFIX = "ECP1:"; // plaintext DM wrapper (compat mode)
const ROOM_ENVELOPE_PREFIX = "ECR1:";
const GROUP_ENVELOPE_PREFIX = "ECG1:";

// Cache RSA public keys (username -> { key: CryptoKey, fetchedAt: ms })
// NOTE: Keys can rotate (e.g., after password reset). Never cache forever.
const RSA_PUBKEY_CACHE = new Map();
const RSA_PUBKEY_CACHE_TTL_MS = Number((window.ECHOCHAT_CFG && window.ECHOCHAT_CFG.pubkey_cache_ttl_ms) || 60_000);
// Non-secret server-provided client config (injected in templates/chat.html)
const ECHOCHAT_CFG = (window.ECHOCHAT_CFG && typeof window.ECHOCHAT_CFG === "object") ? window.ECHOCHAT_CFG : {};

// DM encryption policy (server-configurable)
const ALLOW_PLAINTEXT_DM_FALLBACK = (ECHOCHAT_CFG.allow_plaintext_dm_fallback === undefined) ? true : !!ECHOCHAT_CFG.allow_plaintext_dm_fallback;
const REQUIRE_DM_E2EE = !!ECHOCHAT_CFG.require_dm_e2ee;

// Keep in sync with server max_dm_file_bytes (routes_main.py). Server can override per config.
const MAX_DM_FILE_BYTES = Number(ECHOCHAT_CFG.max_dm_file_bytes) || (10 * 1024 * 1024);
const MAX_GROUP_FILE_BYTES = Number(ECHOCHAT_CFG.max_group_file_bytes) || MAX_DM_FILE_BYTES;


// Attempt WebRTC P2P first, fallback to server upload.
const P2P_FILE_ENABLED = (ECHOCHAT_CFG.p2p_file_enabled === undefined) ? true : !!ECHOCHAT_CFG.p2p_file_enabled;
const P2P_FILE_CHUNK_BYTES = Number(ECHOCHAT_CFG.p2p_chunk_bytes) || (16 * 1024); // safe default
const P2P_FILE_HANDSHAKE_TIMEOUT_MS = Number(ECHOCHAT_CFG.p2p_handshake_timeout_ms) || 7_000;
const P2P_FILE_TRANSFER_TIMEOUT_MS = Number(ECHOCHAT_CFG.p2p_transfer_timeout_ms) || 120_000;
const P2P_ICE_SERVERS = (Array.isArray(ECHOCHAT_CFG.p2p_ice_servers) && ECHOCHAT_CFG.p2p_ice_servers.length)
  ? ECHOCHAT_CFG.p2p_ice_servers
  : [
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "stun:stun1.l.google.com:19302" },
    ];
const P2P_TRANSFERS = new Map(); // transfer_id -> { role, peer, pc, dc, ui, meta, ... }

// ───────────────────────────────────────────────────────────────────────────────
// Voice chat (WebRTC audio) — Yahoo-style rooms + 1:1 calls
// ───────────────────────────────────────────────────────────────────────────────
const VOICE_ENABLED = (ECHOCHAT_CFG.voice_enabled === undefined) ? true : !!ECHOCHAT_CFG.voice_enabled;
// 0 (or <=0) means unlimited. IMPORTANT: do not treat 0 as falsy here.
const VOICE_MAX_ROOM_PEERS = (() => {
  const v = ECHOCHAT_CFG.voice_max_room_peers;
  if (v === undefined || v === null || v === "") return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
})();
const VOICE_ICE_SERVERS = (Array.isArray(ECHOCHAT_CFG.voice_ice_servers) && ECHOCHAT_CFG.voice_ice_servers.length)
  ? ECHOCHAT_CFG.voice_ice_servers
  : P2P_ICE_SERVERS;

const VOICE_STATE = {
  micStream: null,
  // Single mic for both DM + room voice. Mute is global.
  micMuted: false,
  dmCalls: new Map(), // peer -> { call_id, pc, remoteEl, state, muted, isCaller }
  room: {
    name: null,
    joined: false,
    peers: new Map(), // peer -> { pc, remoteEl }
  }
};

function voiceSecureContextOk() {
  // getUserMedia requires a secure context (HTTPS) except on localhost.
  const h = (location && location.hostname) || "";
  const localhost = (h === "localhost" || h === "127.0.0.1" || h === "::1");
  return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && (window.isSecureContext || localhost));
}

async function voiceEnsureMic() {
  if (VOICE_STATE.micStream) return VOICE_STATE.micStream;
  if (!VOICE_ENABLED) throw new Error("Voice chat disabled");
  if (!voiceSecureContextOk()) {
    throw new Error("Voice requires HTTPS or http://localhost");
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    video: false,
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1,
    }
  });
  VOICE_STATE.micStream = stream;
  // If the user yanks permissions mid-call, cleanup.
  stream.getTracks().forEach(t => {
    t.addEventListener("ended", () => {
      // Best-effort: end all calls/room voice
      voiceEndAll("Mic stopped");
    });
  });
  return stream;
}

function voiceMaybeStopMic() {
  const anyDm = (VOICE_STATE.dmCalls.size > 0);
  const anyRoom = !!VOICE_STATE.room.joined;
  if (anyDm || anyRoom) return;
  if (VOICE_STATE.micStream) {
    try { VOICE_STATE.micStream.getTracks().forEach(t => t.stop()); } catch {}
  }
  VOICE_STATE.micStream = null;
    VOICE_STATE.micMuted = false;
}

function voiceSetMute(muted) {
  VOICE_STATE.micMuted = !!muted;
  try {
    const s = VOICE_STATE.micStream;
    if (s) s.getAudioTracks().forEach(t => (t.enabled = !muted));
  } catch {}
}

function voiceMakePc() {
  const pc = new RTCPeerConnection({ iceServers: VOICE_ICE_SERVERS });
  // Best-effort resilience: try ICE restart on failure.
  pc.oniceconnectionstatechange = () => {
    try {
      if (pc.iceConnectionState === "failed") {
        pc.restartIce && pc.restartIce();
      }
    } catch {}
  };
  pc.onconnectionstatechange = () => {
    try {
      if (pc.connectionState === "failed") {
        pc.restartIce && pc.restartIce();
      }
    } catch {}
  };
  return pc;
}

function voiceAttachRemoteAudio(key, stream) {
  // Create (or replace) a hidden <audio> element so remote audio plays.
  const id = `ec-voice-audio-${key.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
  let el = document.getElementById(id);
  if (!el) {
    el = document.createElement("audio");
    el.id = id;
    el.autoplay = true;
    el.playsInline = true;
    el.style.display = "none";
    document.body.appendChild(el);
  }
  try { el.srcObject = stream; } catch {}
  return el;
}

function voiceDmUi(peer, patch = {}) {
  const win = UIState.windows.get("dm:" + peer);
  if (!win || !win._ym) return;

  const bar = win._ym.voiceBar;
  const status = win._ym.voiceStatus;
  const bCall = win._ym.voiceBtnCall;
  const bHang = win._ym.voiceBtnHang;
  const bMute = win._ym.voiceBtnMute;
  const bAcc = win._ym.voiceBtnAccept;
  const bDec = win._ym.voiceBtnDecline;

  if (bar) bar.classList.remove("hidden");
  if (patch.hideBar && bar) bar.classList.add("hidden");

  if (status && patch.statusText !== undefined) status.textContent = patch.statusText;

  const mode = patch.mode || null; // idle|calling|incoming|active
  if (mode) {
    if (bCall) bCall.style.display = (mode === "idle") ? "" : "none";
    if (bHang) bHang.style.display = (mode === "calling" || mode === "active") ? "" : "none";
    if (bMute) bMute.style.display = (mode === "active") ? "" : "none";
    if (bAcc) bAcc.style.display = (mode === "incoming") ? "" : "none";
    if (bDec) bDec.style.display = (mode === "incoming") ? "" : "none";
  }
  if (bMute && patch.muteLabel) bMute.textContent = patch.muteLabel;

  // Yahoo-style voice button state
  try { voiceUpdateDmVoiceButton(peer); } catch (e) {}
}

function voiceUpdateDmVoiceButton(peer) {
  const win = UIState.windows.get("dm:" + peer);
  if (!win || !win._ym || !win._ym.voiceBtn) return;
  const call = VOICE_STATE.dmCalls.get(peer);
  if (!call) {
    win._ym.voiceBtn.textContent = "🎤";
    win._ym.voiceBtn.title = "Voice chat — click to call (hands‑free)";
    return;
  }
  if (call.state === "incoming") {
    win._ym.voiceBtn.textContent = "📞";
    win._ym.voiceBtn.title = "Incoming voice — click to accept • Decline button in bar";
    return;
  }
  if (VOICE_STATE.micMuted) {
    win._ym.voiceBtn.textContent = "🔇";
    win._ym.voiceBtn.title = "Voice is on (muted) — click to hang up • right‑click to unmute";
  } else {
    win._ym.voiceBtn.textContent = "📞";
    win._ym.voiceBtn.title = "Voice is on — click to hang up • right‑click to mute";
  }
}

function voiceRoomUi(patch = {}) {
  const bar = $("roomEmbedVoiceBar");
  const status = $("roomEmbedVoiceStatus");
  const bJoin = $("btnRoomEmbedVoiceJoin");
  const bLeave = $("btnRoomEmbedVoiceLeave");
  const bMute = $("btnRoomEmbedVoiceMute");

  if (bar) {
    if (patch.show === true) bar.classList.remove("hidden");
    if (patch.show === false) bar.classList.add("hidden");
  }
  if (status && patch.statusText !== undefined) status.textContent = patch.statusText;
  if (bJoin) bJoin.style.display = patch.joinVisible === false ? "none" : "";
  if (bLeave) bLeave.style.display = patch.leaveVisible === false ? "none" : "";
  if (bMute) bMute.style.display = patch.muteVisible === false ? "none" : "";
  if (bMute && patch.muteLabel) bMute.textContent = patch.muteLabel;

  // Keep the main room voice button in sync with state.
  try { voiceUpdateRoomVoiceButton(); } catch (e) {}
}


function voiceUpdateRoomVoiceButton() {
  const btn = $("btnRoomEmbedVoice");
  if (!btn) return;
  const active = !!(VOICE_STATE.room.joined && VOICE_STATE.room.name);
  if (!active) {
    btn.textContent = "🎤 Voice";
    btn.title = "Voice chat (room) — click to join (hands‑free)";
    btn.classList.remove("active");
    return;
  }
  btn.classList.add("active");
  if (VOICE_STATE.micMuted) {
    btn.textContent = "🔇 Voice";
    btn.title = "Voice is on (muted) — click to leave • right‑click to unmute";
  } else {
    btn.textContent = "📞 Voice";
    btn.title = "Voice is on — click to leave • right‑click to mute";
  }
}

function voiceDmCleanup(peer, reason = "") {
  const call = VOICE_STATE.dmCalls.get(peer);
  if (!call) return;
  try { call.pc?.close(); } catch {}
  try {
    if (call.remoteEl) {
      call.remoteEl.srcObject = null;
      call.remoteEl.remove();
    }
  } catch {}
  VOICE_STATE.dmCalls.delete(peer);
  voiceDmUi(peer, { statusText: reason ? `Ended: ${reason}` : "Not connected", mode: "idle", hideBar: false });
  try { voiceUpdateDmVoiceButton(peer); } catch (e) {}
  voiceMaybeStopMic();
}

async function voiceStartDmCall(peer) {
  if (!VOICE_ENABLED) return toast("🎤 Voice is disabled on this server", "warn");
  // Ensure DM window exists
  openPrivateChat(peer);

  if (VOICE_STATE.dmCalls.has(peer)) {
    return toast("🎤 Voice call already active", "warn");
  }

  const call_id = crypto?.randomUUID ? crypto.randomUUID() : (Date.now() + "-" + Math.random());
  voiceSetMute(false);
  voiceDmUi(peer, { statusText: "Calling…", mode: "calling" });
  try { voiceUpdateDmVoiceButton(peer); } catch (e) {}

  try {
    await voiceEnsureMic();
    const pc = voiceMakePc();
    const stream = VOICE_STATE.micStream;
    stream.getTracks().forEach(t => pc.addTrack(t, stream));

    const call = { call_id, peer, pc, remoteEl: null, state: "calling", muted: false, isCaller: true };
    VOICE_STATE.dmCalls.set(peer, call);

    pc.ontrack = (ev) => {
      const st = ev.streams && ev.streams[0];
      if (st) call.remoteEl = voiceAttachRemoteAudio(`dm-${peer}`, st);
    };
    pc.onicecandidate = (ev) => {
      if (ev.candidate) socket.emit("voice_dm_ice", { to: peer, call_id, candidate: ev.candidate });
    };

    // Send invite first (lets receiver accept/decline)
    const inv = await new Promise((resolve) => socket.emit("voice_dm_invite", { to: peer, call_id }, resolve));
    if (!inv?.success || !inv?.delivered) {
      voiceDmCleanup(peer, inv?.error || "User offline");
      return toast("❌ Voice invite not delivered", "error");
    }

    // Wait for accept event to start offer (see socket.on handlers)
  } catch (e) {
    console.error(e);
    voiceDmCleanup(peer, e?.message || "Voice call failed");
    toast(`❌ Voice call failed: ${e?.message || e}`, "error");
  }
}

async function voiceAcceptDmCall(peer) {
  const call = VOICE_STATE.dmCalls.get(peer);
  if (!call || call.state !== "incoming") return;
  try {
    voiceSetMute(false);
    try { voiceUpdateDmVoiceButton(peer); } catch (e) {}
    await voiceEnsureMic();
    const pc = voiceMakePc();
    const stream = VOICE_STATE.micStream;
    stream.getTracks().forEach(t => pc.addTrack(t, stream));

    call.pc = pc;
    call.state = "active"; // will confirm after SDP
    pc.ontrack = (ev) => {
      const st = ev.streams && ev.streams[0];
      if (st) call.remoteEl = voiceAttachRemoteAudio(`dm-${peer}`, st);
    };
    pc.onicecandidate = (ev) => {
      if (ev.candidate) socket.emit("voice_dm_ice", { to: peer, call_id: call.call_id, candidate: ev.candidate });
    };

    await new Promise((resolve) => socket.emit("voice_dm_accept", { to: peer, call_id: call.call_id }, resolve));
    voiceDmUi(peer, { statusText: "Connecting…", mode: "active", muteLabel: "Mute" });
  } catch (e) {
    console.error(e);
    voiceDmCleanup(peer, e?.message || "Accept failed");
    toast(`❌ Voice accept failed: ${e?.message || e}`, "error");
  }
}

function voiceDeclineDmCall(peer, reason = "Declined") {
  const call = VOICE_STATE.dmCalls.get(peer);
  if (!call) return;
  socket.emit("voice_dm_decline", { to: peer, call_id: call.call_id, reason }, () => {});
  voiceDmCleanup(peer, reason);
}

async function voiceToggleDmMain(peer) {
  const call = VOICE_STATE.dmCalls.get(peer);
  if (!call) {
    voiceSetMute(false);
    return await voiceStartDmCall(peer);
  }
  if (call.state === "incoming") {
    voiceSetMute(false);
    return await voiceAcceptDmCall(peer);
  }
  return voiceHangupDm(peer, "Ended", true);
}

function voiceHangupDm(peer, reason = "Ended", notifyPeer = true) {
  const call = VOICE_STATE.dmCalls.get(peer);
  if (!call) return;
  if (notifyPeer) socket.emit("voice_dm_end", { to: peer, call_id: call.call_id, reason }, () => {});
  voiceDmCleanup(peer, reason);
}

function voiceToggleMuteDm(peer) {
  const call = VOICE_STATE.dmCalls.get(peer);
  if (!call) return;
  const muted = !VOICE_STATE.micMuted;
  voiceSetMute(muted);
  call.muted = muted;
  voiceDmUi(peer, { muteLabel: muted ? "Unmute" : "Mute" });
  try { voiceUpdateDmVoiceButton(peer); } catch (e) {}
}

async function voiceJoinRoom(room, opts) {
  opts = opts || {};
  const silent = !!opts.silent;
  const restore = !!opts.restore;

  if (!VOICE_ENABLED) {
    if (!silent && !restore) toast("🎤 Voice is disabled on this server", "warn");
    return { success: false, error: "voice_disabled" };
  }
  if (!room) {
    if (!silent && !restore) toast("⚠️ Join a room first", "warn");
    return { success: false, error: "missing_room" };
  }
  if (VOICE_STATE.room.joined && VOICE_STATE.room.name === room) return { success: true, already: true };

  try {
    await voiceEnsureMic();
    VOICE_STATE.room.name = room;
    VOICE_STATE.room.joined = true;
    VOICE_STATE.room.peers.clear();
    voiceSetMute(false);
    voiceRoomUi({ show: true, statusText: "Joining…", joinVisible: false, leaveVisible: false, muteVisible: false, muteLabel: "Mute" });

    const ack = await new Promise((resolve) => socket.emit("voice_room_join", { room }, resolve));
    if (!ack?.success) {
      VOICE_STATE.room.joined = false;
      VOICE_STATE.room.name = null;
      voiceRoomUi({ show: true, statusText: ack?.error || "Voice join failed" });
      if (!silent && !restore) toast(`❌ ${ack?.error || "Voice join failed"}`, "error");
      return { success: false, error: ack?.error || "voice_join_failed" };
    }

    // Persist for reconnect restore (per-tab).
    try {
      sessionStorage.setItem("echochat_voice_room", String(room));
      sessionStorage.setItem("echochat_voice_room_joined", "1");
    } catch (e) {}

    const roster = Array.isArray(ack.users) ? ack.users : [];
    const limN = (ack && ack.limit !== undefined && ack.limit !== null) ? Number(ack.limit) : VOICE_MAX_ROOM_PEERS;
    const limText = (Number.isFinite(limN) && limN > 0) ? String(limN) : "∞";
    voiceRoomUi({ show: true, statusText: `Voice connected (${roster.length}/${limText})`, joinVisible: false, leaveVisible: false, muteVisible: false });
    voiceUpdateRoomVoiceButton();

    // Ensure peers
    for (const p of roster) {
      if (!p || p === currentUser) continue;
      voiceRoomEnsurePeer(room, p);
    }

    return { success: true, users: roster, limit: limN };
  } catch (e) {
    console.error(e);
    if (!silent && !restore) toast(`❌ Voice room failed: ${e?.message || e}`, "error");
    voiceLeaveRoom("Error", false);
    return { success: false, error: e?.message || String(e) };
  }
}


function voiceLeaveRoom(reason = "Left", notifyServer = true) {
  const room = VOICE_STATE.room.name;
  if (!room || !VOICE_STATE.room.joined) {
    voiceRoomUi({ show: false });
    return;
  }
  // Close peer PCs
  for (const [peer, obj] of VOICE_STATE.room.peers.entries()) {
    try { obj.pc?.close(); } catch {}
    try {
      if (obj.remoteEl) {
        obj.remoteEl.srcObject = null;
        obj.remoteEl.remove();
      }
    } catch {}
  }
  VOICE_STATE.room.peers.clear();
  VOICE_STATE.room.joined = false;
  VOICE_STATE.room.name = null;
  voiceSetMute(false);
  // Persisted state (reconnect restore)
  try {
    sessionStorage.removeItem("echochat_voice_room");
    sessionStorage.removeItem("echochat_voice_room_joined");
  } catch (e) {}
  if (notifyServer) socket.emit("voice_room_leave", { room }, () => {});
  voiceRoomUi({ show: false });
  voiceUpdateRoomVoiceButton();
  if (reason) toast(`🎤 ${reason}`, "info");
  voiceMaybeStopMic();
}

function voiceToggleMuteRoom() {
  const muted = !VOICE_STATE.micMuted;
  voiceSetMute(muted);
  voiceRoomUi({ muteLabel: muted ? "Unmute" : "Mute" });
  voiceUpdateRoomVoiceButton();
}

function voiceRoomIsInitiator(a, b) {
  return String(a) < String(b);
}

function voiceRoomEnsurePeer(room, peer) {
  if (!VOICE_STATE.room.joined || VOICE_STATE.room.name !== room) return;
  if (VOICE_STATE.room.peers.has(peer)) return;
  const pc = voiceMakePc();
  const stream = VOICE_STATE.micStream;
  if (stream) stream.getTracks().forEach(t => pc.addTrack(t, stream));
  const obj = { pc, remoteEl: null };
  VOICE_STATE.room.peers.set(peer, obj);

  pc.ontrack = (ev) => {
    const st = ev.streams && ev.streams[0];
    if (st) obj.remoteEl = voiceAttachRemoteAudio(`room-${room}-${peer}`, st);
  };
  pc.onicecandidate = (ev) => {
    if (ev.candidate) socket.emit("voice_room_ice", { room, to: peer, candidate: ev.candidate });
  };

  // Deterministic initiator to avoid glare
  if (voiceRoomIsInitiator(currentUser, peer)) {
    pc.onnegotiationneeded = async () => {
      try {
        const offer = await pc.createOffer({ offerToReceiveAudio: true });
        await pc.setLocalDescription(offer);
        socket.emit("voice_room_offer", { room, to: peer, offer: pc.localDescription });
      } catch (e) {
        console.warn("voice negotiation failed", e);
      }
    };
  }
}

function voiceEndAll(reason = "Ended") {
  // DM calls
  for (const peer of Array.from(VOICE_STATE.dmCalls.keys())) {
    voiceHangupDm(peer, reason, true);
  }
  // Room
  voiceLeaveRoom(reason, true);
  voiceMaybeStopMic();
}


function b64FromBytes(bytes) {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

function bytesFromB64(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Plaintext DM compatibility wrapper (used when WebCrypto is unavailable or peer lacks keys).
// WARNING: not E2EE; should only be used as a last-resort compatibility mode.
const _DM_UTF8_ENC = new TextEncoder();
const _DM_UTF8_DEC = new TextDecoder();

function wrapPlainDm(plaintext) {
  const bytes = _DM_UTF8_ENC.encode(String(plaintext ?? ""));
  return PM_PLAINTEXT_PREFIX + b64FromBytes(bytes);
}

function unwrapPlainDm(cipher) {
  const b64 = String(cipher || "").slice(PM_PLAINTEXT_PREFIX.length);
  return _DM_UTF8_DEC.decode(bytesFromB64(b64));
}

// PEM helpers
// WebCrypto expects DER (ArrayBuffer) for pkcs8/spki imports, but we store PEM text.
// Accepts either full PEM (with BEGIN/END lines) or a raw base64 body.
function pemToArrayBuffer(pemText) {
  const pem = String(pemText || "");
  const b64 = pem
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\s+/g, "");
  if (!b64) throw new Error("Invalid PEM (empty)");
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

async function importMyPrivateKey(encryptedPrivStr, password) {
  // Supports:
  //  - v2:<salt_b64>:<nonce_b64>:<cipher_b64> (PBKDF2->AES-256-GCM, AAD "echochat:keyblob:v2")
  //  - legacy: <salt_b64>:<cipher_b64> (PBKDF2->XOR)
  if (!encryptedPrivStr || typeof encryptedPrivStr !== "string") {
    throw new Error("No encrypted private key available.");
  }

  function b64ToBytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const parts = encryptedPrivStr.split(":");

  // v2 AES-GCM (preferred)
  if (parts.length === 4 && parts[0] === "v2") {
    const salt = b64ToBytes(parts[1]);
    const nonce = b64ToBytes(parts[2]);
    const cipher = b64ToBytes(parts[3]);

    const keyMaterial = await crypto.subtle.importKey(
      "raw",
      enc.encode(password),
      { name: "PBKDF2" },
      false,
      ["deriveBits"]
    );

    const derivedBits = await crypto.subtle.deriveBits(
      {
        name: "PBKDF2",
        salt: salt,
        iterations: 390000,
        hash: "SHA-256",
      },
      keyMaterial,
      256
    );

    const aesKey = await crypto.subtle.importKey(
      "raw",
      derivedBits,
      { name: "AES-GCM" },
      false,
      ["decrypt"]
    );

    const aad = enc.encode("echochat:keyblob:v2");
    const plainBuf = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: nonce, additionalData: aad, tagLength: 128 },
      aesKey,
      cipher
    );

    const privatePem = dec.decode(new Uint8Array(plainBuf));
    const privateKey = await crypto.subtle.importKey(
      "pkcs8",
      pemToArrayBuffer(privatePem),
      { name: "RSA-OAEP", hash: "SHA-256" },
      false,
      ["decrypt"]
    );
    return privateKey;
  }

  // legacy v1 XOR fallback
  if (parts.length < 2) {
    throw new Error("Invalid encrypted private key format.");
  }
  const saltB64 = parts[0];
  const cipherB64 = parts.slice(1).join(":"); // tolerate extra ':' if any
  const salt = b64ToBytes(saltB64);
  const encryptedBytes = b64ToBytes(cipherB64);

  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    enc.encode(password),
    { name: "PBKDF2" },
    false,
    ["deriveBits"]
  );

  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: salt,
      iterations: 390000,
      hash: "SHA-256",
    },
    keyMaterial,
    256
  );
  const derivedKey = new Uint8Array(derivedBits);

  // XOR decrypt
  const decryptedBytes = new Uint8Array(encryptedBytes.length);
  for (let i = 0; i < encryptedBytes.length; i++) {
    decryptedBytes[i] = encryptedBytes[i] ^ derivedKey[i % derivedKey.length];
  }

  const privatePem = dec.decode(decryptedBytes);
  const privateKey = await crypto.subtle.importKey(
    "pkcs8",
    pemToArrayBuffer(privatePem),
    { name: "RSA-OAEP", hash: "SHA-256" },
    false,
    ["decrypt"]
  );
  return privateKey;
}

window.myPrivateCryptoKey = null;

function getStoredDmPassword() {
  try {
    return sessionStorage.getItem("echochat_dm_pwd") || "";
  } catch (_e) {
    return "";
  }
}

async function tryAutoUnlockPrivateMessages(reason = "") {
  // If already unlocked, nothing to do.
  if (window.myPrivateCryptoKey) return true;

  // Only attempt if we have everything we need.
  if (!HAS_WEBCRYPTO) return false;
  if (!window.ENCRYPTED_PRIV_KEY) return false;

  const pwd = getStoredDmPassword();
  if (!pwd) return false;

  try {
    const key = await importMyPrivateKey(window.ENCRYPTED_PRIV_KEY, pwd);
    window.myPrivateCryptoKey = key;
    UIState.unlockSkipped = false;
    // Keep password in sessionStorage for this tab/session so refreshes don't re-prompt.
    if (reason) {
      // Avoid spamming toasts: only show when reason is explicit.
      toast("🔓 Private messages unlocked", "ok");
    }
    return true;
  } catch (e) {
    console.error("Auto-unlock failed", e);
    return false;
  }
}

function showUnlockModal() {
  const modal = $("unlockModal");
  const input = $("unlockPassword");
  const remember = $("unlockRemember");
  const errBox = $("unlockError");
  const btnUnlock = $("btnUnlock");
  const btnSkip = $("btnUnlockSkip");

  if (!modal || !input || !remember || !btnUnlock || !btnSkip) return;

  // Reset UI
  errBox?.classList.add("hidden");
  errBox && (errBox.textContent = "");
  input.value = "";
  remember.checked = true;
  modal.classList.remove("hidden");
  input.focus();

  const done = (ok) => {
    modal.classList.add("hidden");
    btnUnlock.onclick = null;
    btnSkip.onclick = null;
    input.onkeydown = null;
    return ok;
  };

  const attempt = async () => {
    if (!HAS_WEBCRYPTO) {
      (errBox && (errBox.textContent = `Private messages require a secure context. Open this app over HTTPS, or use http://localhost (or http://127.0.0.1). Current origin: ${window.location.origin}`));
      errBox?.classList.remove("hidden");
      return;
    }
    if (!window.ENCRYPTED_PRIV_KEY) {
      (errBox && (errBox.textContent = "No encrypted private key available for this user."));
      errBox?.classList.remove("hidden");
      return;
    }
    const pwd = (input.value || "").trim();
    if (!pwd) {
      (errBox && (errBox.textContent = "Password required."));
      errBox?.classList.remove("hidden");
      return;
    }
    try {
      const key = await importMyPrivateKey(window.ENCRYPTED_PRIV_KEY, pwd);
      window.myPrivateCryptoKey = key;
      UIState.unlockSkipped = false;
      UIState.prefs.rememberUnlock = remember.checked;

      // Optional: keep the password in sessionStorage for this tab so auto-unlock works
      // (sessionStorage clears on tab close; it does not persist like localStorage).
      try {
        if (remember.checked) {
          sessionStorage.setItem("echochat_dm_pwd", pwd);
          sessionStorage.setItem("echochat_dm_pwd_set_at", String(Date.now()));
        } else {
          sessionStorage.removeItem("echochat_dm_pwd");
          sessionStorage.removeItem("echochat_dm_pwd_set_at");
        }
      } catch {}

      toast("✅ Private messages unlocked", "ok");
      done(true);
    } catch (e) {
      console.error(e);
      if (errBox) {
        if (e && e.message && e.message.includes("secure context")) {
          errBox.textContent = e.message;
        } else if (e && (e.name === "ReferenceError" || e instanceof ReferenceError)) {
          errBox.textContent = `Unlock failed due to a client script error: ${e.message || e}. Refresh the page after updating EchoChat.`;
        } else {
          // Important: login can succeed even when the stored encrypted private key
          // is still wrapped under an *older* password (e.g., prior admin reset).
          const msg = (e && (e.message || e.toString())) ? String(e.message || e.toString()) : "";
          errBox.textContent = "Unlock failed." + (msg ? ` (${msg})` : "") + " If you can log in but unlock keeps failing, your encrypted key may be tied to an older password. Log out and log back in (this will rotate keys), or have an admin reset your password again.";
        }
      }
      errBox?.classList.remove("hidden");
    }
  };

  btnUnlock.onclick = attempt;
  btnSkip.onclick = () => { UIState.unlockSkipped = true; toast("⚠️ Skipped unlock (DMs may not decrypt)", "warn"); done(false); };
  input.onkeydown = (e) => { if (e.key === "Enter") attempt(); };
}

async function ensurePrivateKeyUnlocked() {
  if (!HAS_WEBCRYPTO) throw new Error(`E2EE requires HTTPS (or http://localhost / http://127.0.0.1). Current origin: ${window.location.origin}`);
  if (window.myPrivateCryptoKey) return window.myPrivateCryptoKey;
  if (UIState.unlockSkipped) throw new Error("Unlock skipped");

  // No second prompt: we reuse the main login password stored in sessionStorage (per-tab)
  // and unlock automatically.
  const ok = await tryAutoUnlockPrivateMessages("");
  if (ok && window.myPrivateCryptoKey) return window.myPrivateCryptoKey;

  // If we can't unlock automatically, fail with a clear error.
  const hasPwd = !!getStoredDmPassword();
  if (!hasPwd) {
    throw new Error("Private messages are locked. Log out and log back in with 'Unlock private messages automatically' enabled.");
  }
  throw new Error("Private messages are locked. Auto-unlock failed (wrong password or key mismatch). Try logging out and back in.");
}

