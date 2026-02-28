# LiveKit deployment helpers (for EchoChat)

EchoChat uses LiveKit as the SFU for scalable audio/video. LiveKit runs as a separate service
(can be on the same machine as EchoChat).

## 1) Local dev (fastest sanity test)

Install LiveKit Server (Linux):
    curl -sSL https://get.livekit.io | bash

Run in dev mode (LAN accessible):
    livekit-server --dev --bind 0.0.0.0

Dev credentials (built-in):
    API key: devkey
    API secret: secret

EchoChat config (server_config.json):
    "livekit_api_url": "http://127.0.0.1:7880"
    "livekit_ws_url": "ws://127.0.0.1:7880"
    "livekit_api_key": "devkey"
    "livekit_api_secret": "secret"

Notes:
- For browser E2EE/media, public use should be over HTTPS/WSS (secure context).
- For real internet usage you must open WebRTC media ports (UDP) or provide TURN/TLS.

## 2) Production (recommended path)

LiveKit's official VM guide uses Docker Compose + Caddy and can auto-provision TLS certs.
It also supports TURN/TLS for restrictive networks.

Use the generator:
    docker pull livekit/generate
    docker run --rm -it -v$PWD:/output livekit/generate

The generated folder includes:
    docker-compose.yaml, livekit.yaml, caddy.yaml, redis.conf, init scripts

Then deploy following LiveKit docs:
    https://docs.livekit.io/transport/self-hosting/vm/
