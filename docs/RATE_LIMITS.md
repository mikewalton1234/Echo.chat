# Rate limits

EchoChat uses two layers of rate limiting:

1) **Flask-Limiter** (HTTP endpoints): per-IP limits on sensitive routes (auth, uploads, moderation, etc.).
   - Storage backend is controlled by `rate_limit_storage_uri` (default `memory://`).

2) **In-process guardrail** (HTTP `/admin/*`): centralized per-IP limiter applied in `server_init.py` so new admin endpoints
   cannot be accidentally shipped without a limit.
   - This is **not** a replacement for a shared storage backend in production.

## Defaults (server_config.json)

You can override these keys in `server_config.json`:

### Auth
- `rate_limit_login`: `10 per minute` (POST)
- `rate_limit_register`: `3 per minute` (POST)
- `rate_limit_forgot_password`: `3 per minute` (POST)
- `rate_limit_reset_password`: `6 per minute` (POST)
- `rate_limit_refresh`: `30 per minute` (POST)

### Uploads / downloads
- `rate_limit_upload`: `20 per minute` (POST)
- `rate_limit_dm_file_upload`: `10 per minute` (POST)
- `rate_limit_group_file_upload`: `10 per minute` (POST)
- `rate_limit_torrent_upload`: `5 per minute` (POST)
- `rate_limit_torrent_scrape`: `30 per minute` (POST)

### Admin (central guardrail)
- `admin_rate_limit_get`: `600 per minute`
- `admin_rate_limit_write`: `120 per minute`

### Socket.IO anti-abuse (per-user)
- `friend_req_rate_limit`: `5` per `friend_req_rate_window_sec` (default 60s)
- `friend_req_action_rate_limit`: `30` per `friend_req_action_rate_window_sec` (default 60s)
- `p2p_file_signal_rate_limit`: `600` per `p2p_file_signal_rate_window_sec` (default 60s)
- `admin_socket_read_rate_limit`: `120` per `admin_socket_read_rate_window_sec` (default 60s)
- `admin_socket_write_rate_limit`: `60` per `admin_socket_write_rate_window_sec` (default 60s)
