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

