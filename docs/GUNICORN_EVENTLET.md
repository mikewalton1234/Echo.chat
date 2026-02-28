# Gunicorn + Eventlet (WebSockets) + Multi-worker

EchoChat uses Flask-SocketIO. For real scale, you want:

- WebSockets (to avoid long-polling spam)
- Multiple workers (use multiple CPU cores)
- A shared Socket.IO message queue (Redis)

## Requirements

```bash
pip install -r requirements.txt
# includes: eventlet, gunicorn, redis
```

## Required env vars

- `ECHOCHAT_SOCKETIO_ASYNC=eventlet`
- `REDIS_URL=redis://127.0.0.1:6379/0` (or `ECHOCHAT_SOCKETIO_MESSAGE_QUEUE=...`)

Why Redis?
- Without `message_queue`, rooms/DM events only broadcast within a single worker.

## Run (direct)

```bash
export ECHOCHAT_SOCKETIO_ASYNC=eventlet
export REDIS_URL=redis://127.0.0.1:6379/0

gunicorn -c gunicorn_conf.py wsgi:app
```

Or explicitly:

```bash
gunicorn -k eventlet -w 2 -b 0.0.0.0:5000 wsgi:app
```

## Janitor loop (important)

When you run multiple Gunicorn workers, **do not** start the janitor inside each worker.

Run it as a dedicated process:

```bash
python janitor_runner.py --config server_config.json
```

## Reverse proxy notes (Nginx/Caddy)

If you put Nginx in front, you must allow WebSocket upgrade for `/socket.io/`.

At minimum, for Nginx:

- `proxy_set_header Upgrade $http_upgrade;`
- `proxy_set_header Connection "upgrade";`
- `proxy_http_version 1.1;`

Also ensure your CSP allows `ws:` / `wss:` (EchoChat default CSP already does).

## Multi-instance / load balancers

If you run **multiple** EchoChat instances behind a load balancer, you need:

- Redis message queue (still required)
- Sticky sessions for Socket.IO

With a single Gunicorn instance on one host, sticky sessions are not needed.
