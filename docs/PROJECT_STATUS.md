# EchoChat Project Status (audit)

Snapshot reviewed: **echochat-2026-02-17-antiabuse-c2-v0.7.21**.

This file is a *practical* roadmap: what’s done, what’s fragile, and what to implement next.

---

## 1) What’s already implemented ✅

### Auth / sessions
- **Register** (email + 4-digit recovery PIN required) → stores Argon2-hashed password + hashed PIN.
- **Login** → issues **JWT access + refresh cookies**.
- **Refresh rotation + revocation checks** are enforced via DB checks in `server_init.py` (blocklist loader).
- **Session tracking**: auth sessions + “logout all / logout others” endpoints.
- **Idle logout**: session auto-logs out after `idle_logout_hours` of no client activity (default 8h); active users can stay logged in indefinitely.
- **Password reset flow** is implemented:
  - `/forgot-password` creates single-use tokens (DB table `password_reset_tokens`).
  - `/reset-password/<token>` enforces recovery PIN (if set) + rotates E2EE keys + revokes sessions.

### Chat + E2EE
- **DM E2EE**: client encrypts to recipient public key (server relays ciphertext).
- **Room E2EE**: room shared key (client-side); server relays ciphertext.
- **Group E2EE**: group key distribution + ciphertext relay (client-side; optional setting).

### Voice + file transfer
- **Room voice** (WebRTC audio mesh) + **DM calls**.
- **Voice cap** exists in settings: `voice_max_room_peers` (0/<=0 = unlimited).
- **Admin can set voice cap at runtime** via admin tools endpoint; if lowered, users are randomly disconnected to meet the cap.
- **File transfer** (DM + groups): P2P-first via WebRTC datachannel, fallback to server upload endpoints.

### Admin tooling (injection model)
- Admin UI is **server-side injected** (no admin HTML/JS in end-user files) via `admin_panel_inject.py`.
- Admin endpoints exist (`routes_admin_tools.py`) protected by RBAC.

### Anti-abuse
- **Room slowmode**: per-room seconds throttle (admin-settable) + default slowmode setting.
- **Burst rate limiting**: room/DM/file-offer.
- **Flood controls**: room-join and room-creation rate limits.
- **Social spam controls**: friend-request rate limits + unique-target spread guard.
- **Content heuristics (plaintext rooms only)**: duplicate-message suppression + link/magnet/mention caps.

### Emoji / GIF
- Emoji picker implemented as a **Unicode emoji** popover (no external assets required).
- GIF search endpoint exists (`routes_main.py`) for GIPHY if enabled/configured.

---

## 2) P0 — must fix next (these map to your recent pain points) 🔥

### P0.1 Admin panel “missing” / admin rights confusion
**Why it happens:**
- UI injection currently depends on `session['is_admin']`.
- RBAC enforcement for endpoints is separate.
- If your DB / DSN is mismatched or `is_admin` is false, the admin panel will not inject.

**What to do (operational):**
1) Confirm you’re hitting the *same* Postgres DB that the server is using.
2) Run:
   ```bash
   source .venv/bin/activate
   python adminctl.py status drdrizzle
   python adminctl.py list
   ```
3) If not admin:
   ```bash
   python adminctl.py grant drdrizzle --create-role
   ```

**What to do (code hardening):**
- Make admin injection check RBAC permission (`admin:basic`) in addition to `users.is_admin`.
  - Otherwise you can be “admin by RBAC” but not see the panel.

> Included in this audit ZIP: **adminctl.py now reads `server_config.json`** to auto-pick the correct DSN.

---

### P0.2 Password reset emails “I don’t see the email”
**Current behavior:** if SMTP is not configured, the UI still shows a generic “sent” message (anti-enumeration), but nothing is delivered.

**What to do now:**
- Configure SMTP per `docs/EMAIL_SMTP.md`.
- Test:
  ```bash
  source .venv/bin/activate
  python tools/smtp_test.py --to you@example.com
  ```

**Recommended next code improvement:**
- Dev-only fallback: if request comes from localhost/LAN, optionally **spool reset emails to a local folder** *or* display the reset URL once (never on public internet). This keeps security posture while improving dev UX.

---

### P0.3 “Registered user but can’t login”
In practice this is almost always one of these:
- **Wrong database** (register wrote to DB A, login reads DB B).
- Old DB schema / partially failed migrations.
- Duplicate email constraint problems.

**What to do:**
1) Verify `server_config.json` has the DSN you expect (`database_url`).
2) If your DB already has duplicate emails, run the provided helper:
   ```bash
   source .venv/bin/activate
   python tools/dedupe_duplicate_emails.py --dry-run
   # then without --dry-run
   ```
3) Restart server and re-test register/login.

---

## 3) P1 — next highest value improvements 💡

### P1.1 Voice “unlimited” is not realistic with mesh WebRTC
Right now voice is a **mesh**: each person connects to every other person.
- This explodes bandwidth/CPU as N grows (roughly O(N²)).

If you truly want “unlimited” voice rooms:
- Add an **SFU** (Selective Forwarding Unit) like **Janus**, **mediasoup**, or **LiveKit**.
- Keep current mesh mode for small rooms (fast + simple), and auto-switch to SFU when a room exceeds a threshold.

### P1.2 Make admin rights single-source-of-truth
- Today you have two admin signals:
  - `users.is_admin` (UI injection)
  - RBAC permissions (endpoint gating)
- Consolidate so both UI + backend use the same check (`admin:basic` / `admin:super`).

### P1.3 Remove / quarantine legacy code paths

✅ Completed: legacy modules were removed from the repo (they were unused runtime code).

