# EchoChat v0.7.14j — Project Analysis

**Source build:** `echochat-2026-02-15-giphy-v0.7.14j.zip` → folder `echochat_v0711`

---

## 1) Executive snapshot 🧭

EchoChat is already a **working** Yahoo‑Messenger‑style web messenger with a fairly complete backbone:

- **Auth:** cookie‑based JWT (access+refresh) with refresh rotation, server‑side token/session tracking, and logout revocation.
- **DB:** PostgreSQL with idempotent schema creation + “ensure_*” patching on startup.
- **Messaging:** rooms + DMs, including **E2EE envelopes** for DMs (and optional encrypted rooms/groups).
- **Presence:** online/away/busy/invisible + custom status propagation to friends.
- **Missed/offline PMs:** ciphertext‑only offline queue with per‑sender counts and fetch‑on‑click.
- **File sharing:** WebRTC P2P first (DataChannel) with server fallback.
- **Voice:** WebRTC 1:1 and room voice with server‑enforced participant caps.
- **Admin:** server‑side injected draggable/minimizable admin panel + RBAC‑protected endpoints.
- **Fun stuff:** emoticon picker + GIPHY search integration.

The top risk area isn’t “missing features” anymore — it’s **correctness + durability**:

- **Admin panel missing / lost admin rights** is almost always a data/DSN mismatch (wrong DB) or `users.is_admin` being false.
- **Schema patch failures** can poison a Postgres transaction (especially around uniqueness constraints) and cascade into “random” auth/registration breakage.
- **Scaling** beyond a single process will require re‑thinking all in‑memory registries (presence map, voice rosters, P2P sessions) and the use of polling.

---

## 2) Repo layout (what each file is doing) 🧩

### Entrypoints
- `main.py`
  - Loads config (defaults + `server_config.json`), configures logging, initializes DB, runs server.
- `server_init.py`
  - Builds Flask app + Socket.IO, configures JWT cookies, CSRF, rate limiting, and registers routes/handlers.
- `interactive_setup.py`
  - Compact setup wizard that writes a **small** `server_config.json` and can seed admin user + verify DB connectivity.

### Core subsystems
- `database.py`
  - Postgres pool + helpers, schema creation, schema “ensure_*” patching, RBAC seeding, offline PM storage, auth token/session tables.
- `socket_handlers.py`
  - Real‑time messaging, presence fanout, offline PM queueing, voice/room voice signaling, P2P file transfer session routing.
- `routes_auth.py`
  - Login/register/logout, refresh rotation endpoint, password reset flows (email + 4‑digit PIN), cookie handling.
- `routes_main.py`
  - Main pages (`/`, `/chat`) + misc endpoints (rooms/groups helpers, torrent/GIF helpers, public key fetch, etc.).
- `routes_admin_tools.py` + `admin_panel_inject.py`
  - RBAC‑protected admin API endpoints and **server‑injected** admin UI snippet.

### Client
- `templates/*.html`
  - Jinja templates for login/register/chat/forgot password.
- `static/js/chat.js`
  - **Large** all‑in‑one client: UI windows, E2EE logic, presence, PM windows, room embed, file transfer, voice, emoticons, GIF search.
- `static/css/chat.css`
  - Yahoo‑style dock + embedded room UI.

---

## 3) Feature inventory (current state) ✅

### 3.1 Authentication & session model
What you have:
- JWT in cookies (access + refresh). ✅
- CSRF checks for form routes + CSRF headers used by injected admin panel. ✅
- Refresh rotation and server-side token store (`auth_tokens`) with “fail‑closed unknown JTI”. ✅
- Session tracking (`auth_sessions`) with session-bound tokens (`sid` claim). ✅

Where it can still bite:
- **CORS default is `*`** in config. If you ever turn on cross‑origin usage, you’ll want tight origin lists.
- Cookie flags depend on config (`cookie_secure`, samesite). In production HTTPS you’ll want `Secure=True` + likely `SameSite=Lax/Strict` tuned to your usage.

### 3.2 E2EE (DMs and optional rooms/groups)
What you have:
- Hybrid crypto in the browser: AES‑GCM payload + RSA‑OAEP wrapped key per recipient. ✅
- Private key encrypted client-side and stored server-side (as encrypted blob). ✅
- “Unlock” concept in UI (WebCrypto secure context requirement). ✅

Notes:
- This is a solid “web‑safe” approach for a pre‑alpha.
- Longer-term: consider migrating toward X25519/Ed25519 + symmetric session keys for chat threads (performance + forward secrecy). That’s a roadmap item, not a blocker.

### 3.3 Presence + custom status
What you have:
- Presence states: online / away / busy / invisible.
- Custom status text with sanitization/clamping.
- “Invisible” treated as offline for friends.

Gap:
- Presence is correct for single server process.
- In multi-worker deployments, presence must be backed by Redis/pubsub (or similar), otherwise different workers disagree.

### 3.4 Missed messages
What you have:
- `offline_messages` table for ciphertext-only PM storage.
- Client gets per-sender counts + can fetch the backlog from a sender.

Key durability concern:
- Delivery semantics are “mark delivered when fetched”. That’s acceptable, but if you want “delivered/read receipts” later, you’ll need explicit ACKs.

### 3.5 Voice chat (room + DM)
What you have:
- WebRTC signaling over Socket.IO.
- In-memory voice rosters for rooms.
- **Configurable voice limit per room** (`voice_max_room_peers`):
  - `0` means **unlimited**.
  - Admin endpoint `/admin/settings/voice` enforces cap and **randomly kicks** users from voice rosters when lowering the limit.
  - Injected admin UI includes the control. ✅

Scalability caveat:
- Voice rosters are in-memory; multiple processes will diverge.

### 3.6 Admin UI + RBAC
What you have:
- Admin UI is **server-injected** into `/chat` only when `is_admin` is true.
- Admin endpoints are RBAC protected (e.g. `@require_permission('admin:basic')`).
- There are CLI tools (`adminctl.py`, `addadmin.py`).

This is the exact area that explains your symptom:
> “my admin panel is either missing or drdrizzle lost admin rights”

If the panel is missing, the server rendered `window.IS_ADMIN = false` which comes from `users.is_admin` or the superadmin session.

---

## 4) The 3 most likely root causes of your current pain points 🔎

### A) Admin panel missing / lost admin rights
**Most likely cause:** you’re logged into an account that is **not admin in the DB you’re connected to**.

Why this happens in practice:
- Your DSN can come from:
  1) `server_config.json` → `database_url`
  2) env var `DB_CONNECTION_STRING` / `DATABASE_URL`
  3) fallback constant in `constants.py`

If you changed any of these recently (or ran setup again), you may be pointing at a **different DB** than you think.

**Fast diagnosis (copy/paste):**
```bash
cd echochat_v0711

# 1) See which DSN the config is using
cat server_config.json | sed -n '1,120p'

# 2) Check admin status in the connected DB
python adminctl.py status drdrizzle

# 3) If it's false, grant admin (this sets users.is_admin AND RBAC role)
python adminctl.py grant drdrizzle
```

If `adminctl.py` says it can’t connect, run with explicit DSN:
```bash
python adminctl.py --dsn "postgresql://drdrizzle:houdini@localhost:5432/echo_db" status drdrizzle
python adminctl.py --dsn "postgresql://drdrizzle:houdini@localhost:5432/echo_db" grant  drdrizzle
```

### B) “Registration succeeded but login says invalid username/password”
The registration/login code looks logically consistent (lowercased username, PBKDF2 hash, verification), so this symptom tends to come from:
- You’re hitting a **different DB** on login than the one you registered into, or
- A prior **failed schema patch** left the DB connection in an aborted transaction state, making later queries silently fail.

**Fast diagnosis:**
- Confirm the DSN once (same steps as above).
- Restart server and watch startup logs for any “transaction aborted” errors.

### C) Duplicate email index warnings causing cascading DB weirdness
Your DB patching attempts to create a case-insensitive unique index `users_email_unique_ci` only when duplicates are not present.

If duplicates exist, the project already includes a helper:
- `tools/dedupe_duplicate_emails.py`

**Use it like this:**
```bash
cd echochat_v0711

# Dry-run first
python tools/dedupe_duplicate_emails.py --dry-run

# Then execute
python tools/dedupe_duplicate_emails.py
```

If you ignore duplicates, the system still runs (it intentionally continues), but any part of the app that assumes “email is unique” (password reset flows) becomes ambiguous.

---

## 5) Security review (what’s good, what to improve) 🛡️

### Already good ✅
- Refresh rotation + server-side token storage (revocation-capable).
- Fail‑closed token revocation logic (unknown JTI rejected).
- CSRF handling for cookie-based JWT.
- Hybrid encryption pattern (AES-GCM + RSA wrap).

### Improve next (practical + high value) 🔧
1) **Lock down CORS/origins**
   - `cors_allowed_origins` and `allowed_origins` default to `*`.
   - In production, set explicit origins.

2) **Harden cookie settings for production**
   - When HTTPS: `cookie_secure=True`.
   - Consider `SameSite=Lax` (typical) unless you need cross-site embeddings.

3) **Password hashing strategy**
   - PBKDF2 is okay, but Argon2id is better for password storage.
   - Not a forced change today; note it for later.

4) **Rate limiting storage**
   - Memory backend is fine for dev.
   - For anything public-facing, use Redis storage (consistent rate limits across processes).

---

## 6) Scalability & reliability review 📈

### Socket.IO transport
Client forces `transports: ['polling']` because server async mode is threading.
- Works in dev.
- For production + lower latency, migrate to **eventlet/gevent** or another WebSocket-capable stack.

### In-memory registries
These will break under multiple workers:
- Presence map / connected sockets
- Voice rosters
- P2P file session registry

If you ever run multiple workers, you’ll want:
- Redis (pub/sub + shared state)
- Or a dedicated signaling service

### DB pool
- Pool exists (min/max configurable), good.
- If you ever see “too many connections”, pair this with PgBouncer.

---

## 7) Maintainability review 🧰

### Biggest maintainability hotspot
- `static/js/chat.js` is a single huge module handling *everything*.

That’s not “wrong” early on, but it increases bug surface and slows iteration.

**Low-risk refactor path:**
1) Split into `static/js/modules/`:
   - `ui_dock.js`, `ui_windows.js`, `presence.js`, `e2ee.js`, `voice.js`, `p2p_file.js`, `emoji.js`, `giphy.js`
2) Keep a small `chat.js` as the bootloader.
3) Add a minimal bundler later (or just ES modules).

---

## 8) Recommended roadmap (ordered) 🧱

### P0 (stability blockers)
- ✅ Fix admin visibility issues by standardizing “source of truth”:
  - Ensure `users.is_admin` is set for your admin account.
  - Ensure RBAC role assignment matches `is_admin`.
  - Add an `/admin/whoami` endpoint to show: username, is_admin, roles, permissions.
- ✅ Add a startup sanity check:
  - Log the **resolved DSN** (sanitized) and DB name.
  - Log whether the admin user exists and is_admin.
- ✅ Make DB patching fail-safe:
  - Any DDL failure should `ROLLBACK` to avoid “transaction aborted”.

### P1 (quality)
- Convert long polling to WebSocket-capable server mode.
- Replace in-memory presence/voice registries with Redis-backed equivalents.
- Add integration “smoke tests” (you already have `tools/smoke_test_pm_relay.py`).

### P2 (features)
- Moderation/reporting workflows.
- Better delivery receipts/ACKs.
- Multi-device sessions management UI (show sessions, revoke one).

---

## 9) “If you only do 5 minutes of debugging” checklist ⏱️

1) Confirm your server is using the DSN you think:
```bash
cat server_config.json | sed -n '1,120p'
```

2) Check admin status:
```bash
python adminctl.py status drdrizzle
```

3) Grant admin if needed:
```bash
python adminctl.py grant drdrizzle
```

4) Run the duplicate-email cleanup (if you see warnings):
```bash
python tools/dedupe_duplicate_emails.py --dry-run
```

5) Restart and watch for “transaction aborted” on startup.

---

## 10) Quick note on your recent requests (voice limit + emoticons) 🎛️

Based on this build:
- **Voice limit** is already **unlimited by default** (`voice_max_room_peers = 0`).
- Admin can change it via **Admin Panel → Voice room limit** which calls `/admin/settings/voice`.
- Lowering the limit enforces immediately and **randomly kicks** users from voice rosters.
- **Emoticons** are implemented as a Unicode emoji picker (no licensing burden, no asset hosting).

