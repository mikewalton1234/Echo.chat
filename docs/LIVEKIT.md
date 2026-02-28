# LiveKit (Audio + Video) integration

EchoChat can use **LiveKit** as its scalable media plane (voice/video), while EchoChat remains the
auth + chat + rooms + permissions layer.

## What this enables
- Scalable voice/video across many rooms (SFU)
- "Sub-rooms" for capacity overflow: `Lobby` -> `echo-Lobby(2)` etc.
- EchoChat-issued LiveKit tokens (server-controlled)

## Server configuration

Add these keys to `server_config.json`:

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

  "rate_limit_livekit_token": "120 per minute"
}
```

Notes:
- `livekit_api_url` must be the LiveKit server URL for Server APIs (https://...).
- `livekit_ws_url` is the WebSocket URL used by clients (wss://...).

## Dependencies

Install the server SDK:

```bash
pip install livekit-api
```

## Token endpoint

EchoChat exposes:

- `POST /api/livekit/token`
  - Body: `{ "room": "<EchoChat room name>" }`
  - Returns: `{ url, room, token }`

The client uses `url` + `token` to connect to the returned LiveKit room.

## Frontend

The web client loads the LiveKit JS SDK from jsDelivr and uses the token endpoint above to join
a LiveKit room matching the current EchoChat room.

---

## Self-hosting guide
See `docs/LIVEKIT_SELFHOST.md` for local dev + production deployment notes.
