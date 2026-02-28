// Echo Messenger (web) — Retro Yahoo-style GUI
// Single-file client: UI + Socket.IO + E2EE DM envelopes
//
// Notes:
// - Auth is cookie-based (JWT in access_token_cookie).
// - DMs are ciphertext-only relay via Socket.IO.
// - Rooms can be ciphertext-only (ECR1: envelopes); server never decrypts.

// ───────────────────────────────────────────────────────────────────────────────
// Socket connection
// ───────────────────────────────────────────────────────────────────────────────
// IMPORTANT:
// Server currently runs Flask-SocketIO with async_mode="threading" (dev-safe),
// which does NOT support WebSocket transport. Force long-polling to avoid
// repeated WebSocket connection errors in the browser console.
const socket = io({
  transports: ["polling"],
  upgrade: false,
  withCredentials: true,

  // Connection resilience:
  // - Keep trying to reconnect on transient network/server restarts.
  // - We only send the user back to /login on *auth* failures (refresh/token invalid),
  //   or explicit server-side logout events.
  reconnection: true,
  reconnectionAttempts: Infinity,
  reconnectionDelay: 600,
  reconnectionDelayMax: 6000,
  timeout: 20000,

  // Don't auto-connect; we first try to refresh the short-lived access token.
  autoConnect: false
});

// When the server rejects Socket.IO events because the access JWT expired,
// we try a silent refresh + reconnect. This flag suppresses the generic
// "disconnect → redirect to login" path during that recovery.
let AUTH_RECOVERY_IN_PROGRESS = false;
// ───────────────────────────────────────────────────────────────────────────────
// Connection status banner (do NOT redirect to /login on transient disconnects)
// ───────────────────────────────────────────────────────────────────────────────
let EC_HAS_EVER_CONNECTED = false;
let EC_CONN_BANNER = null;
let EC_CONN_STATE = "init";
let EC_CONN_ATTEMPT = 0;
let EC_CONN_LAST_REASON = "";

function ensureConnBanner() {
  if (EC_CONN_BANNER) return EC_CONN_BANNER;
  const el = document.createElement("div");
  el.id = "ecConnBanner";
  el.className = "ec-conn hidden";
  el.innerHTML = `
    <div class="ec-conn-inner">
      <div class="ec-conn-left">
        <span class="ec-spinner" aria-hidden="true"></span>
        <span id="ecConnText" class="ec-conn-text">Connecting…</span>
      </div>
      <div class="ec-conn-right">
        <button id="ecConnRetry" class="miniBtn">Retry</button>
        <button id="ecConnLogout" class="miniBtn danger" title="Log out">Logout</button>
      </div>
    </div>
  `;
  (document.body || document.documentElement).appendChild(el);
  EC_CONN_BANNER = el;

  // Buttons
  el.querySelector("#ecConnRetry")?.addEventListener("click", () => {
    tryReconnectNow("manual_retry");
  });
  el.querySelector("#ecConnLogout")?.addEventListener("click", () => {
    bestEffortLogoutThenRedirect("user_logout").catch(() => {
      window.location.href = "/login?reason=user_logout";
    });
  });

  return el;
}

function setConnBanner(state, text, { spinner = true, showRetry = true } = {}) {
  EC_CONN_STATE = String(state || "");
  const el = ensureConnBanner();
  const t = el.querySelector("#ecConnText");
  if (t) t.textContent = String(text || "");
  el.classList.remove("hidden");
  el.classList.toggle("no-spinner", !spinner);
  el.classList.toggle("no-retry", !showRetry);
}

function hideConnBanner() {
  if (!EC_CONN_BANNER) return;
  EC_CONN_BANNER.classList.add("hidden");
  EC_CONN_BANNER.classList.remove("no-spinner", "no-retry");
  EC_CONN_STATE = "connected";
  EC_CONN_ATTEMPT = 0;
  EC_CONN_LAST_REASON = "";
}

function tryReconnectNow(reason = "") {
  // If server disconnected us, Socket.IO won't auto-reconnect until we call connect().
  // If we're offline, just show the banner and wait for the browser "online" event.
  EC_CONN_LAST_REASON = String(reason || EC_CONN_LAST_REASON || "");
  if (navigator && navigator.onLine === false) {
    setConnBanner("offline", "📡 Offline — waiting for network…", { spinner: false, showRetry: false });
    return;
  }
  try {
    if (!socket.connected) socket.connect();
  } catch {}
}

const currentUser = window.USERNAME || "guest";
const USER_PERMS = new Set(Array.isArray(window.USER_PERMS) ? window.USER_PERMS.map(String) : []);

// WebCrypto (SubtleCrypto) is only available in a *secure context* (HTTPS or localhost).
const HAS_WEBCRYPTO = !!(window.isSecureContext && window.crypto && window.crypto.subtle);

// ───────────────────────────────────────────────────────────────────────────────
// Settings (localStorage)
// ───────────────────────────────────────────────────────────────────────────────
const Settings = {
  get(key, fallback) {
    try {
      const raw = localStorage.getItem("ec_" + key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  },
  set(key, val) {
    try {
      localStorage.setItem("ec_" + key, JSON.stringify(val));
    } catch {
      // Some browser contexts/extensions block storage; fall back to in-memory prefs.
    }
  }
};

const UIState = {
  highestZ: 1000,
  windows: new Map(),      // id -> window element
  minimized: new Map(),    // id -> task button element
  activeTab: "friends",
  currentRoom: null,       // server-side one room at a time
  roomsCache: [],          // last known room list for re-rendering (policy badges)
  roomUsers: new Map(),    // room -> [usernames] (last known)
  roomPolicy: new Map(),   // room -> {locked, readonly, slowmode_seconds, can_send, ...}
  groupMembers: new Map(), // group_id -> [usernames] (last known)
  roomEmbedRoom: null,     // room currently shown in the left embedded pane
  presence: new Map(),     // username -> {online, presence, custom_status, last_seen}
  unlockSkipped: false,
  prefs: {
    darkMode: Settings.get("darkMode", true),
    accentTheme: Settings.get("accentTheme", "default"),
    popupNotif: Settings.get("popupNotif", false),
    soundNotif: Settings.get("soundNotif", true),
    rememberUnlock: true,
    roomFontSize: Settings.get("roomFontSize", 12),
    missedToast: Settings.get("missedToast", true),
    savePmLocal: Settings.get("savePmLocal", false)
  }
};

function clampInt(v, min, max, fallback) {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function applyRoomFontSize(px) {
  const val = clampInt(px, 10, 22, 12);
  document.documentElement.style.setProperty("--room-font-size", `${val}px`);
  const out = $("setRoomFontSizeVal");
  if (out) out.textContent = `${val}px`;
}



// ───────────────────────────────────────────────────────────────────────────────
// Local PM history (client-side only)
//
// - Stored in browser localStorage (per-device)
// - Only saved if the user enables it in Settings
// - Intended for *client* convenience; server remains ciphertext-only for DMs
// ───────────────────────────────────────────────────────────────────────────────
const PM_HISTORY_KEY = "pmHistoryV1";
const PM_HISTORY_MAX_PER_CONV = 500;

function loadPmHistory() {
  const d = Settings.get(PM_HISTORY_KEY, { v: 1, convs: {} });
  if (!d || typeof d !== "object") return { v: 1, convs: {} };
  if (!d.convs || typeof d.convs !== "object") d.convs = {};
  return d;
}

function savePmHistory(d) {
  Settings.set(PM_HISTORY_KEY, d);
}

function getPmHistory(peer) {
  const d = loadPmHistory();
  const arr = d.convs[peer];
  return Array.isArray(arr) ? arr : [];
}

function addPmHistory(peer, dir, text, tsSec = null) {
  if (!UIState.prefs.savePmLocal) return;
  if (!peer || !text) return;

  const d = loadPmHistory();
  const arr = Array.isArray(d.convs[peer]) ? d.convs[peer] : [];
  const ts = (typeof tsSec === "number" && !Number.isNaN(tsSec)) ? tsSec : (Date.now() / 1000);

  arr.push({ dir, ts, text: String(text) });
  if (arr.length > PM_HISTORY_MAX_PER_CONV) {
    d.convs[peer] = arr.slice(arr.length - PM_HISTORY_MAX_PER_CONV);
  } else {
    d.convs[peer] = arr;
  }
  savePmHistory(d);
}

function clearPmHistory() {
  savePmHistory({ v: 1, convs: {} });
  toast("🧹 Local PM history cleared", "ok");
}

function downloadTextFile(filename, content, mime = "application/json") {
  try {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2500);
  } catch (e) {
    console.error(e);
    toast("❌ Download failed", "error");
  }
}

function downloadBlob(filename, blob) {
  try {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2500);
  } catch (e) {
    console.error(e);
    toast("❌ Download failed", "error");
  }
}

function humanBytes(n) {
  const num = Number(n);
  if (!Number.isFinite(num) || num <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let u = 0;
  let v = num;
  while (v >= 1024 && u < units.length - 1) {
    v = v / 1024;
    u++;
  }
  const fixed = (u === 0) ? String(Math.round(v)) : v.toFixed(v >= 10 ? 1 : 2);
  return `${fixed} ${units[u]}`;
}

// ───────────────────────────────────────────────────────────────────────────────
// Torrent helpers (bencode parse + tracker scrape via server)
// ───────────────────────────────────────────────────────────────────────────────
// A small default tracker set (best-effort). Used when a magnet has no trackers.
// Note: many public trackers are UDP, which requires the server's UDP scrape support.
const DEFAULT_PUBLIC_TRACKERS = [
  "udp://tracker.opentrackr.org:1337/announce",
  "udp://open.stealth.si:80/announce",
  "udp://tracker.torrent.eu.org:451/announce",
  "udp://tracker.moeking.me:6969/announce",
  "https://tracker2.ctix.cn:443/announce",
  "https://tracker.tamersunion.org:443/announce"
];

function _hexFromBytes(u8) {
  return Array.from(u8).map(b => b.toString(16).padStart(2, "0")).join("");
}

async function sha1HexFromBytes(u8) {
  if (!HAS_WEBCRYPTO) throw new Error("WebCrypto required");
  const digest = await crypto.subtle.digest("SHA-1", u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength));
  return _hexFromBytes(new Uint8Array(digest));
}

function _bdecodeWithInfoSlice(bytes) {
  // Minimal bencode decoder that also captures the raw bencoded "info" dict slice.
  let i = 0;
  const td = new TextDecoder("utf-8");
  let infoStart = null, infoEnd = null;

  const parse = () => {
    const c = bytes[i];
    if (c === 0x69) { // i
      i++;
      const end = bytes.indexOf(0x65, i);
      const num = parseInt(td.decode(bytes.slice(i, end)), 10);
      i = end + 1;
      return num;
    }
    if (c === 0x6C) { // l
      i++;
      const arr = [];
      while (bytes[i] !== 0x65) arr.push(parse());
      i++;
      return arr;
    }
    if (c === 0x64) { // d
      i++;
      const obj = {};
      while (bytes[i] !== 0x65) {
        const kBytes = parse();
        const key = td.decode(kBytes);
        if (key === "info") {
          infoStart = i;
          obj[key] = parse();
          infoEnd = i;
        } else {
          obj[key] = parse();
        }
      }
      i++;
      return obj;
    }
    // bytes: <len>:<payload>
    let colon = bytes.indexOf(0x3A, i);
    const len = parseInt(td.decode(bytes.slice(i, colon)), 10);
    i = colon + 1;
    const out = bytes.slice(i, i + len);
    i += len;
    return out;
  };

  const root = parse();
  const infoSlice = (infoStart !== null && infoEnd !== null) ? bytes.slice(infoStart, infoEnd) : null;
  return { root, infoSlice };
}

function _u8ToUtf8(u8) {
  try { return new TextDecoder("utf-8").decode(u8); } catch { return ""; }
}

function parseTorrentBytes(u8) {
  const { root, infoSlice } = _bdecodeWithInfoSlice(u8);
  const t = root || {};
  const info = t.info || {};
  const name = info.name ? _u8ToUtf8(info.name) : "Torrent";

  const trackers = [];
  if (t.announce) trackers.push(_u8ToUtf8(t.announce));
  if (Array.isArray(t["announce-list"])) {
    for (const tier of t["announce-list"]) {
      if (!Array.isArray(tier)) continue;
      for (const tr of tier) trackers.push(_u8ToUtf8(tr));
    }
  }
  const uniqTrackers = [...new Set(trackers.filter(Boolean))].slice(0, 25);

  let totalSize = 0;
  if (typeof info.length === "number") totalSize = info.length;
  if (Array.isArray(info.files)) {
    totalSize = 0;
    for (const f of info.files) totalSize += (typeof f.length === "number" ? f.length : 0);
  }

  const creation_date = (typeof t["creation date"] === "number") ? new Date(t["creation date"] * 1000).toISOString() : "";
  const created_by = t["created by"] ? _u8ToUtf8(t["created by"]) : "";
  const comment = t.comment ? _u8ToUtf8(t.comment) : "";

  return { name, trackers: uniqTrackers, total_size: totalSize, infoSlice, created_by, creation_date, comment };
}

function buildMagnet(infohashHex, name, trackers = []) {
  const xt = `urn:btih:${String(infohashHex || "").toLowerCase()}`;
  const params = new URLSearchParams();
  params.set("xt", xt);
  if (name) params.set("dn", name);
  for (const tr of (trackers || []).slice(0, 15)) params.append("tr", tr);
  return "magnet:?" + params.toString();
}

function _base32ToHex(s) {
  // Decode 32-char base32 (A-Z2-7) to 20-byte infohash, return hex.
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const clean = String(s || "").trim().toUpperCase().replace(/=+$/g, "");
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    const idx = alphabet.indexOf(ch);
    if (idx === -1) return null;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >>> bits) & 0xff);
    }
  }
  if (out.length !== 20) return null;
  return _hexFromBytes(new Uint8Array(out));
}

function parseMagnet(magnetText) {
  const raw = String(magnetText || "").trim();
  if (!raw.toLowerCase().startsWith("magnet:?")) return null;
  const q = raw.slice(raw.indexOf("?") + 1);
  const params = new URLSearchParams(q);
  const xts = params.getAll("xt");
  let infohash = "";
  for (const xt of xts) {
    const v = String(xt || "");
    const m = v.match(/urn:btih:([a-zA-Z0-9]+)/i);
    if (!m) continue;
    const token = m[1];
    if (/^[0-9a-fA-F]{40}$/.test(token)) {
      infohash = token.toLowerCase();
      break;
    }
    if (/^[A-Z2-7]{32}$/i.test(token)) {
      const hex = _base32ToHex(token);
      if (hex) { infohash = hex.toLowerCase(); break; }
    }
  }
  if (!infohash) return null;

  const dn = params.get("dn") || "";
  const trackers = params.getAll("tr").map(String).filter(Boolean);
  const usableTrackers = trackers.length ? trackers : DEFAULT_PUBLIC_TRACKERS;

  // Canonical magnet we share/copy (ensures trackers exist)
  const canonical = buildMagnet(infohash, dn, usableTrackers);
  return { infohash, name: dn, trackers: usableTrackers, magnet: canonical };
}

function isMagnetText(text) {
  const s = String(text || "").trim();
  return s.toLowerCase().startsWith("magnet:?");
}

async function fetchTorrentSwarm(infohashHex, trackers = []) {
  try {
    const resp = await fetchWithAuth("/api/torrent/scrape", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ infohash_hex: String(infohashHex || ""), trackers: (trackers || []).slice(0, 12) })
    });
    const data = await resp.json().catch(() => null);
    if (!resp.ok || !data?.success) return { seeds: null, leechers: null, completed: null };
    return {
      seeds: (data.seeds === null || data.seeds === undefined) ? null : Number(data.seeds),
      leechers: (data.leechers === null || data.leechers === undefined) ? null : Number(data.leechers),
      completed: (data.completed === null || data.completed === undefined) ? null : Number(data.completed),
    };
  } catch {
    return { seeds: null, leechers: null, completed: null };
  }
}

async function sendTorrentShare(toUser, file, { win } = {}) {
  if (!file || !toUser) return;

  let meta = null;
  try {
    const ab = await file.arrayBuffer();
    const u8 = new Uint8Array(ab);
    const parsed = parseTorrentBytes(u8);
    const infohash = parsed.infoSlice ? await sha1HexFromBytes(parsed.infoSlice) : "";
    const magnet = infohash ? buildMagnet(infohash, parsed.name, parsed.trackers) : "";
    // IMPORTANT (UX): do NOT block sending on tracker scrape.
    // Scraping can take 10–60s when trackers are slow/unreachable.
    // Torrent cards already self-refresh swarm stats asynchronously.
    const swarm = { seeds: null, leechers: null, completed: null };

    meta = {
      _ec: "torrent",
      name: parsed.name || file.name,
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
  } catch (e) {
    toast("⚠️ Could not parse torrent; sending as a normal file", "warn");
  }

  if (meta) {
    try {
      await sendPrivateTo(toUser, JSON.stringify(meta));
      if (win) appendTorrentLine(win, "You:", { ...meta, file_name: file.name });
    } catch {
      toast("⚠️ Could not send torrent metadata (still sending file)…", "warn");
    }
  }

  await sendDmFileTo(toUser, file, { win });
}

async function sendTorrentMagnetShare(toUser, magnetText, { win } = {}) {
  if (!toUser) return;
  const parsed = parseMagnet(magnetText);
  if (!parsed) {
    toast("⚠️ Invalid magnet link", "warn");
    return;
  }

  // IMPORTANT (UX): do NOT block sending on tracker scrape.
  // Torrent cards already self-refresh swarm stats asynchronously.
  const swarm = { seeds: null, leechers: null, completed: null };

  const meta = {
    _ec: "torrent",
    name: parsed.name || "Magnet",
    infohash: parsed.infohash,
    magnet: parsed.magnet,
    total_size: 0,
    seeds: swarm.seeds,
    leechers: swarm.leechers,
    completed: swarm.completed,
    trackers: parsed.trackers || []
  };

  await sendPrivateTo(toUser, JSON.stringify(meta));
  if (win) appendTorrentLine(win, "You:", meta);
  return meta;
}


function downloadPmHistory() {
  const d = loadPmHistory();
  const json = JSON.stringify(d, null, 2);
  downloadTextFile(`echochat_pm_history_${currentUser}_${new Date().toISOString().slice(0,10)}.json`, json);
}

function ensureDmHistoryRendered(win, peer) {
  if (!win || !peer) return;
  if (!UIState.prefs.savePmLocal) return;

  // Render once per window instance.
  if (win.dataset.pmHistoryRendered === "1") return;
  win.dataset.pmHistoryRendered = "1";

  const hist = getPmHistory(peer);
  if (!hist.length) return;

  appendLine(win, "System:", `Loaded ${hist.length} local history message(s).`);
  for (const h of hist) {
    const tag = (h.dir === "out") ? "You:" : `${peer}:`;
    appendLine(win, tag, h.text);
  }
}
// Audio is blocked until a user gesture (browser autoplay policy).
// Arm sound after the first pointer interaction to avoid console spam.
let AUDIO_ARMED = false;
document.addEventListener("pointerdown", () => { AUDIO_ARMED = true; }, { once: true });

// ───────────────────────────────────────────────────────────────────────────────
// DOM helpers
// ───────────────────────────────────────────────────────────────────────────────
function $(id) { return document.getElementById(id); }

function setThemeFromPrefs() {
  const root = $("appRoot");
  const dark = !!UIState.prefs.darkMode;

  const raw = String(UIState.prefs.accentTheme || "default");
  const accent = (["default", "blue", "purple"].includes(raw) ? raw : "default");
  const accentClasses = ["accent-default", "accent-blue", "accent-purple"];

  document.body.classList.toggle("theme-dark", dark);
  document.body.classList.toggle("theme-light", !dark);
  document.body.classList.remove(...accentClasses);
  document.body.classList.add(`accent-${accent}`);

  if (root) {
    root.classList.toggle("theme-dark", dark);
    root.classList.toggle("theme-light", !dark);
    root.classList.remove(...accentClasses);
    root.classList.add(`accent-${accent}`);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (m) => ({
    "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"
  }[m]));
}

// ───────────────────────────────────────────────────────────────────────────────
// Emoticons / Emoji picker (rooms + DMs + groups)
//
// Design goals:
// - Zero server changes (emoji are just Unicode text)
// - Works everywhere we have a message <input>
// - One shared popover instance (lighter + fewer event listeners)
// ───────────────────────────────────────────────────────────────────────────────

const EMOJI_RECENT_KEY = "recentEmojisV1";

// Minimal curated set (common chat emoticons). Add more anytime.
// Each entry: { e: "😀", n: "grinning face", cat: "smileys", k: "keywords" }
const EMOJI_DB = [
  // Smileys
  { e: "😀", n: "grinning face", cat: "smileys", k: "grin smile happy" },
  { e: "😃", n: "grinning face with big eyes", cat: "smileys", k: "grin smile happy" },
  { e: "😄", n: "grinning face with smiling eyes", cat: "smileys", k: "grin laugh" },
  { e: "😁", n: "beaming face with smiling eyes", cat: "smileys", k: "grin teeth" },
  { e: "😆", n: "grinning squinting face", cat: "smileys", k: "laugh haha" },
  { e: "😅", n: "grinning face with sweat", cat: "smileys", k: "laugh nervous" },
  { e: "🤣", n: "rolling on the floor laughing", cat: "smileys", k: "rofl lol" },
  { e: "😂", n: "face with tears of joy", cat: "smileys", k: "lol laugh" },
  { e: "🙂", n: "slightly smiling face", cat: "smileys", k: "smile" },
  { e: "🙃", n: "upside-down face", cat: "smileys", k: "silly" },
  { e: "😉", n: "winking face", cat: "smileys", k: "wink" },
  { e: "😊", n: "smiling face with smiling eyes", cat: "smileys", k: "blush happy" },
  { e: "😇", n: "smiling face with halo", cat: "smileys", k: "angel" },
  { e: "😍", n: "smiling face with heart-eyes", cat: "smileys", k: "love" },
  { e: "🥰", n: "smiling face with hearts", cat: "smileys", k: "love" },
  { e: "😘", n: "face blowing a kiss", cat: "smileys", k: "kiss" },
  { e: "😗", n: "kissing face", cat: "smileys", k: "kiss" },
  { e: "😋", n: "face savoring food", cat: "smileys", k: "yum" },
  { e: "😜", n: "winking face with tongue", cat: "smileys", k: "silly" },
  { e: "😝", n: "squinting face with tongue", cat: "smileys", k: "silly" },
  { e: "😎", n: "smiling face with sunglasses", cat: "smileys", k: "cool" },
  { e: "🤓", n: "nerd face", cat: "smileys", k: "geek" },
  { e: "🫠", n: "melting face", cat: "smileys", k: "melt" },
  { e: "😏", n: "smirking face", cat: "smileys", k: "smirk" },
  { e: "😒", n: "unamused face", cat: "smileys", k: "meh" },
  { e: "🙄", n: "face with rolling eyes", cat: "smileys", k: "eyeroll" },
  { e: "😔", n: "pensive face", cat: "smileys", k: "sad" },
  { e: "😢", n: "crying face", cat: "smileys", k: "sad cry" },
  { e: "😭", n: "loudly crying face", cat: "smileys", k: "sad cry" },
  { e: "😤", n: "face with steam from nose", cat: "smileys", k: "angry" },
  { e: "😡", n: "pouting face", cat: "smileys", k: "angry mad" },
  { e: "🤬", n: "face with symbols on mouth", cat: "smileys", k: "angry swearing" },
  { e: "😱", n: "face screaming in fear", cat: "smileys", k: "scared" },
  { e: "😴", n: "sleeping face", cat: "smileys", k: "sleep" },
  { e: "🤯", n: "exploding head", cat: "smileys", k: "mind blown" },
  { e: "🤔", n: "thinking face", cat: "smileys", k: "think" },
  { e: "🫡", n: "saluting face", cat: "smileys", k: "salute" },

  // People / gestures
  { e: "👍", n: "thumbs up", cat: "people", k: "like yes" },
  { e: "👎", n: "thumbs down", cat: "people", k: "dislike no" },
  { e: "👋", n: "waving hand", cat: "people", k: "hello hi bye" },
  { e: "👏", n: "clapping hands", cat: "people", k: "clap" },
  { e: "🙏", n: "folded hands", cat: "people", k: "pray thanks" },
  { e: "🤝", n: "handshake", cat: "people", k: "deal" },
  { e: "💪", n: "flexed biceps", cat: "people", k: "strong" },
  { e: "🫶", n: "heart hands", cat: "people", k: "love" },
  { e: "✌️", n: "victory hand", cat: "people", k: "peace" },
  { e: "🤘", n: "sign of the horns", cat: "people", k: "rock" },
  { e: "🤙", n: "call me hand", cat: "people", k: "phone" },

  // Animals
  { e: "🐶", n: "dog", cat: "animals", k: "pet" },
  { e: "🐱", n: "cat", cat: "animals", k: "pet" },
  { e: "🐭", n: "mouse", cat: "animals", k: "animal" },
  { e: "🐹", n: "hamster", cat: "animals", k: "animal" },
  { e: "🐰", n: "rabbit", cat: "animals", k: "bunny" },
  { e: "🦊", n: "fox", cat: "animals", k: "animal" },
  { e: "🐻", n: "bear", cat: "animals", k: "animal" },
  { e: "🐼", n: "panda", cat: "animals", k: "animal" },
  { e: "🐸", n: "frog", cat: "animals", k: "animal" },
  { e: "🦄", n: "unicorn", cat: "animals", k: "magic" },
  { e: "🐔", n: "chicken", cat: "animals", k: "animal" },
  { e: "🐧", n: "penguin", cat: "animals", k: "animal" },
  { e: "🐢", n: "turtle", cat: "animals", k: "animal" },

  // Food
  { e: "🍕", n: "pizza", cat: "food", k: "food" },
  { e: "🍔", n: "hamburger", cat: "food", k: "food" },
  { e: "🌮", n: "taco", cat: "food", k: "food" },
  { e: "🍟", n: "fries", cat: "food", k: "food" },
  { e: "🍣", n: "sushi", cat: "food", k: "food" },
  { e: "🍪", n: "cookie", cat: "food", k: "food" },
  { e: "🍩", n: "doughnut", cat: "food", k: "food" },
  { e: "☕", n: "hot beverage", cat: "food", k: "coffee" },
  { e: "🍺", n: "beer", cat: "food", k: "drink" },

  // Activities
  { e: "🎮", n: "video game", cat: "activity", k: "gaming" },
  { e: "🎧", n: "headphone", cat: "activity", k: "music" },
  { e: "🎸", n: "guitar", cat: "activity", k: "music" },
  { e: "🏆", n: "trophy", cat: "activity", k: "win" },
  { e: "⚽", n: "soccer", cat: "activity", k: "sports" },
  { e: "🏀", n: "basketball", cat: "activity", k: "sports" },

  // Travel / places
  { e: "🚗", n: "car", cat: "travel", k: "drive" },
  { e: "✈️", n: "airplane", cat: "travel", k: "flight" },
  { e: "🗺️", n: "map", cat: "travel", k: "travel" },
  { e: "🏠", n: "house", cat: "travel", k: "home" },
  { e: "🌎", n: "globe", cat: "travel", k: "world" },

  // Objects
  { e: "📎", n: "paperclip", cat: "objects", k: "file" },
  { e: "📷", n: "camera", cat: "objects", k: "photo" },
  { e: "📱", n: "mobile phone", cat: "objects", k: "phone" },
  { e: "💻", n: "laptop", cat: "objects", k: "computer" },
  { e: "🖥️", n: "desktop computer", cat: "objects", k: "computer" },
  { e: "⌨️", n: "keyboard", cat: "objects", k: "computer" },
  { e: "🖱️", n: "mouse", cat: "objects", k: "computer" },
  { e: "🔒", n: "lock", cat: "objects", k: "security" },
  { e: "🔑", n: "key", cat: "objects", k: "security" },
  { e: "🧲", n: "magnet", cat: "objects", k: "torrent magnet" },

  // Symbols
  { e: "❤️", n: "red heart", cat: "symbols", k: "love" },
  { e: "💔", n: "broken heart", cat: "symbols", k: "sad" },
  { e: "✨", n: "sparkles", cat: "symbols", k: "sparkle" },
  { e: "🔥", n: "fire", cat: "symbols", k: "lit" },
  { e: "✅", n: "check", cat: "symbols", k: "ok" },
  { e: "❌", n: "cross mark", cat: "symbols", k: "no" },
  { e: "⚠️", n: "warning", cat: "symbols", k: "warn" },
  { e: "💯", n: "hundred points", cat: "symbols", k: "100" },
  { e: "⭐", n: "star", cat: "symbols", k: "favorite" }
];

const EMOJI_CATS = [
  { id: "recent", icon: "🕘", label: "Recent" },
  { id: "smileys", icon: "😀", label: "Smileys" },
  { id: "people", icon: "👍", label: "People" },
  { id: "animals", icon: "🐶", label: "Animals" },
  { id: "food", icon: "🍕", label: "Food" },
  { id: "activity", icon: "🎮", label: "Activity" },
  { id: "travel", icon: "✈️", label: "Travel" },
  { id: "objects", icon: "💻", label: "Objects" },
  { id: "symbols", icon: "❤️", label: "Symbols" }
];

function loadRecentEmojis() {
  const arr = Settings.get(EMOJI_RECENT_KEY, []);
  return Array.isArray(arr) ? arr.filter(x => typeof x === "string" && x.length <= 8) : [];
}

function bumpRecentEmoji(emoji) {
  try {
    const cur = loadRecentEmojis();
    const next = [emoji, ...cur.filter(e => e !== emoji)].slice(0, 24);
    Settings.set(EMOJI_RECENT_KEY, next);
  } catch { /* ignore */ }
}

function insertAtCursor(inputEl, text) {
  if (!inputEl) return;
  const v = String(inputEl.value || "");
  const start = (typeof inputEl.selectionStart === "number") ? inputEl.selectionStart : v.length;
  const end = (typeof inputEl.selectionEnd === "number") ? inputEl.selectionEnd : v.length;
  const next = v.slice(0, start) + text + v.slice(end);
  inputEl.value = next;
  const pos = start + text.length;
  try { inputEl.setSelectionRange(pos, pos); } catch { /* ignore */ }
  inputEl.focus();
  try { inputEl.dispatchEvent(new Event("input", { bubbles: true })); } catch { /* ignore */ }
}

const EmojiUI = {
  pop: null,
  search: null,
  tabs: null,
  grid: null,
  empty: null,
  activeInput: null,
  activeAnchor: null,
  activeCat: "recent",
  visible: false
};

function ensureEmojiPopover() {
  if (EmojiUI.pop) return EmojiUI.pop;

  const pop = document.createElement("div");
  pop.id = "ecEmojiPopover";
  pop.className = "ec-emojiPopover hidden";
  pop.setAttribute("role", "dialog");
  pop.setAttribute("aria-label", "Emoticons");

  const head = document.createElement("div");
  head.className = "ec-emojiHead";

  const search = document.createElement("input");
  search.type = "text";
  search.className = "ec-emojiSearch";
  search.placeholder = "Search emoticons…";
  search.autocomplete = "off";

  const close = document.createElement("button");
  close.type = "button";
  close.className = "ec-emojiClose";
  close.title = "Close";
  close.textContent = "×";

  head.appendChild(search);
  head.appendChild(close);

  const tabs = document.createElement("div");
  tabs.className = "ec-emojiTabs";

  EMOJI_CATS.forEach((c) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "ec-emojiTab";
    b.dataset.cat = c.id;
    b.title = c.label;
    b.textContent = c.icon;
    tabs.appendChild(b);
  });

  const grid = document.createElement("div");
  grid.className = "ec-emojiGrid";

  const empty = document.createElement("div");
  empty.className = "ec-emojiEmpty hidden";
  empty.textContent = "No matches";

  pop.appendChild(head);
  pop.appendChild(tabs);
  pop.appendChild(grid);
  pop.appendChild(empty);
  document.body.appendChild(pop);

  const setActiveTab = (cat) => {
    EmojiUI.activeCat = cat;
    tabs.querySelectorAll(".ec-emojiTab").forEach((el) => {
      el.classList.toggle("active", el.dataset.cat === cat);
    });
  };

  const getList = () => {
    const q = (search.value || "").trim().toLowerCase();
    if (q) {
      return EMOJI_DB.filter((x) => {
        const hay = `${x.n} ${x.k}`.toLowerCase();
        return hay.includes(q) || x.e.includes(q);
      });
    }
    if (EmojiUI.activeCat === "recent") {
      const rec = loadRecentEmojis();
      const map = new Map(EMOJI_DB.map(x => [x.e, x]));
      const out = [];
      rec.forEach((e) => {
        const obj = map.get(e);
        if (obj) out.push(obj);
        else out.push({ e, n: "recent", cat: "recent", k: "" });
      });
      // If nothing yet, show a few defaults.
      if (!out.length) {
        return EMOJI_DB.filter(x => x.cat === "smileys").slice(0, 24);
      }
      return out;
    }
    return EMOJI_DB.filter(x => x.cat === EmojiUI.activeCat);
  };

  const render = () => {
    const list = getList();
    grid.innerHTML = "";
    if (!list.length) {
      empty.classList.remove("hidden");
      return;
    }
    empty.classList.add("hidden");
    list.slice(0, 240).forEach((x) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "ec-emojiCell";
      b.textContent = x.e;
      b.title = x.n;
      b.onclick = () => {
        if (EmojiUI.activeInput) insertAtCursor(EmojiUI.activeInput, x.e);
        bumpRecentEmoji(x.e);
        closeEmojiPicker();
      };
      grid.appendChild(b);
    });
  };

  const position = () => {
    if (!EmojiUI.activeAnchor) return;
    const r = EmojiUI.activeAnchor.getBoundingClientRect();
    const w = 320;
    const h = 320;
    let left = Math.max(8, Math.min(window.innerWidth - w - 8, r.right - w));
    let top = r.top - h - 8;
    if (top < 8) top = Math.min(window.innerHeight - h - 8, r.bottom + 8);
    pop.style.left = `${left}px`;
    pop.style.top = `${top}px`;
  };

  const open = () => {
    setActiveTab(EmojiUI.activeCat || "recent");
    render();
    position();
    pop.classList.remove("hidden");
    EmojiUI.visible = true;
    setTimeout(() => search.focus(), 0);
  };

  const closeFn = () => closeEmojiPicker();

  // Events
  close.onclick = closeFn;
  tabs.addEventListener("click", (e) => {
    const t = e.target;
    if (!(t instanceof HTMLElement)) return;
    if (!t.dataset.cat) return;
    setActiveTab(t.dataset.cat);
    search.value = "";
    render();
    search.focus();
  });
  search.addEventListener("input", render);
  search.addEventListener("keydown", (e) => { if (e.key === "Escape") closeFn(); });

  // One global outside-click handler
  if (!document.body.dataset.ecEmojiOutsideBound) {
    document.body.dataset.ecEmojiOutsideBound = "1";
    document.addEventListener("mousedown", (e) => {
      if (!EmojiUI.visible || !EmojiUI.pop) return;
      const t = e.target;
      if (!(t instanceof Node)) return;
      if (EmojiUI.pop.contains(t)) return;
      if (EmojiUI.activeAnchor && EmojiUI.activeAnchor.contains(t)) return;
      closeEmojiPicker();
    });
    window.addEventListener("resize", () => { if (EmojiUI.visible) closeEmojiPicker(); });
    window.addEventListener("scroll", () => { if (EmojiUI.visible) closeEmojiPicker(); }, true);
    document.addEventListener("keydown", (e) => { if (EmojiUI.visible && e.key === "Escape") closeEmojiPicker(); });
  }

  // Expose for openEmojiPicker
  EmojiUI.pop = pop;
  EmojiUI.search = search;
  EmojiUI.tabs = tabs;
  EmojiUI.grid = grid;
  EmojiUI.empty = empty;
  pop._ecOpen = open;
  pop._ecRender = render;
  pop._ecPosition = position;
  return pop;
}

function openEmojiPicker(anchorEl, inputEl) {
  const pop = ensureEmojiPopover();
  EmojiUI.activeInput = inputEl || null;
  EmojiUI.activeAnchor = anchorEl || null;
  EmojiUI.activeCat = "recent";
  if (EmojiUI.search) EmojiUI.search.value = "";
  pop._ecOpen && pop._ecOpen();
}

function closeEmojiPicker() {
  if (!EmojiUI.pop) return;
  EmojiUI.pop.classList.add("hidden");
  EmojiUI.visible = false;
  EmojiUI.activeInput = null;
  EmojiUI.activeAnchor = null;
}

function bindEmojiButton(btnEl, inputEl) {
  if (!btnEl || !inputEl) return;
  if (btnEl.dataset.ecEmojiBound === "1") return;
  btnEl.dataset.ecEmojiBound = "1";
  btnEl.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    openEmojiPicker(btnEl, inputEl);
  });
}



// ───────────────────────────────────────────────────────────────────────────────
// GIF picker (GIPHY)
// ───────────────────────────────────────────────────────────────────────────────
const GifUI = {
  modal: null,
  card: null,
  closeBtn: null,
  search: null,
  searchBtn: null,
  status: null,
  grid: null,
  onPick: null,
  visible: false,
};

function ensureGifPicker() {
  if (GifUI.modal) return GifUI.modal;

  const overlay = document.createElement('div');
  overlay.id = 'ecGifPicker';
  overlay.className = 'ym-gifPicker hidden';

  overlay.innerHTML = `
    <div class="ym-gifCard" role="dialog" aria-modal="true" aria-label="GIF picker">
      <div class="ym-gifHead">
        <div class="ym-gifTitle">GIFs</div>
        <button type="button" class="winBtn danger ym-gifClose" title="Close">×</button>
      </div>
      <div class="ym-gifSearchRow">
        <input class="ym-gifSearch" type="text" placeholder="Search GIPHY…" autocomplete="off" />
        <button type="button" class="ym-send ym-gifSearchBtn">Search</button>
      </div>
      <div class="ym-gifStatus"></div>
      <div class="ym-gifGrid" aria-label="GIF results"></div>
    </div>
  `;

  document.body.appendChild(overlay);

  GifUI.modal = overlay;
  GifUI.card = overlay.querySelector('.ym-gifCard');
  GifUI.closeBtn = overlay.querySelector('.ym-gifClose');
  GifUI.search = overlay.querySelector('.ym-gifSearch');
  GifUI.searchBtn = overlay.querySelector('.ym-gifSearchBtn');
  GifUI.status = overlay.querySelector('.ym-gifStatus');
  GifUI.grid = overlay.querySelector('.ym-gifGrid');

  const close = () => closeGifPicker();

  GifUI.closeBtn?.addEventListener('click', (e) => { e.preventDefault(); close(); });
  overlay.addEventListener('mousedown', (e) => {
    // click outside the card closes
    const tgt = e.target;
    if (!tgt) return;
    if (tgt === overlay) close();
  });

  const doSearch = () => {
    const q = GifUI.search?.value?.trim() || '';
    gifSearch(q);
  };

  GifUI.searchBtn?.addEventListener('click', (e) => { e.preventDefault(); doSearch(); });
  GifUI.search?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doSearch();
    if (e.key === 'Escape') close();
  });

  // One-time global escape binding
  if (!document.body.dataset.ecGifEscapeBound) {
    document.body.dataset.ecGifEscapeBound = '1';
    document.addEventListener('keydown', (e) => {
      if (GifUI.visible && e.key === 'Escape') closeGifPicker();
    });
  }

  return overlay;
}

function openGifPicker(onPick, { prefill = '' } = {}) {
  const modal = ensureGifPicker();
  GifUI.onPick = (typeof onPick === 'function') ? onPick : null;

  if (GifUI.search) {
    GifUI.search.value = String(prefill || '');
    try { GifUI.search.focus(); GifUI.search.select(); } catch {}
  }

  // Show
  modal.classList.remove('hidden');
  GifUI.visible = true;

  // Auto-search on open if prefilled
  const q = (GifUI.search?.value || '').trim();
  if (q) gifSearch(q);
  else {
    if (GifUI.grid) GifUI.grid.innerHTML = '';
    if (GifUI.status) GifUI.status.textContent = 'Type a search, then hit Enter.';
  }
}

function closeGifPicker() {
  if (!GifUI.modal) return;
  GifUI.modal.classList.add('hidden');
  GifUI.visible = false;
  GifUI.onPick = null;
}

async function gifSearch(query) {
  const q = (query || '').trim();
  if (!GifUI.status || !GifUI.grid) return;

  if (!q) {
    GifUI.grid.innerHTML = '';
    GifUI.status.textContent = 'Type a search, then hit Enter.';
    return;
  }

  GifUI.status.textContent = 'Searching…';
  GifUI.grid.innerHTML = '';

  try {
    const resp = await fetchWithAuth(`/api/gifs/search?q=${encodeURIComponent(q)}&limit=24`, { method: 'GET' });
    const data = await resp.json().catch(() => null);
    if (!resp.ok || !data?.success) {
      const msg = data?.error || `HTTP ${resp.status}`;
      GifUI.status.textContent = `❌ ${msg}`;
      return;
    }

    const arr = Array.isArray(data?.data) ? data.data : [];
    if (!arr.length) {
      GifUI.status.textContent = 'No results.';
      return;
    }

    GifUI.status.textContent = `${arr.length} result(s)`;

    arr.forEach((g) => {
      const url = String(g?.url || '').trim();
      const pv = String(g?.preview || url).trim();
      if (!url) return;

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ym-gifItem';
      btn.title = (g?.title || 'GIF').toString().slice(0, 120);

      const img = document.createElement('img');
      img.loading = 'lazy';
      img.decoding = 'async';
      img.referrerPolicy = 'no-referrer';
      img.src = pv || url;
      img.alt = 'GIF';

      img.onerror = () => {
        const fb = _gifFallbackUrl(url) || _gifFallbackUrl(pv);
        if (fb && img.src !== fb) img.src = _gifCacheBust(fb);
      };
      btn.appendChild(img);
      btn.onclick = () => {
        try {
          if (GifUI.onPick) GifUI.onPick(url);
        } finally {
          closeGifPicker();
        }
      };

      GifUI.grid.appendChild(btn);
    });
  } catch (e) {
    console.error(e);
    GifUI.status.textContent = '❌ GIF search failed.';
  }
}

function getCookie(name) {
  const value = `; ${document.cookie}`;
  const parts = value.split(`; ${name}=`);
  if (parts.length === 2) return parts.pop().split(";").shift();
  return null;
}

// ───────────────────────────────────────────────────────────────────────────────
// Auth helpers (short-lived access token + refresh token in HttpOnly cookies)
// ───────────────────────────────────────────────────────────────────────────────
let _refreshPromise = null;

let _redirectingToLogin = false;

async function bestEffortLogoutThenRedirect(reason = 'disconnected') {
  // Used for *true* logout conditions (idle timeout, auth required, admin force logout).
  // Transient disconnects should NOT call this.
  if (_redirectingToLogin) return;
  _redirectingToLogin = true;

  try { sessionStorage.setItem('ec_disconnect_reason', String(reason)); } catch {}

  // Stop Socket.IO reconnection spam before navigating away.
  try { socket.io.opts.reconnection = false; } catch {}
  try { socket.disconnect(); } catch {}

  // Best-effort cookie clearing + session revoke. This may fail if the server is down.
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 1500);
    await fetch('/logout', { method: 'GET', credentials: 'same-origin', signal: controller.signal });
    clearTimeout(t);
  } catch {}

  window.location.href = `/login?reason=${encodeURIComponent(String(reason))}`;
}


// ───────────────────────────────────────────────────────────────────────────────
// Idle logout + activity pings
//
// Server enforces idle logout based on auth session's last_activity_at.
// We update last_activity_at from the browser based on real user interaction.
//
// Config:
//   window.ECHOCHAT_CFG.idle_logout_seconds (0 disables)
// ───────────────────────────────────────────────────────────────────────────────

const _idleCfg = (window.ECHOCHAT_CFG || {});
const _idleLimitMs = Math.max(0, Number(_idleCfg.idle_logout_seconds || 0)) * 1000;
let _lastUserInteractionMs = Date.now();
let _lastActivityPingMs = 0;

function _markUserInteraction() {
  _lastUserInteractionMs = Date.now();
  // Throttle activity pings to at most 1/minute.
  const now = _lastUserInteractionMs;
  if (now - _lastActivityPingMs < 60_000) return;
  _lastActivityPingMs = now;
  // Best-effort; failures are handled by fetchWithAuth (may refresh/redirect).
  fetchWithAuth("/api/activity", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  }).catch(() => {});
}

// Listen for interaction events (passive where possible).
window.addEventListener("mousemove", _markUserInteraction, { passive: true });
window.addEventListener("mousedown", _markUserInteraction, { passive: true });
window.addEventListener("keydown", _markUserInteraction, { passive: true });
window.addEventListener("scroll", _markUserInteraction, { passive: true });
window.addEventListener("touchstart", _markUserInteraction, { passive: true });
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) _markUserInteraction();
});

// Auto-logout when idle window is exceeded.
if (_idleLimitMs > 0) {
  setInterval(() => {
    const idleFor = Date.now() - _lastUserInteractionMs;
    if (idleFor > _idleLimitMs) {
      bestEffortLogoutThenRedirect("idle_timeout").catch(() => {
        // As a fallback, hard redirect.
        window.location.href = "/login?reason=idle_timeout";
      });
    }
  }, 30_000);
}


async function refreshAccessToken() {
  // De-dupe concurrent refresh attempts.
  if (_refreshPromise) return _refreshPromise;

  _refreshPromise = (async () => {
    const csrf = getCookie("csrf_refresh_token");
    const headers = csrf ? { "X-CSRF-TOKEN": csrf } : {};

    let resp;
    try {
      resp = await fetch("/token/refresh", {
        method: "POST",
        credentials: "same-origin",
        headers
      });
    } catch (e) {
      throw new Error('refresh network error');
    }

    if (!resp.ok) {
      // 409 = stale refresh (another tab/device likely rotated the refresh token).
      // Retry once after a short delay.
      if (resp.status === 409) {
        await new Promise(r => setTimeout(r, 250));
        let resp2;
        try {
          resp2 = await fetch("/token/refresh", {
            method: "POST",
            credentials: "same-origin",
            headers
          });
        } catch (_e) {
          throw new Error('refresh network error');
        }
        if (resp2.ok) return true;
        throw new Error(`refresh failed (${resp2.status})`);
      }
      // Let caller decide what to do (usually redirect to /login).
      throw new Error(`refresh failed (${resp.status})`);
    }
    return true;
  })();

  try {
    return await _refreshPromise;
  } finally {
    _refreshPromise = null;
  }
}

async function fetchWithAuth(url, options = {}, { retryOn401 = true, useRefreshCsrf = false } = {}) {
  const opts = { credentials: "same-origin", ...options };
  opts.headers = { ...(opts.headers || {}) };

  // JWT cookie CSRF protection: access requests use csrf_access_token,
  // refresh uses csrf_refresh_token.
  const csrfName = useRefreshCsrf ? "csrf_refresh_token" : "csrf_access_token";
  const csrfVal = getCookie(csrfName);
  if (csrfVal && !opts.headers["X-CSRF-TOKEN"]) {
    opts.headers["X-CSRF-TOKEN"] = csrfVal;
  }

  let resp;
  try {
    resp = await fetch(url, opts);
  } catch (e) {
    // Network/server down: stay in-app and show reconnect banner.
    setConnBanner("disconnected", "🔌 Connection lost — reconnecting…");
    tryReconnectNow("network_error");
    return new Response('', { status: 0 });
  }
  if (resp.status === 401 && retryOn401) {
    // Typical when the access token has expired.
    try {
      await refreshAccessToken();
      try {
        resp = await fetch(url, opts);
      } catch (e) {
        setConnBanner("disconnected", "🔌 Connection lost — reconnecting…");
        tryReconnectNow("network_error");
        return new Response('', { status: 0 });
      }
    } catch {
      // Refresh token likely expired/cleared.
      await bestEffortLogoutThenRedirect('auth_required');
      return resp;
    }
  }
  return resp;
}

async function xhrPostFormWithAuth(url, formData, { onProgress } = {}) {
  // XHR is used so we can show upload progress bars for server-fallback file transfers.
  const doOnce = () => new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url, true);
    xhr.withCredentials = true;

    const csrfVal = getCookie("csrf_access_token");
    if (csrfVal) xhr.setRequestHeader("X-CSRF-TOKEN", csrfVal);

    // If the browser/network stack wedges, XHR can appear to "do nothing".
    // Add a stall watchdog: if we see zero progress/state-change for too long,
    // abort so we can fall back to fetch().
    const TOTAL_TIMEOUT_MS = 60_000;
    const STALL_TIMEOUT_MS = 12_000;
    let lastActivity = Date.now();
    const bump = () => { lastActivity = Date.now(); };

    const stallTimer = setInterval(() => {
      if ((Date.now() - lastActivity) > STALL_TIMEOUT_MS) {
        try { xhr.abort(); } catch {}
      }
    }, 750);

    const cleanup = () => { try { clearInterval(stallTimer); } catch {} };

    if (xhr.upload && typeof onProgress === "function") {
      xhr.upload.onprogress = (ev) => {
        bump();
        try {
          if (ev.lengthComputable && ev.total > 0) onProgress(ev.loaded / ev.total);
        } catch {}
      };
    }

    xhr.onreadystatechange = () => bump();
    xhr.onerror = () => { cleanup(); reject(new Error("Network error")); };
    xhr.onabort = () => { cleanup(); reject(new Error("Upload stalled")); };
    xhr.ontimeout = () => { cleanup(); reject(new Error("Upload timeout")); };
    xhr.timeout = TOTAL_TIMEOUT_MS;

    xhr.onload = () => {
      cleanup();
      let json = null;
      try { json = JSON.parse(xhr.responseText || ""); } catch {}
      resolve({ status: xhr.status, ok: xhr.status >= 200 && xhr.status < 300, json, text: xhr.responseText });
    };

    bump();
    xhr.send(formData);
  });

  let res = await doOnce();
  if (res.status === 401) {
    // Access token likely expired; attempt refresh then retry once.
    await refreshAccessToken();
    res = await doOnce();
  }
  return res;
}

async function fetchPostFormWithAuth(url, formData) {
  const resp = await fetchWithAuth(url, {
    method: "POST",
    credentials: "same-origin",
    body: formData,
  });
  let json = null;
  let text = "";
  try { text = await resp.text(); } catch {}
  try { json = text ? JSON.parse(text) : null; } catch {}
  return { status: resp.status, ok: resp.ok, json, text };
}


// ───────────────────────────────────────────────────────────────────────────────
// Toasts + optional browser notifications + optional sound
// ───────────────────────────────────────────────────────────────────────────────
function playBeep() {
  if (!UIState.prefs.soundNotif) return;
  if (!AUDIO_ARMED) return;
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.connect(g); g.connect(ctx.destination);
    o.type = "square";
    o.frequency.value = 880;
    g.gain.value = 0.03;
    o.start();
    setTimeout(() => { o.stop(); ctx.close(); }, 80);
  } catch {}
}

function maybeBrowserNotify(title, body) {
  if (!UIState.prefs.popupNotif) return;
  if (!("Notification" in window)) return;

  if (Notification.permission === "granted") {
    try { new Notification(title, { body }); } catch {}
    return;
  }
}

function toast(message, kind = "info", timeout = 3500) {
  const stack = $("toastStack");
  if (!stack) return;

  const div = document.createElement("div");
  div.className = `toast ${kind}`;
  div.textContent = message;
  stack.appendChild(div);

  playBeep();

  setTimeout(() => div.remove(), timeout);
}

// Backwards-compat with old code path:
function notify(msg) { toast(msg, "info"); }

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

// ───────────────────────────────────────────────────────────────────────────────
// Window manager (floating windows like classic Yahoo Messenger)
// ───────────────────────────────────────────────────────────────────────────────
function bringToFront(winEl) {
  UIState.highestZ += 1;
  winEl.style.zIndex = UIState.highestZ;
}

function createWindow({ id, title, kind }) {
  // If exists, just focus
  if (UIState.windows.has(id)) {
    const existing = UIState.windows.get(id);
    existing.classList.remove("hidden");
    bringToFront(existing);
    return existing;
  }

  const layer = $("windowsLayer");
  if (!layer) return null;

  const win = document.createElement("div");
  win.className = "ym-window";
  win.dataset.winId = id;
  win.dataset.kind = kind;

  // Default placement
  const baseX = Math.max(20, window.innerWidth - 420 - 360 - 40);
  const x = baseX + Math.floor(Math.random() * 50);
  const y = 80 + Math.floor(Math.random() * 60);
  win.style.left = `${x}px`;
  win.style.top = `${y}px`;
  win.style.zIndex = String(++UIState.highestZ);

  const titlebar = document.createElement("div");
  titlebar.className = "ym-titlebar";

  const titleEl = document.createElement("div");
  titleEl.className = "ym-title";
  titleEl.textContent = title;

  const btns = document.createElement("div");
  btns.className = "ym-winBtns";

  const btnMin = document.createElement("button");
  btnMin.className = "winBtn";
  btnMin.title = "Minimize";
  btnMin.textContent = "–";

  const btnClose = document.createElement("button");
  btnClose.className = "winBtn danger";
  btnClose.title = "Close";
  btnClose.textContent = "×";

  btns.appendChild(btnMin);
  btns.appendChild(btnClose);

  titlebar.appendChild(titleEl);
  titlebar.appendChild(btns);

  const body = document.createElement("div");
  body.className = "ym-body";

  const log = document.createElement("div");
  log.className = "ym-log";
  log.innerHTML = `<div class="ym-line"><span class="tag">System:</span>Window opened.</div>`;

  const compose = document.createElement("div");
  compose.className = "ym-compose";

  const input = document.createElement("input");
  input.className = "ym-input";
  input.type = "text";
  input.placeholder = "Type a message…";

  // Emoticons (emoji) button
  const emojiBtn = document.createElement("button");
  emojiBtn.type = "button";
  emojiBtn.className = "ym-toolBtn ym-emojiBtn";
  emojiBtn.title = "Emoticons";
  emojiBtn.textContent = "😊";

  const send = document.createElement("button");
  send.className = "ym-send";
  send.textContent = "Send";

  compose.appendChild(input);
  compose.appendChild(emojiBtn);
  compose.appendChild(send);

  body.appendChild(log);

  // DM toolbar sits between output (log) and input (compose)
  let toolbar = null;
  let fileBtn = null;
  let fileInput = null;
  let toolHint = null;
  let gifBtn = null;
  let gifHint = null;
  let voiceBtn = null;
  let voiceHint = null;
  let voiceBar = null;
  let voiceStatus = null;
  let voiceBtnCall = null;
  let voiceBtnHang = null;
  let voiceBtnMute = null;
  let voiceBtnAccept = null;
  let voiceBtnDecline = null;
  if (kind === "dm") {
    toolbar = document.createElement("div");
    toolbar.className = "ym-toolbar";

    fileBtn = document.createElement("button");
    fileBtn.type = "button";
    fileBtn.className = "ym-toolBtn";
    fileBtn.title = "Send a file";
    fileBtn.textContent = "📎";

    toolHint = document.createElement("span");
    toolHint.className = "ym-toolHint";
    toolHint.textContent = "File";

    fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.className = "ym-fileInput";
    fileInput.style.display = "none";

    toolbar.appendChild(fileBtn);
    toolbar.appendChild(toolHint);

// GIF button (GIPHY)
gifBtn = document.createElement("button");
gifBtn.type = "button";
gifBtn.className = "ym-toolBtn";
gifBtn.title = "Search GIFs";
gifBtn.textContent = "GIF";

gifHint = document.createElement("span");
gifHint.className = "ym-toolHint";
gifHint.textContent = "GIF";

toolbar.appendChild(gifBtn);
toolbar.appendChild(gifHint);
    // Voice button (Yahoo-style)
    voiceBtn = document.createElement("button");
    voiceBtn.type = "button";
    voiceBtn.className = "ym-toolBtn";
    voiceBtn.title = "Voice chat";
    voiceBtn.textContent = "🎤";

    voiceHint = document.createElement("span");
    voiceHint.className = "ym-toolHint";
    voiceHint.textContent = "Voice";

    toolbar.appendChild(voiceBtn);
    toolbar.appendChild(voiceHint);

    toolbar.appendChild(fileInput);
    body.appendChild(toolbar);

    // Voice bar: call status + quick actions
    voiceBar = document.createElement("div");
    voiceBar.className = "ym-voiceBar hidden";

    const left = document.createElement("div");
    left.className = "ym-voiceLeft";
    left.innerHTML = `<span class="ym-voiceBadge">VOICE</span>`;

    voiceStatus = document.createElement("span");
    voiceStatus.className = "ym-voiceStatus";
    voiceStatus.textContent = "Not connected";
    left.appendChild(voiceStatus);

    const btns = document.createElement("div");
    btns.className = "ym-voiceBtns";

    voiceBtnCall = document.createElement("button");
    voiceBtnCall.className = "miniBtn";
    voiceBtnCall.textContent = "Call";

    voiceBtnHang = document.createElement("button");
    voiceBtnHang.className = "miniBtn danger";
    voiceBtnHang.textContent = "Hang up";

    voiceBtnMute = document.createElement("button");
    voiceBtnMute.className = "miniBtn";
    voiceBtnMute.textContent = "Mute";

    voiceBtnAccept = document.createElement("button");
    voiceBtnAccept.className = "miniBtn";
    voiceBtnAccept.textContent = "Accept";

    voiceBtnDecline = document.createElement("button");
    voiceBtnDecline.className = "miniBtn danger";
    voiceBtnDecline.textContent = "Decline";

    // Default: show outbound controls only
    voiceBtnAccept.style.display = "none";
    voiceBtnDecline.style.display = "none";

    btns.appendChild(voiceBtnCall);
    btns.appendChild(voiceBtnHang);
    btns.appendChild(voiceBtnMute);
    btns.appendChild(voiceBtnAccept);
    btns.appendChild(voiceBtnDecline);

    voiceBar.appendChild(left);
    voiceBar.appendChild(btns);
    body.appendChild(voiceBar);
  }
  if (kind === "group") {
    toolbar = document.createElement("div");
    toolbar.className = "ym-toolbar";

    fileBtn = document.createElement("button");
    fileBtn.type = "button";
    fileBtn.className = "ym-toolBtn";
    fileBtn.title = "Send a file to the group (E2EE)";
    fileBtn.textContent = "📎";

    toolHint = document.createElement("span");
    toolHint.className = "ym-toolHint";
    toolHint.textContent = "File";

    fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.className = "ym-fileInput";
    fileInput.style.display = "none";

    toolbar.appendChild(fileBtn);
    toolbar.appendChild(toolHint);

// GIF button (GIPHY)
gifBtn = document.createElement("button");
gifBtn.type = "button";
gifBtn.className = "ym-toolBtn";
gifBtn.title = "Search GIFs";
gifBtn.textContent = "GIF";

gifHint = document.createElement("span");
gifHint.className = "ym-toolHint";
gifHint.textContent = "GIF";

toolbar.appendChild(gifBtn);
toolbar.appendChild(gifHint);
    toolbar.appendChild(fileInput);
    body.appendChild(toolbar);
  }

  body.appendChild(compose);

  const resize = document.createElement("div");
  resize.className = "ym-resize";

  win.appendChild(titlebar);
  win.appendChild(body);
  win.appendChild(resize);

  layer.appendChild(win);
  UIState.windows.set(id, win);

  // Focus behavior
  win.addEventListener("mousedown", () => bringToFront(win));
  titlebar.addEventListener("mousedown", () => bringToFront(win));

  // Drag behavior
  (function attachDrag() {
    let dragging = false;
    let startX = 0, startY = 0, origX = 0, origY = 0;

    titlebar.addEventListener("mousedown", (e) => {
      dragging = true;
      startX = e.clientX; startY = e.clientY;
      origX = parseInt(win.style.left || "0", 10);
      origY = parseInt(win.style.top || "0", 10);
      e.preventDefault();
    });

    window.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      win.style.left = `${origX + dx}px`;
      win.style.top = `${origY + dy}px`;
    });

    window.addEventListener("mouseup", () => { dragging = false; });
  })();

  // Resize behavior
  (function attachResize() {
    let resizing = false;
    let startX = 0, startY = 0, startW = 0, startH = 0;

    resize.addEventListener("mousedown", (e) => {
      resizing = true;
      startX = e.clientX; startY = e.clientY;
      startW = win.offsetWidth; startH = win.offsetHeight;
      e.preventDefault();
      bringToFront(win);
    });

    window.addEventListener("mousemove", (e) => {
      if (!resizing) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      win.style.width = `${Math.max(340, startW + dx)}px`;
      win.style.height = `${Math.max(280, startH + dy)}px`;
    });

    window.addEventListener("mouseup", () => { resizing = false; });
  })();

  // Minimize/Close
  btnMin.onclick = () => minimizeWindow(id, title);
  btnClose.onclick = () => closeWindow(id);

  // Expose handles for message plumbing
  win._ym = { titleEl, log, input, send, emojiBtn, toolbar, fileBtn, fileInput, toolHint, gifBtn, gifHint, voiceBtn, voiceHint, voiceBar, voiceStatus, voiceBtnCall, voiceBtnHang, voiceBtnMute, voiceBtnAccept, voiceBtnDecline };

  // Bind emoticons picker
  bindEmojiButton(emojiBtn, input);

  // Enter-to-send
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") send.click();
  });

  return win;
}

function minimizeWindow(id, title) {
  const win = UIState.windows.get(id);
  if (!win) return;

  win.classList.add("hidden");

  if (UIState.minimized.has(id)) return;

  const bar = $("dockTaskbar");
  if (!bar) return;

  const btn = document.createElement("button");
  btn.className = "taskBtn";
  btn.textContent = title;
  btn.onclick = () => {
    win.classList.remove("hidden");
    bringToFront(win);
    btn.remove();
    UIState.minimized.delete(id);
  };

  bar.appendChild(btn);
  UIState.minimized.set(id, btn);
}

function closeWindow(id) {
  const win = UIState.windows.get(id);
  if (!win) return;

  // If closing a DM while in a voice call, hang up.
  if (typeof id === "string" && id.startsWith("dm:")) {
    const peer = id.slice(3);
    if (peer && VOICE_STATE.dmCalls.has(peer)) {
      voiceHangupDm(peer, "Closed", true);
    }
  }

  // If it's a room window, keep state consistent
  if (win.dataset.kind === "room") {
    // no-op: leaving room is user-controlled via Leave button
  }

  win.remove();
  UIState.windows.delete(id);

  const taskBtn = UIState.minimized.get(id);
  if (taskBtn) taskBtn.remove();
  UIState.minimized.delete(id);
}

function parseGifMarker(text) {
  if (typeof text !== 'string') return null;
  const s = text.trim();
  if (!s) return null;
  if (!s.toLowerCase().startsWith('gif:')) return null;
  const url = s.slice(4).trim();
  if (!url) return null;
  if (url.length > 2048) return null;
  if (!/^https?:\/\//i.test(url)) return null;
  return url;
}


function _gifFallbackUrl(url) {
  try {
    const u = new URL(url);
    const parts = (u.pathname || "").split("/").filter(Boolean);
    const mi = parts.indexOf("media");
    if (mi !== -1 && parts.length > (mi + 1)) {
      const id = parts[mi + 1];
      if (id) return `https://i.giphy.com/media/${id}/giphy.gif`;
    }
  } catch {}
  return null;
}

function _gifCacheBust(url) {
  try {
    const u = new URL(url);
    u.searchParams.set("cb", String(Date.now()));
    return u.toString();
  } catch {
    const sep = url.includes("?") ? "&" : "?";
    return url + sep + "cb=" + Date.now();
  }
}

function refreshGifInlineImage(img, reason = "manual") {
  if (!img) return false;

  const maxTries = 3;
  const tries = Number(img.dataset.gifTry || "0");
  if (tries >= maxTries) {
    img.dataset.gifFailed = "1";
    img.classList.add("ym-gifBroken");
    return false;
  }

  const base = img.dataset.gifBase || img.dataset.gifOrig || img.src || "";
  const canonical = _gifFallbackUrl(base) || base;

  img.dataset.gifBase = canonical;
  img.dataset.gifTry = String(tries + 1);
  img.dataset.gifLoaded = "0";
  img.dataset.gifFailed = "0";
  img.classList.remove("ym-gifBroken");

  const next = _gifCacheBust(canonical);

  // Force a reload (cache-busted) without spamming the network.
  try { img.src = ""; } catch {}
  setTimeout(() => { img.src = next; }, 0);

  return true;
}

function scheduleGifLoadCheck(img) {
  if (!img) return;
  if (img.dataset.gifWatch === "1") return;
  img.dataset.gifWatch = "1";

  // Some browsers keep images in a "stuck" state inside scroll containers.
  // If it doesn't load within a few seconds, retry with a cache-busted URL.
  setTimeout(() => {
    if (img.dataset.gifLoaded === "1") return;
    if (!navigator.onLine) return;
    if (!img.complete || img.naturalWidth === 0) {
      refreshGifInlineImage(img, "timeout");
    }
  }, 7000);
}

function refreshUnloadedGifsInScope(scope = document) {
  const root = scope || document;
  const imgs = root.querySelectorAll('img[data-ec-gif="1"]');
  let n = 0;

  imgs.forEach((img) => {
    const loaded = img.dataset.gifLoaded === "1";
    if (loaded) return;

    if (!img.complete || img.naturalWidth === 0 || img.dataset.gifFailed === "1") {
      if (refreshGifInlineImage(img, "scan")) n++;
    }
  });

  return n;
}

// Console / power-user hook: window.EchoChatRefreshGifs()
if (!window.EchoChatRefreshGifs) {
  window.EchoChatRefreshGifs = () => {
    const n = refreshUnloadedGifsInScope(document);
    try { toast(`↻ Retried ${n} GIF(s)`, "info"); } catch {}
    return n;
  };
}

// Auto-recover when network comes back or user returns to the tab
if (!window.__ecGifAutoRefreshBound) {
  window.__ecGifAutoRefreshBound = true;
  window.addEventListener("online", () => setTimeout(() => refreshUnloadedGifsInScope(document), 400));
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) setTimeout(() => refreshUnloadedGifsInScope(document), 400);
  });
}


function configureGifInlineImage(img, gifUrl) {
  img.className = "ym-gifInline";
  // Lazy-loading inside scroll containers is unreliable; force eager for chat UX.
  img.loading = "eager";
  img.decoding = "async";
  img.referrerPolicy = "no-referrer";
  img.alt = "GIF";

  img.dataset.ecGif = "1";
  img.dataset.gifOrig = gifUrl;

  const base = _gifFallbackUrl(gifUrl) || gifUrl;
  img.dataset.gifBase = base;
  img.dataset.gifTry = "0";
  img.dataset.gifLoaded = "0";
  img.dataset.gifFailed = "0";

  img.src = base;
  scheduleGifLoadCheck(img);

  img.onload = () => {
    img.dataset.gifLoaded = "1";
    img.dataset.gifFailed = "0";
    img.classList.remove("ym-gifBroken");
  };

  img.onerror = () => {
    refreshGifInlineImage(img, "error");
  };

  img.onclick = () => {
    const notLoaded = (img.dataset.gifLoaded !== "1") && (!img.complete || img.naturalWidth === 0);

    // If it looks stuck/broken, clicking retries; the "Open" link still opens the URL.
    if (notLoaded || img.dataset.gifFailed === "1") {
      refreshGifInlineImage(img, "click");
      return;
    }

    try { window.open(img.dataset.gifOrig || img.dataset.gifBase || img.src, "_blank"); } catch {}
  };
}



function appendLine(winEl, who, text, kind = "msg") {
  const log = winEl._ym?.log;
  if (!log) return;

  const line = document.createElement("div");
  line.className = "ym-line";

  const tag = document.createElement("span");
  tag.className = "tag";
  tag.textContent = String(who || "");
  line.appendChild(tag);

  const gifUrl = parseGifMarker(text);
  if (gifUrl) {
    line.appendChild(document.createTextNode(" "));

    const img = document.createElement("img");
    configureGifInlineImage(img, gifUrl);

    const open = document.createElement("a");
    open.className = "ym-gifOpen";
    open.href = gifUrl;
    open.target = "_blank";
    open.rel = "noopener noreferrer";
    open.textContent = "Open";

    line.appendChild(img);
    line.appendChild(document.createTextNode(" "));
    line.appendChild(open);
  } else {
    const s = (typeof text === "string") ? text : String(text ?? "");
    line.appendChild(document.createTextNode(" " + s));
  }

  log.appendChild(line);
  log.scrollTop = log.scrollHeight;
}


function parseDmPayload(plaintext) {
  if (typeof plaintext !== "string") return { kind: "text", text: String(plaintext) };

  // DM special payloads are encrypted JSON objects: {"_ec":"file"|"torrent", ...}
  if (plaintext.startsWith("{")) {
    try {
      const obj = JSON.parse(plaintext);
      if (obj && obj._ec === "file" && typeof obj.file_id === "string") {
        return {
          kind: "file",
          file_id: obj.file_id,
          name: String(obj.name || "file"),
          size: Number(obj.size || 0) || 0,
          mime: String(obj.mime || "application/octet-stream"),
          sha256: obj.sha256 ? String(obj.sha256) : null,
        };
      }
      if (obj && obj._ec === "torrent") {
        return {
          kind: "torrent",
          t: {
            name: String(obj.name || obj.display_name || "Torrent"),
            infohash: String(obj.infohash || obj.infohash_hex || ""),
            magnet: String(obj.magnet || ""),
            total_size: Number(obj.total_size || 0) || 0,
            seeds: (obj.seeds === null || obj.seeds === undefined) ? null : Number(obj.seeds),
            leechers: (obj.leechers === null || obj.leechers === undefined) ? null : Number(obj.leechers),
            completed: (obj.completed === null || obj.completed === undefined) ? null : Number(obj.completed),
            trackers: Array.isArray(obj.trackers) ? obj.trackers.map(String) : [],
            comment: obj.comment ? String(obj.comment) : "",
            created_by: obj.created_by ? String(obj.created_by) : "",
            creation_date: obj.creation_date ? String(obj.creation_date) : "",
            // Optional: if the sender also sent the .torrent file via server, they can include it.
            file_id: typeof obj.file_id === "string" ? obj.file_id : null,
          }
        };
      }
    } catch {
      // fall through
    }
  }
  // If a user pastes a magnet link as plain text, render it as a torrent card.
  if (isMagnetText(plaintext)) {
    const pm = parseMagnet(plaintext);
    if (pm) {
      return {
        kind: "torrent",
        t: {
          name: pm.name || "Magnet",
          infohash: pm.infohash,
          magnet: pm.magnet,
          total_size: 0,
          seeds: null,
          leechers: null,
          completed: null,
          trackers: pm.trackers || [],
          comment: "",
          created_by: "",
          creation_date: "",
          file_id: null,
        }
      };
    }
  }
  return { kind: "text", text: plaintext };
}

function appendDmPayload(winEl, who, payload, { peer, direction } = {}) {
  if (!payload || !winEl) return;
  if (payload.kind === "file") {
    appendFileLine(winEl, who, payload, { peer, direction });
  } else if (payload.kind === "torrent") {
    appendTorrentLine(winEl, who, payload.t, { peer, direction });
  } else {
    appendLine(winEl, who, payload.text);
  }
}

function makeFileLineElement(who, filePayload, { peer, direction } = {}) {
  const line = document.createElement("div");
  line.className = "ym-line";

  const tag = document.createElement("span");
  tag.className = "tag";
  tag.textContent = who;
  line.appendChild(tag);
  line.appendChild(document.createTextNode(" "));

  const card = document.createElement("span");
  card.className = "ym-fileCard";

  const icon = document.createElement("span");
  icon.textContent = "📎";

  const name = document.createElement("span");
  name.className = "ym-fileName";
  name.textContent = filePayload?.name || "file";

  const meta = document.createElement("span");
  meta.className = "ym-fileMeta";
  meta.textContent = humanBytes(filePayload?.size || 0);

  // Source badge (P2P vs server)
  const badge = document.createElement("span");
  badge.className = "ym-fileBadge";
  const src = filePayload?.source || (filePayload?.transfer_id ? "p2p" : "server");
  badge.textContent = (src === "p2p") ? "P2P" : "SRV";

  // Download / status
  let actionEl = null;

  if (filePayload?.blob instanceof Blob) {
    const dl = document.createElement("button");
    dl.type = "button";
    dl.className = "ym-fileDl";
    dl.textContent = "Download";
    dl.onclick = () => downloadBlob(filePayload.name || "file", filePayload.blob);
    actionEl = dl;
  } else if (typeof filePayload?.file_id === "string" && filePayload.file_id) {
    const dl = document.createElement("button");
    dl.type = "button";
    dl.className = "ym-fileDl";
    dl.textContent = "Download";
    dl.onclick = async () => {
      try {
        if (filePayload && filePayload.group_id) {
          await downloadAndDecryptGroupFile(filePayload.file_id, filePayload.name, filePayload.group_id);
        } else {
          await downloadAndDecryptDmFile(filePayload.file_id, filePayload.name);
        }
      } catch (e) {
        console.error(e);
        toast("❌ File download failed", "error");
      }
    };
    actionEl = dl;
  } else {
    // Outgoing P2P: nothing to download (receiver-side only).
    const st = document.createElement("span");
    st.className = "ym-fileMeta";
    st.textContent = (direction === "out") ? "Sent" : "";
    actionEl = st;
  }

  card.appendChild(icon);
  card.appendChild(name);
  card.appendChild(meta);
  card.appendChild(badge);
  if (actionEl) card.appendChild(actionEl);
  line.appendChild(card);
  return line;
}

function appendFileLine(winEl, who, filePayload, { peer, direction } = {}) {
  const log = winEl._ym?.log;
  if (!log) return;
  const line = makeFileLineElement(who, filePayload, { peer, direction });
  if (!line) return;
  log.appendChild(line);
  log.scrollTop = log.scrollHeight;
}

function isTorrentName(name) {
  return typeof name === "string" && /\.torrent$/i.test(name.trim());
}

function _shortHash(h) {
  if (!h) return "";
  const s = String(h);
  return s.length > 12 ? (s.slice(0, 6) + "…" + s.slice(-6)) : s;
}

function buildTorrentCard(t) {
  const card = document.createElement("span");
  card.className = "ym-torrentCard";

  const icon = document.createElement("span");
  icon.textContent = "🧲";

  const main = document.createElement("span");
  main.className = "ym-torrentMain";

  const title = document.createElement("div");
  title.className = "ym-torrentTitle";
  title.innerHTML = `<span class="ym-torrentName">${escapeHtml(t?.name || "Torrent")}</span>`;

  const meta = document.createElement("div");
  meta.className = "ym-torrentMeta";

  const sizeText = t?.total_size ? humanBytes(Number(t.total_size) || 0) : "—";
  const seeds = (t?.seeds === null || t?.seeds === undefined || Number.isNaN(Number(t?.seeds))) ? "?" : String(Math.max(0, Number(t.seeds)));
  const leech = (t?.leechers === null || t?.leechers === undefined || Number.isNaN(Number(t?.leechers))) ? "?" : String(Math.max(0, Number(t.leechers)));
  const done = (t?.completed === null || t?.completed === undefined || Number.isNaN(Number(t?.completed))) ? "?" : String(Math.max(0, Number(t.completed)));

  meta.textContent = `Size ${sizeText} • Seeds ${seeds} • Leechers ${leech} • Completed ${done}`;

  // If we didn't receive swarm stats, do a lazy refresh once (best-effort).
  // This makes pasted magnet links and old clients still show seeds/leechers.
  const needsRefresh = (seeds === "?" || leech === "?" || done === "?") && !!t?.infohash;
  if (needsRefresh) {
    const trList = (Array.isArray(t?.trackers) && t.trackers.length) ? t.trackers : DEFAULT_PUBLIC_TRACKERS;
    fetchTorrentSwarm(String(t.infohash || ""), trList).then((sw) => {
      if (!sw) return;
      const s2 = (sw.seeds === null || sw.seeds === undefined || Number.isNaN(Number(sw.seeds))) ? "?" : String(Math.max(0, Number(sw.seeds)));
      const l2 = (sw.leechers === null || sw.leechers === undefined || Number.isNaN(Number(sw.leechers))) ? "?" : String(Math.max(0, Number(sw.leechers)));
      const d2 = (sw.completed === null || sw.completed === undefined || Number.isNaN(Number(sw.completed))) ? "?" : String(Math.max(0, Number(sw.completed)));
      const size2 = t?.total_size ? humanBytes(Number(t.total_size) || 0) : "—";
      meta.textContent = `Size ${size2} • Seeds ${s2} • Leechers ${l2} • Completed ${d2}`;
    }).catch(() => {});
  }

  const hash = document.createElement("div");
  hash.className = "ym-torrentHash";
  hash.textContent = `Infohash: ${_shortHash(t?.infohash || "")}`;

  const actions = document.createElement("div");
  actions.className = "ym-torrentActions";

  const btnCopyMagnet = document.createElement("button");
  btnCopyMagnet.className = "ym-fileDl";
  btnCopyMagnet.textContent = "Copy magnet";
  btnCopyMagnet.onclick = async () => {
    const m = t?.magnet || "";
    if (!m) return toast("⚠️ No magnet available", "warn");
    try {
      await navigator.clipboard.writeText(m);
      toast("📋 Magnet copied", "ok");
    } catch {
      toast("❌ Could not copy", "error");
    }
  };

  const btnCopyHash = document.createElement("button");
  btnCopyHash.className = "ym-fileDl";
  btnCopyHash.textContent = "Copy hash";
  btnCopyHash.onclick = async () => {
    const h = t?.infohash || "";
    if (!h) return toast("⚠️ No infohash", "warn");
    try {
      await navigator.clipboard.writeText(h);
      toast("📋 Hash copied", "ok");
    } catch {
      toast("❌ Could not copy", "error");
    }
  };

  actions.appendChild(btnCopyMagnet);
  actions.appendChild(btnCopyHash);

  // Optional server-stored torrent download (rooms)
  if (t?.download_url) {
    const btnDl = document.createElement("button");
    btnDl.className = "ym-fileDl";
    btnDl.textContent = "Download .torrent";
    btnDl.onclick = () => {
      try {
        const a = document.createElement("a");
        a.href = t.download_url;
        a.download = t?.file_name || "download.torrent";
        document.body.appendChild(a);
        a.click();
        a.remove();
      } catch {
        window.open(t.download_url, "_blank");
      }
    };
    actions.appendChild(btnDl);
  }

  main.appendChild(title);
  main.appendChild(meta);
  if (t?.infohash) main.appendChild(hash);
  if ((t?.trackers || []).length) {
    const tr = document.createElement("div");
    tr.className = "ym-torrentTrackers";
    tr.textContent = `${t.trackers.length} tracker(s)`;
    main.appendChild(tr);
  }
  if (t?.comment) {
    const c = document.createElement("div");
    c.className = "ym-torrentComment";
    c.textContent = t.comment;
    main.appendChild(c);
  }

  card.appendChild(icon);
  card.appendChild(main);
  card.appendChild(actions);
  return card;
}

function appendTorrentLine(winEl, who, t, { peer, direction } = {}) {
  const log = winEl._ym?.log;
  if (!log) return;

  const line = document.createElement("div");
  line.className = "ym-line";

  const tag = document.createElement("span");
  tag.className = "tag";
  tag.textContent = who;
  line.appendChild(tag);
  line.appendChild(document.createTextNode(" "));

  line.appendChild(buildTorrentCard(t));
  log.appendChild(line);
  log.scrollTop = log.scrollHeight;
}

function appendP2pTransferUI(winEl, who, meta, { mode = "outgoing" } = {}) {
  const log = winEl?._ym?.log;
  if (!log) return { setProgress() {}, setStatus() {}, remove() {}, disableActions() {}, onAccept() {}, onDecline() {} };

  const line = document.createElement("div");
  line.className = "ym-line";

  const tag = document.createElement("span");
  tag.className = "tag";
  tag.textContent = who;
  line.appendChild(tag);
  line.appendChild(document.createTextNode(" "));

  const card = document.createElement("span");
  card.className = "ym-xferCard";

  const row = document.createElement("span");
  row.className = "ym-xferRow";

  const icon = document.createElement("span");
  icon.textContent = "📎";

  const name = document.createElement("span");
  name.className = "ym-fileName";
  name.textContent = String(meta?.name || "file");

  const size = document.createElement("span");
  size.className = "ym-fileMeta";
  size.textContent = humanBytes(Number(meta?.size || 0) || 0);

  const badge = document.createElement("span");
  badge.className = "ym-fileBadge";
  badge.textContent = "P2P";

  row.appendChild(icon);
  row.appendChild(name);
  row.appendChild(size);
  row.appendChild(badge);

  const status = document.createElement("div");
  status.className = "ym-xferStatus";
  status.textContent = (mode === "incoming") ? "Incoming file…" : "Preparing…";

  const bar = document.createElement("div");
  bar.className = "ym-xferBar";
  const fill = document.createElement("span");
  fill.className = "ym-xferFill";
  bar.appendChild(fill);

  const actions = document.createElement("div");
  actions.className = "ym-xferActions";

  const btnAccept = document.createElement("button");
  btnAccept.type = "button";
  btnAccept.className = "ym-xferBtn";
  btnAccept.textContent = "Accept";

  const btnDecline = document.createElement("button");
  btnDecline.type = "button";
  btnDecline.className = "ym-xferBtn danger";
  btnDecline.textContent = "Decline";

  if (mode === "incoming") {
    actions.appendChild(btnAccept);
    actions.appendChild(btnDecline);
  }

  card.appendChild(row);
  card.appendChild(status);
  card.appendChild(bar);
  if (mode === "incoming") card.appendChild(actions);

  line.appendChild(card);
  log.appendChild(line);
  log.scrollTop = log.scrollHeight;

  let _onAccept = null;
  let _onDecline = null;

  btnAccept.onclick = () => _onAccept && _onAccept();
  btnDecline.onclick = () => _onDecline && _onDecline();

  return {
    setProgress(r) {
      const ratio = Math.max(0, Math.min(1, Number(r) || 0));
      fill.style.width = `${Math.round(ratio * 100)}%`;
    },
    setStatus(s) {
      status.textContent = String(s || "");
    },
    remove() {
      try { line.remove(); } catch {}
    },
    disableActions() {
      btnAccept.disabled = true;
      btnDecline.disabled = true;
    },
    onAccept(fn) { _onAccept = fn; },
    onDecline(fn) { _onDecline = fn; },
    setBadge(text) {
      badge.textContent = String(text || "").slice(0, 6) || "";
    },
  };
}

// ───────────────────────────────────────────────────────────────────────────────
// Message reactions (rooms)
// ───────────────────────────────────────────────────────────────────────────────
const DEFAULT_REACTION_EMOJIS = ["👍", "👎", "😂", "❤️", "😮"]; // fast common set

function _ensureMsgIndex(viewEl) {
  if (!viewEl) return;
  if (!viewEl._ym) viewEl._ym = {};
  if (!viewEl._ym.msgIndex) viewEl._ym.msgIndex = new Map();
  if (!viewEl._ym.myReactions) viewEl._ym.myReactions = new Map(); // message_id -> emoji (current user)
}

function _findMsgEl(viewEl, messageId) {
  _ensureMsgIndex(viewEl);
  return viewEl._ym.msgIndex.get(messageId) || null;
}

function _getMyReaction(viewEl, messageId) {
  _ensureMsgIndex(viewEl);
  return viewEl?._ym?.myReactions?.get(messageId) || null;
}

function _setMyReaction(viewEl, messageId, emojiOrNull) {
  _ensureMsgIndex(viewEl);
  if (!viewEl?._ym?.myReactions) return;

  if (emojiOrNull) viewEl._ym.myReactions.set(messageId, emojiOrNull);
  else viewEl._ym.myReactions.delete(messageId);

  const msgEl = _findMsgEl(viewEl, messageId);
  if (!msgEl) return;
  msgEl.querySelectorAll(".reactBtn").forEach((b) => {
    b.classList.toggle("active", (b.dataset?.emoji || b.textContent) === emojiOrNull);
  });
}

function _lockReactions(viewEl, messageId) {
  const msgEl = _findMsgEl(viewEl, messageId);
  if (!msgEl) return;
  msgEl.classList.add("rxLocked");
  msgEl.querySelectorAll(".reactBtn").forEach((b) => {
    b.disabled = true;
    b.classList.add("disabled");
  });
}


function _renderReactionPills(container, counts) {
  if (!container) return;
  container.innerHTML = "";
  if (!counts) return;

  // Stable ordering: show default emojis first, then any others the server sends.
  const keys = Object.keys(counts);
  const ordered = [
    ...DEFAULT_REACTION_EMOJIS.filter(e => keys.includes(e)),
    ...keys.filter(e => !DEFAULT_REACTION_EMOJIS.includes(e)).sort()
  ];

  ordered.forEach((emoji) => {
    const n = counts[emoji];
    if (!n) return;
    const pill = document.createElement("span");
    pill.className = "reactPill";
    pill.textContent = `${emoji} ${n}`;
    container.appendChild(pill);
  });
}

function _sendReaction(viewEl, room, messageId, emoji) {
  if (!room || !messageId || !emoji) return;

  // Enforce "final reaction" client-side: once you react, it is locked.
  const current = _getMyReaction(viewEl, messageId);
  if (current) {
    toast("🔒 Reaction is final. You can’t change or undo it.", "warn");
    return;
  }

  socket.emit("react_to_message", { room, message_id: messageId, emoji }, (res) => {
    if (!res?.success) {
      toast(`❌ ${res?.error || "Reaction failed"}`, "error");
      return;
    }

    // Track my selected emoji for UI highlighting.
    _setMyReaction(viewEl, messageId, emoji);
    _lockReactions(viewEl, messageId);

    // Fast-path update (server also broadcasts message_reactions).
    const msgEl = _findMsgEl(viewEl, messageId);
    if (msgEl) {
      const rx = msgEl.querySelector(".msgReactions");
      if (rx && res?.counts) _renderReactionPills(rx, res.counts);
    }
  });
}

function appendRoomMessage(viewEl, payload) {
  const log = viewEl?._ym?.log;
  if (!log) return;

  const username = payload?.username || "";
  const message = payload?.message ?? "";
  const room = payload?.room || UIState.currentRoom || null;

  // If server did not provide one (older server), create a local one.
  const messageId = payload?.message_id || payload?.messageId || `local-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  _ensureMsgIndex(viewEl);

  const row = document.createElement("div");
  row.className = "msgRow";
  row.dataset.msgid = messageId;

  const head = document.createElement("div");
  head.className = "msgHeader";

  const userEl = document.createElement("span");
  userEl.className = "msgUser";
  userEl.textContent = username ? `${username}:` : "";

  head.appendChild(userEl);

  const body = document.createElement("div");
  body.className = "msgText";
  // Support special in-room payloads (e.g. torrent cards)
  let _ecObj = null;
  if (typeof message === "string" && message.startsWith("{")) {
    try { _ecObj = JSON.parse(message); } catch { _ecObj = null; }
  }

  if (_ecObj && _ecObj._ec === "torrent") {
    const t = {
      name: String(_ecObj.name || _ecObj.file_name || "Torrent"),
      infohash: String(_ecObj.infohash || _ecObj.infohash_hex || ""),
      magnet: String(_ecObj.magnet || ""),
      total_size: Number(_ecObj.total_size || 0) || 0,
      seeds: (_ecObj.seeds === null || _ecObj.seeds === undefined) ? null : Number(_ecObj.seeds),
      leechers: (_ecObj.leechers === null || _ecObj.leechers === undefined) ? null : Number(_ecObj.leechers),
      completed: (_ecObj.completed === null || _ecObj.completed === undefined) ? null : Number(_ecObj.completed),
      trackers: Array.isArray(_ecObj.trackers) ? _ecObj.trackers.map(String) : [],
      comment: _ecObj.comment ? String(_ecObj.comment) : "",
      created_by: _ecObj.created_by ? String(_ecObj.created_by) : "",
      creation_date: _ecObj.creation_date ? String(_ecObj.creation_date) : "",
      download_url: _ecObj.download_url ? String(_ecObj.download_url) : ""
    };
    body.innerHTML = "";
    body.appendChild(buildTorrentCard(t));
  } else if (typeof message === "string" && isMagnetText(message)) {
    const pm = parseMagnet(message);
    if (pm) {
      const t = {
        name: pm.name || "Magnet",
        infohash: pm.infohash,
        magnet: pm.magnet,
        total_size: 0,
        seeds: null,
        leechers: null,
        completed: null,
        trackers: pm.trackers || [],
        comment: "",
        created_by: "",
        creation_date: "",
        download_url: ""
      };
      body.innerHTML = "";
      body.appendChild(buildTorrentCard(t));
    } else {
      body.textContent = message;
    }
  } else {
    const gifUrl = parseGifMarker(message);
    if (gifUrl) {
      body.innerHTML = "";
      const wrap = document.createElement("div");
      wrap.className = "ym-gifWrap";

      const img = document.createElement("img");
      configureGifInlineImage(img, gifUrl);

      const open = document.createElement("a");
      open.className = "ym-gifOpen";
      open.href = gifUrl;
      open.target = "_blank";
      open.rel = "noopener noreferrer";
      open.textContent = "Open";

      wrap.appendChild(img);
      wrap.appendChild(open);
      body.appendChild(wrap);
    } else {
      body.textContent = message;
    }
  }

  // Message line: text + (hover) reaction picker on the SAME line
  const line = document.createElement("div");
  line.className = "msgLine";

  const actions = document.createElement("div");
  actions.className = "msgActions";
  DEFAULT_REACTION_EMOJIS.forEach((emoji) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "reactBtn";
    b.textContent = emoji;
    b.dataset.emoji = emoji;
    b.title = `React ${emoji}`;
    b.onclick = () => _sendReaction(viewEl, room, messageId, emoji);
    actions.appendChild(b);
  });

  const rx = document.createElement("div");
  rx.className = "msgReactions";

  line.appendChild(body);
  line.appendChild(actions);

  row.appendChild(head);
  row.appendChild(line);
  row.appendChild(rx);

  log.appendChild(row);
  viewEl._ym.msgIndex.set(messageId, row);
  log.scrollTop = log.scrollHeight;
}

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

// ───────────────────────────────────────────────────────────────────────────────
// DMs (E2EE) — floating windows
// ───────────────────────────────────────────────────────────────────────────────
function openPrivateChat(username) {
  if (!username) return;

  const id = "dm:" + username;
  const existed = UIState.windows.has(id);
  const win = createWindow({ id, title: `Chat — ${username}`, kind: "dm" });
  if (!win) return;

  // Load local history (if enabled) once per window.
  ensureDmHistoryRendered(win, username);

  if (!existed) {
    win._ym.send.onclick = async () => {
      const msg = win._ym.input.value.trim();
      if (!msg) return;

      try {
        // Magnet paste → render as torrent card in chat (Yahoo-ish)
        if (isMagnetText(msg)) {
          const meta = await sendTorrentMagnetShare(username, msg, { win });
          if (meta) {
            addPmHistory(username, "out", `🧲 Magnet: ${meta.name || meta.infohash}`);
            win._ym.input.value = "";
          }
          return;
        }

        const ok = await sendPrivateTo(username, msg);
        if (ok) {
          appendLine(win, "You:", msg);
          addPmHistory(username, "out", msg);
          win._ym.input.value = "";
        }
      } catch (e) {
        console.error(e);
        toast("❌ Message send failed", "error");
      }
    };


    // DM GIF button (send without touching the composer input)
    if (win._ym?.gifBtn) {
      win._ym.gifBtn.onclick = () => {
        openGifPicker(async (url) => {
          const clean = _gifFallbackUrl(url) || url;
          const msg = `gif:${clean}`;
          try {
            const ok = await sendPrivateTo(username, msg);
            if (ok) {
              appendLine(win, "You:", msg);
              addPmHistory(username, "out", msg);
            } else {
              toast("❌ GIF send failed", "error");
            }
          } catch (e) {
            console.error(e);
            toast(`❌ GIF send failed: ${e?.message || e}`, "error");
          }
        });
      };
    }

    // File share (encrypted upload) button between log + compose
    if (win._ym.fileBtn && win._ym.fileInput) {
      win._ym.fileBtn.onclick = () => win._ym.fileInput.click();
      win._ym.fileInput.onchange = async () => {
        const f = win._ym.fileInput.files && win._ym.fileInput.files[0];
        // Reset selection immediately so reselecting the same file triggers change
        win._ym.fileInput.value = "";
        if (!f) return;

        try {
          if (isTorrentName(f.name)) {
            toast(`🧲 Sharing torrent ${f.name}…`, "info", 1600);
            await sendTorrentShare(username, f, { win });
            addPmHistory(username, "out", `🧲 Torrent: ${f.name}`);
            toast(`✅ Torrent shared with ${username}`, "ok");
            return;
          }

          toast(`⬆️ Uploading ${f.name}…`, "info", 1600);
          const payload = await sendDmFileTo(username, f, { win });
          if (payload) {
            appendDmPayload(win, "You:", payload, { peer: username, direction: "out" });
            addPmHistory(username, "out", `📎 ${payload.name} (${humanBytes(payload.size)})`);
            toast(`✅ Sent file to ${username}`, "ok");
          }
        } catch (e) {
          console.error(e);
          toast(`❌ File send failed: ${e?.message || e}`, "error");
        }
      };
    }

    // Voice controls (Yahoo-ish bar)
    if (win._ym.voiceBtn) {
      // Start hidden by default
      voiceDmUi(username, { statusText: "Not connected", mode: "idle", hideBar: true });

      win._ym.voiceBtn.onclick = () => voiceToggleDmMain(username);
      win._ym.voiceBtn.oncontextmenu = (ev) => {
        try {
          ev.preventDefault();
          if (!VOICE_STATE.micStream) return false;
          const muted = !VOICE_STATE.micMuted;
          voiceSetMute(muted);
          voiceDmUi(username, { muteLabel: muted ? "Unmute" : "Mute" });
          voiceUpdateDmVoiceButton(username);
          toast(muted ? "🔇 Mic muted" : "🎤 Mic unmuted", "info");
        } catch (e) {}
        return false;
      };


      win._ym.voiceBtnCall && (win._ym.voiceBtnCall.onclick = () => voiceStartDmCall(username));
      win._ym.voiceBtnHang && (win._ym.voiceBtnHang.onclick = () => voiceHangupDm(username, "Ended", true));
      win._ym.voiceBtnMute && (win._ym.voiceBtnMute.onclick = () => voiceToggleMuteDm(username));
      win._ym.voiceBtnAccept && (win._ym.voiceBtnAccept.onclick = () => voiceAcceptDmCall(username));
      win._ym.voiceBtnDecline && (win._ym.voiceBtnDecline.onclick = () => voiceDeclineDmCall(username, "Declined"));
    }
  }

  bringToFront(win);
  return win;
}

// ───────────────────────────────────────────────────────────────────────────────
async function sendPrivateTo(to, plaintext) {
  const allowPlain = ALLOW_PLAINTEXT_DM_FALLBACK && !REQUIRE_DM_E2EE;

  // If WebCrypto isn't available (non-HTTPS/non-localhost), optionally fall back to plaintext wrapper.
  if (!HAS_WEBCRYPTO) {
    if (allowPlain) {
      try {
        const cipher = wrapPlainDm(plaintext);
        const ok = await new Promise((resolve) => {
          socket.emit("send_direct_message", { to, cipher }, (res) => resolve(!!(res && res.success)));
        });
        if (ok) {
          toast("⚠️ Sent without E2EE (compat mode)", "warn", 2600);
          return true;
        }
      } catch (e) {
        console.error(e);
      }
    }
    toast("🔒 Private messages require HTTPS or http://localhost.", "warn");
    return false;
  }

  // Normal E2EE path (hybrid RSA-OAEP + AES-GCM envelope)
  try {
    // IMPORTANT: do not rely on a long-lived cached pubkey for DMs.
    // Keys can rotate (e.g., after password reset), and stale caches cause 1-way "could not decrypt".
    const rsaPubKey = await getUserRsaPublicKey(to, { forceRefresh: true });

    const encoder = new TextEncoder();
    const msgBytes = encoder.encode(String(plaintext ?? ""));

    const aesKey = await window.crypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 },
      true,
      ["encrypt", "decrypt"]
    );
    const iv = window.crypto.getRandomValues(new Uint8Array(12));
    const ctBuffer = await window.crypto.subtle.encrypt({ name: "AES-GCM", iv }, aesKey, msgBytes);
    const rawAesKey = await window.crypto.subtle.exportKey("raw", aesKey);
    const wrappedKey = await window.crypto.subtle.encrypt({ name: "RSA-OAEP" }, rsaPubKey, rawAesKey);

    const envelope = {
      v: 1,
      alg: "RSA-OAEP+AES-GCM",
      ek: b64FromBytes(new Uint8Array(wrappedKey)),
      iv: b64FromBytes(iv),
      ct: b64FromBytes(new Uint8Array(ctBuffer))
    };

    const cipher = PM_ENVELOPE_PREFIX + btoa(JSON.stringify(envelope));

    const ok = await new Promise((resolve) => {
      socket.emit("send_direct_message", { to, cipher }, (res) => resolve(!!(res && res.success)));
    });

    if (!ok) toast(`❌ PM to ${to} failed`, "error");
    return ok;
  } catch (e) {
    console.error(e);

    // Compatibility: peer may lack keys (or server refused /get_public_key). Optionally fall back.
    if (allowPlain) {
      try {
        const cipher = wrapPlainDm(plaintext);
        const ok = await new Promise((resolve) => {
          socket.emit("send_direct_message", { to, cipher }, (res) => resolve(!!(res && res.success)));
        });
        if (ok) {
          toast("⚠️ Sent without E2EE (peer missing keys)", "warn", 2600);
          return true;
        }
      } catch (e2) {
        console.error(e2);
      }
    }

    toast("❌ Failed to encrypt or send PM", "error");
    return false;
  }
}



// ───────────────────────────────────────────────────────────────────────────────
// Rooms (optional ciphertext-only envelopes)
// ───────────────────────────────────────────────────────────────────────────────
async function encryptRoomEnvelopeForUsers(recipients, plaintext) {
  // Hybrid encrypt (per message): AES-GCM payload, RSA-OAEP wraps AES key *per recipient*.
  const encoder = new TextEncoder();
  const msgBytes = encoder.encode(String(plaintext ?? ""));

  const aesKey = await window.crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"]
  );
  const iv = window.crypto.getRandomValues(new Uint8Array(12));
  const ctBuffer = await window.crypto.subtle.encrypt({ name: "AES-GCM", iv }, aesKey, msgBytes);

  const rawAesKey = await window.crypto.subtle.exportKey("raw", aesKey);

  const keys = {};
  for (const u of recipients) {
    const rsaPubKey = await getUserRsaPublicKey(u);
    const wrappedKey = await window.crypto.subtle.encrypt({ name: "RSA-OAEP" }, rsaPubKey, rawAesKey);
    keys[u] = b64FromBytes(new Uint8Array(wrappedKey));
  }

  const envelope = {
    v: 1,
    alg: "RSA-OAEP+AES-GCM",
    iv: b64FromBytes(iv),
    ct: b64FromBytes(new Uint8Array(ctBuffer)),
    keys
  };

  return ROOM_ENVELOPE_PREFIX + btoa(JSON.stringify(envelope));
}


// Encrypt a group message to all group members (AES-GCM payload + RSA-OAEP wrapped AES key per member).
async function encryptGroupEnvelopeForUsers(recipients, plaintext) {
  const encoder = new TextEncoder();
  const msgBytes = encoder.encode(String(plaintext ?? ""));

  const aesKey = await window.crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"]
  );
  const iv = window.crypto.getRandomValues(new Uint8Array(12));
  const ctBuffer = await window.crypto.subtle.encrypt({ name: "AES-GCM", iv }, aesKey, msgBytes);

  const rawAesKey = await window.crypto.subtle.exportKey("raw", aesKey);

  const keys = {};
  for (const u of recipients) {
    const rsaPubKey = await getUserRsaPublicKey(u);
    const wrappedKey = await window.crypto.subtle.encrypt({ name: "RSA-OAEP" }, rsaPubKey, rawAesKey);
    keys[u] = b64FromBytes(new Uint8Array(wrappedKey));
  }

  const envelope = {
    v: 1,
    alg: "RSA-OAEP+AES-GCM",
    iv: b64FromBytes(iv),
    ct: b64FromBytes(new Uint8Array(ctBuffer)),
    keys
  };

  return GROUP_ENVELOPE_PREFIX + btoa(JSON.stringify(envelope));
}

async function decryptGroupEnvelope(privKey, cipherStr) {
  const envJson = atob(cipherStr.slice(GROUP_ENVELOPE_PREFIX.length));
  let env;
  try { env = JSON.parse(envJson); } catch { throw new Error("Bad group envelope JSON"); }

  if (!env || env.v !== 1 || env.alg !== "RSA-OAEP+AES-GCM" || !env.keys) {
    throw new Error("Unknown group envelope format");
  }
  const myEk = env.keys[currentUser];
  if (!myEk) throw new Error("No recipient key for me");

  const wrappedKeyBuf = bytesFromB64(String(myEk)).buffer;
  const rawAesKey = await window.crypto.subtle.decrypt({ name: "RSA-OAEP" }, privKey, wrappedKeyBuf);

  const aesKey = await window.crypto.subtle.importKey("raw", rawAesKey, { name: "AES-GCM" }, false, ["decrypt"]);
  const iv = bytesFromB64(env.iv);
  const ctBuf = bytesFromB64(env.ct).buffer;

  const decryptedBuffer = await window.crypto.subtle.decrypt({ name: "AES-GCM", iv }, aesKey, ctBuf);
  return new TextDecoder().decode(decryptedBuffer);
}

async function decryptRoomEnvelope(privKey, cipherStr) {
  const envJson = atob(cipherStr.slice(ROOM_ENVELOPE_PREFIX.length));
  let env;
  try { env = JSON.parse(envJson); } catch { throw new Error("Bad room envelope JSON"); }

  if (!env || env.v !== 1 || env.alg !== "RSA-OAEP+AES-GCM" || !env.keys) {
    throw new Error("Unknown room envelope format");
  }
  const myEk = env.keys[currentUser];
  if (!myEk) throw new Error("No recipient key for me");

  const wrappedKeyBuf = bytesFromB64(String(myEk)).buffer;
  const rawAesKey = await window.crypto.subtle.decrypt({ name: "RSA-OAEP" }, privKey, wrappedKeyBuf);

  const aesKey = await window.crypto.subtle.importKey("raw", rawAesKey, { name: "AES-GCM" }, false, ["decrypt"]);
  const iv = bytesFromB64(env.iv);
  const ctBuf = bytesFromB64(env.ct).buffer;

  const decryptedBuffer = await window.crypto.subtle.decrypt({ name: "AES-GCM", iv }, aesKey, ctBuf);
  return new TextDecoder().decode(decryptedBuffer);
}

// Encrypt a room message to all *current* room members that have public keys.
// If any member lacks a key, we abort (ciphertext-only guarantee).
async function buildRoomCipher(room, plaintext) {
  if (!HAS_WEBCRYPTO) throw new Error("Room encryption requires HTTPS or http://localhost.");

  // Get the freshest roster we can.
  const users = await requestRoomUsers(room, 1500).catch(() => (UIState.roomUsers.get(room) || []));
  const uniq = Array.from(new Set((users || []).map(String).filter(Boolean)));
  if (!uniq.includes(currentUser)) uniq.push(currentUser);

  // Prefetch keys (so we can provide a clear error list)
  const missing = [];
  for (const u of uniq) {
    try {
      await getUserRsaPublicKey(u);
    } catch {
      missing.push(u);
    }
  }
  if (missing.length) {
    throw new Error(`Users missing public keys: ${missing.slice(0, 6).join(", ")}${missing.length > 6 ? "…" : ""}`);
  }

  return await encryptRoomEnvelopeForUsers(uniq, plaintext);
}

async function sendRoomTo(room, plaintext) {
  const useE2EE = Settings.get("roomE2EE", true);

  if (useE2EE && HAS_WEBCRYPTO) {
    const cipher = await buildRoomCipher(room, plaintext);
    return await new Promise((resolve) => {
      socket.emit("send_message", { room, cipher }, (res) => {
        const out = res || { success: false };
        try {
          if (!out?.success && out?.error) {
            const e = String(out.error).toLowerCase();
            if (e.includes("read-only") || e.includes("read only")) upsertRoomPolicy(room, { readonly: true, can_send: false, block_reason: "read_only" });
            if (e.includes("locked")) upsertRoomPolicy(room, { locked: true, can_send: false, block_reason: "locked" });
          }
        } catch {}
        resolve(out);
      });
    });
  }

  return await new Promise((resolve) => {
    socket.emit("send_message", { room, message: String(plaintext ?? "") }, (res) => {
        const out = res || { success: false };
        try {
          if (!out?.success && out?.error) {
            const e = String(out.error).toLowerCase();
            if (e.includes("read-only") || e.includes("read only")) upsertRoomPolicy(room, { readonly: true, can_send: false, block_reason: "read_only" });
            if (e.includes("locked")) upsertRoomPolicy(room, { locked: true, can_send: false, block_reason: "locked" });
          }
        } catch {}
        resolve(out);
      });
  });
}


function requestGroupMembers(groupId, timeoutMs = 1500) {
  return new Promise((resolve, reject) => {
    const gid = Number(groupId);
    if (!gid) return resolve([]);
    let done = false;
    const t = setTimeout(() => {
      if (done) return;
      done = true;
      reject(new Error("group_members timeout"));
    }, timeoutMs);

    socket.emit("get_group_members", { group_id: gid }, (res) => {
      if (done) return;
      done = true;
      clearTimeout(t);
      if (res?.success) return resolve(Array.isArray(res.members) ? res.members : []);
      reject(new Error(res?.error || "group_members failed"));
    });
  });
}

// Encrypt a group message to all group members that have public keys.
// If any member lacks a key, we abort (ciphertext-only guarantee).
async function buildGroupCipher(groupId, plaintext) {
  if (!HAS_WEBCRYPTO) throw new Error("Group encryption requires HTTPS or http://localhost.");

  const gid = Number(groupId);
  // Prefer cached members, but refresh from server when possible.
  const cached = UIState.groupMembers.get(gid) || [];
  const members = await requestGroupMembers(gid, 1500).catch(() => cached);
  const uniq = Array.from(new Set((members || []).map(String).filter(Boolean)));
  if (!uniq.includes(currentUser)) uniq.push(currentUser);

  const missing = [];
  for (const u of uniq) {
    try { await getUserRsaPublicKey(u); } catch { missing.push(u); }
  }
  if (missing.length) {
    throw new Error(`Users missing public keys: ${missing.slice(0, 6).join(", ")}${missing.length > 6 ? "…" : ""}`);
  }

  return await encryptGroupEnvelopeForUsers(uniq, plaintext);
}

async function sendGroupTo(groupId, plaintext) {
  const useE2EE = Settings.get("groupE2EE", true);
  const gid = Number(groupId);

  if (useE2EE && HAS_WEBCRYPTO) {
    const cipher = await buildGroupCipher(gid, plaintext);
    return await new Promise((resolve) => {
      socket.emit("group_message", { group_id: gid, cipher }, (res) => resolve(res || { success: false }));
    });
  }

  return await new Promise((resolve) => {
    socket.emit("group_message", { group_id: gid, message: String(plaintext ?? "") }, (res) => resolve(res || { success: false }));
  });
}


async function sendGroupCipher(groupId, plaintext) {
  const gid = Number(groupId);
  const cipher = await buildGroupCipher(gid, plaintext);
  return await new Promise((resolve) => {
    socket.emit("group_message", { group_id: gid, cipher }, (res) => resolve(res));
  });
}

async function sendGroupFileTo(groupId, file, ctx = {}) {
  if (!file) return null;
  if (!HAS_WEBCRYPTO) {
    toast("🔒 Group file transfers require HTTPS (or http://localhost).", "warn", 5200);
    return null;
  }
  if (file.size > MAX_GROUP_FILE_BYTES) {
    toast(`❌ File too large (max ${humanBytes(MAX_GROUP_FILE_BYTES)})`, "error");
    return null;
  }

  const gid = Number(groupId);
  const win = ctx?.win || null;
  const meta = {
    name: file.name || "file",
    size: file.size || 0,
    mime: file.type || "application/octet-stream",
  };

  let ui = null;
  try {
    if (win) {
      ui = appendP2pTransferUI(win, "You:", meta, { mode: "outgoing" });
      if (ui?.setBadge) ui.setBadge("SRV");
      ui.setStatus("Encrypting…");
    }

    const arrayBuffer = await file.arrayBuffer();
    const sha256 = await sha256HexFromArrayBuffer(arrayBuffer);
    meta.sha256 = sha256;

    // Get group member list (includes current user).
    const cached = UIState.groupMembers.get(gid) || [];
    const members = await requestGroupMembers(gid, 1500).catch(() => cached);
    const uniq = Array.from(new Set((members || []).map(String).filter(Boolean)));
    if (!uniq.includes(currentUser)) uniq.push(currentUser);

    // Ensure all pubkeys exist
    const missing = [];
    for (const u of uniq) {
      try { await getUserRsaPublicKey(u); } catch { missing.push(u); }
    }
    if (missing.length) {
      throw new Error(`Users missing public keys: ${missing.slice(0, 6).join(", ")}${missing.length > 6 ? "…" : ""}`);
    }

    // Encrypt file bytes under random AES key, wrap AES key for each member.
    const aesKey = await window.crypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 },
      true,
      ["encrypt", "decrypt"]
    );
    const iv = window.crypto.getRandomValues(new Uint8Array(12));
    const ctBuf = await window.crypto.subtle.encrypt({ name: "AES-GCM", iv }, aesKey, arrayBuffer);
    const rawAesKey = await window.crypto.subtle.exportKey("raw", aesKey);

    const ek_map = {};
    for (const u of uniq) {
      const pub = await getUserRsaPublicKey(u);
      const ek = await window.crypto.subtle.encrypt({ name: "RSA-OAEP" }, pub, rawAesKey);
      ek_map[u] = bytesToB64(new Uint8Array(ek));
    }

    const ctBlob = new Blob([ctBuf], { type: "application/octet-stream" });

    if (ui) ui.setStatus("Uploading…");

    const uploaded = await uploadEncryptedGroupFile(gid, {
      ctBlob,
      originalName: meta.name,
      mimeType: meta.mime,
      ivBytes: iv,
      ek_map,
      sha256: meta.sha256,
    }, {
      onProgress: (pct) => {
        if (ui) ui.setStatus(`Uploading… ${Math.max(0, Math.min(100, Math.floor(pct)))}%`);
      }
    });

    // Send metadata as a group-encrypted payload (never plaintext).
    const wire = {
      kind: "file",
      scope: "group",
      source: "server",
      group_id: gid,
      file_id: uploaded.file_id,
      name: uploaded.name || meta.name,
      size: uploaded.size || meta.size,
      mime: uploaded.mime || meta.mime,
      sha256: uploaded.sha256 || meta.sha256,
    };

    if (ui) ui.setStatus("Sending…");
    const res = await sendGroupCipher(gid, JSON.stringify(wire));
    if (!res?.success) throw new Error(res?.error || "Could not notify group");

    if (ui) ui.remove();
    return wire;
  } catch (e) {
    if (ui) {
      const msg = String(e?.message || e || "Failed");
      ui.setStatus(`❌ Failed: ${msg}`);
      setTimeout(() => ui.remove(), 6500);
    }
    throw e;
  }
}

async function getUserRsaPublicKey(username, opts = {}) {
  // Fetch user’s public key PEM (cookies carry JWT). If the access token expired,
  // refresh and retry automatically.
  const uname = String(username || "").trim();
  if (!uname) throw new Error("username required");
  const forceRefresh = !!opts.forceRefresh;
  const now = Date.now();
  const cached = RSA_PUBKEY_CACHE.get(uname);
  if (cached && cached.key && !forceRefresh) {
    const age = now - (Number(cached.fetchedAt) || 0);
    if (age >= 0 && age < RSA_PUBKEY_CACHE_TTL_MS) return cached.key;
  }

  const resp = await fetchWithAuth(`/get_public_key?username=${encodeURIComponent(uname)}`, {
    method: "GET",
    credentials: "same-origin"
  });
  if (!resp.ok) {
    let detail = "";
    try {
      const j = await resp.json();
      detail = j?.error || j?.msg || JSON.stringify(j);
    } catch {
      try { detail = (await resp.text()).slice(0, 200); } catch {}
    }
    const extra = detail ? `: ${detail}` : "";
    throw new Error(`Could not fetch public key for ${uname} (HTTP ${resp.status}${extra})`);
  }
  const { public_key } = await resp.json();
  const pubPem = String(public_key || "")
    .replace("-----BEGIN PUBLIC KEY-----", "")
    .replace("-----END PUBLIC KEY-----", "")
    .replace(/\s+/g, "");
  const pubDer = Uint8Array.from(atob(pubPem), c => c.charCodeAt(0));
  const key = await window.crypto.subtle.importKey(
    "spki",
    pubDer.buffer,
    { name: "RSA-OAEP", hash: "SHA-256" },
    false,
    ["encrypt"]
  );
  RSA_PUBKEY_CACHE.set(uname, { key, fetchedAt: now });
  return key;
}

async function sha256HexFromArrayBuffer(ab) {
  if (!HAS_WEBCRYPTO) {
    throw new Error("File transfers require HTTPS (or http://localhost).");
  }
  const hash = await window.crypto.subtle.digest("SHA-256", ab);
  const bytes = new Uint8Array(hash);
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

async function uploadEncryptedDmFile(toUser, payload, { onProgress } = {}) {
  if (!HAS_WEBCRYPTO) throw new Error(`E2EE requires HTTPS (or http://localhost / http://127.0.0.1). Current origin: ${window.location.origin}`);

  // Back-compat accepted shapes:
  //  - { ctBlob, originalName, mimeType, iv_b64, ek_to_b64, ek_from_b64, sha256 }
  //  - { ctBytes, original_name, mime_type, ivBytes, ekToBytes, ekFromBytes, sha256 }
  const originalName = payload.originalName || payload.original_name || payload.name || "file.bin";
  const mimeType = payload.mimeType || payload.mime_type || payload.mime || "application/octet-stream";

  const ctBlob = payload.ctBlob
    ? payload.ctBlob
    : new Blob([payload.ctBytes || new Uint8Array()], { type: "application/octet-stream" });

  const iv_b64 = payload.iv_b64 || (payload.ivBytes ? bytesToB64(payload.ivBytes) : "");
  const ek_to_b64 = payload.ek_to_b64 || (payload.ekToBytes ? bytesToB64(payload.ekToBytes) : "");
  const ek_from_b64 = payload.ek_from_b64 || (payload.ekFromBytes ? bytesToB64(payload.ekFromBytes) : "");

  if (!iv_b64 || !ek_to_b64 || !ek_from_b64) throw new Error("Missing encryption envelope fields");

  const fd = new FormData();
  fd.append("to", toUser);
  fd.append("file", ctBlob, "cipher.bin");
  fd.append("iv_b64", iv_b64);
  fd.append("ek_to_b64", ek_to_b64);
  fd.append("ek_from_b64", ek_from_b64);
  if (payload.sha256) fd.append("sha256", payload.sha256);
  fd.append("original_name", originalName);
  fd.append("mime_type", mimeType);

  // Prefer XHR so we can show progress, but fall back to fetch() if the
  // browser/network stack wedges (seen in some environments).
  let res = null;
  try {
    res = await xhrPostFormWithAuth("/api/dm_files/upload", fd, { onProgress });
  } catch (e) {
    console.warn("XHR upload failed; retrying with fetch()", e);
    res = await fetchPostFormWithAuth("/api/dm_files/upload", fd);
  }

  const data = res?.json || null;

  if (!res?.ok || !data?.success) {
    const fallback = (res?.text || "").trim();
    const snippet = fallback ? ` — ${fallback.slice(0, 180)}` : "";
    const msg = data?.error || `Upload failed (HTTP ${res?.status ?? "?"})${snippet}`;
    throw new Error(msg);
  }
  return data; // {success, file_id, name, mime, size}
}


async function uploadEncryptedGroupFile(groupId, payload, { onProgress } = {}) {
  if (!HAS_WEBCRYPTO) throw new Error(`E2EE requires HTTPS (or http://localhost / http://127.0.0.1). Current origin: ${window.location.origin}`);

  const originalName = payload.originalName || payload.original_name || payload.name || "file.bin";
  const mimeType = payload.mimeType || payload.mime_type || payload.mime || "application/octet-stream";

  const ctBlob = payload.ctBlob
    ? payload.ctBlob
    : new Blob([payload.ctBytes || new Uint8Array()], { type: "application/octet-stream" });

  const iv_b64 = payload.iv_b64 || (payload.ivBytes ? bytesToB64(payload.ivBytes) : "");
  const ek_map = payload.ek_map || payload.ekMap || null;
  const ek_map_json = payload.ek_map_json || (ek_map ? JSON.stringify(ek_map) : "");

  if (!iv_b64 || !ek_map_json) throw new Error("Missing encryption envelope fields");

  const fd = new FormData();
  fd.append("group_id", String(groupId));
  fd.append("file", ctBlob, "cipher.bin");
  fd.append("iv_b64", iv_b64);
  fd.append("ek_map_json", ek_map_json);
  if (payload.sha256) fd.append("sha256", payload.sha256);
  fd.append("original_name", originalName);
  fd.append("mime_type", mimeType);

  let res = null;
  try {
    res = await xhrPostFormWithAuth("/api/group_files/upload", fd, { onProgress });
  } catch (e) {
    console.warn("XHR upload failed; retrying with fetch()", e);
    res = await fetchPostFormWithAuth("/api/group_files/upload", fd);
  }

  const data = res?.json || null;
  if (!res?.ok || !data?.success) {
    const fallback = (res?.text || "").trim();
    const snippet = fallback ? ` — ${fallback.slice(0, 180)}` : "";
    const msg = data?.error || `Upload failed (HTTP ${res?.status ?? "?"})${snippet}`;
    throw new Error(msg);
  }
  return data; // {success, group_id, file_id, name, mime, size, sha256}
}

async function sendDmFileTo(toUser, file, ctx = {}) {
  if (!file) return null;
  if (!HAS_WEBCRYPTO) {
    toast("🔒 File transfers require HTTPS (or http://localhost).", "warn", 5200);
    return null;
  }
  if (file.size > MAX_DM_FILE_BYTES) {
    toast(`❌ File too large (max ${humanBytes(MAX_DM_FILE_BYTES)})`, "error");
    return null;
  }

  // Small UX: show a Yahoo-style transfer line while we attempt P2P / upload.
  const win = ctx?.win || null;
  const meta = {
    name: file.name || "file",
    size: file.size || 0,
    mime: file.type || "application/octet-stream",
  };

  let ui = null;
  try {
    if (win) {
      ui = appendP2pTransferUI(win, "You:", meta, { mode: "outgoing" });
      if (ui?.setBadge) ui.setBadge("P2P");
      ui.setStatus("Negotiating P2P…");
    }

    // Preload bytes once; reused for hashing + P2P send + server fallback.
    const arrayBuffer = await file.arrayBuffer();
    const sha256 = await sha256HexFromArrayBuffer(arrayBuffer);
    meta.sha256 = sha256;

    // 1) P2P first (WebRTC DataChannel), 2) fallback to encrypted server upload.
    if (P2P_FILE_ENABLED) {
      let p2pPayload = null;
      try {
        p2pPayload = await tryP2PFileTransfer(toUser, meta, arrayBuffer, { ui });
      } catch (e) {
        const msg = String(e?.message || e || "");
        if (msg.toLowerCase().includes("declin")) {
          if (ui) {
            ui.setStatus("❌ Declined");
            setTimeout(() => ui.remove(), 900);
          }
          return null; // do NOT fallback if the peer explicitly declined.
        }
        console.warn("P2P file transfer failed, falling back to server:", e);
        p2pPayload = null;
      }
      if (p2pPayload) {
        if (ui) ui.remove();
        return p2pPayload;
      }
    }

    if (ui?.setBadge) ui.setBadge("SRV");
    if (ui) ui.setStatus("P2P unavailable — uploading to server…");
    const serverPayload = await sendDmFileViaServer(toUser, meta, arrayBuffer, { ui });
    if (ui) ui.remove();
    return serverPayload;
  } catch (e) {
    if (ui) {
      const msg = String(e?.message || e || "Failed");
      ui.setStatus(`❌ Failed: ${msg}`);
      setTimeout(() => ui.remove(), 6500);
    }
    throw e;
  }
}

async function sendDmFileViaServer(toUser, meta, arrayBuffer, { ui } = {}) {
  if (!HAS_WEBCRYPTO) {
    toast("🔒 File sharing requires HTTPS or http://localhost.", "warn");
    return null;
  }
  if (!toUser || !arrayBuffer) return null;

  // Two wrapped keys: recipient + sender. Server cannot decrypt.
  // Recipient key can rotate (password reset). Fetch fresh to avoid encrypting to a stale key.
  const pubTo = await getUserRsaPublicKey(toUser, { forceRefresh: true });
  const pubMe = await getUserRsaPublicKey(currentUser);

  const aesKey = await window.crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"]
  );
  const iv = window.crypto.getRandomValues(new Uint8Array(12));
  const ctBuf = await window.crypto.subtle.encrypt({ name: "AES-GCM", iv }, aesKey, arrayBuffer);
  const rawAesKey = await window.crypto.subtle.exportKey("raw", aesKey);
  const ekTo = await window.crypto.subtle.encrypt({ name: "RSA-OAEP" }, pubTo, rawAesKey);
  const ekFrom = await window.crypto.subtle.encrypt({ name: "RSA-OAEP" }, pubMe, rawAesKey);

  if (ui?.setBadge) ui.setBadge("SRV");
  if (ui) ui.setStatus("Uploading to server (encrypted)…");

  // Upload ciphertext
  const uploadRes = await uploadEncryptedDmFile(toUser, {
    original_name: meta.name,
    mime_type: meta.mime,
    sha256: meta.sha256,
    ctBytes: new Uint8Array(ctBuf),
    ivBytes: iv,
    ekToBytes: new Uint8Array(ekTo),
    ekFromBytes: new Uint8Array(ekFrom),
  }, { onProgress: (p) => { try { ui && ui.setProgress(p); } catch {} } });

  if (!uploadRes?.file_id) {
    throw new Error(uploadRes?.error || "Upload did not return a file id");
  }

  // Notify peer via normal encrypted PM (wire payload)
  const wire = {
    _ec: "file",
    v: 1,
    file_id: uploadRes.file_id,
    name: meta.name,
    size: meta.size,
    mime: meta.mime,
    sha256: meta.sha256,
  };

  if (ui) ui.setStatus("Notifying peer…");

  const ok = await sendPrivateTo(toUser, JSON.stringify(wire));
  if (!ok) throw new Error("Could not notify peer");

  // Return a UI-friendly payload shape (used by appendDmPayload)
  return {
    kind: "file",
    source: "server",
    file_id: wire.file_id,
    name: wire.name,
    size: wire.size,
    mime: wire.mime,
    sha256: wire.sha256,
  };
}

// ───────────────────────────────────────────────────────────────────────────────
// WebRTC P2P file transfers (Yahoo-style): try P2P first, then fallback to server.
// Server is used ONLY as signaling relay (offer/answer/ICE), not as a data path.
// ───────────────────────────────────────────────────────────────────────────────
function socketEmitAck(event, data, timeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    let done = false;
    const t = setTimeout(() => {
      if (done) return;
      done = true;
      reject(new Error(`Socket ACK timeout for ${event}`));
    }, timeoutMs);

    socket.emit(event, data, (resp) => {
      if (done) return;
      done = true;
      clearTimeout(t);
      resolve(resp);
    });
  });
}

function p2pNewTransferId() {
  // Short, URL-safe id.
  const rnd = Math.random().toString(36).slice(2, 10);
  return `p2p_${Date.now().toString(36)}_${rnd}`;
}

function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }

function p2pMakePc() {
  if (typeof RTCPeerConnection === "undefined") {
    throw new Error("WebRTC not available in this browser.");
  }
  return new RTCPeerConnection({ iceServers: P2P_ICE_SERVERS });
}

async function waitForDataChannelOpen(dc, timeoutMs) {
  if (dc.readyState === "open") return true;
  return new Promise((resolve, reject) => {
    let done = false;
    const t = setTimeout(() => {
      if (done) return;
      done = true;
      reject(new Error("DataChannel open timeout"));
    }, timeoutMs);

    dc.addEventListener("open", () => {
      if (done) return;
      done = true;
      clearTimeout(t);
      resolve(true);
    }, { once: true });

    dc.addEventListener("error", () => {
      if (done) return;
      done = true;
      clearTimeout(t);
      reject(new Error("DataChannel error"));
    }, { once: true });
  });
}

function p2pSafeClose(transfer_id, why = null) {
  const tr = P2P_TRANSFERS.get(transfer_id);
  if (!tr) return;
  try { if (tr._watchdog) clearTimeout(tr._watchdog); } catch {}
  try { if (tr._watchdogInterval) clearInterval(tr._watchdogInterval); } catch {}
  try { tr.dc && tr.dc.close(); } catch {}
  try { tr.pc && tr.pc.close(); } catch {}
  if (tr.ui && why) tr.ui.setStatus(why);
  P2P_TRANSFERS.delete(transfer_id);
}

async function tryP2PFileTransfer(toUser, meta, arrayBuffer, { ui } = {}) {
  // WebRTC requires a secure context in most browsers.
  if (!window.isSecureContext) return null;
  if (!toUser || !arrayBuffer) return null;

  const transfer_id = p2pNewTransferId();
  const pc = p2pMakePc();
  const dc = pc.createDataChannel("ec_file", { ordered: true });

  dc.binaryType = "arraybuffer";

  const tr = {
    role: "sender",
    peer: toUser,
    transfer_id,
    pc,
    dc,
    ui,
    meta,
    _answerResolve: null,
    _answerReject: null,
    _ackResolve: null,
    _ackReject: null,
  };
  P2P_TRANSFERS.set(transfer_id, tr);

  pc.onicecandidate = (e) => {
    if (e.candidate) {
      socket.emit("p2p_file_ice", { to: toUser, transfer_id, candidate: e.candidate });
    }
  };

  // Listen for ack on the datachannel
  const ackPromise = new Promise((resolve, reject) => {
    tr._ackResolve = resolve;
    tr._ackReject = reject;
    const t = setTimeout(() => reject(new Error("P2P transfer timeout")), P2P_FILE_TRANSFER_TIMEOUT_MS);

    dc.addEventListener("message", (ev) => {
      if (typeof ev.data === "string") {
        try {
          const msg = JSON.parse(ev.data);
          if (msg && msg.type === "ack" && msg.transfer_id === transfer_id) {
            clearTimeout(t);
            resolve(true);
          }
        } catch {}
      }
    });
  });

  // Offer / Answer
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  if (ui) ui.setStatus("Sending P2P offer…");
  const offerResp = await socketEmitAck("p2p_file_offer", {
    to: toUser,
    transfer_id,
    offer: { type: pc.localDescription.type, sdp: pc.localDescription.sdp },
    meta,
  }).catch(() => null);

  if (!offerResp || offerResp.success === false || offerResp.delivered === false) {
    p2pSafeClose(transfer_id, "Peer offline — fallback to server");
    return null;
  }

  const answerPromise = new Promise((resolve, reject) => {
    tr._answerResolve = resolve;
    tr._answerReject = reject;
    setTimeout(() => reject(new Error("P2P answer timeout")), P2P_FILE_HANDSHAKE_TIMEOUT_MS);
  });

  const answer = await answerPromise;
  await pc.setRemoteDescription(new RTCSessionDescription(answer));

  if (ui) ui.setStatus("Connecting data channel…");
  await waitForDataChannelOpen(dc, P2P_FILE_HANDSHAKE_TIMEOUT_MS);

  // Send metadata first (JSON string), then raw chunks.
  if (ui) ui.setStatus("Sending file (P2P)…");

  dc.send(JSON.stringify({ type: "meta", transfer_id, meta }));

  const total = arrayBuffer.byteLength || 0;
  let sent = 0;

  // Backpressure thresholds
  const MAX_BUFFERED = 8 * 1024 * 1024; // 8MB
  const buf = arrayBuffer;

  for (let off = 0; off < total; off += P2P_FILE_CHUNK_BYTES) {
    const chunk = buf.slice(off, Math.min(off + P2P_FILE_CHUNK_BYTES, total));

    // Simple flow control
    while (dc.bufferedAmount > MAX_BUFFERED) {
      await delay(30);
    }

    dc.send(chunk);
    sent += chunk.byteLength || 0;
    if (ui) ui.setProgress(sent / total);
  }

  dc.send(JSON.stringify({ type: "done", transfer_id }));

  // Wait for receiver ack (assembled)
  await ackPromise;

  if (ui) {
    ui.setProgress(1);
    ui.setStatus("✅ Sent via P2P");
  }

  // Keep the connection around briefly so late ICE doesn't explode.
  setTimeout(() => p2pSafeClose(transfer_id), 1200);

  return {
    kind: "file",
    source: "p2p",
    transfer_id,
    name: meta.name,
    size: meta.size,
    mime: meta.mime,
    sha256: meta.sha256,
  };
}

async function downloadAndDecryptDmFile(fileId, fallbackName) {
  if (!HAS_WEBCRYPTO) throw new Error(`E2EE requires HTTPS (or http://localhost / http://127.0.0.1). Current origin: ${window.location.origin}`);
  const privKey = await ensurePrivateKeyUnlocked();

  const metaResp = await fetchWithAuth(`/api/dm_files/${encodeURIComponent(fileId)}/meta`, {
    method: "GET",
    credentials: "same-origin",
  });
  const meta = await metaResp.json().catch(() => null);
  if (!metaResp.ok || !meta?.success) {
    throw new Error(meta?.error || `Metadata fetch failed (HTTP ${metaResp.status})`);
  }

  const blobResp = await fetchWithAuth(`/api/dm_files/${encodeURIComponent(fileId)}/blob`, {
    method: "GET",
    credentials: "same-origin",
  });
  if (!blobResp.ok) {
    throw new Error(`Blob fetch failed (HTTP ${blobResp.status})`);
  }
  const ctBuf = await blobResp.arrayBuffer();

  const wrappedKeyBuf = bytesFromB64(meta.ek_b64).buffer;
  const rawAesKey = await window.crypto.subtle.decrypt({ name: "RSA-OAEP" }, privKey, wrappedKeyBuf);
  const aesKey = await window.crypto.subtle.importKey("raw", rawAesKey, { name: "AES-GCM" }, false, ["decrypt"]);
  const iv = bytesFromB64(meta.iv_b64);

  const ptBuf = await window.crypto.subtle.decrypt({ name: "AES-GCM", iv }, aesKey, ctBuf);
  const mime = meta.mime || "application/octet-stream";
  const outBlob = new Blob([ptBuf], { type: mime });
  const filename = meta.name || fallbackName || "file";
  downloadBlob(filename, outBlob);
}


async function downloadAndDecryptGroupFile(fileId, fallbackName, groupId) {
  if (!HAS_WEBCRYPTO) throw new Error(`E2EE requires HTTPS (or http://localhost / http://127.0.0.1). Current origin: ${window.location.origin}`);
  const privKey = await ensurePrivateKeyUnlocked();

  const metaResp = await fetchWithAuth(`/api/group_files/${encodeURIComponent(fileId)}/meta`, {
    method: "GET",
    credentials: "same-origin",
  });
  const meta = await metaResp.json().catch(() => null);
  if (!metaResp.ok || !meta?.success) {
    throw new Error(meta?.error || `Metadata fetch failed (HTTP ${metaResp.status})`);
  }
  if (groupId && Number(meta.group_id) !== Number(groupId)) {
    // Soft guard: the server is authoritative, but keep UI consistent.
    console.warn("Group file meta group_id mismatch", { meta_gid: meta.group_id, expected: groupId });
  }

  const blobResp = await fetchWithAuth(`/api/group_files/${encodeURIComponent(fileId)}/blob`, {
    method: "GET",
    credentials: "same-origin",
  });
  if (!blobResp.ok) {
    throw new Error(`Blob fetch failed (HTTP ${blobResp.status})`);
  }
  const ctBuf = await blobResp.arrayBuffer();

  const wrappedKeyBuf = bytesFromB64(meta.ek_b64).buffer;
  const rawAesKey = await window.crypto.subtle.decrypt({ name: "RSA-OAEP" }, privKey, wrappedKeyBuf);
  const aesKey = await window.crypto.subtle.importKey("raw", rawAesKey, { name: "AES-GCM" }, false, ["decrypt"]);
  const iv = bytesFromB64(meta.iv_b64);

  const ptBuf = await window.crypto.subtle.decrypt({ name: "AES-GCM", iv }, aesKey, ctBuf);
  const mime = meta.mime || "application/octet-stream";
  const outBlob = new Blob([ptBuf], { type: mime });
  const filename = (meta.name || fallbackName || "file").toString();
  downloadBlob(filename, outBlob);
}

async function decryptLegacyRSA(privKey, cipherB64) {
  const raw = atob(cipherB64);
  const buf = new Uint8Array(raw.split("").map(c => c.charCodeAt(0))).buffer;
  const decryptedBuffer = await window.crypto.subtle.decrypt({ name: "RSA-OAEP" }, privKey, buf);
  return new TextDecoder().decode(decryptedBuffer);
}

async function decryptHybridEnvelope(privKey, cipherStr) {
  const envJson = atob(cipherStr.slice(PM_ENVELOPE_PREFIX.length));
  let env;
  try { env = JSON.parse(envJson); } catch { throw new Error("Bad PM envelope JSON"); }

  if (!env || env.v !== 1 || env.alg !== "RSA-OAEP+AES-GCM") {
    throw new Error("Unknown PM envelope format");
  }

  const wrappedKeyBuf = bytesFromB64(env.ek).buffer;
  const rawAesKey = await window.crypto.subtle.decrypt({ name: "RSA-OAEP" }, privKey, wrappedKeyBuf);

  const aesKey = await window.crypto.subtle.importKey("raw", rawAesKey, { name: "AES-GCM" }, false, ["decrypt"]);
  const iv = bytesFromB64(env.iv);
  const ctBuf = bytesFromB64(env.ct).buffer;

  const decryptedBuffer = await window.crypto.subtle.decrypt({ name: "AES-GCM", iv }, aesKey, ctBuf);
  return new TextDecoder().decode(decryptedBuffer);
}

socket.on("private_message", async ({ sender, cipher }) => {
  const win = openPrivateChat(sender) || UIState.windows.get("dm:" + sender);
  try {
    let plaintext;

    // Plaintext wrapper (compat mode): no E2EE required.
    if (typeof cipher === "string" && cipher.startsWith(PM_PLAINTEXT_PREFIX)) {
      plaintext = unwrapPlainDm(cipher);
    } else {
      const privKey = await ensurePrivateKeyUnlocked();
      if (typeof cipher === "string" && cipher.startsWith(PM_ENVELOPE_PREFIX)) {
        plaintext = await decryptHybridEnvelope(privKey, cipher);
      } else {
        plaintext = await decryptLegacyRSA(privKey, cipher);
      }
    }

    const payload = parseDmPayload(plaintext);
    const w = UIState.windows.get("dm:" + sender);
    if (w) appendDmPayload(w, `${sender}:`, payload, { peer: sender, direction: "in" });

    if (payload.kind === "file") {
      addPmHistory(sender, "in", `📎 ${payload.name} (${humanBytes(payload.size)})`);
    } else if (payload.kind === "torrent") {
      const nm = payload?.t?.name || payload?.t?.infohash || "Torrent";
      addPmHistory(sender, "in", `🧲 ${nm}`);
    } else {
      addPmHistory(sender, "in", payload.text);
    }

    if (payload.kind === "file") {
      toast(`📎 ${sender} sent a file: ${payload.name}`, "info");
      maybeBrowserNotify("File received", `${sender}: ${payload.name}`);
    } else if (payload.kind === "torrent") {
      const nm = payload?.t?.name || payload?.t?.infohash || "Torrent";
      toast(`🧲 ${sender} shared a torrent: ${nm}`, "info");
      maybeBrowserNotify("Torrent shared", `${sender}: ${nm}`);
    } else {
      toast(`📥 New PM from ${sender}`, "info");
      maybeBrowserNotify("Private message", `${sender}: ${payload.text}`);
    }
  } catch (e) {
    console.error("Failed to process PM:", e);
    const w = UIState.windows.get("dm:" + sender);

    const msg = String(e?.message || e || "");
    const low = msg.toLowerCase();

    let sysLine = "PM received but could not decrypt.";
    let toastMsg = `⚠️ PM from ${sender} (could not decrypt)`;

    if (!HAS_WEBCRYPTO) {
      sysLine = `PM received but could not decrypt (E2EE requires HTTPS or localhost; current: ${window.location.origin}).`;
      toastMsg = `⚠️ PM from ${sender} (E2EE unavailable on this origin)`;
    } else if (low.includes("private messages are locked") || low.includes("unlock skipped") || low.includes("no encrypted private key")) {
      sysLine = "🔒 PM received but your private messages are locked on this tab. Open ⚙ Settings → Unlock DMs.";
      toastMsg = `🔒 Unlock DMs to read PM from ${sender}`;
      // Best-effort: prompt once per tab.
      if (!window.__ec_unlock_prompted) {
        window.__ec_unlock_prompted = true;
        try { showUnlockModal(); } catch {}
      }
    } else if (low.includes("operationerror") || low.includes("data error") || low.includes("could not decrypt") || low.includes("bad pm envelope")) {
      // Most common cause in practice: sender encrypted to a stale public key (keys rotate after password reset).
      sysLine = "🔑 PM received but could not decrypt (key mismatch). If you recently reset your password, ask the sender to refresh and resend.";
      toastMsg = `🔑 PM from ${sender} (key mismatch)`;
    }

    if (w) appendLine(w, "System:", sysLine);
    toast(toastMsg, "warn");
  }
});

// WebRTC P2P file transfer signaling (offer/answer/ICE)
// ───────────────────────────────────────────────────────────────────────────────
socket.on("p2p_file_answer", ({ sender, transfer_id, answer }) => {
  const tr = P2P_TRANSFERS.get(transfer_id);
  if (!tr || tr.role !== "sender") return;
  if (tr._answerResolve) tr._answerResolve(answer);
});

socket.on("p2p_file_decline", ({ sender, transfer_id, reason }) => {
  const tr = P2P_TRANSFERS.get(transfer_id);
  if (!tr) return;
  if (tr._answerReject) tr._answerReject(new Error(reason || "Declined"));
  if (tr.ui) tr.ui.setStatus("❌ Declined");
  p2pSafeClose(transfer_id);
});

socket.on("p2p_file_ice", async ({ sender, transfer_id, candidate }) => {
  const tr = P2P_TRANSFERS.get(transfer_id);
  if (!tr || !tr.pc || !candidate) return;
  try {
    await tr.pc.addIceCandidate(new RTCIceCandidate(candidate));
  } catch (e) {
    // ICE can race with setRemoteDescription; ignore noisy failures.
  }
});

socket.on("p2p_file_offer", async ({ sender, transfer_id, offer, meta }) => {
  try {
    // If we already have a transfer with this id, ignore dupes.
    if (P2P_TRANSFERS.has(transfer_id)) return;

    const win = openPrivateChat(sender) || UIState.windows.get("dm:" + sender);
    if (!win) return;

    const ui = appendP2pTransferUI(win, `${sender}:`, meta || {}, { mode: "incoming" });
    ui.setStatus("Incoming file offer");

    ui.onAccept(async () => {
      ui.disableActions();
      if (ui?.setBadge) ui.setBadge("P2P");
      ui.setStatus("Accepting…");

      const pc = p2pMakePc();
      let dc = null;

      const tr = {
        role: "receiver",
        peer: sender,
        transfer_id,
        pc,
        dc: null,
        ui,
        meta: meta || {},
        recv: { expected: 0, got: 0, parts: [], gotDone: false },
        _watchdog: null,
        _watchdogInterval: null,
      };
      P2P_TRANSFERS.set(transfer_id, tr);

      const fail = (msg) => {
        try { ui.setStatus(msg || "⚠️ Transfer failed"); } catch {}
        try { socket.emit("p2p_file_decline", { to: sender, transfer_id, reason: msg || "Failed" }); } catch {}
        p2pSafeClose(transfer_id);
      };

      // ICE + state diagnostics
      pc.onicecandidate = (e) => {
        if (e.candidate) {
          socket.emit("p2p_file_ice", { to: sender, transfer_id, candidate: e.candidate });
        }
      };
      pc.onconnectionstatechange = () => {
        const st = pc.connectionState;
        if (st === "failed") fail("⚠️ Connection failed");
      };
      pc.oniceconnectionstatechange = () => {
        const st = pc.iceConnectionState;
        if (st === "failed") fail("⚠️ ICE failed");
      };

      pc.ondatachannel = (ev) => {
        dc = ev.channel;
        tr.dc = dc;
        dc.binaryType = "arraybuffer";

        dc.onmessage = async (msgEv) => {
          const data = msgEv.data;

          if (typeof data === "string") {
            let obj = null;
            try { obj = JSON.parse(data); } catch {}
            if (!obj || obj.transfer_id !== transfer_id) return;

            if (obj.type === "meta" && obj.meta) {
              tr.meta = obj.meta;
              tr.recv.expected = Number(obj.meta.size || 0) || 0;
              ui.setStatus("Receiving…");
              return;
            }

            if (obj.type === "done") {
              tr.recv.gotDone = true;
              if (tr.recv.expected && tr.recv.got >= tr.recv.expected) {
                await finalizeIncomingP2pFile(sender, transfer_id);
              }
              return;
            }

            return;
          }

          if (data instanceof ArrayBuffer) {
            tr.recv.parts.push(data);
            tr.recv.got += data.byteLength || 0;
            if (tr.recv.expected) ui.setProgress(tr.recv.got / tr.recv.expected);

            if (tr.recv.gotDone && tr.recv.expected && tr.recv.got >= tr.recv.expected) {
              await finalizeIncomingP2pFile(sender, transfer_id);
            }
          }
        };

        dc.onopen = () => ui.setStatus("Receiving…");
        dc.onerror = () => fail("⚠️ DataChannel error");
        dc.onclose = () => {
          // If we didn't finish, treat as failure.
          if (!tr.recv.gotDone || (tr.recv.expected && tr.recv.got < tr.recv.expected)) {
            fail("⚠️ Channel closed");
          }
        };
      };

      // Watchdog: if the sender never completes handshake / never sends data.
      const deadline = Date.now() + (Number(P2P_HANDSHAKE_TIMEOUT_MS) || 7000) * 3;
      tr._watchdogInterval = setInterval(() => {
        if (!P2P_TRANSFERS.has(transfer_id)) return;
        if (tr.recv.got > 0) return; // activity started
        if (Date.now() > deadline) {
          fail("⏳ Sender not responding");
        }
      }, 600);

      try {
        // Apply offer, generate answer
        await pc.setRemoteDescription(new RTCSessionDescription(offer));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);

        const resp = await socketEmitAck("p2p_file_answer", {
          to: sender,
          transfer_id,
          answer: { type: pc.localDescription.type, sdp: pc.localDescription.sdp },
        }).catch(() => null);

        if (!resp || resp.success === false) {
          fail("⚠️ Answer failed");
          return;
        }

        ui.setStatus("Answer sent — waiting for sender…");
      } catch (e) {
        const msg = `❌ Accept failed: ${String(e?.message || e || "error")}`;
        fail(msg);
      }
    });

    ui.onDecline(() => {
      ui.setStatus("Declined");
      socket.emit("p2p_file_decline", { to: sender, transfer_id, reason: "Declined" });
      setTimeout(() => ui.remove(), 700);
    });
  } catch (e) {
    console.error("p2p_file_offer handler failed:", e);
  }
});

async function finalizeIncomingP2pFile(sender, transfer_id) {
  const tr = P2P_TRANSFERS.get(transfer_id);
  if (!tr || tr.role !== "receiver") return;

  const meta = tr.meta || {};
  const parts = tr.recv?.parts || [];
  const blob = new Blob(parts, { type: meta.mime || "application/octet-stream" });

  // Optional integrity check (best-effort)
  try {
    if (meta.sha256) {
      const buf = await blob.arrayBuffer();
      const got = await sha256HexFromArrayBuffer(buf);
      if (got !== meta.sha256) {
        tr.ui.setStatus("⚠️ Hash mismatch");
      }
    }
  } catch {}

  // Show final file card in the PM window
  const win = UIState.windows.get("dm:" + sender);
  if (win) {
    appendDmPayload(win, `${sender}:`, {
      kind: "file",
      source: "p2p",
      transfer_id,
      name: meta.name || "file",
      size: Number(meta.size || blob.size) || blob.size,
      mime: meta.mime || blob.type || "application/octet-stream",
      sha256: meta.sha256 || null,
      blob,
    }, { peer: sender, direction: "in" });

    addPmHistory(sender, "in", `📎 ${meta.name || "file"} (${humanBytes(Number(meta.size || blob.size) || blob.size)})`);
  }

  // ACK back to sender
  try {
    tr.dc && tr.dc.send(JSON.stringify({ type: "ack", transfer_id }));
  } catch {}

  tr.ui.setProgress(1);
  tr.ui.setStatus("✅ Received — click Download");
  setTimeout(() => tr.ui.remove(), 900);

  p2pSafeClose(transfer_id);
}

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
