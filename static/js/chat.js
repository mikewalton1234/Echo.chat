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
// Transport selection:
// - If the server enables WebSockets, prefer them to avoid long-polling request spam.
// - Otherwise stay on polling (dev-safe fallback).
const __wsEnabled = !!(window.ECHOCHAT_CFG && window.ECHOCHAT_CFG.ws_enabled);

const socket = io({
  transports: __wsEnabled ? ["websocket", "polling"] : ["polling"],
  upgrade: __wsEnabled,
  rememberUpgrade: __wsEnabled,
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

// Auth/session recovery state:
// - When access expires we try a bounded refresh-with-backoff.
// - If that still fails (or we get repeat 401 after refresh), we PAUSE polling
//   and show a banner prompting the user to Retry (manual recovery) or Logout.
let AUTH_EXPIRED = false;
let AUTH_FAIL_REASON = "";
let AUTH_RECOVERY_ATTEMPTS = 0;
let _authRecoveryPromise = null;

// Timers that should stop during auth-expired mode
let EC_TOKEN_KEEPALIVE_TIMER = null;

function enterAuthExpiredState(reason = "auth_required") {
  AUTH_EXPIRED = true;
  AUTH_FAIL_REASON = String(reason || "auth_required");
  AUTH_RECOVERY_ATTEMPTS = 0;

  // Stop any periodic network traffic
  try { if (EC_TOKEN_KEEPALIVE_TIMER) { clearInterval(EC_TOKEN_KEEPALIVE_TIMER); EC_TOKEN_KEEPALIVE_TIMER = null; } } catch {}
  try { if (typeof rbStopPolling === "function") rbStopPolling(); } catch {}

  // Drop socket to prevent reconnect/polling spam
  try { if (socket && socket.connected) socket.disconnect(); } catch {}

  // Show banner with Retry + Logout (no redirect)
  setConnBanner("auth_expired", "🔒 Session expired. Click Retry to re-authenticate.", { spinner: false, showRetry: true });
}

async function refreshAccessTokenWithBackoff(maxAttempts = 3) {
  // De-dupe concurrent recovery attempts
  if (_authRecoveryPromise) return _authRecoveryPromise;

  _authRecoveryPromise = (async () => {
    const delays = [250, 750, 2000]; // ms
    let lastErr = null;

    for (let i = 0; i < Math.max(1, Number(maxAttempts || 1)); i++) {
      AUTH_RECOVERY_ATTEMPTS = i + 1;
      try {
        await refreshAccessToken();
        return true;
      } catch (e) {
        lastErr = e;
        // If offline, don't keep hammering.
        if (navigator && navigator.onLine === false) break;
        const d = delays[Math.min(i, delays.length - 1)];
        await new Promise(r => setTimeout(r, d));
      }
    }
    const msg = (lastErr && (lastErr.message || lastErr.toString())) || "refresh failed";
    throw new Error(msg);
  })();

  try {
    return await _authRecoveryPromise;
  } finally {
    _authRecoveryPromise = null;
  }
}

async function attemptAuthRecoveryFlow(trigger = "auth_required") {
  if (AUTH_RECOVERY_IN_PROGRESS) return false;
  AUTH_RECOVERY_IN_PROGRESS = true;
  try {
    setConnBanner("auth_recovering", `🔐 Restoring session… (attempt ${AUTH_RECOVERY_ATTEMPTS + 1}/3)`, { spinner: true, showRetry: false });
    await refreshAccessTokenWithBackoff(3);

    // If we got here, token refresh succeeded → resume.
    AUTH_EXPIRED = false;
    AUTH_FAIL_REASON = "";
    hideConnBanner();

    // Reconnect socket (best-effort)
    try { if (socket && !socket.connected) socket.connect(); } catch {}

    // Restart room browser polling
    try { if (typeof rbStartPolling === "function") rbStartPolling(); } catch {}

    // Restart keepalive refresh timer
    try {
      if (!EC_TOKEN_KEEPALIVE_TIMER) {
        EC_TOKEN_KEEPALIVE_TIMER = setInterval(() => {
          if (AUTH_EXPIRED) return;
          refreshAccessToken().catch(() => {});
        }, 22 * 60 * 1000);
      }
    } catch {}

    return true;
  } catch (_e) {
    enterAuthExpiredState(trigger);
    return false;
  } finally {
    AUTH_RECOVERY_IN_PROGRESS = false;
  }
}

// ───────────────────────────────────────────────────────────────────────────────
// Connection status banner (do NOT redirect to /login on transient disconnects)
// ───────────────────────────────────────────────────────────────────────────────
let EC_HAS_EVER_CONNECTED = false;
let EC_CONN_BANNER = null;
let EC_CONN_STATE = "init";
let EC_CONN_ATTEMPT = 0;
let EC_CONN_LAST_REASON = "";
let EC_RECONNECT_IN_PROGRESS = false;
let EC_SERVER_DISCONNECT_RETRIES = 0;
let EC_LAST_RECONNECT_TOAST_AT = 0;

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
    // If we are in auth-expired mode, Retry means: attempt token refresh + resume.
    if (typeof AUTH_EXPIRED !== "undefined" && AUTH_EXPIRED) {
      attemptAuthRecoveryFlow("manual_retry").catch(() => {});
      return;
    }
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
    if (EC_RECONNECT_IN_PROGRESS) return;
    if (socket.connected) return;
    EC_RECONNECT_IN_PROGRESS = true;
    setConnBanner("connecting", "🔌 Reconnecting…", { spinner: true, showRetry: true });
    // Small delay prevents tight loops when the server keeps dropping us.
    setTimeout(() => {
      try {
        if (!socket.connected) socket.connect();
      } catch {}
    }, 400);
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
  friendSet: new Set(),    // fast check for (is friend)
  blockedSet: new Set(),   // fast check for (is blocked by me)
  pendingRequests: [],     // pending inbound friend requests
  myGroups: [],            // cached group list for the right dock
  groupInvites: [],        // cached group invites for the right dock
  roomPolicy: new Map(),   // room -> {locked, readonly, slowmode_seconds, can_send, ...}
  groupMembers: new Map(), // group_id -> [usernames] (last known)
  roomEmbedRoom: null,     // room currently shown in the left embedded pane
  presence: new Map(),     // username -> {online, presence, custom_status, last_seen}
  missedPmSummary: [],     // [{sender, count}] from server (offline-only)
  consumingOfflinePeers: new Set(), // peers currently being consumed (avoid duplicate fetch loops)
  pendingOfflineDm: new Map(),      // peer -> [{id, cipher, ts}]
  pendingOfflineDmSeen: new Set(),  // offline id -> already queued/processed in this tab
  unlockSkipped: false,
  prefs: {
    darkMode: Settings.get("darkMode", true),
    accentTheme: Settings.get("accentTheme", "default"),
    popupNotif: Settings.get("popupNotif", false),
    soundNotif: Settings.get("soundNotif", true),
    rememberUnlock: true,
    roomFontSize: Settings.get("roomFontSize", 12),
    missedToast: Settings.get("missedToast", true),
    savePmLocal: Settings.get("savePmLocal", false),
    friendStatusInline: Settings.get("friendStatusInline", true),
    friendStatusTooltip: Settings.get("friendStatusTooltip", true)
  },
  inviteSeen: new Set()
};

const DOCK_SECTION_DEFAULT_ORDER = {
  friends: ["friendsSectionList", "friendsSectionMissed", "friendsSectionPending", "friendsSectionBlocked"],
  groups: ["groupsSectionList", "groupsSectionInvites", "groupsSectionCreate", "groupsSectionJoin"]
};


const HELP_TOUR_STORAGE_KEY = 'helpTourSeen_v2';
const HELP_TOUR_AUTO_DELAY_MS = 1200;

const EC_HELP = {
  layer: null,
  card: null,
  title: null,
  body: null,
  step: null,
  prevBtn: null,
  nextBtn: null,
  doneBtn: null,
  closeBtn: null,
  badge: null,
  svg: null,
  arrow: null,
  arrowHead: null,
  currentTarget: null,
  visible: false,
  mode: '',
  hoverTimer: null,
  hoverTarget: null,
  tourIndex: 0,
  steps: [],
  currentStep: null,
  autoStarted: false
};

function isElementActuallyVisible(el) {
  if (!el || !el.isConnected) return false;
  if (el.classList?.contains('hidden')) return false;
  let cur = el;
  while (cur && cur !== document.body) {
    if (cur.classList?.contains('hidden')) return false;
    const cs = window.getComputedStyle(cur);
    if (!cs || cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity || 1) === 0) return false;
    cur = cur.parentElement;
  }
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

function findVisibleHelpTarget(selectorOrEl) {
  if (!selectorOrEl) return null;
  if (typeof selectorOrEl !== 'string') return isElementActuallyVisible(selectorOrEl) ? selectorOrEl : null;
  const nodes = [...document.querySelectorAll(selectorOrEl)];
  return nodes.find((el) => isElementActuallyVisible(el)) || null;
}

function ensureHelpLayer() {
  if (EC_HELP.layer) return EC_HELP.layer;
  const layer = document.createElement('div');
  layer.id = 'ecHelpLayer';
  layer.className = 'ecHelpLayer hidden';
  layer.innerHTML = `
    <div class="ecHelpBackdrop"></div>
    <svg class="ecHelpSvg" aria-hidden="true">
      <path class="ecHelpArrow" />
      <path class="ecHelpArrowHead" />
    </svg>
    <div class="ecHelpCard" role="dialog" aria-live="polite" aria-atomic="true">
      <button type="button" class="ecHelpClose" aria-label="Close help">×</button>
      <div class="ecHelpBadge">EchoChat guide</div>
      <div class="ecHelpTitle"></div>
      <div class="ecHelpBody"></div>
      <div class="ecHelpFooter">
        <div class="ecHelpStep"></div>
        <div class="ecHelpActions">
          <button type="button" class="miniBtn secondary ecHelpPrev">Back</button>
          <button type="button" class="miniBtn ecHelpNext">Next</button>
          <button type="button" class="miniBtn ecHelpDone">Done</button>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(layer);

  EC_HELP.layer = layer;
  EC_HELP.card = layer.querySelector('.ecHelpCard');
  EC_HELP.title = layer.querySelector('.ecHelpTitle');
  EC_HELP.body = layer.querySelector('.ecHelpBody');
  EC_HELP.step = layer.querySelector('.ecHelpStep');
  EC_HELP.prevBtn = layer.querySelector('.ecHelpPrev');
  EC_HELP.nextBtn = layer.querySelector('.ecHelpNext');
  EC_HELP.doneBtn = layer.querySelector('.ecHelpDone');
  EC_HELP.closeBtn = layer.querySelector('.ecHelpClose');
  EC_HELP.badge = layer.querySelector('.ecHelpBadge');
  EC_HELP.svg = layer.querySelector('.ecHelpSvg');
  EC_HELP.arrow = layer.querySelector('.ecHelpArrow');
  EC_HELP.arrowHead = layer.querySelector('.ecHelpArrowHead');

  EC_HELP.prevBtn?.addEventListener('click', () => stepHelpTour(-1));
  EC_HELP.nextBtn?.addEventListener('click', () => stepHelpTour(1));
  EC_HELP.doneBtn?.addEventListener('click', () => closeHelpOverlay({ markSeen: true }));
  EC_HELP.closeBtn?.addEventListener('click', () => closeHelpOverlay({ markSeen: true }));
  layer.querySelector('.ecHelpBackdrop')?.addEventListener('click', () => {
    if (EC_HELP.mode === 'tour') stepHelpTour(1);
    else closeHelpOverlay({ markSeen: false });
  });

  return layer;
}

function setHelpMetadata(el, meta = {}) {
  if (!el || !meta) return;
  if (meta.title) el.dataset.helpTitle = String(meta.title);
  if (meta.text) el.dataset.helpText = String(meta.text);
  if (meta.placement) el.dataset.helpPlacement = String(meta.placement);
  wireInlineHelpTarget(el);
}

function applyHelpMetadata(selector, meta = {}) {
  document.querySelectorAll(selector).forEach((el) => setHelpMetadata(el, meta));
}

function wireInlineHelpTarget(el) {
  if (!el || el.dataset.helpWired === '1') return;
  el.dataset.helpWired = '1';

  const openHint = () => {
    if (EC_HELP.mode === 'tour') return;
    showHelpForElement(el, {
      mode: 'hint',
      title: el.dataset.helpTitle || 'EchoChat',
      text: el.dataset.helpText || '',
      placement: el.dataset.helpPlacement || 'right'
    });
  };

  const scheduleOpen = () => {
    if (EC_HELP.mode === 'tour') return;
    clearTimeout(EC_HELP.hoverTimer);
    EC_HELP.hoverTarget = el;
    EC_HELP.hoverTimer = setTimeout(() => {
      if (EC_HELP.hoverTarget === el) openHint();
    }, 260);
  };

  const scheduleHide = () => {
    if (EC_HELP.mode === 'tour') return;
    clearTimeout(EC_HELP.hoverTimer);
    EC_HELP.hoverTarget = null;
    setTimeout(() => {
      if (EC_HELP.mode === 'tour') return;
      if (EC_HELP.currentTarget === el) closeHelpOverlay({ markSeen: false });
    }, 90);
  };

  el.addEventListener('mouseenter', scheduleOpen);
  el.addEventListener('mouseleave', scheduleHide);
  el.addEventListener('focus', openHint);
  el.addEventListener('blur', scheduleHide);
}

function initHelpMetadata() {
  const defs = [
    ['#sitePlaceholder .rbTitle', { title: 'Room browser', text: 'This is the main lobby picker. Choose a category on the left, see official rooms in the middle, and browse public or invited custom rooms on the right.', placement: 'right' }],
    ['#rbCatSearch', { title: 'Category search', text: 'Filter the category tree without changing your active room. This is handy when the room list gets long.', placement: 'right' }],
    ['#rbRoomSearch', { title: 'Official room search', text: 'Search the built-in rooms in the selected category. Use the Active / A–Z menu and Hide empty toggle to narrow the list faster.', placement: 'right' }],
    ['#rbRoomSort', { title: 'Official room sort', text: 'Switch between most active rooms first or alphabetical order.', placement: 'bottom' }],
    ['#rbHideEmpty', { title: 'Hide empty rooms', text: 'Turn this on if you only want rooms that currently have people inside them.', placement: 'bottom' }],
    ['#rbCustomSearch', { title: 'Custom room search', text: 'Search user-created rooms. Private rooms only show here if you created them or received an invite.', placement: 'left' }],
    ['#rbCustomFilter', { title: 'Custom room filter', text: 'Filter all custom rooms, public rooms, private rooms, or just the ones you own.', placement: 'bottom' }],
    ['#rbCustomSort', { title: 'Custom room sort', text: 'Sort custom rooms by activity or alphabetically.', placement: 'bottom' }],
    ['#btnOpenCreateRoom', { title: 'Create room', text: 'Open the custom-room creator. Pick a category, visibility, and optional age / NSFW flags before creating it.', placement: 'left' }],
    ['#roomEmbedTitle', { title: 'Active room', text: 'When you join a room, the live chat opens here on the left side.', placement: 'right' }],
    ['#roomEmbedInput', { title: 'Room message box', text: 'Type a room message here. Use the emoji, torrent, and GIF buttons beside it for extras.', placement: 'top' }],
    ['#roomEmbedEmojiBtn', { title: 'Emoji picker', text: 'Open the emoji picker for the current room message.', placement: 'top' }],
    ['#roomEmbedGifBtn', { title: 'GIF picker', text: 'Search and send a GIF into the current room.', placement: 'top' }],
    ['#roomEmbedTorrentBtn', { title: 'Torrent share', text: 'Attach a .torrent file or magnet-style share into the current room.', placement: 'top' }],
    ['#btnRoomEmbedVoice', { title: 'Room voice', text: 'Join or manage voice chat for the current room from here.', placement: 'left' }],
    ['#meStatus', { title: 'Presence status', text: 'Set yourself Online, Away, Busy, Invisible, or add a custom status message.', placement: 'left' }],
    ['#friendUser', { title: 'Add a friend', text: 'If your build shows an add-friend box, type a username here and send a request.', placement: 'left' }],
    ['#dockSearch', { title: 'Dock search', text: 'Search inside the active Friends or Groups panel. It filters names, statuses, invites, and request lists.', placement: 'left' }],
    ['#dockQuickStats', { title: 'Quick jumps', text: 'These tiles jump you to Missed messages, Friends, Requests, or Groups and show live counts.', placement: 'left' }],
    ['#tabFriends', { title: 'Friends tab', text: 'Shows your buddy list, unread private messages, pending requests, and blocked users.', placement: 'left' }],
    ['#tabGroups', { title: 'Groups tab', text: 'Shows group tools, invites, and the groups you already belong to.', placement: 'left' }],
    ['#friendsSectionList', { title: 'Friends list', text: 'Single-click or double-click a friend to open a private chat. Use the icons on each row for quick actions.', placement: 'left' }],
    ['#friendsSectionMissed', { title: 'Missed messages', text: 'Unread private-message threads land here after login or refresh until you open them.', placement: 'left' }],
    ['#friendsSectionPending', { title: 'Pending requests', text: 'Incoming friend requests show up here so you can accept, ignore, or review them.', placement: 'left' }],
    ['#friendsSectionBlocked', { title: 'Blocked users', text: 'Anyone you block moves here so you can review or unblock them later.', placement: 'left' }],
    ['#groupsSectionCreate', { title: 'Create group', text: 'Make a private group-style chat space for invited members.', placement: 'left' }],
    ['#groupCreateName', { title: 'New group name', text: 'Type the name of the group you want to create, then click Create.', placement: 'left' }],
    ['#groupsSectionJoin', { title: 'Join by invite', text: 'Paste a group ID here when someone invites you to an existing group.', placement: 'left' }],
    ['#groupJoinId', { title: 'Group ID field', text: 'Paste an invite-based group ID here to join that group.', placement: 'left' }],
    ['#groupsSectionInvites', { title: 'Group invites', text: 'Pending group invitations show up here. Refresh if you expect one to arrive.', placement: 'left' }],
    ['#groupsSectionList', { title: 'My groups', text: 'This list contains the groups you already belong to.', placement: 'left' }],
    ['#btnLogout', { title: 'Log out', text: 'Safely sign out of EchoChat from here.', placement: 'bottom' }],
    ['#btnSettings', { title: 'Settings', text: 'Open preferences for room text size, notifications, PM storage, themes, and DM unlocking.', placement: 'bottom' }],
    ['#btnHelpTour', { title: 'Help / tour', text: 'Click here any time to replay the guided EchoChat tour.', placement: 'bottom' }],
    ['#createRoomModal .modalCard', { title: 'Create custom room', text: 'Name the room, choose a category, decide whether it is public or private, then create it.', placement: 'left' }],
    ['#crName', { title: 'Room name', text: 'Give the room a clear name so people know what it is for.', placement: 'bottom' }],
    ['#settingsModal .modalCard', { title: 'Settings panel', text: 'This is where you tune notifications, themes, DM behavior, and room text size.', placement: 'left' }],
    ['#unlockModal .modalCard', { title: 'Unlock private messages', text: 'Enter your password here to unlock encrypted DMs for the current browser tab.', placement: 'left' }],
    ['#unlockPassword', { title: 'DM unlock password', text: 'Use your account password here to decrypt your private-message key for this tab.', placement: 'bottom' }]
  ];
  defs.forEach(([selector, meta]) => applyHelpMetadata(selector, meta));
}

function buildHelpTourSteps() {
  return [
    {
      selector: '#sitePlaceholder .rbTitle',
      title: 'Welcome to EchoChat',
      text: 'This first screen is your room browser. The left panel chooses categories, the middle shows built-in rooms, and the right shows custom rooms made by users.',
      placement: 'right',
      before: () => { try { rbCloseModal('createRoomModal'); } catch {} try { closeSettings(); } catch {} try { setActiveTab('friends'); } catch {} }
    },
    {
      selector: '#rbCatSearch',
      title: 'Find categories fast',
      text: 'Use this search box to narrow the category tree without touching your joined room.',
      placement: 'right'
    },
    {
      selector: '#rbOfficialRooms',
      title: 'Join official rooms',
      text: 'Each built-in room appears here with a Join button and live user counts. Joining loads the room into the large left chat pane.',
      placement: 'right'
    },
    {
      selector: '#rbCustomRooms',
      title: 'Browse custom rooms',
      text: 'Custom rooms can be public or private. Private rooms only appear if you created them or someone invited you.',
      placement: 'left'
    },
    {
      selector: '#btnOpenCreateRoom',
      title: 'Create a custom room',
      text: 'Use this whenever you want your own public or invite-only room.',
      placement: 'left'
    },
    {
      selector: '#createRoomModal .modalCard',
      title: 'Room setup form',
      text: 'Pick the room name, category, visibility, and optional 18+ or NSFW flags. EchoChat will auto-clean inactive custom rooms later.',
      placement: 'left',
      before: () => { try { rbOpenCreateRoomModal(); } catch {} },
      after: () => { try { rbCloseModal('createRoomModal'); } catch {} }
    },
    {
      selector: '#meStatus',
      title: 'Set your status',
      text: 'Your dock starts here. Change your presence to Online, Away, Busy, Invisible, or set a custom status message.',
      placement: 'left'
    },
    {
      selector: '#dockSearch',
      title: 'Search the active dock panel',
      text: 'This search filters whatever tab you are currently viewing, including friends, requests, invites, and groups.',
      placement: 'left'
    },
    {
      selector: '#dockQuickStats',
      title: 'Jump by count',
      text: 'These tiles show live totals and jump straight to the related section when clicked.',
      placement: 'left'
    },
    {
      selector: '#friendsSectionList',
      title: 'Your buddy list',
      text: 'This is the main friends section. Open a DM by clicking a friend row. You can also use the row buttons for quick actions.',
      placement: 'left',
      before: () => { try { setActiveTab('friends'); } catch {} }
    },
    {
      selector: '#friendsSectionMissed',
      title: 'Unread private chats',
      text: 'Missed messages stay here until you reopen the conversation.',
      placement: 'left',
      before: () => { try { setActiveTab('friends'); } catch {} }
    },
    {
      selector: '#groupsSectionCreate',
      title: 'Groups tab tools',
      text: 'Switch to the Groups tab to create invite-based group chats separate from the public room browser.',
      placement: 'left',
      before: () => { try { setActiveTab('groups'); } catch {} }
    },
    {
      selector: '#groupsSectionJoin',
      title: 'Join a group by ID',
      text: 'If someone sends you a group ID, paste it here to join the group.',
      placement: 'left',
      before: () => { try { setActiveTab('groups'); } catch {} }
    },
    {
      selector: '#btnSettings',
      title: 'Personal settings',
      text: 'Open settings to change room text size, theme colors, notifications, and DM behavior.',
      placement: 'bottom',
      before: () => { try { setActiveTab('friends'); } catch {} }
    },
    {
      selector: '#settingsModal .modalCard',
      title: 'Tune EchoChat your way',
      text: 'This panel controls appearance, notification behavior, local PM storage, and DM unlocking.',
      placement: 'left',
      before: () => { try { openSettings(); } catch {} },
      after: () => { try { closeSettings(); } catch {} }
    },
    {
      selector: '#btnHelpTour',
      title: 'Replay the guide anytime',
      text: 'If you forget how something works, click this Help button and EchoChat will walk you back through the tour.',
      placement: 'bottom',
      before: () => { try { closeSettings(); } catch {} try { setActiveTab('friends'); } catch {} }
    }
  ];
}

function clearHelpTargetHighlight() {
  try {
    document.querySelectorAll('.ecHelpTarget').forEach((el) => el.classList.remove('ecHelpTarget'));
  } catch {}
}

function closeHelpOverlay(opts = {}) {
  const markSeen = !!opts.markSeen;
  const layer = ensureHelpLayer();
  clearTimeout(EC_HELP.hoverTimer);
  EC_HELP.hoverTarget = null;
  clearHelpTargetHighlight();
  if (EC_HELP.currentStep?.after) {
    try { EC_HELP.currentStep.after(); } catch {}
  }
  EC_HELP.currentStep = null;
  EC_HELP.currentTarget = null;
  EC_HELP.visible = false;
  EC_HELP.mode = '';
  layer.classList.add('hidden');
  layer.classList.remove('isTour', 'isHint');
  if (markSeen) Settings.set(HELP_TOUR_STORAGE_KEY, true);
}

function getHelpCardPreferredPlacement(targetRect, cardWidth, cardHeight, preferred = 'right') {
  const vw = window.innerWidth || document.documentElement.clientWidth || 1280;
  const vh = window.innerHeight || document.documentElement.clientHeight || 720;
  const gap = 22;
  const margin = 16;
  const plans = [];
  const pushPlan = (placement, left, top) => plans.push({ placement, left, top });

  pushPlan('right', targetRect.right + gap, targetRect.top + Math.max(-6, (targetRect.height - cardHeight) / 2));
  pushPlan('left', targetRect.left - cardWidth - gap, targetRect.top + Math.max(-6, (targetRect.height - cardHeight) / 2));
  pushPlan('bottom', targetRect.left + (targetRect.width - cardWidth) / 2, targetRect.bottom + gap);
  pushPlan('top', targetRect.left + (targetRect.width - cardWidth) / 2, targetRect.top - cardHeight - gap);

  const ordered = [preferred, 'right', 'left', 'bottom', 'top'].filter((v, i, arr) => arr.indexOf(v) === i);
  const candidates = ordered.map((placement) => plans.find((p) => p.placement === placement)).filter(Boolean);

  for (const plan of candidates) {
    const left = Math.min(Math.max(plan.left, margin), vw - cardWidth - margin);
    const top = Math.min(Math.max(plan.top, margin), vh - cardHeight - margin);
    const fits = left >= margin && top >= margin && left + cardWidth <= vw - margin && top + cardHeight <= vh - margin;
    if (fits) return { placement: plan.placement, left, top };
  }

  const fallback = candidates[0] || { placement: 'right', left: margin, top: margin };
  return {
    placement: fallback.placement,
    left: Math.min(Math.max(fallback.left, margin), vw - cardWidth - margin),
    top: Math.min(Math.max(fallback.top, margin), vh - cardHeight - margin)
  };
}

function drawHelpArrow(cardRect, targetRect, placement) {
  const svg = EC_HELP.svg;
  const path = EC_HELP.arrow;
  const head = EC_HELP.arrowHead;
  if (!svg || !path || !head) return;

  const vw = window.innerWidth || document.documentElement.clientWidth || 1280;
  const vh = window.innerHeight || document.documentElement.clientHeight || 720;
  svg.setAttribute('viewBox', `0 0 ${vw} ${vh}`);
  svg.setAttribute('width', String(vw));
  svg.setAttribute('height', String(vh));

  const targetX = targetRect.left + targetRect.width / 2;
  const targetY = targetRect.top + targetRect.height / 2;
  let startX = cardRect.left + cardRect.width / 2;
  let startY = cardRect.top + cardRect.height / 2;

  if (placement === 'right') {
    startX = cardRect.left;
    startY = cardRect.top + Math.min(cardRect.height - 26, Math.max(28, cardRect.height * 0.45));
  } else if (placement === 'left') {
    startX = cardRect.right;
    startY = cardRect.top + Math.min(cardRect.height - 26, Math.max(28, cardRect.height * 0.45));
  } else if (placement === 'top') {
    startX = cardRect.left + Math.min(cardRect.width - 28, Math.max(28, cardRect.width * 0.50));
    startY = cardRect.bottom;
  } else {
    startX = cardRect.left + Math.min(cardRect.width - 28, Math.max(28, cardRect.width * 0.50));
    startY = cardRect.top;
  }

  const dx = targetX - startX;
  const dy = targetY - startY;
  const curveLift = placement === 'left' ? -70 : placement === 'right' ? 70 : (dy > 0 ? 70 : -70);
  const controlX = startX + dx * 0.48 + (placement === 'top' || placement === 'bottom' ? curveLift : 0);
  const controlY = startY + dy * 0.48 - (placement === 'left' || placement === 'right' ? 80 : 0);
  path.setAttribute('d', `M ${startX} ${startY} Q ${controlX} ${controlY} ${targetX} ${targetY}`);

  const angle = Math.atan2(targetY - controlY, targetX - controlX);
  const headLen = 12;
  const a1 = angle - Math.PI / 7;
  const a2 = angle + Math.PI / 7;
  const x1 = targetX - Math.cos(a1) * headLen;
  const y1 = targetY - Math.sin(a1) * headLen;
  const x2 = targetX - Math.cos(a2) * headLen;
  const y2 = targetY - Math.sin(a2) * headLen;
  head.setAttribute('d', `M ${x1} ${y1} L ${targetX} ${targetY} L ${x2} ${y2}`);
}

function positionHelpCard(target, placement = 'right') {
  const layer = ensureHelpLayer();
  const card = EC_HELP.card;
  if (!target || !card || !layer) return;
  card.style.left = '-9999px';
  card.style.top = '-9999px';
  card.style.visibility = 'hidden';
  layer.classList.remove('hidden');

  const targetRect = target.getBoundingClientRect();
  const cardRectSeed = card.getBoundingClientRect();
  const width = Math.max(280, Math.min(360, cardRectSeed.width || 320));
  card.style.width = `${width}px`;
  const measured = card.getBoundingClientRect();
  const pos = getHelpCardPreferredPlacement(targetRect, measured.width || width, measured.height || 180, placement);
  card.style.left = `${pos.left}px`;
  card.style.top = `${pos.top}px`;
  card.style.visibility = 'visible';
  const cardRect = card.getBoundingClientRect();
  drawHelpArrow(cardRect, targetRect, pos.placement);
}

function showHelpForElement(target, opts = {}) {
  const layer = ensureHelpLayer();
  if (!target) return;
  clearHelpTargetHighlight();
  EC_HELP.currentTarget = target;
  target.classList.add('ecHelpTarget');
  EC_HELP.mode = opts.mode || 'hint';
  EC_HELP.visible = true;
  layer.classList.remove('hidden');
  layer.classList.toggle('isTour', EC_HELP.mode === 'tour');
  layer.classList.toggle('isHint', EC_HELP.mode !== 'tour');

  if (EC_HELP.badge) EC_HELP.badge.textContent = EC_HELP.mode === 'tour' ? 'EchoChat tour' : 'Tip';
  if (EC_HELP.title) EC_HELP.title.textContent = String(opts.title || target.dataset.helpTitle || 'EchoChat');
  if (EC_HELP.body) EC_HELP.body.textContent = String(opts.text || target.dataset.helpText || '');

  const total = Number(opts.total || 0);
  const stepNum = Number(opts.step || 0);
  if (EC_HELP.step) EC_HELP.step.textContent = (EC_HELP.mode === 'tour' && total > 0) ? `Step ${stepNum} of ${total}` : 'Hover or focus controls for quick tips.';
  if (EC_HELP.prevBtn) EC_HELP.prevBtn.style.display = EC_HELP.mode === 'tour' ? '' : 'none';
  if (EC_HELP.nextBtn) EC_HELP.nextBtn.style.display = EC_HELP.mode === 'tour' ? '' : 'none';
  if (EC_HELP.doneBtn) EC_HELP.doneBtn.style.display = EC_HELP.mode === 'tour' ? '' : 'none';
  if (EC_HELP.closeBtn) EC_HELP.closeBtn.style.display = '';
  if (EC_HELP.prevBtn) EC_HELP.prevBtn.disabled = !(EC_HELP.mode === 'tour' && stepNum > 1);
  if (EC_HELP.nextBtn) EC_HELP.nextBtn.style.display = (EC_HELP.mode === 'tour' && stepNum < total) ? '' : 'none';
  if (EC_HELP.doneBtn) EC_HELP.doneBtn.style.display = (EC_HELP.mode === 'tour' && stepNum >= total) ? '' : (EC_HELP.mode === 'tour' ? 'none' : 'none');

  positionHelpCard(target, opts.placement || target.dataset.helpPlacement || 'right');
}

function showHelpTourStep(index, direction = 1) {
  const steps = EC_HELP.steps || [];
  if (!steps.length) {
    closeHelpOverlay({ markSeen: true });
    return;
  }
  let idx = Number(index || 0);
  if (idx < 0) idx = 0;
  if (idx >= steps.length) {
    closeHelpOverlay({ markSeen: true });
    return;
  }

  const step = steps[idx];
  EC_HELP.tourIndex = idx;
  EC_HELP.currentStep = step;
  try { step.before?.(); } catch {}

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      const target = findVisibleHelpTarget(step.selector);
      if (!target) {
        stepHelpTour(direction || 1, true);
        return;
      }
      try {
        target.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
      } catch {}
      showHelpForElement(target, {
        mode: 'tour',
        title: step.title,
        text: step.text,
        placement: step.placement,
        step: idx + 1,
        total: steps.length
      });
    });
  });
}

function stepHelpTour(delta = 1, fromSkip = false) {
  const steps = EC_HELP.steps || [];
  if (!steps.length) {
    closeHelpOverlay({ markSeen: true });
    return;
  }
  if (EC_HELP.currentStep?.after) {
    try { EC_HELP.currentStep.after(); } catch {}
  }
  const next = Number(EC_HELP.tourIndex || 0) + Number(delta || 1);
  if (next < 0) {
    showHelpTourStep(0, delta);
    return;
  }
  if (next >= steps.length) {
    closeHelpOverlay({ markSeen: true });
    return;
  }
  if (fromSkip && next === EC_HELP.tourIndex) {
    closeHelpOverlay({ markSeen: true });
    return;
  }
  showHelpTourStep(next, delta);
}

function startHelpTour(opts = {}) {
  ensureHelpLayer();
  EC_HELP.steps = buildHelpTourSteps();
  if (!EC_HELP.steps.length) return;
  EC_HELP.mode = 'tour';
  EC_HELP.visible = true;
  EC_HELP.autoStarted = !!opts.auto;
  Settings.set(HELP_TOUR_STORAGE_KEY, true);
  showHelpTourStep(0);
}

function maybeAutoStartHelpTour() {
  if (Settings.get(HELP_TOUR_STORAGE_KEY, false)) return;
  setTimeout(() => {
    if (EC_HELP.visible || EC_HELP.mode === 'tour') return;
    startHelpTour({ auto: true });
  }, HELP_TOUR_AUTO_DELAY_MS);
}

function refreshActiveHelpPosition() {
  if (!EC_HELP.visible || !EC_HELP.currentTarget) return;
  if (!isElementActuallyVisible(EC_HELP.currentTarget)) {
    if (EC_HELP.mode === 'tour') stepHelpTour(1, true);
    else closeHelpOverlay({ markSeen: false });
    return;
  }
  const placement = (EC_HELP.mode === 'tour' ? EC_HELP.currentStep?.placement : EC_HELP.currentTarget.dataset.helpPlacement) || 'right';
  positionHelpCard(EC_HELP.currentTarget, placement);
}

function initHelpSystem() {
  ensureHelpLayer();
  initHelpMetadata();
  window.addEventListener('resize', refreshActiveHelpPosition);
  window.addEventListener('scroll', refreshActiveHelpPosition, true);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && EC_HELP.visible) {
      e.preventDefault();
      closeHelpOverlay({ markSeen: EC_HELP.mode === 'tour' });
      return;
    }
    if (EC_HELP.mode !== 'tour') return;
    if (e.key === 'ArrowRight' || e.key === 'Enter') {
      e.preventDefault();
      stepHelpTour(1);
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      stepHelpTour(-1);
    }
  });

  const observer = new MutationObserver(() => initHelpMetadata());
  observer.observe(document.body || document.documentElement, { childList: true, subtree: true });
}

// Ensure we don't leave "ghost" room occupants behind when the user navigates away
// (Back button, tab close, BFCache pagehide). This helps keep room counts accurate.
window.addEventListener("pagehide", () => {
  try {
    if (socket && socket.connected) {
      if (UIState.currentRoom) {
        // Best-effort; server disconnect handler is the real cleanup.
        socket.emit("leave", { room: UIState.currentRoom });
      }
      socket.disconnect();
    }
  } catch (e) {}
});

// Track which invite notifications we've already shown this tab/session.
// This prevents repeated toasts on reconnect/reload while still allowing
// invites to be re-surfaced after a full sign-out.
const INV_SEEN_SS_KEY = "echochat_invite_seen_v1";
try {
  const raw = sessionStorage.getItem(INV_SEEN_SS_KEY);
  const arr = raw ? JSON.parse(raw) : [];
  if (Array.isArray(arr)) UIState.inviteSeen = new Set(arr.map(String));
} catch (e) {}

function rememberInviteSeen(key) {
  try {
    UIState.inviteSeen.add(String(key));
    sessionStorage.setItem(INV_SEEN_SS_KEY, JSON.stringify([...UIState.inviteSeen].slice(-200)));
  } catch (e) {}
}

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

  appendLine(win, "System:", `Loaded ${hist.length} local history message(s).`, { ts: Date.now() });
  for (const h of hist) {
    const tag = (h.dir === "out") ? "You:" : `${peer}:`;
    appendLine(win, tag, h.text, { ts: h.ts });
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
// We use a real emoji picker library (no hardcoded emoji list) via:
//   https://github.com/nolanlawson/emoji-picker-element
//   (loaded in templates/chat.html as a <script type="module">)
//
// Design goals:
// - Zero server changes (emoji are just Unicode text)
// - Works everywhere we have a message <input>
// - One shared popover instance
// ───────────────────────────────────────────────────────────────────────────────

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
  picker: null,
  activeInput: null,
  activeAnchor: null,
  visible: false
};

function ensureEmojiPopover() {
  if (EmojiUI.pop) return EmojiUI.pop;

  const pop = document.createElement("div");
  pop.id = "ecEmojiPopover";
  pop.className = "ec-emojiPopover hidden";
  pop.setAttribute("role", "dialog");
  pop.setAttribute("aria-label", "Emoticons");

  // The custom element is defined by emoji-picker-element (loaded as a module script).
  const picker = document.createElement("emoji-picker");
  picker.id = "ecEmojiPicker";

  // Pin data source (lots of emoji) to jsDelivr (default in the library is also jsDelivr).
  // If you ever want to self-host, replace this URL with a local /static/... path.
  picker.setAttribute(
    "data-source",
    "https://cdn.jsdelivr.net/npm/emoji-picker-element-data@1.8.0/en/emojibase/data.json"
  );

  pop.appendChild(picker);
  document.body.appendChild(pop);

  const position = () => {
    if (!EmojiUI.activeAnchor) return;
    const r = EmojiUI.activeAnchor.getBoundingClientRect();

    // Popover size is CSS-controlled; measure real size.
    const w = pop.offsetWidth || 360;
    const h = pop.offsetHeight || 420;

    let left = Math.max(8, Math.min(window.innerWidth - w - 8, r.right - w));
    let top = r.top - h - 8;
    if (top < 8) top = Math.min(window.innerHeight - h - 8, r.bottom + 8);

    pop.style.left = `${left}px`;
    pop.style.top = `${top}px`;
  };

  // Insert emoji into the active input
  picker.addEventListener("emoji-click", (event) => {
    const d = event?.detail || {};
    const unicode = d.unicode || d.emoji?.unicode || d.emoji?.native || d.emoji?.emoji || "";
    if (unicode && EmojiUI.activeInput) {
      insertAtCursor(EmojiUI.activeInput, unicode);
    }
    closeEmojiPicker();
  });

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

  // Expose helpers
  EmojiUI.pop = pop;
  EmojiUI.picker = picker;
  pop._ecPosition = position;
  return pop;
}

function openEmojiPicker(anchorEl, inputEl) {
  const pop = ensureEmojiPopover();

  // Toggle if clicking the same button while open
  if (EmojiUI.visible && EmojiUI.activeAnchor === anchorEl) {
    closeEmojiPicker();
    return;
  }

  EmojiUI.activeInput = inputEl || null;
  EmojiUI.activeAnchor = anchorEl || null;

  pop.classList.remove("hidden");
  EmojiUI.visible = true;
  pop._ecPosition && pop._ecPosition();
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
const GIF_RECENTS_KEY = 'ec_gif_recents_v1';
const GIF_RECENTS_LIMIT = 24;

const GifUI = {
  modal: null,
  card: null,
  closeBtn: null,
  search: null,
  searchBtn: null,
  recentBtn: null,
  trendingBtn: null,
  randomBtn: null,
  status: null,
  grid: null,
  onPick: null,
  visible: false,
  mode: 'recents',
  lastResults: [],
};

function gifReadRecents() {
  try {
    const raw = localStorage.getItem(GIF_RECENTS_KEY) || '[]';
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr
      .map((g) => ({
        id: String(g?.id || '').trim(),
        title: String(g?.title || '').trim(),
        url: String(g?.url || '').trim(),
        preview: String(g?.preview || g?.url || '').trim(),
      }))
      .filter((g) => g.url)
      .slice(0, GIF_RECENTS_LIMIT);
  } catch {
    return [];
  }
}

function gifWriteRecents(items) {
  try {
    localStorage.setItem(GIF_RECENTS_KEY, JSON.stringify((items || []).slice(0, GIF_RECENTS_LIMIT)));
  } catch {}
}

function gifPushRecent(item) {
  if (!item?.url) return;
  const next = [
    {
      id: String(item.id || '').trim(),
      title: String(item.title || '').trim(),
      url: String(item.url || '').trim(),
      preview: String(item.preview || item.url || '').trim(),
    },
    ...gifReadRecents().filter((g) => String(g?.url || '').trim() !== String(item.url || '').trim()),
  ].slice(0, GIF_RECENTS_LIMIT);
  gifWriteRecents(next);
}

function gifSetMode(mode) {
  GifUI.mode = mode || 'recents';
  const active = String(GifUI.mode);
  GifUI.recentBtn?.classList.toggle('is-active', active === 'recents');
  GifUI.trendingBtn?.classList.toggle('is-active', active === 'trending');
  GifUI.randomBtn?.classList.toggle('is-active', active === 'random');
}

function gifItemMeta(g) {
  const url = String(g?.url || '').trim();
  const preview = String(g?.preview || url).trim();
  const title = String(g?.title || 'GIF').trim();
  const id = String(g?.id || '').trim();
  return { id, title, url, preview };
}

function gifRenderItems(items, statusText = '') {
  if (!GifUI.status || !GifUI.grid) return;
  const arr = Array.isArray(items) ? items.map(gifItemMeta).filter((g) => g.url) : [];
  GifUI.lastResults = arr;
  GifUI.grid.innerHTML = '';

  if (!arr.length) {
    GifUI.status.textContent = statusText || 'No GIFs to show yet.';
    return;
  }

  GifUI.status.textContent = statusText || `${arr.length} result(s)`;

  arr.forEach((g) => {
    const url = g.url;
    const pv = g.preview || url;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ym-gifItem';
    btn.title = g.title.slice(0, 120) || 'GIF';

    const img = document.createElement('img');
    img.className = 'ym-gifItemImg';
    img.loading = 'lazy';
    img.decoding = 'async';
    img.referrerPolicy = 'no-referrer';
    img.src = pv || url;
    img.alt = g.title || 'GIF';
    img.onerror = () => {
      const fb = _gifFallbackUrl(url) || _gifFallbackUrl(pv);
      if (fb && img.src !== fb) img.src = _gifCacheBust(fb);
    };

    const label = document.createElement('div');
    label.className = 'ym-gifItemLabel';
    label.textContent = g.title || 'GIF';

    btn.appendChild(img);
    btn.appendChild(label);
    btn.onclick = () => {
      try {
        gifPushRecent(g);
        if (GifUI.onPick) GifUI.onPick(url);
      } finally {
        closeGifPicker();
      }
    };

    GifUI.grid.appendChild(btn);
  });
}

function gifShowRecents() {
  gifSetMode('recents');
  const items = gifReadRecents();
  if (!items.length) {
    GifUI.grid && (GifUI.grid.innerHTML = '');
    GifUI.status && (GifUI.status.textContent = 'No recent GIFs yet. Search or open Top GIFs.');
    return;
  }
  gifRenderItems(items, `Recent GIFs (${items.length})`);
}

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
      <div class="ym-gifQuickRow">
        <button type="button" class="ym-gifQuickBtn ym-gifRecentBtn">Recents</button>
        <button type="button" class="ym-gifQuickBtn ym-gifTrendingBtn">Top GIFs</button>
        <button type="button" class="ym-gifQuickBtn ym-gifRandomBtn">Random</button>
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
  try { wireTransientSearchInput(GifUI.search, { clearOnLoad: false, clearOnPageShow: false, clearOnRefocusAfterBlur: false }); } catch {}
  GifUI.searchBtn = overlay.querySelector('.ym-gifSearchBtn');
  GifUI.recentBtn = overlay.querySelector('.ym-gifRecentBtn');
  GifUI.trendingBtn = overlay.querySelector('.ym-gifTrendingBtn');
  GifUI.randomBtn = overlay.querySelector('.ym-gifRandomBtn');
  GifUI.status = overlay.querySelector('.ym-gifStatus');
  GifUI.grid = overlay.querySelector('.ym-gifGrid');

  const close = () => closeGifPicker();

  GifUI.closeBtn?.addEventListener('click', (e) => { e.preventDefault(); close(); });
  overlay.addEventListener('mousedown', (e) => {
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

  GifUI.recentBtn?.addEventListener('click', (e) => {
    e.preventDefault();
    gifShowRecents();
  });
  GifUI.trendingBtn?.addEventListener('click', (e) => {
    e.preventDefault();
    gifTrending();
  });
  GifUI.randomBtn?.addEventListener('click', (e) => {
    e.preventDefault();
    gifRandom();
  });

  if (!document.body.dataset.ecGifEscapeBound) {
    document.body.dataset.ecGifEscapeBound = '1';
    document.addEventListener('keydown', (e) => {
      if (GifUI.visible && e.key === 'Escape') closeGifPicker();
    });
  }

  return overlay;
}

function openGifPicker(onPick, { prefill = '' } = {}) {
  clearSearchesForModalTransition();
  const modal = ensureGifPicker();
  GifUI.onPick = (typeof onPick === 'function') ? onPick : null;

  if (GifUI.search) {
    GifUI.search.value = String(prefill || '');
    try { GifUI.search.dispatchEvent(new Event('input', { bubbles: true })); } catch {}
    try { GifUI.search.focus(); GifUI.search.select(); } catch {}
  }

  modal.classList.remove('hidden');
  GifUI.visible = true;

  const q = (GifUI.search?.value || '').trim();
  if (q) gifSearch(q);
  else if (gifReadRecents().length) gifShowRecents();
  else gifTrending();
}

function closeGifPicker() {
  if (!GifUI.modal) return;
  GifUI.modal.classList.add('hidden');
  GifUI.visible = false;
  GifUI.onPick = null;
  clearSearchesForModalTransition({ includeGifSearch: true });
}

async function gifSearch(query) {
  const q = (query || '').trim();
  if (!GifUI.status || !GifUI.grid) return;

  if (!q) {
    gifShowRecents();
    return;
  }

  gifSetMode('search');
  GifUI.status.textContent = 'Searching…';
  GifUI.grid.innerHTML = '';

  try {
    const resp = await fetchWithAuth(`/api/gifs/search?q=${encodeURIComponent(q)}&limit=24`, { method: 'GET' });
    const data = await resp.json().catch(() => null);
    if (!resp.ok || !data?.success) {
      let msg = data?.error || `HTTP ${resp.status}`;
      if (String(msg).includes('GIPHY_API_KEY') || String(msg).toLowerCase().includes('giphy')) {
        msg = `${msg} — Admin: open Admin panel → Settings → GIFs and set the key.`;
      }
      GifUI.status.textContent = `❌ ${msg}`;
      return;
    }

    const arr = Array.isArray(data?.data) ? data.data : [];
    if (!arr.length) {
      GifUI.status.textContent = 'No results.';
      return;
    }

    gifRenderItems(arr, `${arr.length} result(s) for “${q}”`);
  } catch (e) {
    console.error(e);
    GifUI.status.textContent = '❌ GIF search failed.';
  }
}

async function gifTrending() {
  if (!GifUI.status || !GifUI.grid) return;
  gifSetMode('trending');
  GifUI.status.textContent = 'Loading top GIFs…';
  GifUI.grid.innerHTML = '';

  try {
    const resp = await fetchWithAuth('/api/gifs/trending?limit=24', { method: 'GET' });
    const data = await resp.json().catch(() => null);
    if (!resp.ok || !data?.success) {
      let msg = data?.error || `HTTP ${resp.status}`;
      if (String(msg).includes('GIPHY_API_KEY') || String(msg).toLowerCase().includes('giphy')) {
        msg = `${msg} — Admin: open Admin panel → Settings → GIFs and set the key.`;
      }
      GifUI.status.textContent = `❌ ${msg}`;
      return;
    }

    const arr = Array.isArray(data?.data) ? data.data : [];
    if (!arr.length) {
      GifUI.status.textContent = 'No top GIFs right now.';
      return;
    }

    gifRenderItems(arr, `Top GIFs (${arr.length})`);
  } catch (e) {
    console.error(e);
    GifUI.status.textContent = '❌ Could not load top GIFs.';
  }
}

async function gifRandom() {
  if (!GifUI.status || !GifUI.grid) return;
  gifSetMode('random');
  GifUI.status.textContent = 'Loading a random GIF…';
  GifUI.grid.innerHTML = '';

  try {
    let arr = Array.isArray(GifUI.lastResults) ? GifUI.lastResults.slice() : [];
    if (!arr.length) {
      const resp = await fetchWithAuth('/api/gifs/trending?limit=24', { method: 'GET' });
      const data = await resp.json().catch(() => null);
      if (!resp.ok || !data?.success) {
        let msg = data?.error || `HTTP ${resp.status}`;
        if (String(msg).includes('GIPHY_API_KEY') || String(msg).toLowerCase().includes('giphy')) {
          msg = `${msg} — Admin: open Admin panel → Settings → GIFs and set the key.`;
        }
        GifUI.status.textContent = `❌ ${msg}`;
        return;
      }
      arr = Array.isArray(data?.data) ? data.data : [];
    }

    if (!arr.length) {
      GifUI.status.textContent = 'No GIFs available for random pick.';
      return;
    }

    const chosen = arr[Math.floor(Math.random() * arr.length)];
    gifRenderItems([chosen], 'Random GIF');
  } catch (e) {
    console.error(e);
    GifUI.status.textContent = '❌ Could not load a random GIF.';
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
  if (typeof AUTH_EXPIRED !== "undefined" && AUTH_EXPIRED) return;
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

  // If we already know the session is expired, don't keep hammering the server.
  if (typeof AUTH_EXPIRED !== "undefined" && AUTH_EXPIRED) {
    return new Response('', { status: 401 });
  }

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
    // Do a bounded refresh-with-backoff. If that fails, enter auth-expired mode
    // and stop periodic polling until the user manually retries/logs out.
    try {
      await refreshAccessTokenWithBackoff(3);
      try {
        resp = await fetch(url, opts);
      } catch (e) {
        setConnBanner("disconnected", "🔌 Connection lost — reconnecting…");
        tryReconnectNow("network_error");
        return new Response('', { status: 0 });
      }
      if (resp.status === 401) {
        // Refresh said OK but the request is still unauthorized (server-side session revoked,
        // refresh rotated in another tab/device, etc).
        enterAuthExpiredState('auth_required');
      }
    } catch {
      enterAuthExpiredState('auth_required');
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

// Action toast (clickable CTA button)
function toastAction(message, opts = {}) {
  const kind = opts.kind || "info";
  const timeout = Number(opts.timeout || 9000);
  const actionLabel = String(opts.actionLabel || "Open");
  const onAction = (typeof opts.onAction === "function") ? opts.onAction : null;

  const stack = $("toastStack");
  if (!stack) return;

  const div = document.createElement("div");
  div.className = `toast ${kind} actionToast`;

  const msg = document.createElement("div");
  msg.className = "toastMsg";
  msg.textContent = message;

  const btn = document.createElement("button");
  btn.className = "toastBtn";
  btn.type = "button";
  btn.textContent = actionLabel;

  const finish = () => { try { div.remove(); } catch {} };
  btn.onclick = (e) => {
    try { e?.stopPropagation?.(); } catch {}
    try { if (onAction) onAction(); } catch {}
    finish();
  };
  div.onclick = () => {
    try { if (onAction) onAction(); } catch {}
    finish();
  };

  div.appendChild(msg);
  div.appendChild(btn);
  stack.appendChild(div);

  playBeep();
  setTimeout(finish, timeout);
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


// ───────────────────────────────────────────────────────────────────────────────
// LiveKit A/V (scalable SFU) — replaces P2P voice when enabled
// ───────────────────────────────────────────────────────────────────────────────
const LIVEKIT_ENABLED = !!(ECHOCHAT_CFG && ECHOCHAT_CFG.livekit_enabled);

const LK_STATE = {
  room: null,
  connected: false,
  joining: false,
  echoRoom: null,
  livekitRoom: null,
  micEnabled: true,
  camEnabled: true,
  tiles: new Map(), // identity -> tileEl
};

function lkSdkOk() {
  return !!(window.LivekitClient && window.LivekitClient.Room && window.LivekitClient.RoomEvent);
}

function lkEls() {
  return {
    avPanel: $("roomEmbedAvPanel"),
    avGrid: $("roomEmbedAvGrid"),
    avStatus: $("roomEmbedAvStatus"),
    btnHide: $("btnRoomEmbedAvHide"),
    btnCam: $("btnRoomEmbedVoiceCam"),
    btnMute: $("btnRoomEmbedVoiceMute"),
  };
}

function lkSetAvStatus(txt) {
  const el = lkEls().avStatus;
  if (el) el.textContent = String(txt || "");
}

function lkShowAvPanel(show) {
  const el = lkEls().avPanel;
  if (!el) return;
  if (show) el.classList.remove("hidden");
  else el.classList.add("hidden");
}

function lkClearAvGrid() {
  const { avGrid } = lkEls();
  if (!avGrid) return;
  avGrid.innerHTML = "";
  LK_STATE.tiles.clear();
}

function lkEnsureTile(identity) {
  const { avGrid } = lkEls();
  if (!avGrid) return null;
  const key = String(identity || "unknown");
  if (LK_STATE.tiles.has(key)) return LK_STATE.tiles.get(key);

  const tile = document.createElement("div");
  tile.className = "ym-avTile";
  tile.dataset.identity = key;

  const head = document.createElement("div");
  head.className = "ym-avTileHead";

  const name = document.createElement("div");
  name.className = "ym-avTileName";
  name.textContent = key;

  head.appendChild(name);
  tile.appendChild(head);

  const media = document.createElement("div");
  media.className = "ym-avMedia";
  tile.appendChild(media);

  avGrid.appendChild(tile);
  LK_STATE.tiles.set(key, tile);
  return tile;
}

function lkAttachTrack(track, participantIdentity) {
  try {
    const tile = lkEnsureTile(participantIdentity);
    if (!tile) return;
    const media = tile.querySelector(".ym-avMedia");
    if (!media) return;

    // Remove any previous element with the same sid
    const existing = document.getElementById("lk_" + track.sid);
    if (existing) existing.remove();

    const el = track.attach();
    el.id = "lk_" + track.sid;
    // best-effort autoplay flags
    try { el.autoplay = true; } catch {}
    try { el.playsInline = true; } catch {}
    media.appendChild(el);
  } catch {}
}

function lkDetachTrack(track) {
  try {
    const els = track.detach();
    if (Array.isArray(els)) els.forEach(e => { try { e.remove(); } catch {} });
  } catch {}
  try {
    const el = document.getElementById("lk_" + track.sid);
    if (el) el.remove();
  } catch {}
}

function lkUpdateUiConnected() {
  const eRoom = LK_STATE.echoRoom || "Room";
  const lkRoom = LK_STATE.livekitRoom || "";
  lkSetAvStatus(`Connected: ${lkRoom}`);
  lkShowAvPanel(true);

  // Show quick controls in the voice bar (reusing existing UI)
  voiceRoomUi({
    show: true,
    statusText: `📹 A/V connected (${lkRoom})`,
    joinVisible: false,
    leaveVisible: false,
    muteVisible: true,
    camVisible: true,
    muteLabel: LK_STATE.micEnabled ? "Mute" : "Unmute",
    camLabel: LK_STATE.camEnabled ? "Cam Off" : "Cam On",
  });

  try { voiceUpdateRoomVoiceButton(); } catch {}
}

function lkUpdateUiDisconnected(msg="Not connected") {
  lkSetAvStatus(msg);
  lkShowAvPanel(false);
  try {
    voiceRoomUi({ show: false, statusText: "Not connected", joinVisible: false, leaveVisible: false, muteVisible: false, camVisible: false });
  } catch {}
  try { voiceUpdateRoomVoiceButton(); } catch {}
}

async function lkJoinForRoom(echoRoom) {
  if (!LIVEKIT_ENABLED) throw new Error("LiveKit disabled");
  if (!lkSdkOk()) throw new Error("LiveKit JS SDK not loaded");
  if (!voiceSecureContextOk()) throw new Error("A/V requires HTTPS or http://localhost");

  const roomName = String(echoRoom || "").trim();
  if (!roomName) throw new Error("Room missing");

  if (LK_STATE.joining) return;
  LK_STATE.joining = true;

  // If already connected to another room, leave first
  if (LK_STATE.connected && LK_STATE.room) {
    await lkLeave("Switching rooms");
  }

  voiceRoomUi({ show: true, statusText: "📹 Connecting A/V…", joinVisible: false, leaveVisible: false, muteVisible: false, camVisible: false });
  lkShowAvPanel(true);
  lkSetAvStatus("Connecting…");
  lkClearAvGrid();

  try {
    const resp = await fetch("/api/livekit/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ room: roomName }),
    });
    const j = await resp.json().catch(() => ({}));
    if (!resp.ok || !j || !j.ok) {
      const err = (j && (j.error || j.message)) || `HTTP ${resp.status}`;
      throw new Error(err);
    }

    const url = j.url;
    const token = j.token;
    const lkRoom = j.room;

    const LKC = window.LivekitClient;
    const room = new LKC.Room();

    // Track events
    room.on(LKC.RoomEvent.TrackSubscribed, (track, _pub, participant) => {
      lkAttachTrack(track, participant?.identity || "unknown");
    });
    room.on(LKC.RoomEvent.TrackUnsubscribed, (track, _pub, _participant) => {
      lkDetachTrack(track);
    });
    room.on(LKC.RoomEvent.LocalTrackPublished, (pub, track) => {
      try {
        const me = (window.USERNAME || "me");
        lkAttachTrack(track, me);
      } catch {}
    });
    room.on(LKC.RoomEvent.LocalTrackUnpublished, (_pub, track) => {
      lkDetachTrack(track);
    });
    room.on(LKC.RoomEvent.Disconnected, () => {
      lkCleanup("Disconnected");
    });

    await room.connect(url, token);

    LK_STATE.room = room;
    LK_STATE.connected = true;
    LK_STATE.echoRoom = roomName;
    LK_STATE.livekitRoom = lkRoom;

    // Enable mic + cam (will prompt permissions)
    await room.localParticipant.setMicrophoneEnabled(true);
    await room.localParticipant.setCameraEnabled(true);
    LK_STATE.micEnabled = true;
    LK_STATE.camEnabled = true;

    lkUpdateUiConnected();
  } finally {
    LK_STATE.joining = false;
  }
}

function lkCleanup(reason="") {
  try { LK_STATE.room && LK_STATE.room.disconnect && LK_STATE.room.disconnect(); } catch {}
  LK_STATE.room = null;
  LK_STATE.connected = false;
  LK_STATE.echoRoom = null;
  LK_STATE.livekitRoom = null;
  LK_STATE.micEnabled = true;
  LK_STATE.camEnabled = true;
  lkClearAvGrid();
  lkUpdateUiDisconnected(reason || "Not connected");
}

async function lkLeave(reason="Left") {
  try {
    if (LK_STATE.room && LK_STATE.room.disconnect) LK_STATE.room.disconnect();
  } catch {}
  lkCleanup(reason);
}

async function lkToggleForRoom(echoRoom) {
  const roomName = String(echoRoom || "").trim();
  if (!roomName) return;
  if (LK_STATE.connected && LK_STATE.echoRoom === roomName) {
    await lkLeave("Left A/V");
    return;
  }
  await lkJoinForRoom(roomName);
}

async function lkToggleMic() {
  try {
    if (!LK_STATE.room || !LK_STATE.connected) return;
    LK_STATE.micEnabled = !LK_STATE.micEnabled;
    await LK_STATE.room.localParticipant.setMicrophoneEnabled(LK_STATE.micEnabled);
    lkUpdateUiConnected();
  } catch {}
}

async function lkToggleCam() {
  try {
    if (!LK_STATE.room || !LK_STATE.connected) return;
    LK_STATE.camEnabled = !LK_STATE.camEnabled;
    await LK_STATE.room.localParticipant.setCameraEnabled(LK_STATE.camEnabled);
    lkUpdateUiConnected();
  } catch {}
}


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
  if (bCam) bCam.style.display = patch.camVisible === false ? "none" : "";
  if (bCam && patch.camLabel) bCam.textContent = patch.camLabel;

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
  const bCam = $("btnRoomEmbedVoiceCam");

  if (bar) {
    if (patch.show === true) bar.classList.remove("hidden");
    if (patch.show === false) bar.classList.add("hidden");
  }
  if (status && patch.statusText !== undefined) status.textContent = patch.statusText;
  if (bJoin) bJoin.style.display = patch.joinVisible === false ? "none" : "";
  if (bLeave) bLeave.style.display = patch.leaveVisible === false ? "none" : "";
  if (bMute) bMute.style.display = patch.muteVisible === false ? "none" : "";
  if (bMute && patch.muteLabel) bMute.textContent = patch.muteLabel;
  if (bCam) bCam.style.display = patch.camVisible === false ? "none" : "";
  if (bCam && patch.camLabel) bCam.textContent = patch.camLabel;

  // Keep the main room voice button in sync with state.
  try { voiceUpdateRoomVoiceButton(); } catch (e) {}
}


function voiceUpdateRoomVoiceButton() {
  const btn = $("btnRoomEmbedVoice");
  if (!btn) return;

  // LiveKit A/V mode
  if (LIVEKIT_ENABLED) {
    const active = !!(LK_STATE.connected && LK_STATE.echoRoom);
    if (!active) {
      btn.textContent = "📹 A/V";
      btn.title = "Audio/Video (LiveKit) — click to join";
      btn.classList.remove("active");
      return;
    }
    btn.classList.add("active");
    if (!LK_STATE.micEnabled && !LK_STATE.camEnabled) {
      btn.textContent = "⛔ A/V";
      btn.title = "A/V connected (mic+cam off) — click to leave • right‑click to unmute";
    } else if (!LK_STATE.micEnabled) {
      btn.textContent = "🔇 A/V";
      btn.title = "A/V connected (muted) — click to leave • right‑click to unmute";
    } else if (!LK_STATE.camEnabled) {
      btn.textContent = "🎤 A/V";
      btn.title = "A/V connected (camera off) — click to leave • right‑click to mute";
    } else {
      btn.textContent = "📹 A/V";
      btn.title = "A/V connected — click to leave • right‑click to mute";
    }
    return;
  }

  // Legacy P2P voice mode
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
  // Return a Promise so callers can await the unlock result.
  // Existing callers that do not await are unaffected.
  return new Promise((resolve) => {
    const modal = $("unlockModal");
    const input = $("unlockPassword");
    const remember = $("unlockRemember");
    const errBox = $("unlockError");
    const btnUnlock = $("btnUnlock");
    const btnSkip = $("btnUnlockSkip");

    if (!modal || !input || !remember || !btnUnlock || !btnSkip) {
      resolve(false);
      return;
    }

    let resolved = false;
    const resolveOnce = (v) => {
      if (resolved) return;
      resolved = true;
      resolve(!!v);
    };

  // Reset UI
  clearSearchesForModalTransition();
  errBox?.classList.add("hidden");
  errBox && (errBox.textContent = "");
  input.value = "";
  remember.checked = true;
  modal.classList.remove("hidden");
  input.focus();

    const done = (ok) => {
      modal.classList.add("hidden");
      clearSearchesForModalTransition();
      btnUnlock.onclick = null;
      btnSkip.onclick = null;
      input.onkeydown = null;
      resolveOnce(ok);
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

      // If we consumed offline PMs while locked, decrypt any pending ciphertext now.
      try { setTimeout(() => { flushPendingOfflineDm(); }, 50); } catch {}
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
  });
}

async function ensurePrivateKeyUnlocked() {
  if (!HAS_WEBCRYPTO) throw new Error(`E2EE requires HTTPS (or http://localhost / http://127.0.0.1). Current origin: ${window.location.origin}`);
  if (window.myPrivateCryptoKey) return window.myPrivateCryptoKey;
  if (UIState.unlockSkipped) throw new Error("Unlock skipped");

  // First try auto-unlock using the remembered DM password (sessionStorage).
  const ok = await tryAutoUnlockPrivateMessages("");
  if (ok && window.myPrivateCryptoKey) return window.myPrivateCryptoKey;

  // Fall back to an interactive unlock prompt (no logout required).
  const unlocked = await showUnlockModal();
  if (unlocked && window.myPrivateCryptoKey) return window.myPrivateCryptoKey;

  // User skipped/cancelled or unlock failed.
  throw new Error("Private messages are locked");
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
  log.innerHTML = "";

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
  try { appendLine(win, "System:", "Window opened.", { ts: Date.now() }); } catch {}

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
    if (img._ecScrollLog) scheduleScrollLogToBottom(img._ecScrollLog);
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



const CHAT_GROUP_WINDOW_MS = 5 * 60 * 1000;

function forceScrollLogToBottom(log) {
  if (!log) return;
  try { log.scrollTop = log.scrollHeight; } catch {}
}

function scheduleScrollLogToBottom(log) {
  if (!log) return;
  const run = () => forceScrollLogToBottom(log);
  run();
  try {
    requestAnimationFrame(() => {
      run();
      requestAnimationFrame(run);
    });
  } catch {}
  setTimeout(run, 0);
  setTimeout(run, 50);
  setTimeout(run, 180);
}

function normalizeChatTs(ts) {
  if (ts === null || ts === undefined || ts === "") return Date.now();
  if (ts instanceof Date) return ts.getTime();
  if (typeof ts === "number" && Number.isFinite(ts)) return ts < 1e12 ? Math.round(ts * 1000) : Math.round(ts);
  const n = Number(ts);
  if (Number.isFinite(n)) return n < 1e12 ? Math.round(n * 1000) : Math.round(n);
  const parsed = Date.parse(String(ts));
  return Number.isNaN(parsed) ? Date.now() : parsed;
}

function chatDateKey(ts) {
  const d = new Date(normalizeChatTs(ts));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function formatChatTime(ts) {
  return new Date(normalizeChatTs(ts)).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function formatChatDateLabel(ts) {
  const dt = new Date(normalizeChatTs(ts));
  const that = new Date(dt.getFullYear(), dt.getMonth(), dt.getDate());
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diffDays = Math.round((today - that) / 86400000);
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  const opts = { weekday: "long", month: "short", day: "numeric" };
  if (dt.getFullYear() !== now.getFullYear()) opts.year = "numeric";
  return dt.toLocaleDateString([], opts);
}

function ensureChatLogState(log) {
  if (!log) return null;
  if (!log._ecChatUi) log._ecChatUi = { lastDateKey: null, lastGroup: null };
  return log._ecChatUi;
}

function resetChatLogState(log) {
  if (!log) return;
  try { log.innerHTML = ""; } catch {}
  const st = ensureChatLogState(log);
  if (!st) return;
  st.lastDateKey = null;
  st.lastGroup = null;
}

function makeDateSeparatorElement(ts) {
  const el = document.createElement("div");
  el.className = "ec-dateSep";
  el.dataset.dateKey = chatDateKey(ts);
  const label = document.createElement("span");
  label.textContent = formatChatDateLabel(ts);
  el.appendChild(label);
  return el;
}

function ensureDateSeparatorForLog(log, tsMs) {
  const st = ensureChatLogState(log);
  if (!st) return null;
  const key = chatDateKey(tsMs);
  if (st.lastDateKey === key) return null;
  const sep = makeDateSeparatorElement(tsMs);
  log.appendChild(sep);
  st.lastDateKey = key;
  st.lastGroup = null;
  return sep;
}

function getGroupAvatarInitial(label) {
  const s = String(label || "?").trim();
  const m = s.match(/[A-Za-z0-9]/);
  return (m ? m[0] : (s[0] || "?")).toUpperCase();
}

function makeChatGroupElement(senderLabel, tsMs, { variant = "generic" } = {}) {
  const group = document.createElement("div");
  group.className = `ec-msgGroup ec-msgGroup--${variant}`;
  group.dataset.senderKey = String(senderLabel || "").trim().toLowerCase();
  group.dataset.dateKey = chatDateKey(tsMs);
  group.dataset.variant = variant;
  const mine = /^you$/i.test(String(senderLabel || "").trim()) || String(senderLabel || "").trim() === String(currentUser || "").trim();
  if (mine) group.classList.add("is-self");

  const avatar = document.createElement("div");
  avatar.className = "ec-msgAvatar";
  avatar.setAttribute("aria-hidden", "true");
  avatar.textContent = getGroupAvatarInitial(senderLabel);

  const main = document.createElement("div");
  main.className = "ec-msgGroupMain";

  const head = document.createElement("div");
  head.className = "ec-msgGroupHead";

  const nameEl = document.createElement("span");
  nameEl.className = "ec-msgSender";
  nameEl.textContent = String(senderLabel || "Unknown");

  const timeEl = document.createElement("span");
  timeEl.className = "ec-msgTime";
  timeEl.textContent = formatChatTime(tsMs);
  timeEl.title = new Date(normalizeChatTs(tsMs)).toLocaleString();

  const items = document.createElement("div");
  items.className = "ec-msgItems";

  head.appendChild(nameEl);
  head.appendChild(timeEl);
  main.appendChild(head);
  main.appendChild(items);
  group.appendChild(avatar);
  group.appendChild(main);

  return { group, items, timeEl };
}

function canReuseChatGroup(state, senderKey, tsMs, variant) {
  const last = state?.lastGroup;
  if (!last) return false;
  if (last.variant !== variant) return false;
  if (last.senderKey !== senderKey) return false;
  if (last.dateKey !== chatDateKey(tsMs)) return false;
  return Math.abs(tsMs - last.tsMs) <= CHAT_GROUP_WINDOW_MS;
}

function getOrCreateChatGroup(log, senderLabel, tsMs, { variant = "generic" } = {}) {
  const st = ensureChatLogState(log);
  if (!st) return null;
  const senderKey = String(senderLabel || "unknown").trim().toLowerCase() || "unknown";
  if (canReuseChatGroup(st, senderKey, tsMs, variant)) {
    st.lastGroup.tsMs = tsMs;
    return st.lastGroup;
  }

  ensureDateSeparatorForLog(log, tsMs);
  const built = makeChatGroupElement(senderLabel, tsMs, { variant });
  log.appendChild(built.group);

  st.lastGroup = {
    variant,
    senderKey,
    tsMs,
    dateKey: chatDateKey(tsMs),
    el: built.group,
    itemsEl: built.items,
    timeEl: built.timeEl,
  };
  return st.lastGroup;
}

function parseWhoInfo(who) {
  const raw = String(who || "").trim();
  const label = raw.replace(/:\s*$/, "").trim();
  const isSystem = /^system$/i.test(label);
  return { raw, label: isSystem ? "System" : (label || "Unknown"), isSystem };
}

function makeSystemRow(text, tsMs) {
  const row = document.createElement("div");
  row.className = "ec-systemRow";

  const msg = document.createElement("span");
  msg.className = "ec-systemText";
  msg.textContent = String(text || "");

  const tm = document.createElement("span");
  tm.className = "ec-systemTime";
  tm.textContent = formatChatTime(tsMs);
  tm.title = new Date(normalizeChatTs(tsMs)).toLocaleString();

  row.appendChild(msg);
  row.appendChild(tm);
  return row;
}

function buildTextMessageBody(text, { autoScrollLog = null } = {}) {
  const gifUrl = parseGifMarker(text);
  if (gifUrl) {
    const wrap = document.createElement("div");
    wrap.className = "ym-gifWrap";

    const img = document.createElement("img");
    configureGifInlineImage(img, gifUrl);
    if (autoScrollLog) img._ecScrollLog = autoScrollLog;

    const open = document.createElement("a");
    open.className = "ym-gifOpen";
    open.href = gifUrl;
    open.target = "_blank";
    open.rel = "noopener noreferrer";
    open.textContent = "Open";

    wrap.appendChild(img);
    wrap.appendChild(open);
    return wrap;
  }

  const body = document.createElement("div");
  body.className = "ec-msgText";
  body.textContent = (typeof text === "string") ? text : String(text ?? "");
  return body;
}

function appendGenericMessageItem(log, who, contentEl, { ts = null, kind = "text" } = {}) {
  if (!log) return null;
  const meta = parseWhoInfo(who);
  const tsMs = normalizeChatTs(ts);

  if (meta.isSystem) {
    ensureDateSeparatorForLog(log, tsMs);
    const row = makeSystemRow(contentEl?.textContent ?? contentEl, tsMs);
    log.appendChild(row);
    const st = ensureChatLogState(log);
    if (st) st.lastGroup = null;
    return row;
  }

  const group = getOrCreateChatGroup(log, meta.label, tsMs, { variant: "generic" });
  if (!group?.itemsEl) return null;

  const item = document.createElement("div");
  item.className = `ec-msgItem ec-msgItem--${kind}`;
  if (contentEl instanceof Node) item.appendChild(contentEl);
  else item.textContent = String(contentEl ?? "");
  group.itemsEl.appendChild(item);
  return item;
}

function appendLine(winEl, who, text, kind = "msg", opts = {}) {
  if (kind && typeof kind === "object" && !Array.isArray(kind)) {
    opts = kind;
    kind = "msg";
  }
  const log = winEl._ym?.log;
  if (!log) return;

  const body = buildTextMessageBody(text, { autoScrollLog: log });
  const msgKind = parseGifMarker(text) ? "gif" : "text";
  appendGenericMessageItem(log, who, body, { ts: opts?.ts, kind: msgKind });
  scheduleScrollLogToBottom(log);
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

function buildFileCardElement(filePayload, { peer, direction } = {}) {
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

  const badge = document.createElement("span");
  badge.className = "ym-fileBadge";
  const src = filePayload?.source || (filePayload?.transfer_id ? "p2p" : "server");
  badge.textContent = (src === "p2p") ? "P2P" : "SRV";

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
  return card;
}

function makeFileLineElement(who, filePayload, { peer, direction } = {}) {
  return buildFileCardElement(filePayload, { peer, direction });
}

function appendFileLine(winEl, who, filePayload, { peer, direction, ts } = {}) {
  const log = winEl._ym?.log;
  if (!log) return;
  const card = buildFileCardElement(filePayload, { peer, direction });
  appendGenericMessageItem(log, who, card, { ts, kind: "file" });
  scheduleScrollLogToBottom(log);
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

function appendTorrentLine(winEl, who, t, { peer, direction, ts } = {}) {
  const log = winEl._ym?.log;
  if (!log) return;
  appendGenericMessageItem(log, who, buildTorrentCard(t), { ts, kind: "torrent" });
  scheduleScrollLogToBottom(log);
}

function appendP2pTransferUI(winEl, who, meta, { mode = "outgoing", ts } = {}) {
  const log = winEl?._ym?.log;
  if (!log) return { setProgress() {}, setStatus() {}, remove() {}, disableActions() {}, onAccept() {}, onDecline() {} };

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

  const item = appendGenericMessageItem(log, who, card, { ts, kind: "transfer" });
  scheduleScrollLogToBottom(log);

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
      try { item?.remove(); } catch {}
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
  const tsMs = normalizeChatTs(payload?.timestamp || payload?.ts || payload?.created_at || payload?.createdAt);

  const messageId = payload?.message_id || payload?.messageId || payload?.id || `local-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  _ensureMsgIndex(viewEl);

  const group = getOrCreateChatGroup(log, username ? String(username) : "?", tsMs, { variant: "room" });
  if (!group?.itemsEl) return;

  const item = document.createElement("div");
  item.className = "ec-msgItem ec-msgItem--room";
  item.dataset.msgid = messageId;

  // Content
  const contentWrap = document.createElement("div");
  contentWrap.className = "ec-msgContent";

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
    contentWrap.appendChild(buildTorrentCard(t));
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
      contentWrap.appendChild(buildTorrentCard(t));
    } else {
      contentWrap.appendChild(buildTextMessageBody(message, { autoScrollLog: log }));
    }
  } else {
    contentWrap.appendChild(buildTextMessageBody(message, { autoScrollLog: log }));
  }

  const line = document.createElement("div");
  line.className = "msgLine";

  // Reactions (rooms only)
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

  line.appendChild(contentWrap);
  line.appendChild(actions);
  item.appendChild(line);
  item.appendChild(rx);

  group.itemsEl.appendChild(item);
  viewEl._ym.msgIndex.set(messageId, item);

  const media = item.querySelector('img[data-ec-gif="1"]');
  if (media) media._ecScrollLog = log;
  scheduleScrollLogToBottom(log);
}

// ───────────────────────────────────────────────────────────────────────────────
// Dock tabs + search
// ───────────────────────────────────────────────────────────────────────────────
function getDockPanelByKey(panelKey) {
  return $(panelKey === 'groups' ? 'panelGroups' : 'panelFriends');
}

function getDockSectionStorageKey(panelKey) {
  return `dockSectionOrder_${String(panelKey || 'friends')}`;
}

function getDockSections(panel) {
  if (!panel) return [];
  return [...panel.querySelectorAll(':scope > .dockSection[id]')];
}

function saveDockSectionOrder(panelKey) {
  const panel = getDockPanelByKey(panelKey);
  if (!panel) return;
  const order = getDockSections(panel).map((section) => section.id).filter(Boolean);
  Settings.set(getDockSectionStorageKey(panelKey), order);
}

function applyDockSectionOrder(panelKey) {
  const panel = getDockPanelByKey(panelKey);
  if (!panel) return;

  const defaults = Array.isArray(DOCK_SECTION_DEFAULT_ORDER[panelKey]) ? DOCK_SECTION_DEFAULT_ORDER[panelKey].slice() : [];
  const saved = Settings.get(getDockSectionStorageKey(panelKey), defaults);
  const sections = getDockSections(panel);
  const map = new Map(sections.map((section) => [section.id, section]));
  const mergedOrder = [];

  [...saved, ...defaults, ...sections.map((section) => section.id)].forEach((id) => {
    const key = String(id || '');
    if (!key || !map.has(key) || mergedOrder.includes(key)) return;
    mergedOrder.push(key);
  });

  const tail = panel.querySelector(':scope > .dockSearchEmpty');
  mergedOrder.forEach((id) => {
    const section = map.get(id);
    if (!section) return;
    if (tail) panel.insertBefore(section, tail);
    else panel.appendChild(section);
  });
}

function getDockDragAfterElement(panel, y) {
  const sections = getDockSections(panel).filter((section) => !section.classList.contains('dragging'));
  let closest = { offset: Number.NEGATIVE_INFINITY, element: null };
  sections.forEach((section) => {
    const rect = section.getBoundingClientRect();
    const offset = y - rect.top - rect.height / 2;
    if (offset < 0 && offset > closest.offset) closest = { offset, element: section };
  });
  return closest.element;
}

function decorateDockSection(section) {
  if (!section || section.dataset.dragDecorated === '1') return;
  section.dataset.dragDecorated = '1';
  section.draggable = true;

  const row = section.querySelector('.panelSubRow');
  if (row) {
    row.classList.add('dockSectionHeaderRow');
    let main = row.querySelector('.dockSectionHeaderMain');
    if (!main) {
      main = document.createElement('div');
      main.className = 'dockSectionHeaderMain';
      const first = row.querySelector('.panelSub');
      if (first) row.insertBefore(main, first);
      while (row.firstChild && row.firstChild !== main) main.appendChild(row.firstChild);
      const sub = row.querySelector('.panelSub');
      if (sub && sub.parentElement !== main) main.appendChild(sub);
    }

    if (!row.querySelector('.dockDragHandle')) {
      const handle = document.createElement('button');
      handle.type = 'button';
      handle.className = 'dockDragHandle';
      handle.title = 'Drag to move section';
      handle.setAttribute('aria-label', 'Drag to move section');
      handle.textContent = '⋮⋮';
      handle.draggable = false;
      handle.addEventListener('mousedown', () => { section.dataset.dragArmed = '1'; });
      handle.addEventListener('touchstart', () => { section.dataset.dragArmed = '1'; }, { passive: true });
      main.insertBefore(handle, main.firstChild || null);
    }
  }

  section.addEventListener('dragstart', (ev) => {
    if (section.dataset.dragArmed !== '1') {
      ev.preventDefault();
      return;
    }
    const panel = section.closest('.dockPanel');
    if (!panel) {
      ev.preventDefault();
      return;
    }
    section.classList.add('dragging');
    if (ev.dataTransfer) {
      ev.dataTransfer.effectAllowed = 'move';
      try { ev.dataTransfer.setData('text/plain', section.id || 'dock-section'); } catch {}
    }
  });

  section.addEventListener('dragend', () => {
    delete section.dataset.dragArmed;
    section.classList.remove('dragging');
    document.querySelectorAll('.dockSection.dragOver').forEach((el) => el.classList.remove('dragOver'));
    const panel = section.closest('.dockPanel');
    const panelKey = panel?.dataset?.panelKey || '';
    if (panelKey) saveDockSectionOrder(panelKey);
  });
}

function initDockSectionReorder() {
  document.querySelectorAll('.dockPanel').forEach((panel) => {
    const panelKey = String(panel.dataset.panelKey || '');
    if (!panelKey) return;
    applyDockSectionOrder(panelKey);
    getDockSections(panel).forEach((section) => decorateDockSection(section));

    panel.addEventListener('dragover', (ev) => {
      const dragging = panel.querySelector('.dockSection.dragging');
      if (!dragging) return;
      ev.preventDefault();
      const after = getDockDragAfterElement(panel, ev.clientY);
      const currentAfter = dragging.nextElementSibling === after || (!after && dragging.nextElementSibling && dragging.nextElementSibling.classList?.contains('dockSearchEmpty'));
      if (currentAfter) return;
      if (after) panel.insertBefore(dragging, after);
      else {
        const tail = panel.querySelector(':scope > .dockSearchEmpty');
        if (tail) panel.insertBefore(dragging, tail);
        else panel.appendChild(dragging);
      }

      document.querySelectorAll('.dockSection.dragOver').forEach((el) => el.classList.remove('dragOver'));
      if (after) after.classList.add('dragOver');
    });

    panel.addEventListener('drop', (ev) => {
      const dragging = panel.querySelector('.dockSection.dragging');
      if (!dragging) return;
      ev.preventDefault();
      document.querySelectorAll('.dockSection.dragOver').forEach((el) => el.classList.remove('dragOver'));
      saveDockSectionOrder(panelKey);
    });

    panel.addEventListener('dragleave', (ev) => {
      const rel = ev.relatedTarget;
      if (rel && panel.contains(rel)) return;
      document.querySelectorAll('.dockSection.dragOver').forEach((el) => el.classList.remove('dragOver'));
    });
  });

  document.addEventListener('mouseup', () => {
    document.querySelectorAll('.dockSection[data-drag-armed="1"]').forEach((el) => delete el.dataset.dragArmed);
  });
  document.addEventListener('touchend', () => {
    document.querySelectorAll('.dockSection[data-drag-armed="1"]').forEach((el) => delete el.dataset.dragArmed);
  }, { passive: true });
}

function setActiveDockQuickStat(targetId = null, tab = null) {
  const btns = [...document.querySelectorAll('#dockQuickStats .dockStat')];
  if (!btns.length) return;
  let active = null;
  if (targetId) active = btns.find((b) => String(b.dataset.jumpTarget || '') === String(targetId));
  if (!active && tab) active = btns.find((b) => String(b.dataset.jumpTab || '') === String(tab));
  if (!active) active = btns[0];
  btns.forEach((b) => b.classList.toggle('active', b === active));
}

function setActiveTab(tab) {
  const prevTab = String(UIState.activeTab || '');
  UIState.activeTab = tab;
  if (tab === 'groups') { try { refreshMyGroups(); refreshGroupInvites(); } catch (e) {} }

  ['friends', 'groups'].forEach(t => {
    $('tab' + t[0].toUpperCase() + t.slice(1))?.classList.toggle('active', t === tab);
    $('panel' + t[0].toUpperCase() + t.slice(1))?.classList.toggle('hidden', t !== tab);
  });

  if (prevTab !== String(tab || '')) {
    clearDockSearchesForPanelSwitch();
  }

  setActiveDockQuickStat(null, tab);
  applyDockSearchFilter($('dockSearch')?.value || '');
}

function dockInitials(name) {
  const s = String(name || '').trim();
  if (!s) return '•';
  const parts = s.split(/\s+/).filter(Boolean).slice(0, 2);
  return parts.map((p) => p[0]?.toUpperCase() || '').join('') || s[0].toUpperCase();
}

function humanPresenceText(online, presence) {
  if (!online) return 'Offline';
  switch (String(presence || 'online')) {
    case 'busy': return 'Busy';
    case 'away': return 'Away';
    case 'invisible': return 'Invisible';
    default: return 'Online';
  }
}

function createDockIdentity(left, { name = '', presenceClass = 'offline', meta = '', chip = '' } = {}) {
  const dot = document.createElement('span');
  dot.className = 'presDot ' + presenceClass;

  const avatar = document.createElement('span');
  avatar.className = 'liAvatar';
  avatar.textContent = dockInitials(name);

  const textWrap = document.createElement('div');
  textWrap.className = 'liText';

  const primary = document.createElement('div');
  primary.className = 'liPrimaryRow';

  const nameEl = document.createElement('span');
  nameEl.className = 'liName';
  nameEl.textContent = name;
  primary.appendChild(nameEl);

  if (chip) {
    const chipEl = document.createElement('span');
    chipEl.className = 'liChip';
    chipEl.textContent = chip;
    primary.appendChild(chipEl);
  }

  textWrap.appendChild(primary);

  if (meta) {
    const metaEl = document.createElement('div');
    metaEl.className = 'liMeta';
    metaEl.textContent = meta;
    textWrap.appendChild(metaEl);
  }

  left.appendChild(dot);
  left.appendChild(avatar);
  left.appendChild(textWrap);

  return { dot, avatar, textWrap, nameEl };
}

function isDockPlaceholderItem(li) {
  if (!li) return true;
  const n = String(li.dataset?.name || '').toLowerCase();
  return n === 'empty' || n === 'none' || n === 'error';
}


function clearSearchLikeInput(el) {
  if (!el) return;
  try { el.value = ''; } catch {}
  const syncWrap = () => {
    try {
      const wrap = el.parentElement;
      if (!wrap || !wrap.classList?.contains('searchInputWrap')) return;
      const hasValue = String(el.value || '').length > 0;
      wrap.classList.toggle('hasValue', hasValue);
      const btn = wrap.querySelector(':scope > .searchClearBtn');
      if (btn) {
        btn.disabled = !hasValue;
        btn.setAttribute('aria-hidden', hasValue ? 'false' : 'true');
      }
    } catch {}
  };
  switch (String(el.id || '')) {
    case 'dockSearch':
      try { applyDockSearchFilter(''); } catch {}
      break;
    case 'rbCatSearch':
      try { ROOM_BROWSER.catQuery = ''; } catch {}
      try { rbRenderCategoryTree(); } catch {}
      break;
    case 'rbRoomSearch':
      try { ROOM_BROWSER.roomQuery = ''; } catch {}
      try { rbRenderRoomLists(); } catch {}
      try { rbUpdateCountsInDom(); } catch {}
      break;
    case 'rbCustomSearch':
      try { ROOM_BROWSER.customQuery = ''; } catch {}
      try { rbRenderRoomLists(); } catch {}
      try { rbUpdateCountsInDom(); } catch {}
      break;
    default:
      if (el.classList?.contains('ym-gifSearch')) {
        try {
          if (GifUI?.visible) gifShowRecents();
        } catch {}
      }
      break;
  }
  syncWrap();
}

function clearSearchInputs(ids = []) {
  (Array.isArray(ids) ? ids : []).forEach((id) => {
    try { clearSearchLikeInput(typeof id === 'string' ? $(id) : id); } catch {}
  });
}

function clearDockSearchesForPanelSwitch() {
  clearSearchInputs(['dockSearch', 'friendUser']);
}

function clearRoomBrowserSearchesForPanelSwitch() {
  // Keep the category search intact so users can continue navigating categories,
  // but clear the content-panel searches because the visible room/custom-room
  // results are changing underneath them.
  clearSearchInputs(['rbRoomSearch', 'rbCustomSearch']);
}

function clearSearchesForModalTransition(opts = {}) {
  const includeGifSearch = !!opts.includeGifSearch;
  clearSearchInputs(['dockSearch', 'friendUser', 'rbRoomSearch', 'rbCustomSearch']);
  if (includeGifSearch) {
    try { clearSearchLikeInput(GifUI?.search); } catch {}
  }
}

function isSearchLikeInput(el) {
  if (!el || String(el.tagName || '').toUpperCase() !== 'INPUT') return false;
  const id = String(el.id || '');
  if (['dockSearch', 'friendUser', 'rbCatSearch', 'rbRoomSearch', 'rbCustomSearch'].includes(id)) return true;
  if (el.classList?.contains('dockSearch') || el.classList?.contains('rbSearch') || el.classList?.contains('ym-gifSearch')) return true;
  const ph = String(el.getAttribute('placeholder') || '');
  return /search/i.test(ph);
}

function ensureSearchClearButton(idOrEl) {
  const el = (typeof idOrEl === 'string') ? $(idOrEl) : idOrEl;
  if (!isSearchLikeInput(el)) return el;

  try { el.dataset.searchClearable = '1'; } catch {}

  let wrap = el.parentElement;
  if (!wrap || !wrap.classList?.contains('searchInputWrap')) {
    wrap = document.createElement('div');
    wrap.className = 'searchInputWrap';
    try {
      el.parentNode?.insertBefore(wrap, el);
      wrap.appendChild(el);
    } catch {
      return el;
    }
  }

  let btn = wrap.querySelector(':scope > .searchClearBtn');
  if (!btn) {
    btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'searchClearBtn';
    btn.setAttribute('aria-label', 'Clear search');
    btn.setAttribute('title', 'Clear search');
    btn.textContent = '×';
    wrap.appendChild(btn);
  }

  if (el.dataset?.searchClearButtonWired === '1') {
    const hasValue = String(el.value || '').length > 0;
    wrap.classList.toggle('hasValue', hasValue);
    return el;
  }

  const sync = () => {
    const hasValue = String(el.value || '').length > 0;
    wrap.classList.toggle('hasValue', hasValue);
    btn.disabled = !hasValue;
    btn.setAttribute('aria-hidden', hasValue ? 'false' : 'true');
    return hasValue;
  };

  const clearAndSync = () => {
    clearSearchLikeInput(el);
    try { el.dispatchEvent(new Event('input', { bubbles: true })); } catch {}
    try { el.dispatchEvent(new Event('change', { bubbles: true })); } catch {}
    sync();
  };

  try { el.dataset.searchClearButtonWired = '1'; } catch {}

  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    clearAndSync();
    try { el.focus(); } catch {}
  });

  el.addEventListener('input', sync);
  el.addEventListener('change', sync);
  el.addEventListener('blur', sync);
  el.addEventListener('focus', sync);
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && String(el.value || '').length > 0) {
      e.preventDefault();
      e.stopPropagation();
      clearAndSync();
    }
  });

  sync();
  return el;
}

function wireTransientSearchInput(idOrEl, opts = {}) {
  const el = (typeof idOrEl === 'string') ? $(idOrEl) : idOrEl;
  if (!el) return null;
  ensureSearchClearButton(el);
  if (el.dataset?.transientSearchWired === '1') return el;

  const clearOnLoad = !!opts.clearOnLoad;
  const clearOnPageShow = !!opts.clearOnPageShow;
  const clearOnRefocusAfterBlur = opts.clearOnRefocusAfterBlur !== false;

  let userTouched = false;
  const markTouched = () => { userTouched = true; };
  const unlockReadonly = () => {
    try {
      if (el.readOnly) el.readOnly = false;
    } catch {}
  };
  const clearIfUntouched = () => {
    if (!userTouched) clearSearchLikeInput(el);
  };

  try { el.dataset.transientSearchWired = '1'; } catch {}
  try { el.setAttribute('autocomplete', 'new-password'); } catch {}
  try { el.setAttribute('autocapitalize', 'off'); } catch {}
  try { el.setAttribute('autocorrect', 'off'); } catch {}
  try { el.setAttribute('spellcheck', 'false'); } catch {}
  try { el.setAttribute('data-lpignore', 'true'); } catch {}
  try { el.setAttribute('data-1p-ignore', 'true'); } catch {}
  try { el.setAttribute('aria-autocomplete', 'none'); } catch {}
  try {
    if (!el.dataset?.autofillSafeNameApplied) {
      const base = String(el.id || el.name || 'search').replace(/[^a-z0-9_-]/gi, '').toLowerCase() || 'search';
      el.name = `ym_${base}_${Math.random().toString(36).slice(2, 8)}`;
      el.dataset.autofillSafeNameApplied = '1';
    }
  } catch {}
  try {
    el.readOnly = true;
    requestAnimationFrame(() => setTimeout(unlockReadonly, 0));
  } catch {}
  try { el.spellcheck = false; } catch {}

  if (clearOnLoad) {
    clearSearchLikeInput(el);
    [0, 60, 250, 800].forEach((ms) => setTimeout(clearIfUntouched, ms));
  }

  let clearOnNextFocus = false;

  const maybeClear = () => {
    unlockReadonly();
    if (!clearOnRefocusAfterBlur || !clearOnNextFocus) return;
    if (String(el.value || '').length > 0) clearSearchLikeInput(el);
    clearOnNextFocus = false;
  };

  el.addEventListener('input', markTouched);
  el.addEventListener('keydown', markTouched);
  el.addEventListener('paste', markTouched);
  el.addEventListener('change', markTouched);
  el.addEventListener('pointerdown', unlockReadonly, { capture: true });
  el.addEventListener('mousedown', unlockReadonly, { capture: true });
  el.addEventListener('touchstart', unlockReadonly, { capture: true, passive: true });

  el.addEventListener('blur', () => {
    if (clearOnRefocusAfterBlur) clearOnNextFocus = true;
  });

  el.addEventListener('pointerdown', maybeClear);
  el.addEventListener('focus', maybeClear);

  if (clearOnPageShow) {
    window.addEventListener('pageshow', () => {
      userTouched = false;
      clearSearchLikeInput(el);
      [0, 60, 250, 800].forEach((ms) => setTimeout(clearIfUntouched, ms));
      clearOnNextFocus = false;
      try {
        el.readOnly = true;
        requestAnimationFrame(() => setTimeout(unlockReadonly, 0));
      } catch {}
    });
  }

  return el;
}

function wireTransientSearchInputWhenAvailable(id, opts = {}) {
  const wired = wireTransientSearchInput(id, opts);
  if (wired) return wired;

  const root = document.body || document.documentElement;
  if (!root || typeof MutationObserver === 'undefined') return null;

  const obs = new MutationObserver(() => {
    const found = wireTransientSearchInput(id, opts);
    if (found) obs.disconnect();
  });
  obs.observe(root, { childList: true, subtree: true });
  return null;
}

function setDockBadge(id, count, title = '') {
  const el = $(id);
  if (!el) return;
  const n = Number(count || 0);
  const safe = Number.isFinite(n) ? n : 0;
  el.textContent = String(safe);
  if (title) el.title = title;
}

function updateDockSummaryCounts() {
  const missedThreads = Array.isArray(UIState.missedPmSummary) ? UIState.missedPmSummary.length : 0;
  const missedTotal = Array.isArray(UIState.missedPmSummary)
    ? UIState.missedPmSummary.reduce((sum, it) => sum + (Number(it?.count || 0) || 0), 0)
    : 0;
  const friendCount = UIState.friendSet instanceof Set ? UIState.friendSet.size : 0;
  const pendingCount = Array.isArray(UIState.pendingRequests) ? UIState.pendingRequests.length : 0;
  const blockedCount = UIState.blockedSet instanceof Set ? UIState.blockedSet.size : 0;
  const groupCount = Array.isArray(UIState.myGroups) ? UIState.myGroups.length : 0;
  const groupInviteCount = Array.isArray(UIState.groupInvites) ? UIState.groupInvites.length : 0;

  setDockBadge('dockMissedCount', missedTotal, `${missedThreads} conversations`);
  setDockBadge('missedPmCount', missedThreads, `${missedTotal} total unread private messages`);
  setDockBadge('dockFriendsCount', friendCount, 'Friends in your dock');
  setDockBadge('friendsCount', friendCount, 'Friends in your dock');
  setDockBadge('dockPendingCount', pendingCount, 'Pending inbound friend requests');
  setDockBadge('pendingRequestsCount', pendingCount, 'Pending inbound friend requests');
  setDockBadge('blockedUsersCount', blockedCount, 'Blocked contacts');
  setDockBadge('dockGroupsCount', groupCount, 'Groups in your dock');
  setDockBadge('groupListCount', groupCount, 'Groups in your dock');
  setDockBadge('groupInvitesCount', groupInviteCount, 'Pending group invites');

  applyDockSearchFilter($('dockSearch')?.value || '');
}

function applyDockSearchFilter(query) {
  const q = String(query || '').trim().toLowerCase();
  const activePanelId = UIState.activeTab === 'groups' ? 'panelGroups' : 'panelFriends';
  const panel = $(activePanelId);
  if (!panel) return;

  let anyVisible = false;
  panel.querySelectorAll('.dockSection[data-filter-list]').forEach((section) => {
    const listId = section.dataset.filterList;
    const ul = $(listId);
    if (!ul) return;
    let visible = 0;

    [...ul.children].forEach((li) => {
      const placeholder = isDockPlaceholderItem(li);
      const hay = `${li.dataset?.name || ''} ${li.dataset?.search || ''} ${li.textContent || ''}`.toLowerCase();
      let show = true;
      if (q) show = !placeholder && hay.includes(q);
      li.style.display = show ? '' : 'none';
      if (show && !placeholder) visible += 1;
    });

    section.classList.toggle('sectionFilteredEmpty', !!q && visible === 0);
    if ((!q && ul.children.length > 0) || visible > 0) anyVisible = true;
  });

  const empty = UIState.activeTab === 'groups' ? $('groupsSearchEmpty') : $('friendsSearchEmpty');
  if (empty) empty.classList.toggle('hidden', !q || anyVisible);
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
  const ul = $('friendsList');
  if (!ul) return;
  ul.innerHTML = '';

  try {
    UIState.friendSet = new Set((Array.isArray(friends) ? friends : []).map(String));
  } catch {
    UIState.friendSet = new Set();
  }

  if (!friends || friends.length === 0) {
    UIState.friendSet = new Set();
    const li = document.createElement('li');
    li.dataset.name = 'empty';
    li.innerHTML = `<div class="liLeft"><span class="presDot offline"></span><span class="liAvatar">+</span><span class="liName muted">No friends yet</span></div>`;
    ul.appendChild(li);
    updateDockSummaryCounts();
    return;
  }

  friends.forEach(friend => {
    const p = UIState.presence.get(friend);
    const online = (p && typeof p === 'object') ? !!p.online : !!p;
    const presence = (p && typeof p === 'object') ? (p.presence || (online ? 'online' : 'offline')) : (online ? 'online' : 'offline');
    const customStatus = (p && typeof p === 'object') ? (p.custom_status || '') : '';

    const li = document.createElement('li');
    li.dataset.name = friend;
    li.dataset.search = `${friend} ${presence} ${customStatus}`;
    li.classList.add('friendItem', 'isInteractive');
    li.classList.toggle('offline', !online);

    const left = document.createElement('div');
    left.className = 'liLeft';
    const dotState = online ? ((presence === 'busy') ? 'busy' : ((presence === 'away') ? 'away' : 'online')) : 'offline';
    createDockIdentity(left, {
      name: friend,
      presenceClass: dotState,
      meta: customStatus || humanPresenceText(online, presence),
      chip: online ? 'Live' : ''
    });

    const showTooltip = !!UIState.prefs.friendStatusTooltip;
    if (showTooltip && customStatus) li.title = customStatus;

    const actions = document.createElement('div');
    actions.className = 'liActions';

    const chatBtn = document.createElement('button');
    chatBtn.className = 'iconBtn';
    chatBtn.title = 'Chat';
    chatBtn.textContent = '💬';
    chatBtn.onclick = (ev) => { ev.stopPropagation(); openPrivateChat(friend); };

    const blockBtn = document.createElement('button');
    blockBtn.className = 'iconBtn';
    blockBtn.title = 'Block';
    blockBtn.textContent = '🚫';
    blockBtn.onclick = (ev) => {
      ev.stopPropagation();
      socket.emit('block_user', { blocked: friend }, (res) => {
        toast(res?.success ? `🚫 Blocked ${friend}` : `❌ Block failed`, res?.success ? 'ok' : 'error');
        getBlockedUsers();
      });
    };

    actions.appendChild(chatBtn);
    actions.appendChild(blockBtn);

    li.appendChild(left);
    li.appendChild(actions);
    li.onclick = () => openPrivateChat(friend);
    li.ondblclick = () => openPrivateChat(friend);
    li.oncontextmenu = (ev) => showUserContextMenu(ev, friend, { source: 'friends' });

    ul.appendChild(li);
  });

  renderMissedPmList(UIState.missedPmSummary);
  updateDockSummaryCounts();
}

// ───────────────────────────────────────────────────────────────────────────────
// User right-click context menu + profile mini-window
// ───────────────────────────────────────────────────────────────────────────────
let EC_USER_CTX_MENU = null;

function ensureUserContextMenu() {
  if (EC_USER_CTX_MENU) return EC_USER_CTX_MENU;

  const menu = document.createElement("div");
  menu.id = "ecUserCtxMenu";
  menu.className = "ecCtxMenu hidden";
  menu.innerHTML = `
    <div class="ecCtxHeader">
      <span id="ecCtxUser" class="ecCtxUser">User</span>
    </div>
    <div class="ecCtxItem" data-action="pm">💬 <span>Send message</span></div>
    <div class="ecCtxItem" data-action="profile">👤 <span>View profile</span></div>
    <div class="ecCtxSep"></div>
    <div class="ecCtxItem" data-action="block">🚫 <span>Block</span></div>
    <div class="ecCtxItem" data-action="unblock">↩ <span>Unblock</span></div>
    <div class="ecCtxItem danger" data-action="removeFriend">🧹 <span>Remove friend</span></div>
  `;

  menu.addEventListener("contextmenu", (e) => {
    // Prevent the browser context menu on our context menu.
    try { e.preventDefault(); } catch {}
  });

  menu.addEventListener("click", (e) => {
    const item = e.target?.closest?.(".ecCtxItem");
    if (!item) return;
    const action = String(item.dataset.action || "");
    const u = String(menu.dataset.username || "");
    hideUserContextMenu();
    if (!action || !u) return;
    handleUserContextAction(action, u);
  });

  document.addEventListener("mousedown", (e) => {
    if (!EC_USER_CTX_MENU || EC_USER_CTX_MENU.classList.contains("hidden")) return;
    if (EC_USER_CTX_MENU.contains(e.target)) return;
    hideUserContextMenu();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") hideUserContextMenu();
  });

  window.addEventListener("blur", () => hideUserContextMenu());
  window.addEventListener("resize", () => hideUserContextMenu());
  document.addEventListener("scroll", () => hideUserContextMenu(), true);

  (document.body || document.documentElement).appendChild(menu);
  EC_USER_CTX_MENU = menu;
  return menu;
}

function hideUserContextMenu() {
  if (!EC_USER_CTX_MENU) return;
  EC_USER_CTX_MENU.classList.add("hidden");
  EC_USER_CTX_MENU.dataset.username = "";
}

function showUserContextMenu(ev, username, opts = {}) {
  const u = String(username || "").trim();
  if (!u) return;
  if (u === "empty" || u === "none") return;

  const menu = ensureUserContextMenu();
  const isSelf = (u === currentUser);
  const isFriend = !!(UIState.friendSet && UIState.friendSet.has(u));
  const isBlocked = !!(UIState.blockedSet && UIState.blockedSet.has(u));

  // Toggle items
  const pm = menu.querySelector('[data-action="pm"]');
  const prof = menu.querySelector('[data-action="profile"]');
  const block = menu.querySelector('[data-action="block"]');
  const unblock = menu.querySelector('[data-action="unblock"]');
  const rm = menu.querySelector('[data-action="removeFriend"]');
  if (pm) pm.style.display = isSelf ? "none" : "";
  if (prof) prof.style.display = "";
  if (block) block.style.display = (!isSelf && !isBlocked) ? "" : "none";
  if (unblock) unblock.style.display = (!isSelf && isBlocked) ? "" : "none";
  if (rm) rm.style.display = (!isSelf && isFriend) ? "" : "none";

  menu.dataset.username = u;
  const head = menu.querySelector("#ecCtxUser");
  if (head) head.textContent = u;

  // Position
  try {
    ev.preventDefault();
    ev.stopPropagation();
  } catch {}
  menu.classList.remove("hidden");

  // Must measure after visible.
  const pad = 8;
  const rect = menu.getBoundingClientRect();
  let left = Number(ev.clientX || 0);
  let top = Number(ev.clientY || 0);
  if (left + rect.width + pad > window.innerWidth) left = window.innerWidth - rect.width - pad;
  if (top + rect.height + pad > window.innerHeight) top = window.innerHeight - rect.height - pad;
  left = Math.max(pad, left);
  top = Math.max(pad, top);
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
}

function handleUserContextAction(action, username) {
  const u = String(username || "").trim();
  if (!u) return;

  if (action === "pm") {
    openPrivateChat(u);
    return;
  }
  if (action === "profile") {
    openProfileWindow(u);
    return;
  }
  if (action === "block") {
    if (u === currentUser) return;
    const ok = window.confirm(`Block ${u}?`);
    if (!ok) return;
    socket.emit("block_user", { blocked: u }, (res) => {
      toast(res?.success ? `🚫 Blocked ${u}` : `❌ ${res?.error || "Block failed"}`, res?.success ? "ok" : "error");
      getBlockedUsers();
    });
    return;
  }
  if (action === "unblock") {
    if (u === currentUser) return;
    socket.emit("unblock_user", { blocked: u }, (res) => {
      toast(res?.success ? `↩ Unblocked ${u}` : `❌ ${res?.error || "Unblock failed"}`, res?.success ? "ok" : "error");
      getBlockedUsers();
    });
    return;
  }
  if (action === "removeFriend") {
    if (u === currentUser) return;
    const ok = window.confirm(`Remove ${u} from your friends list?`);
    if (!ok) return;
    socket.emit("remove_friend", { friend: u }, (res) => {
      toast(res?.success ? `🧹 Removed ${u}` : `❌ ${res?.error || "Remove friend failed"}`, res?.success ? "ok" : "error");
      getFriends();
    });
    return;
  }
}

function _fmtLocalTime(ts) {
  try {
    if (!ts) return "";
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return String(ts);
    return d.toLocaleString();
  } catch {
    return ts ? String(ts) : "";
  }
}

function openProfileWindow(username) {
  const u = String(username || "").trim();
  if (!u) return;

  const id = "profile:" + u;
  const win = createWindow({ id, title: `Profile — ${u}`, kind: "room" });
  if (!win) return;

  // Make this window read-only: hide the composer row.
  try {
    const compose = win.querySelector(".ym-compose");
    if (compose) compose.style.display = "none";
  } catch {}

  // Tighter sizing for profile.
  try {
    if (!win.dataset.profileSized) {
      win.style.width = "420px";
      win.style.height = "360px";
      win.dataset.profileSized = "1";
    }
  } catch {}

  bringToFront(win);

  if (win._ym?.log) {
    win._ym.log.innerHTML = `
      <div class="ecProfileCard">
        <div class="ecProfileTitle">${escapeHtml(u)}</div>
        <div class="ecProfileMeta muted">Loading…</div>
      </div>
    `;
  }

  socket.emit("get_user_profile", { username: u }, (res) => {
    const log = win._ym?.log;
    if (!log) return;
    if (!res?.success || !res?.profile) {
      log.innerHTML = `
        <div class="ecProfileCard">
          <div class="ecProfileTitle">${escapeHtml(u)}</div>
          <div class="ecProfileMeta dangerText">${escapeHtml(res?.error || "Profile not available")}</div>
        </div>
      `;
      return;
    }

    const p = res.profile || {};
    const online = !!p.online;
    const pres = String(p.presence || (online ? "online" : "offline"));
    const custom = String(p.custom_status || "");
    const bio = String(p.bio || "");
    const avatar = p.avatar_url ? String(p.avatar_url) : "";
    const lastSeen = _fmtLocalTime(p.last_seen);
    const created = _fmtLocalTime(p.created_at);
    const isFriend = !!p.is_friend;
    const blockedByMe = !!p.blocked_by_me;
    const blocksMe = !!p.blocks_me;

    const presDot = online ? (pres === "busy" ? "busy" : (pres === "away" ? "away" : "online")) : "offline";

    log.innerHTML = `
      <div class="ecProfileCard">
        <div class="ecProfileTop">
          <div class="ecProfileAvatar">${avatar ? `<img src="${escapeHtml(avatar)}" alt="avatar">` : `<div class="ecAvatarStub">👤</div>`}</div>
          <div class="ecProfileTopText">
            <div class="ecProfileTitle">${escapeHtml(u)}</div>
            <div class="ecProfileMeta">
              <span class="presDot ${presDot}"></span>
              <span>${escapeHtml(online ? "Online" : "Offline")}</span>
              ${custom ? `<span class="muted">· ${escapeHtml(custom)}</span>` : ""}
            </div>
            ${(!online && lastSeen) ? `<div class="ecProfileMeta muted">Last seen: ${escapeHtml(lastSeen)}</div>` : ""}
            ${created ? `<div class="ecProfileMeta muted">Joined: ${escapeHtml(created)}</div>` : ""}
          </div>
        </div>

        ${bio ? `<div class="ecProfileBio">${escapeHtml(bio)}</div>` : `<div class="ecProfileBio muted">No bio</div>`}

        <div class="ecProfileBadges">
          ${isFriend ? `<span class="ecBadge">Friend</span>` : ""}
          ${blockedByMe ? `<span class="ecBadge danger">Blocked</span>` : ""}
          ${blocksMe ? `<span class="ecBadge warn">They blocked you</span>` : ""}
        </div>

        <div class="ecProfileActions">
          ${u !== currentUser ? `<button class="miniBtn" data-act="pm">💬 Message</button>` : ""}
          ${u !== currentUser && !blockedByMe ? `<button class="miniBtn danger" data-act="block">🚫 Block</button>` : ""}
          ${u !== currentUser && blockedByMe ? `<button class="miniBtn" data-act="unblock">↩ Unblock</button>` : ""}
          ${u !== currentUser && isFriend ? `<button class="miniBtn" data-act="removeFriend">🧹 Remove friend</button>` : ""}
        </div>
      </div>
    `;

    // Bind buttons inside the profile window.
    log.querySelectorAll("button[data-act]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const act = String(btn.getAttribute("data-act") || "");
        handleUserContextAction(act, u);
      });
    });
  });
}

// ───────────────────────────────────────────────────────────────────────────────
// Missed (offline) PM notifications
// - Only counts messages received while you were offline.
// - Clicking an item opens the DM window and pulls all currently missed PMs
//   from that sender (ciphertext-only from the server).
// ───────────────────────────────────────────────────────────────────────────────
let MISSED_SUMMARY_TOAST_ARMED = false;

/**
 * Apply a local delta to the missed PM summary list and re-render immediately.
 * This keeps the UI responsive while we wait for the server to push the updated summary.
 */
function consumeMissedPmLocal(sender, consumedCount) {
  if (!sender) return;
  const n = Number(consumedCount || 0) || 0;
  if (n <= 0) return;

  const list = Array.isArray(UIState.missedPmSummary) ? UIState.missedPmSummary.slice() : [];
  let changed = false;

  const next = [];
  for (const it of list) {
    if (!it || it.sender !== sender) {
      next.push(it);
      continue;
    }
    const cur = Number(it.count ?? 0) || 0;
    const remaining = Math.max(0, cur - n);
    changed = true;
    if (remaining > 0) next.push({ ...it, count: remaining });
    // if remaining == 0, drop the entry
  }

  if (changed) {
    UIState.missedPmSummary = next;
    renderMissedPmList(next);
  }
}

function dropMissedEntryLocal(sender) {
  if (!sender) return;
  const list = Array.isArray(UIState.missedPmSummary) ? UIState.missedPmSummary : [];
  const next = list.filter((it) => it && it.sender !== sender);
  if (next.length !== list.length) {
    UIState.missedPmSummary = next;
    renderMissedPmList(next);
  }
}

function getMissedCountFor(sender) {
  const list = Array.isArray(UIState.missedPmSummary) ? UIState.missedPmSummary : [];
  for (const it of list) {
    if (it && it.sender === sender) return Number(it.count ?? 0) || 0;
  }
  return 0;
}

function queuePendingOfflineDm(peer, msg) {
  if (!peer || !msg) return;
  const id = Number(msg.id || 0) || 0;
  if (id > 0) {
    if (UIState.pendingOfflineDmSeen.has(id)) return;
    UIState.pendingOfflineDmSeen.add(id);
  }
  const cur = UIState.pendingOfflineDm.get(peer) || [];
  cur.push({
    id: id || null,
    cipher: msg.cipher,
    ts: (typeof msg.ts === "number") ? msg.ts : null,
  });
  // Keep it bounded per peer to avoid runaway memory.
  UIState.pendingOfflineDm.set(peer, cur.slice(-200));
}

async function flushPendingOfflineDm(peer = null) {
  // Only attempt if we have a key.
  if (!window.myPrivateCryptoKey) return;
  const peers = peer ? [peer] : Array.from(UIState.pendingOfflineDm.keys());
  for (const p of peers) {
    const pending = UIState.pendingOfflineDm.get(p) || [];
    if (!pending.length) continue;

    const win = UIState.windows.get("dm:" + p);
    let processed = 0;
    const keep = [];
    for (const m of pending) {
      try {
        const cipher = m?.cipher;
        if (!cipher) continue;

        let plaintext;
        if (typeof cipher === "string" && cipher.startsWith(PM_PLAINTEXT_PREFIX)) {
          plaintext = unwrapPlainDm(cipher);
        } else if (typeof cipher === "string" && cipher.startsWith(PM_ENVELOPE_PREFIX)) {
          plaintext = await decryptHybridEnvelope(window.myPrivateCryptoKey, cipher);
        } else {
          plaintext = await decryptLegacyRSA(window.myPrivateCryptoKey, cipher);
        }

        const payload = parseDmPayload(plaintext);
        if (win) appendDmPayload(win, `${p}:`, payload, { peer: p, direction: "in" });

        const histText = (payload.kind === "file")
          ? `📎 ${payload.name} (${humanBytes(payload.size)})`
          : (payload.kind === "torrent")
            ? `🧲 ${payload?.t?.name || payload?.t?.infohash || "Torrent"}`
            : payload.text;

        addPmHistory(p, "in", histText, m?.ts);
        processed += 1;
      } catch (e) {
        keep.push(m);
      }
    }

    if (keep.length) UIState.pendingOfflineDm.set(p, keep);
    else UIState.pendingOfflineDm.delete(p);

    if (processed) toast(`🔓 Decrypted ${processed} pending PM(s) from ${p}`, "ok", 2200);
  }
}

async function consumeOfflinePmsForPeer(peer, { promptUnlock = false, quiet = false } = {}) {
  if (!peer) return;
  if (!socket) return;
  if (UIState.consumingOfflinePeers.has(peer)) return;
  UIState.consumingOfflinePeers.add(peer);

  try {
    // Optimistic UI: if the user opens the DM window, the missed entry should disappear immediately.
    dropMissedEntryLocal(peer);

    const res = await new Promise((resolve) => {
      try {
        socket.emit("fetch_offline_pms", { from_user: peer, peek: false }, (r) => resolve(r));
      } catch (e) {
        resolve(null);
      }
    });

    if (!res || !res.success) {
      if (!quiet) toast(`❌ ${res?.error || "Failed to fetch offline PMs"}`, "error");
      try { socket.emit("get_missed_pm_summary"); } catch {}
      return;
    }

    const msgs = Array.isArray(res.messages) ? res.messages : [];
    if (!msgs.length) {
      // Server may already have cleared the summary; still re-sync.
      try { socket.emit("get_missed_pm_summary"); } catch {}
      return;
    }

    // Ensure DM window exists.
    const win = UIState.windows.get("dm:" + peer) || openPrivateChat(peer);
    if (win) ensureDmHistoryRendered(win, peer);

    let privKey = window.myPrivateCryptoKey;
    let processed = 0;
    let failed = 0;

    // Try silent auto-unlock first (no modal pop unless explicitly requested).
    if (!privKey) {
      try {
        await tryAutoUnlockPrivateMessages("");
        privKey = window.myPrivateCryptoKey;
      } catch {}
    }

    for (const m of msgs) {
      const cipher = m?.cipher;
      const msgId = m?.id;
      const ts = (typeof m?.ts === "number") ? m.ts : null;
      if (!cipher || !msgId) continue;

      // Prevent duplicate processing if the server delivers the same IDs again.
      const mid = Number(msgId) || 0;
      if (mid > 0 && UIState.pendingOfflineDmSeen.has(mid)) continue;

      try {
        let plaintext;

        if (typeof cipher === "string" && cipher.startsWith(PM_PLAINTEXT_PREFIX)) {
          plaintext = unwrapPlainDm(cipher);
        } else {
          if (!privKey) {
            if (promptUnlock) {
              privKey = await ensurePrivateKeyUnlocked();
            } else {
              throw new Error("dm_locked");
            }
          }
          if (typeof cipher === "string" && cipher.startsWith(PM_ENVELOPE_PREFIX)) {
            plaintext = await decryptHybridEnvelope(privKey, cipher);
          } else {
            plaintext = await decryptLegacyRSA(privKey, cipher);
          }
        }

        const payload = parseDmPayload(plaintext);
        if (win) appendDmPayload(win, `${peer}:`, payload, { peer, direction: "in" });

        const histText = (payload.kind === "file")
          ? `📎 ${payload.name} (${humanBytes(payload.size)})`
          : (payload.kind === "torrent")
            ? `🧲 ${payload?.t?.name || payload?.t?.infohash || "Torrent"}`
            : payload.text;

        addPmHistory(peer, "in", histText, ts);
        processed += 1;
        if (mid > 0) UIState.pendingOfflineDmSeen.add(mid);
      } catch (e) {
        failed += 1;
        queuePendingOfflineDm(peer, { id: msgId, cipher, ts });
        if (win) {
          appendLine(win, "System:", "🔒 Missed message received (unlock DMs to view)", "system");
        }
      }
    }

    // If we prompted for unlock (or auto-unlock succeeded), attempt to decrypt any queued items.
    if (window.myPrivateCryptoKey) {
      try { await flushPendingOfflineDm(peer); } catch {}
    }

    if (!quiet) {
      if (processed) toast(`📥 Loaded ${processed} missed PM(s) from ${peer}`, "ok");
      if (failed) toast(`⚠️ ${failed} missed PM(s) pending DM unlock`, "warn", 4200);
    }
  } finally {
    UIState.consumingOfflinePeers.delete(peer);
    // Always re-sync; server is source of truth.
    try { socket.emit("get_missed_pm_summary"); } catch {}
  }
}


function renderMissedPmList(items) {
  const ul = $('missedPmList');
  if (!ul) return;
  ul.innerHTML = '';

  const list = Array.isArray(items) ? items : [];
  if (!list.length) {
    const li = document.createElement('li');
    li.dataset.name = 'empty';
    li.innerHTML = `<div class="liLeft"><span class="presDot offline"></span><span class="liAvatar">✉</span><span class="liName muted">No missed messages</span></div>`;
    ul.appendChild(li);
    updateDockSummaryCounts();
    return;
  }

  for (const it of list) {
    const sender = it?.sender;
    const count = Number(it?.count ?? 0) || 0;
    if (!sender || count <= 0) continue;

    const p = UIState.presence.get(sender);
    const online = (p && typeof p === 'object') ? !!p.online : !!p;
    const presence = (p && typeof p === 'object') ? (p.presence || (online ? 'online' : 'offline')) : (online ? 'online' : 'offline');

    const li = document.createElement('li');
    li.dataset.name = sender;
    li.dataset.search = `${sender} missed ${count} ${presence}`;
    li.classList.add('isInteractive');

    const left = document.createElement('div');
    left.className = 'liLeft';
    const dotState = online ? ((presence === 'busy') ? 'busy' : ((presence === 'away') ? 'away' : 'online')) : 'offline';
    createDockIdentity(left, {
      name: sender,
      presenceClass: dotState,
      meta: `${count} unread message${count === 1 ? '' : 's'}`
    });

    const badge = document.createElement('span');
    badge.className = 'liBadge';
    badge.textContent = String(count);

    const actions = document.createElement('div');
    actions.className = 'liActions';
    const openBtn = document.createElement('button');
    openBtn.className = 'iconBtn';
    openBtn.title = 'Open messages';
    openBtn.textContent = '💬';
    openBtn.onclick = (ev) => { ev.stopPropagation(); openMissedPmFrom(sender); };
    actions.appendChild(openBtn);

    li.appendChild(left);
    li.appendChild(badge);
    li.appendChild(actions);

    li.onclick = () => openMissedPmFrom(sender);
    li.ondblclick = () => openMissedPmFrom(sender);

    ul.appendChild(li);
  }

  updateDockSummaryCounts();
}

async function openMissedPmFrom(sender) {
  if (!sender) return;

  // If the user clicked a missed sender, treat that as intent to open the DM and consume
  // the offline queue immediately so the missed list clears.
  openPrivateChat(sender);
  await consumeOfflinePmsForPeer(sender, { promptUnlock: true, quiet: false });
}


// Server can push updated friends list at any time (e.g., friend accepted).
socket.on("friends_list", (friends) => {
  try {
    if (Array.isArray(friends)) updateFriendsListUI(friends);
  } catch (e) {}
});

socket.on("pending_friend_requests", (requests) => {
  const ul = $("pendingRequestsList");
  if (!ul) return;
  ul.innerHTML = "";
  UIState.pendingRequests = Array.isArray(requests) ? requests.slice() : [];

  if (!requests || requests.length === 0) {
    const li = document.createElement("li");
    li.dataset.name = "none";
    li.innerHTML = `<div class="liLeft"><span class="presDot offline"></span><span class="liAvatar">?</span><span class="liName muted">None</span></div>`;
    ul.appendChild(li);
    updateDockSummaryCounts();
    return;
  }

  requests.forEach(from_user => {
    const li = document.createElement("li");
    li.dataset.name = from_user;
    li.dataset.search = `${from_user} request friend invite`;
    li.classList.add('isInteractive');

    const left = document.createElement("div");
    left.className = "liLeft";
    createDockIdentity(left, {
      name: from_user,
      presenceClass: 'offline',
      meta: 'Incoming friend request',
      chip: 'New'
    });

    const actions = document.createElement("div");
    actions.className = "liActions";

    const yes = document.createElement("button");
    yes.className = "iconBtn";
    yes.textContent = "✅";
    yes.title = "Accept";
    yes.onclick = (ev) => {
      ev.stopPropagation();
      socket.emit("accept_friend_request", { from_user }, (res) => {
        if (res?.success) toast("✅ Friend request accepted", "ok");
        else toast("❌ Could not accept request", "error");
        getPendingFriendRequests();
        getFriends();
      });
    };

    const no = document.createElement("button");
    no.className = "iconBtn";
    no.textContent = "✖";
    no.title = "Reject";
    no.onclick = (ev) => {
      ev.stopPropagation();
      socket.emit("reject_friend_request", { from_user }, (res) => {
        if (res?.success) toast("Rejected", "warn");
        else toast("❌ Could not reject request", "error");
        getPendingFriendRequests();
      });
    };

    actions.appendChild(yes);
    actions.appendChild(no);

    li.appendChild(left);
    li.appendChild(actions);
    li.onclick = () => openProfileWindow(from_user);
    ul.appendChild(li);
  });

  updateDockSummaryCounts();
});

socket.on("blocked_users_list", (users) => {
  try { UIState.blockedSet = new Set((Array.isArray(users) ? users : []).map(String)); } catch { UIState.blockedSet = new Set(); }
  const ul = $("blockedUsersList");
  if (!ul) return;
  ul.innerHTML = "";

  if (!users || users.length === 0) {
    UIState.blockedSet = new Set();
    const li = document.createElement("li");
    li.dataset.name = "none";
    li.innerHTML = `<div class="liLeft"><span class="presDot offline"></span><span class="liAvatar">-</span><span class="liName muted">None</span></div>`;
    ul.appendChild(li);
    updateDockSummaryCounts();
    return;
  }

  users.forEach(u => {
    const li = document.createElement("li");
    li.dataset.name = u;
    li.dataset.search = `${u} blocked`;

    const left = document.createElement("div");
    left.className = "liLeft";
    createDockIdentity(left, {
      name: u,
      presenceClass: 'busy',
      meta: 'Blocked contact',
      chip: 'Blocked'
    });

    const actions = document.createElement("div");
    actions.className = "liActions";

    const unblock = document.createElement("button");
    unblock.className = "iconBtn";
    unblock.textContent = "↩";
    unblock.title = "Unblock";
    unblock.onclick = (ev) => {
      ev.stopPropagation();
      socket.emit("unblock_user", { blocked: u }, (res) => {
        toast(res?.success ? `Unblocked ${u}` : "❌ Unblock failed", res?.success ? "ok" : "error");
        getBlockedUsers();
      });
    };

    actions.appendChild(unblock);

    li.appendChild(left);
    li.appendChild(actions);
    ul.appendChild(li);
  });

  updateDockSummaryCounts();
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
  if (sel && p.presence) {
    sel.value = p.presence;
    try { window.__ym_lastPresence = p.presence; } catch (_) {}
  }
  try {
    window.__ym_lastCustomStatus = (p.custom_status || "");
    const disp = $("meCustomDisplay");
    if (disp) {
      const t = (p.custom_status || "").trim();
      disp.textContent = t ? `“${t}”` : "";
      disp.style.display = t ? "block" : "none";
    }
  } catch (_) {}
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
  // UI-only filters/sort (no server dependency)
  catQuery: "",
  roomQuery: "",
  customQuery: "",
  roomsSort: "active", // active | az
  customSort: "active", // active | az
  customFilter: "all", // all | public | private | mine
  hideEmpty: false,
  collapsedCats: new Set(),
  started: false,
};

function rbNorm(s) {
  return String(s || "").toLowerCase();
}

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

  const cnt = ROOM_BROWSER.counts.get(roomName) || (meta ? Number(meta.member_count || 0) : 0) || 0;

  // Flags (private/18+/nsfw)
  const flags = [];
  if (meta && meta.is_private) flags.push('🔒');
  if (meta && meta.is_18_plus) flags.push('🔞');
  if (meta && meta.is_nsfw) flags.push('⚠️');
  li.dataset.flagsSuffix = flags.length ? '  ' + flags.join(' ') : '';

  // Left side (icon + name/meta)
  const left = document.createElement('div');
  left.className = 'rbItemLeft';

  const icon = document.createElement('div');
  icon.className = 'rbIcon';
  if (!isCustom) icon.textContent = '#';
  else icon.textContent = (meta && meta.is_private) ? '🔒' : '🌐';

  const text = document.createElement('div');
  text.className = 'rbItemText';

  const nameRow = document.createElement('div');
  nameRow.className = 'rbItemNameRow';
  const nm = document.createElement('div');
  nm.className = 'rbItemName';
  nm.textContent = roomName;
  nameRow.appendChild(nm);

  if (flags.length) {
    const fl = document.createElement('span');
    fl.className = 'rbFlags';
    fl.textContent = flags.join(' ');
    nameRow.appendChild(fl);
  }

  const mt = document.createElement('div');
  mt.className = 'rbItemMeta';
  const byMe = (isCustom && meta && meta.created_by === currentUser) ? ' · by you' : '';
  li.dataset.metaSuffix = byMe;
  mt.textContent = `${cnt} online${byMe}`;

  text.appendChild(nameRow);
  text.appendChild(mt);
  left.appendChild(icon);
  left.appendChild(text);

  // Right side (badge + actions)
  const right = document.createElement('div');
  right.className = 'rbBtns';

  const badge = document.createElement('span');
  badge.className = 'rbBadge' + (cnt <= 0 ? ' zero' : '');
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

function rbApplyRoomCounts(countsObj) {
  if (!countsObj || typeof countsObj !== 'object') return;
  const m = new Map();
  try {
    Object.entries(countsObj).forEach(([k, v]) => {
      const n = Number(v || 0) || 0;
      if (k) m.set(String(k), n);
    });
  } catch {}
  ROOM_BROWSER.counts = m;
  rbUpdateCountsInDom();
}

function rbUpdateCountsInDom() {
  const lists = [$('rbOfficialRooms'), $('rbCustomRooms')];
  lists.forEach((ul) => {
    if (!ul) return;
    try {
      ul.querySelectorAll('li[data-room]').forEach((li) => {
        const room = li.dataset.room;
        const cnt = ROOM_BROWSER.counts.get(room) || 0;
        const badge = li.querySelector('.rbBadge');
        if (badge) {
          badge.textContent = String(cnt);
          badge.classList.toggle('zero', cnt <= 0);
        }
        const mt = li.querySelector('.rbItemMeta');
        if (mt) mt.textContent = `${cnt} online${li.dataset.metaSuffix || ''}`;
      });
    } catch {}
  });
}


function rbRenderCategoryTree() {
  const ul = $('rbCategoryTree');
  if (!ul) return;
  ul.innerHTML = '';

  const q = rbNorm(ROOM_BROWSER.catQuery);
  const cats = (ROOM_BROWSER.catalog && ROOM_BROWSER.catalog.categories) ? ROOM_BROWSER.catalog.categories : [];
  cats.forEach((c) => {
    const cName = String(c.name || '').trim();
    if (!cName) return;
    const subs = Array.isArray(c.subcategories) ? c.subcategories : [];

    // Filter logic (search): show category if it matches, or any subcategory matches
    let matchingSubs = subs;
    const catMatches = q ? rbNorm(cName).includes(q) : true;
    if (q) matchingSubs = subs.filter((s) => rbNorm(s?.name || '').includes(q) || catMatches);
    if (q && !catMatches && !matchingSubs.length) return;

    const collapsed = (!q) && ROOM_BROWSER.collapsedCats.has(cName);

    const header = document.createElement('li');
    header.className = 'rbCatHeader';
    header.dataset.category = cName;
    const row = document.createElement('div');
    row.className = 'rbCatHeadRow';
    const title = document.createElement('span');
    title.textContent = cName;
    const chev = document.createElement('span');
    chev.className = 'rbCatChevron';
    chev.textContent = collapsed ? '▸' : '▾';
    row.appendChild(title);
    row.appendChild(chev);
    header.appendChild(row);
    header.addEventListener('click', () => {
      if (q) return; // when searching, keep categories expanded
      if (ROOM_BROWSER.collapsedCats.has(cName)) ROOM_BROWSER.collapsedCats.delete(cName);
      else ROOM_BROWSER.collapsedCats.add(cName);
      rbRenderCategoryTree();
    });
    ul.appendChild(header);

    if (collapsed) return;

    matchingSubs.forEach((s) => {
      const sName = String(s?.name || '').trim();
      if (!sName) return;
      const li = document.createElement('li');
      li.className = 'rbCatSub';
      li.dataset.category = cName;
      li.dataset.subcategory = sName;
      li.textContent = sName;
      const active = (ROOM_BROWSER.selectedCategory === cName && ROOM_BROWSER.selectedSubcategory === sName);
      if (active) li.classList.add('active');
      li.addEventListener('click', async () => {
        const prevCategory = String(ROOM_BROWSER.selectedCategory || '');
        const prevSubcategory = String(ROOM_BROWSER.selectedSubcategory || '');
        ROOM_BROWSER.selectedCategory = cName;
        ROOM_BROWSER.selectedSubcategory = sName;
        if (prevCategory !== cName || prevSubcategory !== sName) {
          clearRoomBrowserSearchesForPanelSwitch();
        }
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

  // ── Official rooms ───────────────────────────────────────────────────────
  const qRoom = rbNorm(ROOM_BROWSER.roomQuery);
  const hideEmpty = !!ROOM_BROWSER.hideEmpty;
  const officialRooms = (rbRoomsForSelection() || []).map((name) => {
    const nm = String(name || '');
    return { name: nm, cnt: (ROOM_BROWSER.counts.get(nm) || 0) };
  }).filter((r) => {
    if (!r.name) return false;
    if (qRoom && !rbNorm(r.name).includes(qRoom)) return false;
    if (hideEmpty && (r.cnt <= 0)) return false;
    return true;
  });

  if (ROOM_BROWSER.roomsSort === 'az') {
    officialRooms.sort((a, b) => a.name.localeCompare(b.name));
  } else {
    officialRooms.sort((a, b) => (b.cnt - a.cnt) || a.name.localeCompare(b.name));
  }

  if (!officialRooms.length) {
    const li = document.createElement('li');
    li.style.cursor = 'default';
    li.innerHTML = `<div class="rbItemLeft"><div class="rbItemText"><div class="rbItemName muted">${(qRoom || hideEmpty) ? 'No matches' : 'No rooms'}</div></div></div>`;
    off.appendChild(li);
  } else {
    officialRooms.forEach((r) => off.appendChild(rbMakeRoomLi(r.name)));
  }

  // ── Custom rooms ─────────────────────────────────────────────────────────
  const qCustom = rbNorm(ROOM_BROWSER.customQuery);
  const filter = String(ROOM_BROWSER.customFilter || 'all');
  const customRooms = (ROOM_BROWSER.customRooms || []).filter((r) => (r && r.name));

  let customRows = customRooms.map((r) => {
    const nm = String(r.name);
    const cnt = (ROOM_BROWSER.counts.get(nm) || Number(r.member_count || 0) || 0);
    return { name: nm, meta: r, cnt };
  }).filter((row) => {
    const r = row.meta;
    if (qCustom && !rbNorm(row.name).includes(qCustom)) return false;
    if (filter === 'public' && r.is_private) return false;
    if (filter === 'private' && !r.is_private) return false;
    if (filter === 'mine' && String(r.created_by || '') !== String(currentUser || '')) return false;
    return true;
  });

  if (ROOM_BROWSER.customSort === 'az') {
    customRows.sort((a, b) => a.name.localeCompare(b.name));
  } else {
    customRows.sort((a, b) => (b.cnt - a.cnt) || a.name.localeCompare(b.name));
  }

  const priv = customRows.filter((x) => !!x.meta?.is_private);
  const pub = customRows.filter((x) => !x.meta?.is_private);

  const addGroupHeader = (label) => {
    const li = document.createElement('li');
    li.className = 'rbGroupHeader';
    li.textContent = label;
    cust.appendChild(li);
  };

  if (!customRows.length) {
    const li = document.createElement('li');
    li.style.cursor = 'default';
    li.innerHTML = `<div class="rbItemLeft"><div class="rbItemText"><div class="rbItemName muted">${(qCustom || filter !== 'all') ? 'No matches' : 'No custom rooms'}</div><div class="rbItemMeta muted">Use “Create Room” to make one.</div></div></div>`;
    cust.appendChild(li);
  } else {
    if (filter === 'private' || filter === 'mine') {
      // In these modes, grouping is less useful—render as-is
      customRows.forEach((r) => cust.appendChild(rbMakeRoomLi(r.name, { isCustom: true, meta: r.meta })));
    } else {
      if (priv.length) {
        addGroupHeader('Private');
        priv.forEach((r) => cust.appendChild(rbMakeRoomLi(r.name, { isCustom: true, meta: r.meta })));
      }
      if (pub.length) {
        addGroupHeader('Public');
        pub.forEach((r) => cust.appendChild(rbMakeRoomLi(r.name, { isCustom: true, meta: r.meta })));
      }
    }
  }
}

async function rbRefreshLists() {
  await rbLoadCounts();
  await rbLoadCustomRooms();
  rbRenderRoomLists();
}

function rbOpenModal(id) {
  clearSearchesForModalTransition();
  const el = $(id);
  if (el) el.classList.remove('hidden');
}
function rbCloseModal(id) {
  const el = $(id);
  if (el) el.classList.add('hidden');
  clearSearchesForModalTransition();
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
    let existing = null;
    try {
      const j = await resp.json();
      if (j && j.error) msg = j.error;
      if (j && j.existing) existing = j.existing;
    } catch {}
    toast(`❌ ${msg}`, 'error');

    // Helpful UX: if the room already exists under a different category/subcategory,
    // jump the room browser to that location so the user can see it immediately.
    try {
      if (existing && existing.category && existing.subcategory) {
        ROOM_BROWSER.selectedCategory = String(existing.category);
        ROOM_BROWSER.selectedSubcategory = String(existing.subcategory);
        rbRenderCategoryTree();
        await rbRefreshLists();
      }
    } catch {}

    return;
  }
  toast(`✅ Room created: ${name}`, 'ok');
  rbCloseModal('createRoomModal');
  ROOM_BROWSER.selectedCategory = category;
  ROOM_BROWSER.selectedSubcategory = subcategory;
  rbRenderCategoryTree();
  await rbRefreshLists();

  // Room browser controls (search/filter/sort)
  const catSearch = $('rbCatSearch');
  if (catSearch) {
    catSearch.value = ROOM_BROWSER.catQuery || '';
    catSearch.addEventListener('input', () => {
      ROOM_BROWSER.catQuery = catSearch.value || '';
      rbRenderCategoryTree();
    });
  }

  const roomSearch = $('rbRoomSearch');
  if (roomSearch) {
    roomSearch.value = ROOM_BROWSER.roomQuery || '';
    roomSearch.addEventListener('input', () => {
      ROOM_BROWSER.roomQuery = roomSearch.value || '';
      rbRenderRoomLists();
      rbUpdateCountsInDom();
    });
  }

  const roomSort = $('rbRoomSort');
  if (roomSort) {
    roomSort.value = ROOM_BROWSER.roomsSort || 'active';
    roomSort.addEventListener('change', () => {
      ROOM_BROWSER.roomsSort = roomSort.value || 'active';
      rbRenderRoomLists();
      rbUpdateCountsInDom();
    });
  }

  const hideEmpty = $('rbHideEmpty');
  if (hideEmpty) {
    hideEmpty.checked = !!ROOM_BROWSER.hideEmpty;
    hideEmpty.addEventListener('change', () => {
      ROOM_BROWSER.hideEmpty = !!hideEmpty.checked;
      rbRenderRoomLists();
      rbUpdateCountsInDom();
    });
  }

  const customSearch = $('rbCustomSearch');
  if (customSearch) {
    customSearch.value = ROOM_BROWSER.customQuery || '';
    customSearch.addEventListener('input', () => {
      ROOM_BROWSER.customQuery = customSearch.value || '';
      rbRenderRoomLists();
      rbUpdateCountsInDom();
    });
  }

  const customFilter = $('rbCustomFilter');
  if (customFilter) {
    customFilter.value = ROOM_BROWSER.customFilter || 'all';
    customFilter.addEventListener('change', () => {
      ROOM_BROWSER.customFilter = customFilter.value || 'all';
      rbRenderRoomLists();
      rbUpdateCountsInDom();
    });
  }

  const customSort = $('rbCustomSort');
  if (customSort) {
    customSort.value = ROOM_BROWSER.customSort || 'active';
    customSort.addEventListener('change', () => {
      ROOM_BROWSER.customSort = customSort.value || 'active';
      rbRenderRoomLists();
      rbUpdateCountsInDom();
    });
  }
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

  rbStartPolling();
}


function rbStartPolling() {
  if (!ROOM_BROWSER.started) return;
  if (ROOM_BROWSER._pollTimer) return;
  ROOM_BROWSER._pollTimer = setInterval(() => {
    if (typeof AUTH_EXPIRED !== 'undefined' && AUTH_EXPIRED) return;
    rbRefreshLists().catch(() => {});
  }, 15_000);
}

function rbStopPolling() {
  try {
    if (ROOM_BROWSER && ROOM_BROWSER._pollTimer) {
      clearInterval(ROOM_BROWSER._pollTimer);
      ROOM_BROWSER._pollTimer = null;
    }
  } catch {}
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
  if (pane._ym?.log) resetChatLogState(pane._ym.log);
  if (pane._ym) pane._ym.msgIndex = new Map();
  // Server emits join notifications (e.g., "user has entered room").

  // Wire send
  const sendFn = async () => {
    const msg = pane._ym?.input?.value?.trim() || "";
    if (!msg) return;

    // Slash command: /invite <username>
    // Sends an invite notification to the target user without posting into chat.
    if (/^\/invite(\s|$)/i.test(msg)) {
      const rest = msg.replace(/^\/invite\s*/i, "").trim();
      const raw = (rest.split(/\s+/)[0] || "").trim();
      const u = raw.replace(/^@/, "");
      if (!u) {
        toast("Usage: /invite <username>", "info", 6000);
        return;
      }
      try {
        await apiJson("/api/rooms/invite", {
          method: "POST",
          body: JSON.stringify({ room, invitee: u })
        });
        toast(`✅ Invited ${u} to ${room}`, "ok");
        if (pane._ym?.input) pane._ym.input.value = "";
      } catch (e) {
        toast(`❌ ${e.message}`, "error");
      }
      return;
    }

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
        if (LIVEKIT_ENABLED) {
          await lkToggleForRoom(room);
          return;
        }
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
        if (LIVEKIT_ENABLED) {
          lkToggleMic();
          return false;
        }
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

// Server hint that room inventory changed (autoscaled room created/deleted).
socket.on("rooms_changed", (_payload) => {
  try {
    getRooms();
    if (typeof rbRefreshLists === "function") rbRefreshLists();
  } catch (e) {}
});

socket.on("room_counts", (payload) => {
  try {
    if (payload && payload.counts) rbApplyRoomCounts(payload.counts);
  } catch (e) {}
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
        const joinedRoom = String(res?.room || room);
        UIState.currentRoom = joinedRoom;
        const roomToJoin = $("roomToJoin");
        if (roomToJoin) roomToJoin.value = joinedRoom;

        // Persist for reconnect/session restore (per-tab).
        try {
          sessionStorage.setItem("echochat_last_room", String(joinedRoom));
          sessionStorage.setItem("echochat_last_room_set_at", String(Date.now()));
        } catch (e) {}

        if (!silent && !restore) {
          if (joinedRoom !== room) toast(`🚪 ${room} full — joined: ${joinedRoom}`, "ok");
          else toast(`🚪 Joined room: ${joinedRoom}`, "ok");
        }
        openRoomEmbedded(joinedRoom);

        // If the server returned room history, render it now (ciphertext stays E2EE; client decrypts locally).
        try {
          const hist = Array.isArray(res?.history) ? res.history : [];
          const view = getActiveRoomView(joinedRoom);
          if (view && hist.length) {
            resetChatLogState(view._ym.log);
            view._ym.msgIndex = new Map();

            for (const item of hist) {
              const payload = { room: joinedRoom, ...item };

              // Decrypt room envelope history if applicable.
              if (payload.cipher && typeof payload.cipher === "string" && payload.cipher.startsWith(ROOM_ENVELOPE_PREFIX)) {
                // Try to auto-unlock using the per-tab stored password (if available),
                // then decrypt with our private key. If we can't, keep a clear placeholder.
                if (HAS_WEBCRYPTO) {
                  try { if (!window.myPrivateCryptoKey) await tryAutoUnlockPrivateMessages(""); } catch (e) {}
                }
                if (HAS_WEBCRYPTO && window.myPrivateCryptoKey) {
                  try {
                    const dec = await decryptRoomEnvelope(window.myPrivateCryptoKey, payload.cipher);
                    if (dec) payload.message = dec;
                  } catch (e) {
                    // Keep placeholder from server if decryption fails (e.g., keys rotated).
                    payload.message = payload.message || "🔒 Encrypted message";
                  }
                } else {
                  payload.message = "🔒 Encrypted message (unlock to read)";
                }
                payload.encrypted = true;
              }

              appendRoomMessage(view, payload);
            }

            appendLine(view, "System:", "History loaded.");
          }
        } catch (e) {
          // ignore
        }

        getUsersInRoom(joinedRoom);
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

socket.on("room_users", (payload) => {
  const room = typeof payload === "object" && payload ? String(payload.room || "") : "";
  const users = Array.isArray(payload) ? payload : (Array.isArray(payload?.users) ? payload.users : []);
  try {
    const cur = UIState.currentRoom;
    if (cur && (!room || room === cur)) UIState.roomUsers.set(cur, users);
    const waiters = _roomUsersWaiters.slice();
    _roomUsersWaiters = [];
    waiters.forEach(w => { try { w(users); } catch {} });
  } catch {}
  // If server sent a room name and it isn't the active room, ignore UI render.
  if (room && UIState.currentRoom && room !== UIState.currentRoom) return;
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

    // Right-click context menu
    li.oncontextmenu = (ev) => showUserContextMenu(ev, u, { source: "room" });

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

    // Slash command: /invite <username>
    if (/^\/invite(\s|$)/i.test(msg)) {
      const rest = msg.replace(/^\/invite\s*/i, "").trim();
      const raw = (rest.split(/\s+/)[0] || "").trim();
      const u = raw.replace(/^@/, "");
      if (!u) return toast("Usage: /invite <username>", "info", 6000);
      apiJson("/api/rooms/invite", { method: "POST", body: JSON.stringify({ room, invitee: u }) })
        .then(() => {
          toast(`✅ Invited ${u} to ${room}`, "ok");
          win._ym.input.value = "";
        })
        .catch((e) => toast(`❌ ${e.message}`, "error"));
      return;
    }

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
  // Server emits join notifications (e.g., "user has entered room").
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
let EC_LAST_STR_NOTIF = { msg: "", ts: 0 };
socket.on("notification", (payload) => {
  // payload can be {room, message} or sometimes string
  if (typeof payload === "string") {
    const msg = (payload || "").trim();
    // Suppress noisy self-presence strings (may be emitted during reconnect)
    if (currentUser && (msg === `${currentUser} connected` || msg === `${currentUser} disconnected`)) return;
    const now = Date.now();
    if (EC_LAST_STR_NOTIF.msg === msg && (now - EC_LAST_STR_NOTIF.ts) < 5000) return;
    EC_LAST_STR_NOTIF = { msg, ts: now };
    toast(msg || payload, "info");
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
  const ul = $('groupList');
  if (!ul) return;
  ul.innerHTML = '';

  try {
    const data = await apiJson('/api/groups/mine', { method: 'GET' });
    const groups = data.groups || [];
    UIState.myGroups = Array.isArray(groups) ? groups.slice() : [];
    if (groups.length === 0) {
      const li = document.createElement('li');
      li.dataset.name = 'none';
      li.innerHTML = `<div class="liLeft"><span class="presDot offline"></span><span class="liAvatar">#</span><span class="liName muted">No groups yet</span></div>`;
      ul.appendChild(li);
      updateDockSummaryCounts();
      return;
    }

    groups.forEach(g => {
      const gid = String(g.id);
      const gname = String(g.group_name || gid);
      const li = document.createElement('li');
      li.dataset.name = gname;
      li.dataset.search = `${gname} ${gid} group`;
      li.classList.add('isInteractive');

      const left = document.createElement('div');
      left.className = 'liLeft';
      createDockIdentity(left, {
        name: gname,
        presenceClass: 'online',
        meta: `Group chat · ID #${gid}`,
        chip: 'Group'
      });

      const actions = document.createElement('div');
      actions.className = 'liActions';

      const openBtn = document.createElement('button');
      openBtn.className = 'iconBtn';
      openBtn.textContent = '💬';
      openBtn.title = 'Open';
      openBtn.onclick = (ev) => { ev.stopPropagation(); openGroupWindow(gid, gname); };

      const inviteBtn = document.createElement('button');
      inviteBtn.className = 'iconBtn';
      inviteBtn.textContent = '➕';
      inviteBtn.title = 'Invite user';
      inviteBtn.onclick = async (ev) => {
        ev.stopPropagation();
        const u = prompt('Invite which username?');
        if (!u) return;
        try {
          await apiJson(`/api/groups/${encodeURIComponent(g.id)}/invite`, { method: 'POST', body: JSON.stringify({ to_user: u.trim() }) });
          toast('✅ Invite sent', 'ok');
          await refreshGroupInvites();
        } catch (e) {
          toast(`❌ ${e.message}`, 'error');
        }
      };

      const leaveBtn = document.createElement('button');
      leaveBtn.className = 'iconBtn';
      leaveBtn.textContent = '🚪';
      leaveBtn.title = 'Leave group';
      leaveBtn.onclick = async (ev) => {
        ev.stopPropagation();
        if (!confirm(`Leave group "${gname}"?`)) return;
        try {
          await apiJson(`/api/groups/${encodeURIComponent(g.id)}/leave`, { method: 'POST', body: JSON.stringify({}) });
          toast('Left group', 'info');
          await refreshMyGroups();
        } catch (e) {
          toast(`❌ ${e.message}`, 'error');
        }
      };

      actions.appendChild(openBtn);
      actions.appendChild(inviteBtn);
      actions.appendChild(leaveBtn);

      li.appendChild(left);
      li.appendChild(actions);
      li.onclick = () => openGroupWindow(gid, gname);
      li.ondblclick = () => openGroupWindow(gid, gname);

      ul.appendChild(li);
    });
    updateDockSummaryCounts();
  } catch (e) {
    console.error(e);
    UIState.myGroups = [];
    const li = document.createElement('li');
    li.dataset.name = 'error';
    li.innerHTML = `<div class="liLeft"><span class="presDot busy"></span><span class="liAvatar">!</span><span class="liName muted">Could not load groups</span></div>`;
    ul.appendChild(li);
    updateDockSummaryCounts();
  }
}

// Custom private-room invites (room browser feature)
async function refreshCustomRoomInvites() {
  try {
    const data = await apiJson("/api/custom_rooms/invites", { method: "GET" });
    const invites = Array.isArray(data?.invites) ? data.invites : [];
    invites.forEach((inv) => {
      try { showRoomInviteToast(inv?.room, inv?.by); } catch {}
    });
  } catch (e) {
    // ignore
  }
}

// Generic room invites (official/public rooms)
async function refreshRoomInvites() {
  try {
    const data = await apiJson("/api/rooms/invites", { method: "GET" });
    const invites = Array.isArray(data?.invites) ? data.invites : [];
    invites.forEach((inv) => {
      try { showRoomInviteToast(inv?.room, inv?.by); } catch {}
    });
  } catch (e) {
    // ignore
  }
}

async function refreshGroupInvites() {
  const ul = $('groupInviteList');
  if (!ul) return;
  ul.innerHTML = '';

  try {
    const data = await apiJson('/api/groups/invites', { method: 'GET' });
    const invites = data.invites || [];
    UIState.groupInvites = Array.isArray(invites) ? invites.slice() : [];
    if (invites.length === 0) {
      const li = document.createElement('li');
      li.dataset.name = 'none';
      li.innerHTML = `<div class="liLeft"><span class="presDot offline"></span><span class="liAvatar">#</span><span class="liName muted">No invites</span></div>`;
      ul.appendChild(li);
      updateDockSummaryCounts();
      return;
    }

    invites.forEach(inv => {
      const label = String(inv.group_name || inv.group_id);
      const li = document.createElement('li');
      li.dataset.name = `${label}`;
      li.dataset.search = `${label} ${inv.group_id} ${inv.from_user} invite`;
      li.classList.add('isInteractive');

      const left = document.createElement('div');
      left.className = 'liLeft';
      createDockIdentity(left, {
        name: label,
        presenceClass: 'away',
        meta: `Invited by ${inv.from_user} · Group #${inv.group_id}`,
        chip: 'Invite'
      });

      const actions = document.createElement('div');
      actions.className = 'liActions';

      const acceptBtn = document.createElement('button');
      acceptBtn.className = 'iconBtn';
      acceptBtn.textContent = '✅';
      acceptBtn.title = 'Accept';
      acceptBtn.onclick = async (ev) => {
        ev.stopPropagation();
        try {
          await apiJson(`/api/groups/${encodeURIComponent(inv.group_id)}/accept`, { method: 'POST', body: JSON.stringify({}) });
          toast('✅ Joined group', 'ok');
          await refreshGroupInvites();
          await refreshMyGroups();
        } catch (e) {
          toast(`❌ ${e.message}`, 'error');
        }
      };

      const declineBtn = document.createElement('button');
      declineBtn.className = 'iconBtn';
      declineBtn.textContent = '❌';
      declineBtn.title = 'Decline';
      declineBtn.onclick = async (ev) => {
        ev.stopPropagation();
        try {
          await apiJson(`/api/groups/${encodeURIComponent(inv.group_id)}/decline`, { method: 'POST', body: JSON.stringify({}) });
          toast('Declined', 'info');
          await refreshGroupInvites();
        } catch (e) {
          toast(`❌ ${e.message}`, 'error');
        }
      };

      actions.appendChild(acceptBtn);
      actions.appendChild(declineBtn);

      li.appendChild(left);
      li.appendChild(actions);
      ul.appendChild(li);
    });
    updateDockSummaryCounts();
  } catch (e) {
    UIState.groupInvites = [];
    toast(`❌ ${e.message}`, 'error');
    updateDockSummaryCounts();
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


async function appendGroupHistory(win, hist) {
  const log = win?._ym?.log;
  if (!log) return;
  const id = String(win?._ym?.id || "");
  const gid = id.startsWith("group:") ? Number(id.split(":")[1]) : null;

  for (const m of (hist || [])) {
    const sender = String(m?.sender || "?");
    const ts = m?.timestamp || m?.ts || null;
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
      appendFileLine(win, `${sender}:`, parsed, { peer: gid ? `group:${gid}` : null, direction: "in", ts });
    } else if (parsed && typeof parsed === "object" && parsed.kind === "torrent") {
      appendTorrentLine(win, `${sender}:`, parsed.t || parsed, { peer: gid ? `group:${gid}` : null, direction: "in", ts });
    } else {
      appendLine(win, `${sender}:`, msgForUi, { ts });
    }
  }
  scheduleScrollLogToBottom(log);
}


async function insertGroupHistoryAtTop(win, hist) {
  const log = win?._ym?.log;
  if (!log) return;

  const id = String(win?._ym?.id || "");
  const gid = id.startsWith("group:") ? Number(id.split(":")[1]) : null;

  const beforeH = log.scrollHeight;
  const beforeTop = log.scrollTop;

  const temp = document.createElement("div");
  for (const m of (hist || [])) {
    const sender = String(m?.sender || "?");
    const ts = m?.timestamp || m?.ts || null;
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
      appendGenericMessageItem(temp, `${sender}:`, buildFileCardElement(parsed, { peer: gid ? `group:${gid}` : null, direction: "in" }), { ts, kind: "file" });
    } else if (parsed && typeof parsed === "object" && parsed.kind === "torrent") {
      appendGenericMessageItem(temp, `${sender}:`, buildTorrentCard(parsed.t || parsed), { ts, kind: "torrent" });
    } else {
      appendGenericMessageItem(temp, `${sender}:`, buildTextMessageBody(msgForUi), { ts, kind: parseGifMarker(msgForUi) ? "gif" : "text" });
    }
  }

  const first = log.firstElementChild;
  const incomingLastDate = temp._ecChatUi?.lastDateKey || null;
  if (incomingLastDate && first?.classList?.contains("ec-dateSep") && first.dataset?.dateKey === incomingLastDate) {
    try { first.remove(); } catch {}
  }

  while (temp.firstChild) {
    log.insertBefore(temp.firstChild, log.firstChild);
  }

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
        resetChatLogState(win._ym.log);
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

  // If this DM window is open, the missed-messages sidebar should not keep showing this peer.
  // Consume any offline queue for this peer (quietly; no modal prompts here).
  try {
    consumeOfflinePmsForPeer(username, { promptUnlock: false, quiet: true });
  } catch (e) {}

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
  // Slash command: /invite <username>
  // This must never be broadcast into chat history; it triggers an invite notification only.
  try {
    const raw = (typeof plaintext === 'string') ? plaintext : String(plaintext ?? '');
    const t = raw.trim();
    if (/^\/invite(\s|$)/i.test(t)) {
      const rest = t.replace(/^\/invite\s*/i, '').trim();
      const u = ((rest.split(/\s+/)[0] || '').trim()).replace(/^@/, '');
      if (!u) return { success: false, error: 'Usage: /invite <username>' };
      try {
        await apiJson('/api/rooms/invite', { method: 'POST', body: JSON.stringify({ room, invitee: u }) });
        toast(`✅ Invited ${u} to ${room}`, 'ok');
        return { success: true, command: 'invite' };
      } catch (e) {
        return { success: false, error: (e?.message || String(e)) };
      }
    }
  } catch (e) { /* ignore */ }

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
  clearSearchesForModalTransition();
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

  const fsi = $("setFriendStatusInline");
  if (fsi) fsi.checked = !!UIState.prefs.friendStatusInline;
  const fst = $("setFriendStatusTooltip");
  if (fst) fst.checked = !!UIState.prefs.friendStatusTooltip;

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
  clearSearchesForModalTransition();
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

  const fsi = $("setFriendStatusInline");
  UIState.prefs.friendStatusInline = fsi ? !!fsi.checked : true;
  const fst = $("setFriendStatusTooltip");
  UIState.prefs.friendStatusTooltip = fst ? !!fst.checked : true;

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
  Settings.set("friendStatusInline", UIState.prefs.friendStatusInline);
  Settings.set("friendStatusTooltip", UIState.prefs.friendStatusTooltip);

  setThemeFromPrefs();

  // Re-render friends list to apply display preferences immediately.
  try { getFriends(); } catch (_) {}


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

document.addEventListener("DOMContentLoaded", async () => {
  // Username in dock
  $("meName").textContent = currentUser;
  const av = $("meAvatar");
  if (av) {
    const ch = (currentUser || "?").trim().charAt(0) || "?";
    av.textContent = ch.toUpperCase();
  }

  // Theme
  setThemeFromPrefs();

  initHelpSystem();

  // Re-render friends list to apply display preferences immediately.
  try { getFriends(); } catch (_) {}


  // Apply room text size preference
  applyRoomFontSize(UIState.prefs.roomFontSize);

  // Dock section ordering / drag-to-move
  initDockSectionReorder();

  // Tabs
  $("tabFriends")?.addEventListener("click", () => setActiveTab("friends"));
  $("tabGroups")?.addEventListener("click", () => setActiveTab("groups"));
  document.querySelectorAll('#dockQuickStats .dockStat').forEach((btn) => {
    btn.addEventListener('click', () => {
      clearDockSearchesForPanelSwitch();
      const tab = String(btn.dataset.jumpTab || 'friends');
      const target = String(btn.dataset.jumpTarget || '');
      setActiveTab(tab);
      setActiveDockQuickStat(target, tab);
      if (target) {
        requestAnimationFrame(() => {
          try { $(target)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch {}
        });
      }
    });
  });

  // Search
  const dockSearchEl = wireTransientSearchInputWhenAvailable("dockSearch", { clearOnLoad: true, clearOnPageShow: true, clearOnRefocusAfterBlur: true });
  dockSearchEl?.addEventListener("input", (e) => applyDockSearchFilter(e.target.value));

  // Friend search / add-friend field should not retain stale browser-restored text after login/refresh.
  wireTransientSearchInputWhenAvailable("friendUser", { clearOnLoad: true, clearOnPageShow: true, clearOnRefocusAfterBlur: true });
  document.querySelectorAll("input.rbSearch").forEach((el) => wireTransientSearchInput(el, { clearOnLoad: true, clearOnPageShow: true, clearOnRefocusAfterBlur: false }));
  // Presence controls
  // Track the last real presence so our "Set custom status…" option doesn't send an invalid presence.
  if (!window.__ym_lastPresence) window.__ym_lastPresence = $("meStatus")?.value || "online";
  if (!window.__ym_lastCustomStatus) window.__ym_lastCustomStatus = "";

  $("meStatus")?.addEventListener("change", () => {
    const sel = $("meStatus");
    if (!sel) return;
    const v = sel.value || "online";

    if (v === "__custom__") {
      // Revert select immediately; this is not a real presence value.
      sel.value = window.__ym_lastPresence || "online";
      const current = (window.__ym_lastCustomStatus || "").toString();
      const msg = prompt("Enter a custom status (max 128 characters):", current);
      if (msg === null) return; // cancelled
      const cleaned = (msg || "").toString().trim();
      window.__ym_lastCustomStatus = cleaned;
      setMyPresence({ presence: (window.__ym_lastPresence || "online"), custom_status: cleaned });
      const disp = $("meCustomDisplay");
      if (disp) {
        disp.textContent = cleaned ? `“${cleaned}”` : "";
        disp.style.display = cleaned ? "block" : "none";
      }
      return;
    }

    if (v === "__clear_custom__") {
      // Revert select immediately; clearing is orthogonal to presence.
      sel.value = window.__ym_lastPresence || "online";
      window.__ym_lastCustomStatus = "";
      setMyPresence({ presence: (window.__ym_lastPresence || "online"), custom_status: "" });
      const disp = $("meCustomDisplay");
      if (disp) {
        disp.textContent = "";
        disp.style.display = "none";
      }
      return;
    }

    // Real presence update
    window.__ym_lastPresence = v;
    setMyPresence({ presence: v });
  });


  // Buttons
  $("btnCreateGroup")?.addEventListener("click", createGroup);
  $("btnJoinGroup")?.addEventListener("click", joinGroupById);
  $("btnRefreshGroupInvites")?.addEventListener("click", refreshGroupInvites);

  $("btnSettings")?.addEventListener("click", openSettings);
  $("btnHelpTour")?.addEventListener("click", () => startHelpTour({ auto: false }));

  $("btnLogout")?.addEventListener("click", async () => {
    const ok = confirm("Log out of Echo Messenger?");
    if (!ok) return;
    try {
      await fetch("/logout", { method: "GET", credentials: "include" });
    } catch (_) {}
    window.location.href = "/login?reason=logged_out";
  });
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
  maybeAutoStartHelpTour();

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
      enterAuthExpiredState('refresh_failed');
      return;
    }
  }



  let socketConnectRetried = false;

  async function recoverSocketAuth(trigger) {
    // Re-auth without redirecting; if it can't be recovered, pause traffic and ask user.
    if (AUTH_RECOVERY_IN_PROGRESS) return;
    await attemptAuthRecoveryFlow(trigger || 'auth_required');
  }

  // Server can emit this when a JWT expires inside an event handler.
  socket.on('auth_error', async (_payload) => {
    await recoverSocketAuth('auth_required');
  });
  socket.on("connect_error", async (err) => {
    const msg = (err && (err.message || err.toString())) || "";
	    EC_RECONNECT_IN_PROGRESS = false;

    // Auth-related connect errors: try a single refresh, then force login.
    if (/expired|unauthoriz|401/i.test(msg)) {
      if (!socketConnectRetried) {
        socketConnectRetried = true;
        await attemptAuthRecoveryFlow('auth_required');
        return;
      }
      enterAuthExpiredState('auth_required');
      return;
    }

    // Non-auth connect errors (server down / blocked / CORS): stay in-app.
	    setConnBanner("connect_error", "⚠️ Can't reach server — retrying…", { showRetry: true });
  });

  socket.connect();

  // Yahoo-style room browser on the left.
  initRoomBrowser().catch(() => {});

  // Keep the access token fresh while the app is open.
  // Keep-alive: refresh ~every 22 minutes (below the 30-minute access TTL).
  // Keep-alive: refresh ~every 22 minutes (below the 30-minute access TTL).
  // Store timer so we can pause it during auth-expired mode.
  if (!EC_TOKEN_KEEPALIVE_TIMER) {
    EC_TOKEN_KEEPALIVE_TIMER = setInterval(() => {
      if (typeof AUTH_EXPIRED !== 'undefined' && AUTH_EXPIRED) return;
      refreshAccessToken().catch(() => {});
    }, 22 * 60 * 1000);
  }

  // If the tab was suspended (sleep/background), refresh on focus/visibility.
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      refreshAccessToken().catch((e) => {
        const msg = (e && (e.message || e.toString())) || "";
        if (/network error/i.test(msg)) {
          setConnBanner("connecting", "⚠️ Server unreachable — reconnecting…");
        } else {
          enterAuthExpiredState('refresh_failed');
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
  EC_RECONNECT_IN_PROGRESS = false;
  EC_SERVER_DISCONNECT_RETRIES = 0;
  const first = !EC_HAS_EVER_CONNECTED;
  EC_HAS_EVER_CONNECTED = true;

  if (first) {
    toast("✅ Connected", "ok");
  } else {
    const now = Date.now();
    if (now - EC_LAST_RECONNECT_TOAST_AT > 5000) {
      EC_LAST_RECONNECT_TOAST_AT = now;
      toast("🔁 Reconnected", "ok", 2600);
    }
  }

  hideConnBanner();

  getRooms();
  // Pull invite list so users see invitations even if they were offline when invited.
  refreshCustomRoomInvites();
  refreshRoomInvites();

  // Live room counts for room browser badges (instant updates vs polling)
  try {
    socket.emit("get_room_counts", null, (res) => {
      try { if (res && res.counts) rbApplyRoomCounts(res.counts); } catch {}
    });
  } catch {}

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
  refreshGroupInvites();

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

  // If the *server* explicitly disconnected us, uncontrolled reconnect loops can hammer
  // the server (and flood logs). Do a single delayed attempt, then require manual retry.
  if (r === "io server disconnect") {
    EC_SERVER_DISCONNECT_RETRIES += 1;
    if (EC_SERVER_DISCONNECT_RETRIES <= 1) {
      setTimeout(() => tryReconnectNow("io_server_disconnect"), 2000);
    } else {
      EC_RECONNECT_IN_PROGRESS = false;
      setConnBanner("disconnected", `🔌 Disconnected (${r}) — click Retry to reconnect`, { showRetry: true });
    }
  } else {
    // For transient disconnects, Socket.IO handles exponential backoff.
    EC_RECONNECT_IN_PROGRESS = false;
  }
});


// Missed PM summary from server
socket.on("missed_pm_summary", ({ items }) => {
  const list = Array.isArray(items) ? items : [];

  // If a DM window is already open for a peer, don't keep showing them in the missed panel.
  // We'll immediately consume their offline queue (quietly) so the server summary matches.
  const openDmPeers = new Set();
  try {
    for (const k of UIState.windows.keys()) {
      if (typeof k === "string" && k.startsWith("dm:")) openDmPeers.add(k.slice(3));
    }
  } catch {}

  const filtered = openDmPeers.size
    ? list.filter((it) => it && it.sender && !openDmPeers.has(it.sender))
    : list;

  UIState.missedPmSummary = filtered;
  renderMissedPmList(filtered);

  if (openDmPeers.size) {
    for (const it of list) {
      const sender = it?.sender;
      const count = Number(it?.count ?? 0) || 0;
      if (!sender || count <= 0) continue;
      if (openDmPeers.has(sender)) {
        consumeOfflinePmsForPeer(sender, { promptUnlock: false, quiet: true });
      }
    }
  }

  const total = filtered.reduce((acc, it) => acc + (Number(it?.count ?? 0) || 0), 0);
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

// Friend request accepted (requester side)
socket.on("friend_request_accepted", ({ by }) => {
  const who = String(by || "").trim();
  toast(`✅ ${who || "A user"} accepted your friend request`, "ok", 5000);
  maybeBrowserNotify("Friend request accepted", who ? `${who} accepted your request` : "Accepted");
  getFriends();
});

function _inviteKey(room, by) {
  return `invite:${String(room || "").toLowerCase()}:${String(by || "").toLowerCase()}`;
}

function showRoomInviteToast(room, by) {
  const r = String(room || "").trim();
  if (!r) return;
  const who = String(by || "").trim();
  const key = _inviteKey(r, who);
  if (UIState.inviteSeen?.has?.(key)) return;
  rememberInviteSeen(key);

  const label = who ? `📨 Room invite: ${r} (from ${who})` : `📨 Room invite: ${r}`;
  toastAction(label, {
    kind: "info",
    timeout: 12000,
    actionLabel: "Join",
    onAction: async () => {
      const res = await joinRoom(r);
      if (!res || !res.success) toast(`❌ Could not join ${r}`, "error");
    },
  });

  maybeBrowserNotify("Room invite", who ? `${who} invited you to ${r}` : `Invite to ${r}`);

  // If browser notifications are enabled, make the invite notification clickable.
  try {
    if (UIState.prefs.popupNotif && ("Notification" in window) && Notification.permission === "granted") {
      const n = new Notification("Room invite", { body: who ? `${who} invited you to ${r}` : `Invite to ${r}` });
      n.onclick = () => {
        try { window.focus(); } catch {}
        joinRoom(r);
        try { n.close(); } catch {}
      };
    }
  } catch (e) {}
}

// Realtime custom-room invite event
socket.on("custom_room_invite", ({ room, by }) => {
  showRoomInviteToast(room, by);
});

// Realtime invite for official/public rooms
socket.on("room_invite", ({ room, by }) => {
  showRoomInviteToast(room, by);
});


// ───────────────────────────────────────────────────────────────────────────────
// LiveKit UI wiring (buttons)
// ───────────────────────────────────────────────────────────────────────────────
(function lkWireUiOnce(){
  try{
    const bMute = $("btnRoomEmbedVoiceMute");
    if (bMute) {
      bMute.addEventListener("click", (ev) => {
        try{
          if (LIVEKIT_ENABLED) { lkToggleMic(); return; }
        } catch {}
      });
    }
    const bCam = $("btnRoomEmbedVoiceCam");
    if (bCam) {
      bCam.addEventListener("click", (ev) => {
        try{
          if (LIVEKIT_ENABLED) { lkToggleCam(); return; }
        } catch {}
      });
    }
    const bHide = $("btnRoomEmbedAvHide");
    if (bHide) {
      bHide.addEventListener("click", (ev) => {
        try{
          const p = $("roomEmbedAvPanel");
          if (!p) return;
          p.classList.add("hidden");
        } catch {}
      });
    }
  }catch{}
})();
