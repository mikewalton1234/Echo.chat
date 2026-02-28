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

