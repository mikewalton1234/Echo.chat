"""gunicorn_conf.py

Default Gunicorn config for EchoChat + Flask-SocketIO using Eventlet.

Environment variables:
  ECHOCHAT_BIND=0.0.0.0:5000
  ECHOCHAT_WORKERS=2
  ECHOCHAT_GUNICORN_LOGLEVEL=info
  ECHOCHAT_GUNICORN_ACCESSLOG=-
  ECHOCHAT_GUNICORN_ERRORLOG=-
  ECHOCHAT_GUNICORN_TIMEOUT=60

Recommended:
  ECHOCHAT_SOCKETIO_ASYNC=eventlet
  REDIS_URL=redis://127.0.0.1:6379/0
"""

from __future__ import annotations

import os

bind = os.environ.get("ECHOCHAT_BIND", "0.0.0.0:5000")
workers = int(os.environ.get("ECHOCHAT_WORKERS", "2"))
worker_class = "eventlet"

# WebSockets keep connections open; avoid overly low timeouts.
timeout = int(os.environ.get("ECHOCHAT_GUNICORN_TIMEOUT", "60"))
keepalive = int(os.environ.get("ECHOCHAT_GUNICORN_KEEPALIVE", "5"))

loglevel = os.environ.get("ECHOCHAT_GUNICORN_LOGLEVEL", "info")
accesslog = os.environ.get("ECHOCHAT_GUNICORN_ACCESSLOG", "-")
errorlog = os.environ.get("ECHOCHAT_GUNICORN_ERRORLOG", "-")

# Important for Socket.IO upgrades through reverse proxies.
forwarded_allow_ips = os.environ.get("ECHOCHAT_FORWARDED_ALLOW_IPS", "*")
