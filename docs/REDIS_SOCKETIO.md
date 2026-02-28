# Redis Socket.IO message queue (multi-worker scaling)

EchoChat uses Flask-SocketIO. For **multiple server processes** to broadcast
room events to each other, you need a shared message queue.

## Why you want this

- Without a message queue, only clients connected to the *same* process receive
  broadcasts.
- With Redis message queue, all workers see the same emits: rooms, DMs, presence,
  invites, etc.

## Configure

### Option A (recommended): env vars

Set either of these:

- `REDIS_URL=redis://127.0.0.1:6379/0`
- or `ECHOCHAT_SOCKETIO_MESSAGE_QUEUE=redis://127.0.0.1:6379/0`

`ECHOCHAT_SOCKETIO_MESSAGE_QUEUE` wins if both are set.

### Option B: server_config.json

Set:

```json
{
  "socketio_message_queue": "redis://127.0.0.1:6379/0"
}
```

## Install Redis (Arch)

```bash
sudo pacman -S redis
sudo systemctl enable --now redis
```

## Boot behavior

If a Redis queue URL is configured but Redis is not reachable, EchoChat will
**exit with code 2** and log a clear error. This prevents "looks like it works"
boots where multi-worker broadcasts silently fail.

## Next step

After Redis is enabled, the next scaling lever is enabling WebSockets:

- Install `eventlet`
- Set: `ECHOCHAT_SOCKETIO_ASYNC=eventlet`

This cuts polling traffic and improves latency.
