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

