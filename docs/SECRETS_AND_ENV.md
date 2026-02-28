# Secrets & environment variables (production)

EchoChat supports two ways to provide sensitive values:

1) **Environment variables / .env** (recommended)
2) `server_config.json` (works, but easier to accidentally leak when copying/zipping)

## Recommended production pattern

1. Copy `.env.example` → `.env`
2. Fill in secrets in `.env`
3. Keep `server_config.json` for **non-secret** settings (host/port, rate limits, UI toggles).

### Disable secret persistence

Set:

```
ECHOCHAT_PERSIST_SECRETS=0
```

When this is disabled:
- The server will **not** write `secret_key` / `jwt_secret` back into `server_config.json`.
- Admin settings endpoints will **not** persist secret fields (API keys, SMTP password, LiveKit secrets).

This is intentional: secrets should come from env or a secret manager.

## Common env vars

### Required for real deployments

- `SECRET_KEY` — Flask session signing
- `JWT_SECRET_KEY` — JWT signing
- `DATABASE_URL` (or `DB_CONNECTION_STRING`) — Postgres DSN

### Optional

- `GIPHY_API_KEY` — GIF search

### Redis (recommended for scale)

If you plan to run **multiple EchoChat workers**, you should configure a shared
Socket.IO message queue. The recommended backend is **Redis**:

- `REDIS_URL=redis://127.0.0.1:6379/0`
- Optional explicit override: `ECHOCHAT_SOCKETIO_MESSAGE_QUEUE=redis://127.0.0.1:6379/0`

EchoChat will fail fast on boot if a Redis queue URL is configured but Redis is
not reachable.

- `GIPHY_API_KEY` — GIF search
- LiveKit:
  - `ECHOCHAT_LIVEKIT_ENABLED=1`
  - `LIVEKIT_API_URL`, `LIVEKIT_WS_URL`
  - `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`
- SMTP:
  - `ECHOCHAT_SMTP_ENABLED=1`
  - `SMTP_HOST`, `SMTP_PORT`, `SMTP_USERNAME`, `SMTP_PASSWORD`, `SMTP_FROM`

## Quick verification

After starting EchoChat, check the boot banner logs:

- It should show **Configured DSN** with password redacted.
- You should *not* see secrets written into `server_config.json` if `ECHOCHAT_PERSIST_SECRETS=0`.
