"""wsgi.py

Gunicorn entrypoint for EchoChat.

Run (example):
  ECHOCHAT_SOCKETIO_ASYNC=eventlet \
  ECHOCHAT_SOCKETIO_MESSAGE_QUEUE=redis://127.0.0.1:6379/0 \
  gunicorn -k eventlet -w 2 -b 0.0.0.0:5000 wsgi:app

Notes:
- For multi-worker Socket.IO, a Redis message queue is required.
- Do NOT start the janitor loop inside Gunicorn workers; run janitor_runner.py
  as a separate systemd service.
"""

from __future__ import annotations

import os

# ---- Ensure eventlet monkey_patch happens as early as possible ----
_async = (os.environ.get("ECHOCHAT_SOCKETIO_ASYNC", "auto") or "auto").strip().lower()
if _async in {"auto", "eventlet"}:
    try:
        import eventlet  # type: ignore

        eventlet.monkey_patch()
    except Exception:
        # If eventlet isn't installed, EchoChat will fall back to threading.
        pass

from pathlib import Path

from constants import CONFIG_FILE
from main import load_settings, apply_env_overrides
from server_init import create_app


def _resolve_config_path() -> Path:
    # Prefer explicit env path when running under systemd.
    p = (
        os.environ.get("ECHOCHAT_CONFIG")
        or os.environ.get("ECHOCHAT_CONFIG_FILE")
        or os.environ.get("ECHOCHAT_SETTINGS")
        or CONFIG_FILE
    )
    return Path(p)


_settings_path = _resolve_config_path()
_settings = load_settings(_settings_path)
apply_env_overrides(_settings)

# Create the Flask app + Socket.IO integration.
app, socketio = create_app(_settings, limiter=None, settings_file=_settings_path)

# Expose these for tooling / introspection.
app.config["ECHOCHAT_GUNICORN"] = True
app.config["ECHOCHAT_SETTINGS_PATH"] = str(_settings_path)
