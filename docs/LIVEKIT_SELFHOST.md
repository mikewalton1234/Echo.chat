# Self-hosting LiveKit on the same server as EchoChat

EchoChat is your **application server** (auth, rooms, chat, permissions).
LiveKit is your **media server** (SFU) for scalable audio/video.

## What is the "LiveKit host"?
It's the URL where browsers connect to LiveKit:
- Local dev: `ws://127.0.0.1:7880`
- Production: `wss://livekit.yourdomain.com`

LiveKit's deployment guide recommends a **domain + trusted SSL certificate** and HTTPS/WSS termination
via a reverse proxy / load balancer for production. Self-signed certificates won't work for typical browsers.

## Best network/port choice (recommended)
For best audio/video quality, allow inbound **UDP media** traffic. LiveKit's firewall guidance recommends
allowing UDP ports (default range) for WebRTC.

### Default (best performance)
- UDP: `50000-60000` (WebRTC media)
- TCP: `7881` (ICE/TCP fallback)

### Optional: ICE/UDP mux (simpler firewall, more overhead)
LiveKit can handle all UDP traffic on a single port (`7882`) by setting `rtc.udp_port`.
When this is set, the UDP port range is not used.

Use UDP mux when you *cannot* open a UDP range (some networks, some container constraints).

## Local dev (works immediately)
1) Install LiveKit server (Linux):
   `curl -sSL https://get.livekit.io | bash`

2) Start LiveKit dev mode:
   `livekit-server --dev`

   To allow LAN devices:
   `livekit-server --dev --bind 0.0.0.0`

3) Configure EchoChat (`server_config.json`):
```json
{
  "livekit_enabled": true,
  "livekit_api_url": "http://127.0.0.1:7880",
  "livekit_ws_url": "ws://127.0.0.1:7880",
  "livekit_api_key": "devkey",
  "livekit_api_secret": "secret"
}
```

## Production (recommended: generator + Caddy)
LiveKit provides a configuration generation tool and a VM deployment guide that uses Docker Compose + Caddy
(auto TLS certificates).

1) Run the generator:
   `docker pull livekit/generate`
   `docker run --rm -it -v$PWD:/output livekit/generate`

2) Follow the VM guide to deploy the generated config:
   https://docs.livekit.io/transport/self-hosting/vm/

3) Set EchoChat to point to your public LiveKit host:
- `livekit_ws_url`: `wss://livekit.yourdomain.com`
- `livekit_api_url`: `https://livekit.yourdomain.com`

## EchoChat + LiveKit architecture
- EchoChat mints LiveKit tokens: `POST /api/livekit/token`
- EchoChat assigns subrooms: `room`, `room(2)`, `room(3)` when capacity is reached
- Browsers connect directly to LiveKit for media, reducing load on EchoChat

