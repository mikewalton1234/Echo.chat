# EchoChat (server)

A Flask + Socket.IO chat server backed by PostgreSQL, with **ciphertext-only**
Socket.IO *direct messages* (browser performs RSA/AES hybrid encryption).

> Current state: DMs are encrypted end-to-end; **rooms can be ciphertext-only** in the default UI (`static/js/chat.js`) using `ECR1:` envelopes (server relays without decrypting).
>
> Notes:
> - Room ciphertext mode requires HTTPS (or http://localhost) + WebCrypto.
> - Every current room participant must have a public key; otherwise the client refuses to send (ciphertext-only guarantee).
> - Group chats (DB-backed) still send/store plaintext by default (next milestone: group E2EE).

## Quick start (dev)

### 1) Create a venv and install dependencies

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

### 2) Start PostgreSQL and create the database

Example:

```bash
createdb echo_db
```

Then set your DSN:

```bash
export DATABASE_URL='postgresql://user:pass@localhost:5432/echo_db'
```

### 3) Run setup wizard (writes `server_config.json`)

```bash
python main.py --setup
```

### 4) Run the server

```bash
python main.py
```

Open:

- `http://<host>:<port>/login`
- `http://<host>:<port>/register`
- `http://<host>:<port>/chat` (after login)

## Configuration

### `server_config.json`

This file is treated as plaintext JSON. **Do not store real secrets in it**.
Prefer environment variables:

- `DATABASE_URL` (or `DB_CONNECTION_STRING`)
- `SECRET_KEY`
- `JWT_SECRET_KEY`

For production, copy `.env.example` → `.env`, set your secrets there, and consider:

```bash
export ECHOCHAT_PERSIST_SECRETS=0
```

See `docs/SECRETS_AND_ENV.md`.


### GIFs (GIPHY)

EchoChat includes a GIF search/picker in **rooms**, **DMs**, and **group chats**.
The client calls a **server-side proxy** endpoint (`/api/gifs/search`) so the API key never ships to browsers.

Set your key as an environment variable before starting the server:

```bash
export GIPHY_API_KEY='YOUR_KEY_HERE'
```

Optional (dev-friendly): create a local `.giphy_api_key` file (one line, the key).
This file is **gitignored** and is read by the server at runtime if env vars are not set.

Optional (less recommended): store it in `server_config.json` as:

```json
{ "giphy_api_key": "YOUR_KEY_HERE" }
```

Disable the feature:

```json
{ "giphy_enabled": false }
```

### Email (password reset)

EchoChat sends password-reset emails via an **SMTP relay provider** (you do *not* run your own mail server).

* Setup guide: see `docs/EMAIL_SMTP.md`.

### Health check

Set in `server_config.json`:

```json
{
  "enable_health_check_endpoint": true,
  "health_check_endpoint": "/health"
}
```

Then `GET /health` will return `200` when DB is reachable, `503` otherwise.

## Security notes

- **Don’t commit secrets**: `server_config.json`, `server_key.key` and `.env` are
  in `.gitignore` now.
- In production, run behind HTTPS and set JWT cookie security accordingly
  (see `server_init.py`: `JWT_COOKIE_SECURE`).


## Troubleshooting

### "Could not fetch public key" with HTTP 422

This usually means your browser has an old JWT cookie that no longer matches the server's `jwt_secret` (for example, the server restarted and generated a new secret).

Fix:
1) Stop the server
2) Ensure the server uses a stable JWT secret:
   - Preferred: set `JWT_SECRET_KEY` in env / `.env`
   - Or: allow persistence so `jwt_secret` can be saved in `server_config.json`
3) Clear site data for `127.0.0.1` in your browser (cookies/storage), then log in again



## HTTPS (required for E2EE private messages off localhost)

Private messages use browser WebCrypto (SubtleCrypto) to decrypt your encrypted private key. Browsers only expose WebCrypto in a **secure context**:

- ✅ `https://...` (recommended)
- ✅ `http://localhost:...` (dev)
- ✅ `http://127.0.0.1:...` (dev)
- ❌ `http://<LAN-IP>:...` (WebCrypto is disabled; DMs cannot unlock)

For quick LAN testing, run the included script:

```bash
bash tools/enable_https_selfsigned.sh
python main.py
```

Then open `https://<your-host>:5000/chat` and accept the certificate warning (or import the generated CA/cert).
