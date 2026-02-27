# EchoChat

A self-hosted **Flask + Socket.IO** chat server backed by **PostgreSQL**, with a built-in browser client, realtime messaging, admin tooling, optional encrypted messaging flows, voice/file features, and optional **LiveKit** integration for more scalable media.

**Current version:** `0.10.14.11`
**License:** BSD 2-Clause

---

## Table of contents

* [What EchoChat is](#what-echochat-is)
* [Current feature set](#current-feature-set)
* [Frontend and user experience](#frontend-and-user-experience)
* [Architecture at a glance](#architecture-at-a-glance)
* [Quick start](#quick-start)
* [Configuration](#configuration)
* [Environment variables](#environment-variables)
* [GIF search](#gif-search)
* [Email and password reset](#email-and-password-reset)
* [HTTPS and WebCrypto](#https-and-webcrypto)
* [Voice and media](#voice-and-media)
* [Scaling and production](#scaling-and-production)
* [LiveKit integration](#livekit-integration)
* [Admin tooling](#admin-tooling)
* [Admin panel recovery keys](#admin-panel-recovery-keys)
* [What still needs to be done](#what-still-needs-to-be-done)
* [Project layout](#project-layout)
* [Troubleshooting](#troubleshooting)
* [Docs included in this repo](#docs-included-in-this-repo)
* [License](#license)

---

## What EchoChat is

EchoChat is a browser-based chat platform for people who want to run their own chat server instead of depending on a hosted service.

This build includes:

* **User accounts** with login, refresh tokens, password reset, and session controls
* **Realtime chat** powered by Socket.IO
* **PostgreSQL storage** for users, messages, groups, invites, sessions, and moderation/admin data
* **Direct messages**
* **Official/server rooms**
* **Custom public/private rooms**
* **Groups**
* **Friends / social presence**
* **Voice and file transfer**
* **Admin controls**
* **Rate limits / anti-abuse protections**
* Optional **encrypted messaging flows** for DMs, rooms, and groups
* Optional **LiveKit** support for scaling voice/video beyond small-room mesh WebRTC

EchoChat is usable on localhost for development, but it also includes the pieces needed to move toward a more serious multi-worker deployment with Redis, Gunicorn, Eventlet, and systemd.

---

## Current feature set

### Accounts and sessions

* User registration
* Login with JWT-based auth
* Refresh token rotation and revocation checks
* Session listing
* Logout current session
* Logout other sessions
* Logout all sessions
* Idle logout support
* Password reset flow
* Recovery PIN support during reset flows

### Chat

* Direct messages
* Public rooms
* Private custom rooms
* Room invite system
* Group chat system with invites, accept/decline, role changes, ownership transfer, mute, leave, and kick flows
* Realtime message history loading and unread tracking
* Presence / friend list / pending friend request flows

### Encryption support

This codebase supports multiple encryption-related paths:

* **DMs** are built around ciphertext relay / client-side encryption flows
* **Rooms** support ciphertext-style messaging in the default client using room envelopes
* **Groups** have optional encrypted messaging behavior depending on settings and client flow
* Encrypted DM and group file blobs can be uploaded and served back without the server needing to decrypt their contents

Important nuance: EchoChat still contains some compatibility paths for older/plaintext behavior in places, so exact runtime behavior depends on your config and how the client is being used.

### Voice and files

* Room voice signaling
* DM voice signaling
* WebRTC-based media flows
* P2P-first file transfer signaling
* Encrypted DM file upload/download routes
* Encrypted group file upload/download routes
* Standard upload endpoints
* Torrent metadata upload/download/scrape endpoints

### Admin and moderation

* Admin panel injection model
* User search and detail views
* Create users
* Force logout
* Suspend / deactivate / mute / shadowban actions
* Room lock / unlock / clear / readonly / slowmode
* Global broadcast
* Role and permission management
* Recent audit access
* Voice and GIF settings endpoints
* Anti-abuse settings endpoints

### Anti-abuse / safety

* Login / register / reset / upload rate limits
* Room slowmode
* Room join / room creation throttles
* Friend request spam protection
* Link / magnet / mention controls in abuse heuristics
* Admin socket read/write rate limits
* File upload limits
* Token endpoint rate limits

---

## Frontend and user experience

The frontend is not a minimal one-page demo. This build has a fairly large built-in web client with a **retro / Yahoo Messenger-style layout**, floating DM windows, a right-side buddy dock, an embedded room chat area, settings modals, encryption unlock prompts, GIF/emoji UI, and voice controls.

### Main chat layout

The primary chat page is built from:

* `templates/chat.html`
* `static/js/chat.js`
* `static/css/chat.css`

The interface is split into two main areas:

### Left side

The left side is the main chat/content area and includes:

* A **room browser**
* Official room/category browsing
* Custom room browsing
* Room search
* Category search
* Room sorting/filtering
* A **Create Room** flow
* A full embedded room chat area with:

  * message log
  * room user list
  * room voice controls
  * GIF button
  * emoji button
  * torrent share button
  * send bar
  * optional LiveKit A/V panel

### Right side

The right side is a **Yahoo-style dock / messenger sidebar** and includes:

* Your profile area
* Presence selector:

  * online
  * away
  * busy
  * invisible
  * custom status
* Search box for friends/groups
* **Friends** tab
* **Groups** tab
* Missed PM list
* Friends list
* Pending requests list
* Blocked users list
* Group invite list
* Group list
* Minimized window taskbar

### Floating chat windows

The frontend supports floating windows for interactive chat flows. These are rendered into a dedicated windows layer rather than forcing everything into one panel.

This includes:

* DM windows
* Group windows
* Window minimize behavior
* Taskbar buttons for minimized chats
* Voice bars inside DM windows
* Message composition areas for each conversation

This makes the frontend feel more like a desktop messenger than a single-thread chat page.

### Built-in UI flows

The frontend includes several modals and utility interfaces:

* **Unlock modal** for E2EE private key unlock
* **Settings modal**
* **Create room modal**
* **Private room invite modal**
* **GIF picker**
* **Emoji picker**
* Toast notifications
* Browser notification support
* Reconnect/bootstrap page for restoring session state

### Frontend settings users can control

The browser UI currently exposes settings for:

#### Chat UI

* Room text size
* Missed PM toast on login
* Save PMs locally in browser storage
* Download PM history
* Clear PM history

#### Friends list display

* Show custom status inline
* Show custom status on hover tooltip

#### Private message encryption

* Unlock DMs
* Lock DMs
* Session-only decrypted key behavior

#### Appearance / notifications

* Dark mode
* Accent theme
* Popup notifications
* Sound notifications

### Login and session UX

The frontend also includes supporting pages for:

* `templates/login.html`
* `templates/register.html`
* `templates/forgot_password.html`
* `templates/reset_password.html`
* `templates/chat_bootstrap.html`

Notable UX behavior:

* Login page supports **auto-unlock of DMs for the current tab**
* Logout reason / forced logout reason can be shown on the login page
* Bootstrap/reconnect page attempts refresh-token session restoration before redirecting back into chat

### Frontend keyboard behavior

A few keyboard behaviors are built in:

* **Enter** is used across various input flows
* **Escape** closes things like:

  * emoji picker
  * GIF picker
  * user context UI in some flows

The most important keyboard controls for admins are documented in the dedicated admin recovery section below.

---

## Architecture at a glance

EchoChat is split into a few major layers.

### Backend

* **Flask** for HTTP routes and page delivery
* **Flask-SocketIO** for realtime events
* **PostgreSQL** for durable storage
* **Redis** optional for multi-worker Socket.IO broadcasting
* **Gunicorn + Eventlet** optional for more production-ready websocket handling

### Frontend

Built-in browser client files:

* `templates/chat.html`
* `templates/chat_bootstrap.html`
* `templates/login.html`
* `templates/register.html`
* `templates/forgot_password.html`
* `templates/reset_password.html`
* `static/js/chat.js`
* `static/css/chat.css`

### Realtime modules

The realtime logic is broken into focused modules under `realtime/`:

* `dm.py`
* `rooms.py`
* `groups.py`
* `files.py`
* `voice.py`
* `presence_social.py`
* `admin.py`

### Routing modules

Main route groups live in:

* `routes_auth.py`
* `routes_main.py`
* `routes_chat.py`
* `routes_groups.py`
* `routes_admin_tools.py`
* `routes_livekit.py`
* `moderation_routes.py`

---

## Quick start

### Requirements

You will want:

* **Python 3.10+**
* **PostgreSQL**
* **Redis** (recommended if you plan to run multiple workers)
* Optional SMTP credentials for password reset email delivery
* Optional LiveKit if you want SFU-style voice/video scaling

### 1) Create a virtual environment

```bash
cd Echo-Chat-main
python -m venv .venv
source .venv/bin/activate
pip install -U pip
pip install -r requirements.txt
```

### 2) Create a PostgreSQL database

Example:

```bash
createdb echo_db
```

Then export your DSN:

```bash
export DATABASE_URL='postgresql://USER:PASSWORD@localhost:5432/echo_db'
```

EchoChat also understands `DB_CONNECTION_STRING`, but `DATABASE_URL` is the easiest default.

### 3) Run setup

```bash
python main.py --setup
```

This writes a `server_config.json` file if you choose to use file-based configuration.

### 4) Start the server

```bash
python main.py
```

Then open:

* `http://127.0.0.1:5000/login`
* `http://127.0.0.1:5000/register`
* `http://127.0.0.1:5000/chat`

---

## Configuration

EchoChat uses a mix of:

* `server_config.json`
* environment variables
* optional helper files for certain features

### Main config file

Use:

* `server_config.example.json` as your reference
* `server_config.json` as your actual runtime config

The example config includes settings for:

* host / port
* Postgres connection
* cookies
* token lifetimes
* password reset settings
* SMTP
* logging
* health checks
* upload and file transfer limits
* voice settings
* rate limits
* Redis message queue
* LiveKit settings

### Recommended production pattern

For a real deployment:

1. Copy `.env.example` to `.env`
2. Put secrets in `.env`
3. Keep `server_config.json` focused on non-secret operational settings
4. Set:

```bash
export ECHOCHAT_PERSIST_SECRETS=0
```

That prevents secret fields from being written back into `server_config.json`.

---

## Environment variables

These are the most important ones to know.

### Core secrets

```bash
export SECRET_KEY='change_me'
export JWT_SECRET_KEY='change_me_too'
export DATABASE_URL='postgresql://USER:PASSWORD@localhost:5432/echo_db'
```

### Redis for multi-worker Socket.IO

```bash
export REDIS_URL='redis://127.0.0.1:6379/0'
```

Optional explicit override:

```bash
export ECHOCHAT_SOCKETIO_MESSAGE_QUEUE='redis://127.0.0.1:6379/0'
```

### WebSocket backend mode

```bash
export ECHOCHAT_SOCKETIO_ASYNC='eventlet'
```

### GIF search

```bash
export GIPHY_API_KEY='YOUR_KEY_HERE'
```

### SMTP

```bash
export ECHOCHAT_SMTP_ENABLED=1
export SMTP_HOST='smtp-relay.example.com'
export SMTP_PORT='587'
export SMTP_USERNAME='YOUR_LOGIN'
export SMTP_PASSWORD='YOUR_PASSWORD'
export SMTP_FROM='EchoChat <no-reply@example.com>'
export SMTP_STARTTLS=1
```

### LiveKit

```bash
export ECHOCHAT_LIVEKIT_ENABLED=1
export LIVEKIT_API_URL='https://your-livekit-host'
export LIVEKIT_WS_URL='wss://your-livekit-host'
export LIVEKIT_API_KEY='YOUR_KEY'
export LIVEKIT_API_SECRET='YOUR_SECRET'
```

---

## GIF search

EchoChat includes GIF search in the web client.

### How it works

* The **frontend JavaScript** opens the GIF UI and sends requests to the local EchoChat server
* The **backend server** handles the `/api/gifs/search` request
* The **GIPHY API key is not hardcoded in the public chat JavaScript file**
* The server reads the key from server-side configuration, then makes the request to GIPHY and returns results to the client

### Key storage

The server can load the GIPHY API key from one of these locations:

* `ECHOCHAT_GIPHY_API_KEY`
* `GIPHY_API_KEY`
* `server_config.json` as `giphy_api_key`
* `.giphy_api_key`
* `giphy_api_key.txt`

### Disable GIF search

```json
{ "giphy_enabled": false }
```

### Important note

In this project build, the GIF feature logic exists in the frontend JavaScript, but the actual API key lookup and outbound request handling are done server-side.

---

## Email and password reset

EchoChat supports password reset flows.

### SMTP-based delivery

The recommended setup is to use a third-party SMTP relay provider rather than running your own mail server.

Relevant config keys include:

```json
{
  "public_base_url": "http://127.0.0.1:5000",
  "smtp_enabled": true,
  "smtp_host": "smtp.example.com",
  "smtp_port": 587,
  "smtp_username": "...",
  "smtp_password": "...",
  "smtp_use_starttls": true,
  "smtp_from": "EchoChat <no-reply@yourdomain.com>"
}
```

### Local development helper

If SMTP is not configured, EchoChat can spool reset links for development use.

Default spool file:

```text
logs/reset_links.log
```

Useful settings:

```json
{
  "password_reset_spool_file": "logs/reset_links.log",
  "password_reset_spool_allow_remote": false
}
```

### SMTP test helper

```bash
source .venv/bin/activate
python tools/smtp_test.py --to your@email.com
```

---

## HTTPS and WebCrypto

Some encrypted client-side flows depend on browser WebCrypto, which requires a secure context.

### Secure contexts

* `https://...` -> works
* `http://localhost:...` -> works for development
* `http://127.0.0.1:...` -> works for development
* `http://<LAN-IP>:...` -> browser WebCrypto usually does **not** work

That means if you want encrypted browser-side features off localhost, you should use HTTPS.

### Self-signed HTTPS helper

```bash
bash tools/enable_https_selfsigned.sh
python main.py
```

Then open:

```text
https://<your-host>:5000/chat
```

and accept the certificate warning for local testing.

---

## Voice and media

EchoChat supports voice/media-related flows, but there is an important distinction between **mesh WebRTC** and **SFU scaling**.

### Current built-in approach

The codebase includes WebRTC-style room/DM signaling and configurable voice caps:

* `voice_enabled`
* `voice_max_room_peers`
* ICE server config
* admin voice settings endpoints

The frontend includes:

* Room voice bar
* DM voice controls
* Mic mute state
* Cam button in room A/V flow
* LiveKit room grid when enabled

### Why this matters

Small-room mesh voice is simple, but it does not scale cleanly to large rooms because every peer may need connections to many others.

For larger deployments, you should use an SFU.

---

## Scaling and production

If you want to move beyond a single-process dev setup, use the following stack:

* **Redis** for Socket.IO message queue
* **Eventlet** for websocket transport
* **Gunicorn** for multiple workers
* **Dedicated janitor process**
* Optional reverse proxy such as Nginx or Caddy

### Install Redis on Arch

```bash
sudo pacman -S redis
sudo systemctl enable --now redis
```

### Run with Gunicorn + Eventlet

```bash
export ECHOCHAT_SOCKETIO_ASYNC=eventlet
export REDIS_URL=redis://127.0.0.1:6379/0

gunicorn -c gunicorn_conf.py wsgi:app
```

### Run janitor separately

```bash
python janitor_runner.py --config server_config.json
```

This is important in multi-worker deployments so every worker does not start its own janitor loop.

### Health check endpoint

You can enable a simple DB-backed health check:

```json
{
  "enable_health_check_endpoint": true,
  "health_check_endpoint": "/health"
}
```

Then:

```text
GET /health
```

returns:

* `200` if DB is reachable
* `503` if DB is not reachable

### systemd deployment

This repo includes deployment examples in:

* `deploy/systemd/echochat.service`
* `deploy/systemd/echochat-gunicorn.service`
* `deploy/systemd/echochat-janitor.service`
* `deploy/systemd/echochat.env.example`

For an Arch-style deployment, see:

* `deploy/systemd/README.md`

---

## LiveKit integration

EchoChat can optionally use **LiveKit** as a scalable media plane.

### What that gives you

* More scalable voice/video than pure mesh WebRTC
* EchoChat-controlled token issuance
* Optional sub-room overflow logic

### Example config

```json
{
  "livekit_enabled": true,
  "livekit_api_url": "https://YOUR_LIVEKIT_HOST",
  "livekit_ws_url": "wss://YOUR_LIVEKIT_HOST",
  "livekit_api_key": "YOUR_KEY",
  "livekit_api_secret": "YOUR_SECRET",
  "livekit_token_ttl_seconds": 600,
  "livekit_room_prefix": "echo-",
  "livekit_subrooms_enabled": true,
  "livekit_subroom_capacity": 50,
  "livekit_max_subrooms": 25,
  "livekit_occupancy_cache_ttl_sec": 2.0,
  "rate_limit_livekit_token": "120 per minute"
}
```

### Token endpoint

EchoChat exposes:

```text
POST /api/livekit/token
```

Body:

```json
{ "room": "Lobby" }
```

Response:

```json
{ "url": "...", "room": "...", "token": "..." }
```

More detail:

* `docs/LIVEKIT.md`
* `docs/LIVEKIT_SELFHOST.md`

---

## Admin tooling

EchoChat includes a strong admin and moderation surface.

### HTTP admin routes include

* `/admin/stats`
* `/admin/settings/voice`
* `/admin/settings/gifs`
* `/admin/users`
* `/admin/user_search`
* `/admin/user_detail/<username>`
* `/admin/rooms/list`
* `/admin/settings/general`
* `/admin/settings/antiabuse`
* `/admin/audit/recent`
* room action endpoints
* role/permission endpoints

### Admin UI behavior

The admin panel is **injected server-side** for admin users rather than being a normal always-visible client-side page.

That means:

* regular users do not get the admin panel injected
* admin visibility depends on both server-side permissions and runtime state
* the panel can be hidden/minimized/closed and later reopened
* panel state is persisted locally in the browser

### Admin CLI helper

This repo also includes:

```text
adminctl.py
```

Useful examples:

```bash
source .venv/bin/activate
python adminctl.py status YOUR_USERNAME
python adminctl.py list
python adminctl.py grant YOUR_USERNAME --create-role
```

### Important note about admin UI visibility

In this codebase, admin panel injection and backend RBAC are related but not identical concerns. If you have admin rights in the database but do not see the panel, verify:

* you are using the correct Postgres database
* the user has the expected admin state / role
* your runtime config points to the DB you think it does
* the panel was not simply hidden and persisted as closed in browser storage

---

## Admin panel recovery keys

If the admin panel is missing, hidden, blank, or seems gone, try these first while focused on the chat page:

### Reopen / toggle panel

* **Ctrl + Alt + P**

This toggles the admin panel open/closed.

### Force reset and rebuild panel

* **Ctrl + Alt + Shift + P**

This clears the saved panel state, rebuilds the panel, and reopens it. Use this if:

* the panel is blank
* the panel looks broken
* the panel is stuck minimized
* the panel was dragged off-screen
* the panel state in localStorage got weird

### Console fallback

If keyboard recovery fails, open the browser dev console and try:

```js
window.ECAP.show()
window.ECAP.toggle()
window.ECAP.reset()
```

### Why this happens

The admin panel keeps local UI state in browser storage, including whether it was closed/minimized and where it was positioned. That is useful for persistence, but it also means a bad saved state can make the panel look “gone” until you toggle or reset it.

---

## What still needs to be done

EchoChat can start with a pretty small setup, but there are still a few things the next person needs to do depending on whether they want a **basic local setup** or a more complete **real-world deployment**.

### What the next person must still do to run it

#### Required for a basic working setup

The project does **not** need a frontend build step, and it does **not** need a separate manual migration step. On startup, the server creates or patches the PostgreSQL schema and preloads official rooms from `chat_rooms.json`.

A new person still needs to do these things:

1. **Install the required software**

   * Python 3.10+
   * PostgreSQL

2. **Create a Python virtual environment and install dependencies**

   ```bash
   python -m venv .venv
   source .venv/bin/activate
   pip install -U pip
   pip install -r requirements.txt
   ```

3. **Create a PostgreSQL database**

   ```bash
   createdb echo_db
   ```

4. **Point EchoChat at the correct database**

   ```bash
   export DATABASE_URL='postgresql://USER:PASSWORD@localhost:5432/echo_db'
   ```

5. **Run setup**

   ```bash
   python main.py --setup
   ```

6. **Start the server**

   ```bash
   python main.py
   ```

7. **Log in with the configured superadmin account**

Setup can create/sync the superadmin account in the database, but the operator should still verify that the account can actually log in and see admin tools.

### Strongly recommended before using it seriously

These are not always required just to boot the app, but they should be done before treating the server as a serious deployment.

#### 1) Set stable secrets

Use stable values for:

* `SECRET_KEY`
* `JWT_SECRET_KEY`

Example:

```bash
export SECRET_KEY='something-long-random'
export JWT_SECRET_KEY='something-else-long-random'
```

If secrets unexpectedly change between restarts, login/session behavior can break.

#### 2) Make sure the database DSN is correct

A lot of confusing problems come from using the wrong Postgres database.

Examples:

* registration writes to one DB, login reads another
* the admin account exists in one DB but not the one the server is using
* old/stale data makes it look like the app is broken when it is really pointed at the wrong database

#### 3) Configure GIF search if you want it

The GIF UI exists in the frontend, but the backend still needs a GIPHY key.

Example:

```bash
export GIPHY_API_KEY='YOUR_KEY_HERE'
```

#### 4) Configure SMTP if you want real password reset emails

Without SMTP, password reset may appear to succeed in the UI while no real email is delivered.

#### 5) Use HTTPS if you want browser crypto features over LAN

Browser WebCrypto works on:

* `https://...`
* `http://localhost:...`
* `http://127.0.0.1:...`

It usually does **not** work correctly on plain LAN HTTP such as:

* `http://192.168.x.x:5000`

That matters for encrypted client-side flows.

#### 6) Add Redis if you want multi-worker realtime scaling

Redis is recommended when scaling Socket.IO across multiple workers.

#### 7) Add LiveKit if you want larger voice/video rooms

The built-in WebRTC approach is fine for smaller rooms, but larger rooms should use an SFU such as LiveKit.

### What still needs development work

The core app is working, but there are still important things that should be improved.

#### 1) Admin visibility should be hardened

Right now, admin panel visibility and admin permission enforcement are closely related but not fully unified.

That means a person can run into cases where:

* they are supposed to be admin
* backend permissions partly work
* but the admin panel does not inject or appear the way they expect

This should be hardened so admin UI visibility and backend authorization use the same single source of truth.

#### 2) Password reset UX should be clearer in development

If SMTP is not configured, the UI may still respond in a generic way for security reasons, which can make people think email delivery is broken without understanding why.

A better dev experience would be:

* local spool folder output
* optional localhost-only reset link display
* clearer development-mode guidance

#### 3) Wrong-database mistakes should be easier to diagnose

A lot of “login is broken” or “admin is missing” problems are really DSN/database mismatch problems.

The project would benefit from stronger diagnostics such as:

* clearer startup logging about the active database identity
* a visible admin/debug screen showing DB identity
* easier mismatch detection between setup and runtime

#### 4) Large-room voice/video still needs SFU-first deployment for real scaling

The built-in mesh WebRTC approach is not realistic for very large rooms.

For serious scaling, LiveKit or another SFU should be treated as the production path rather than assuming unlimited mesh voice.

#### 5) Production deployment still needs operator-level setup

For a real deployment, the operator still needs to decide and configure:

* reverse proxy
* HTTPS certificates
* process supervision
* backups
* log handling
* Redis
* SMTP
* LiveKit if needed

### The short version

For a normal local setup, the next person mainly needs to:

* install Python + PostgreSQL
* install Python dependencies
* create the database
* set `DATABASE_URL`
* run `python main.py --setup`
* start the server
* verify the superadmin account works

For a more complete setup, they should also configure:

* stable secrets
* GIPHY key
* SMTP
* HTTPS
* Redis
* LiveKit if they want scalable voice/video

---

## Project layout

### Core files

* `main.py` - startup entrypoint and setup flow
* `server_init.py` - app creation, middleware, JWT behavior, route registration, Socket.IO init
* `database.py` - database helpers and queries
* `config.py` - configuration helpers
* `constants.py` - project constants and DSN utilities
* `wsgi.py` - WSGI/Gunicorn entrypoint

### Routing

* `routes_auth.py`
* `routes_main.py`
* `routes_chat.py`
* `routes_groups.py`
* `routes_admin_tools.py`
* `routes_livekit.py`
* `moderation_routes.py`

### Realtime

* `realtime/dm.py`
* `realtime/rooms.py`
* `realtime/groups.py`
* `realtime/files.py`
* `realtime/voice.py`
* `realtime/presence_social.py`
* `realtime/admin.py`

### Frontend

* `templates/chat.html`
* `templates/chat_bootstrap.html`
* `templates/login.html`
* `templates/register.html`
* `templates/forgot_password.html`
* `templates/reset_password.html`
* `static/js/chat.js`
* `static/css/chat.css`

### Tools and scripts

* `tools/smtp_test.py`
* `tools/enable_https_selfsigned.sh`
* `tools/reset_db_fresh.sh`
* `tools/reset_db_schema_only.sh`
* `tools/dedupe_duplicate_emails.py`

### Deployment and docs

* `deploy/systemd/`
* `deploy/livekit/`
* `docs/`

---

## Troubleshooting

### I registered, but I cannot log in

Most of the time this is one of these:

* registration wrote to one database, login is reading another
* your DSN is wrong
* your schema is stale
* you have duplicate email issues

Check:

```bash
printenv | grep -E 'DATABASE_URL|DB_CONNECTION_STRING'
```

and verify your `server_config.json` matches your intended database.

If needed:

```bash
source .venv/bin/activate
python tools/dedupe_duplicate_emails.py --dry-run
```

### Admin panel is missing

Try these in order:

1. Press **Ctrl + Alt + P**
2. If still broken, press **Ctrl + Alt + Shift + P**
3. Check that you are actually logged in as an admin against the correct database
4. Run:

```bash
source .venv/bin/activate
python adminctl.py status YOUR_USERNAME
python adminctl.py list
```

5. If needed, use browser console:

```js
window.ECAP.show()
window.ECAP.reset()
```

### GIFs are not working

Check whether the server can actually see a GIPHY key:

```bash
printenv | grep -E 'GIPHY|ECHOCHAT_GIPHY'
ls -la .giphy_api_key giphy_api_key.txt 2>/dev/null
grep -n 'giphy_api_key' server_config.json 2>/dev/null
```

Remember:

* the public JS file is **not** where the real key is expected to live
* the browser calls your backend
* the backend reads the key and talks to GIPHY

### WebCrypto / encrypted features fail on LAN IP

If you open EchoChat like:

```text
http://192.168.x.x:5000
```

browser secure-context restrictions may break client-side crypto operations.

Use:

* `https://...`
* or localhost / 127.0.0.1 for development

### Redis configured, but multi-worker behavior is broken

If a Redis queue URL is configured but Redis is unavailable, EchoChat is designed to fail fast rather than silently behave incorrectly.

Check:

```bash
systemctl status redis
```

and verify your queue URL.

---

## Docs included in this repo

* `docs/PROJECT_STATUS.md`
* `docs/SECRETS_AND_ENV.md`
* `docs/EMAIL_SMTP.md`
* `docs/RATE_LIMITS.md`
* `docs/RESET_DB.md`
* `docs/REDIS_SOCKETIO.md`
* `docs/GUNICORN_EVENTLET.md`
* `docs/LIVEKIT.md`
* `docs/LIVEKIT_SELFHOST.md`

---

## License

This project is licensed under the **BSD 2-Clause License**.

See:

```text
LICENSE
```
