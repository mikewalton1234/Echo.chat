# EchoChat Security Hardening (P0)

This patch focuses on practical, **server-side** protections that help immediately in real deployments, while keeping local-dev friendly defaults.

## Included

### 1) Account login lockout (DB-backed)
- Tracks failed login attempts per user (`users.login_failed_attempts`).
- Temporarily locks the account after a threshold (`users.login_locked_until`).
- Resets counters on successful login and records `last_login_*` metadata.

**Settings**
- `login_lockout_attempts` (default: 8)
- `login_lockout_minutes` (default: 10)

### 2) HTTP rate limiting (Flask-Limiter)
If Flask-Limiter is installed/configured (it is in `requirements.txt`), we apply limits to:
- `/login`
- `/register`
- `/token/refresh`
- `/forgot-password`
- `/reset-password`

**Settings**
- `default_rate_limits` (e.g. `["500 per minute", "5000 per hour"]`)
- `login_rate_limit`
- `register_rate_limit`
- `refresh_rate_limit`
- `forgot_password_rate_limit`
- `reset_password_rate_limit`
- `rate_limit_storage_uri` (optional; defaults to `memory://`)

> For production, prefer Redis storage for consistent limits across workers.

### 3) Socket.IO session truth + optional origin allowlist
- On `connect`, we read the JWT claims and enforce that the bound auth session is still active.
- Optional strict `Origin` allowlist check.

**Settings**
- `enforce_origin_check` (default: false)
- `allowed_origins` (or `cors_allowed_origins`)

### 4) Socket event spam throttling (in-memory)
Adds a small sliding-window limiter for high-abuse events:
- room messages
- direct messages
- WebRTC P2P offer signaling
- voice invite signaling

> This is intentionally lightweight and can be moved to Redis later.

### 5) Security headers
Adds common headers (nosniff, frame deny, referrer policy, etc.) and a **dev-friendly CSP**.
If you set `https=true`, HSTS is enabled.

**Setting**
- `content_security_policy` (optional override)

## Notes
- These protections do **not** change your E2EE model. The server still relays ciphertext and does not decrypt DM payloads.
- If you have multiple tabs/devices, session revocation will now properly cut off both HTTP and Socket.IO.

