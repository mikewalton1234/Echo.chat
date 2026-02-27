#!/usr/bin/env python3
"""
server_init.py
Initialises and runs the Echo Chat Server Flask application.
Ensures init_database() is called within an application context
and registers teardown properly without causing context errors.
"""

from __future__ import annotations

import json
import os
import logging

# Optional WebSocket support
# - Default: auto (use eventlet if available, otherwise fall back to threading/polling)
# - Override with: ECHOCHAT_SOCKETIO_ASYNC=threading|eventlet
ECHOCHAT_SOCKETIO_ASYNC = os.environ.get("ECHOCHAT_SOCKETIO_ASYNC", "auto").strip().lower()
_EVENTLET_AVAILABLE = False
if ECHOCHAT_SOCKETIO_ASYNC in {"auto", "eventlet"}:
    try:
        import eventlet  # type: ignore

        eventlet.monkey_patch()
        _EVENTLET_AVAILABLE = True
    except Exception:
        _EVENTLET_AVAILABLE = False
import secrets
import sys
from datetime import timedelta, datetime
from pathlib import Path
from typing import Any, Dict, Optional

from flask import Flask, request
from flask_jwt_extended import JWTManager
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address
from flask_socketio import SocketIO, emit, disconnect

# Socket.IO auth error hardening
from jwt import ExpiredSignatureError
from flask_jwt_extended.exceptions import CSRFError, JWTExtendedException, NoAuthorizationError
from flask_wtf import CSRFProtect

from constants import APP_VERSION, sanitize_postgres_dsn, get_db_connection_string, redact_postgres_dsn, postgres_dsn_parts
from secrets_policy import persist_secrets_enabled

from database import (
    init_database,
    close_db,
    init_db_pool,
    is_auth_token_revoked,
    is_auth_session_active,
    is_refresh_token_active,
    is_refresh_token_usable,
    revoke_all_tokens_global,
    get_db_identity,
    get_schema_version,
)

# Background cleanup
from janitor import start_janitor
from routes_auth import register_auth_routes
from routes_main import register_main_routes
from routes_chat import chat_bp
from routes_groups import register_group_routes
from routes_admin_tools import register_admin_tools
from moderation_routes import register_moderation_routes
from routes_livekit import register_livekit_routes

# CORS is optional
try:
    from flask_cors import CORS
except ImportError:
    CORS = None


def _get_socketio_message_queue(settings: Dict[str, Any]) -> Optional[str]:
    """Resolve the Socket.IO message queue URL.

    Priority:
      1) ECHOCHAT_SOCKETIO_MESSAGE_QUEUE
      2) SOCKETIO_MESSAGE_QUEUE
      3) server_config.json -> socketio_message_queue
      4) REDIS_URL (common convention)
    """
    for key in ("ECHOCHAT_SOCKETIO_MESSAGE_QUEUE", "SOCKETIO_MESSAGE_QUEUE"):
        v = (os.environ.get(key) or "").strip()
        if v:
            return v

    v = (settings.get("socketio_message_queue") or "").strip()
    if v:
        return v

    v = (os.environ.get("REDIS_URL") or "").strip()
    return v or None


def _require_redis_connectivity(redis_url: str) -> None:
    """Fail fast if a Redis message queue is configured but not reachable."""
    if not redis_url:
        return

    if not (redis_url.startswith("redis://") or redis_url.startswith("rediss://")):
        # Only validate redis:// style URLs here.
        return

    try:
        import redis  # type: ignore

        client = redis.Redis.from_url(
            redis_url,
            socket_connect_timeout=1,
            socket_timeout=1,
            health_check_interval=10,
        )
        client.ping()
        logging.info("[socketio] Redis message queue reachable")
    except ImportError:
        logging.critical(
            "[socketio] Redis message queue configured (%s) but python package 'redis' is not installed. "
            "Install with: pip install redis",
            redis_url,
        )
        raise SystemExit(2)
    except Exception as exc:
        logging.critical(
            "[socketio] Redis message queue configured (%s) but Redis is not reachable: %s",
            redis_url,
            exc,
        )
        raise SystemExit(2)



def _log_startup_banner(settings: Dict[str, Any], settings_file: Optional[Path] | None) -> None:
    """Log a boot banner that makes 'wrong DB / wrong config' obvious."""
    try:
        cfg_path = Path(settings_file) if settings_file else None
        cfg_exists = bool(cfg_path and cfg_path.exists())
        cfg_mtime = None
        if cfg_exists:
            try:
                cfg_mtime = datetime.fromtimestamp(cfg_path.stat().st_mtime).isoformat(timespec="seconds")
            except Exception:
                cfg_mtime = None

        dsn = get_db_connection_string(settings)
        parts = postgres_dsn_parts(dsn)

        logging.info("==================== EchoChat Boot ====================")
        logging.info("EchoChat version: %s", APP_VERSION)
        logging.info("Settings file: %s (exists=%s%s)", str(cfg_path) if cfg_path else "<none>", cfg_exists,
                     f", mtime={cfg_mtime}" if cfg_mtime else "")
        logging.info(
            "Configured DB: host=%s port=%s db=%s user=%s",
            parts.get("host"), parts.get("port"), parts.get("db"), parts.get("user"),
        )
        logging.info("Configured DSN: %s", redact_postgres_dsn(dsn))
        logging.info("========================================================")
    except Exception as exc:  # pragma: no cover
        # Never block boot on banner failures.
        try:
            logging.warning("Could not emit boot banner: %s", exc)
        except Exception:
            pass


def create_app(
    settings: Dict[str, Any],
    limiter: Optional[Limiter] | None = None,
    settings_file: Optional[Path] | None = None,
) -> tuple[Flask, SocketIO]:
    """Create and configure the Flask + Socket.IO application.

    This function does **not** start a server. It is safe to import from a
    Gunicorn `wsgi.py` module.
    """

    settings_file = Path(settings_file) if isinstance(settings_file, str) else settings_file

    # ───── Flask App Core ─────
    app = Flask(__name__, static_folder="static", template_folder="templates")
    # Expose the live settings file path to admin endpoints so they can
    # persist runtime settings updates without guessing filenames.
    app.config["ECHOCHAT_SETTINGS_FILE"] = str(settings_file) if settings_file else None
    # Expose the live runtime settings dict to blueprints that need it.
    app.config["ECHOCHAT_SETTINGS"] = settings

    app.secret_key = _ensure_secret_key(settings, settings_file)

    # Cookie security: keep dev-friendly defaults, allow hardened prod settings.
    cookie_secure = bool(settings.get("cookie_secure", False) or settings.get("https", False))
    cookie_samesite = settings.get("cookie_samesite") or "Lax"

    app.config.update(
        SECRET_KEY=app.secret_key,
        JWT_SECRET_KEY=_ensure_jwt_secret(settings, settings_file),
        JWT_TOKEN_LOCATION=["cookies"],
        JWT_ACCESS_COOKIE_NAME="echochat_access",
        JWT_REFRESH_COOKIE_NAME="echochat_refresh",
        JWT_ACCESS_COOKIE_PATH="/",
        JWT_REFRESH_COOKIE_PATH="/token/refresh",
        # Keep CSRF cookies readable from /chat while restricting refresh token cookie path.
        JWT_ACCESS_CSRF_COOKIE_PATH="/",
        JWT_REFRESH_CSRF_COOKIE_PATH="/",
        JWT_COOKIE_SECURE=cookie_secure,
        JWT_COOKIE_SAMESITE=cookie_samesite,
        JWT_COOKIE_CSRF_PROTECT=True,

        # Defaults in Flask-JWT-Extended are short (15 minutes). For dev UX we
        # use a longer access token and rely on refresh to keep sessions alive.
        JWT_ACCESS_TOKEN_EXPIRES=timedelta(minutes=int(settings.get("access_token_minutes", 30))),
        JWT_REFRESH_TOKEN_EXPIRES=timedelta(days=int(settings.get("refresh_token_days", 7))),

        # Flask-WTF's global CSRF protection conflicts with our JSON APIs.
        # We validate CSRF manually on HTML forms, and rely on JWT's CSRF tokens
        # (csrf_access_token/csrf_refresh_token) for API calls.
        WTF_CSRF_CHECK_DEFAULT=False,
        WTF_CSRF_HEADERS=["X-CSRF-TOKEN", "X-CSRFToken"],
    )

    CSRFProtect(app)
    jwt = JWTManager(app)

    # ------------------------------------------------------------------
    # Baseline security headers
    # ------------------------------------------------------------------
    # Keep these defaults non-breaking for your current templates.
    # You can override via server_config.json:
    #   - content_security_policy
    #   - permissions_policy
    #   - x_frame_options
    #   - referrer_policy
    #   - hsts_max_age / hsts_include_subdomains / hsts_preload
    @app.after_request
    def _add_security_headers(resp):
        try:
            resp.headers.setdefault("X-Content-Type-Options", "nosniff")
            resp.headers.setdefault(
                "Referrer-Policy",
                str(settings.get("referrer_policy") or "strict-origin-when-cross-origin"),
            )
            resp.headers.setdefault(
                "X-Frame-Options",
                str(settings.get("x_frame_options") or "DENY"),
            )

            # Permissions-Policy: do not block microphone (EchoChat voice).
            resp.headers.setdefault(
                "Permissions-Policy",
                str(settings.get("permissions_policy") or "geolocation=(), camera=(), microphone=(self)"),
            )

            # CSP: allow the existing inline bootstrap <script> in chat.html.
            csp = settings.get("content_security_policy") or settings.get("csp_policy")
            if not csp:
                csp = (
                    "default-src 'self'; "
                    "base-uri 'self'; "
                    "object-src 'none'; "
                    "frame-ancestors 'none'; "
                    "script-src 'self' 'unsafe-inline' https://cdn.socket.io https://cdn.jsdelivr.net; "
                    "style-src 'self' 'unsafe-inline'; "
                    # Allow GIPHY image CDN for the built-in GIF picker.
                    # If you want a stricter policy, set content_security_policy in server_config.json.
                    "img-src 'self' data: blob: https://*.giphy.com; "
                    "font-src 'self' data:; "
                    "connect-src 'self' ws: wss:; "
                    "media-src 'self' blob: https://*.giphy.com; "
                    "worker-src 'self' blob:"
                )
            resp.headers.setdefault("Content-Security-Policy", str(csp))

            # Only send HSTS when HTTPS is in use.
            if cookie_secure:
                max_age = int(settings.get("hsts_max_age") or 31536000)
                inc_sub = bool(settings.get("hsts_include_subdomains", True))
                preload = bool(settings.get("hsts_preload", False))
                hsts = f"max-age={max_age}"
                if inc_sub:
                    hsts += "; includeSubDomains"
                if preload:
                    hsts += "; preload"
                resp.headers.setdefault("Strict-Transport-Security", hsts)
        except Exception:
            # Never break responses because of header injection.
            pass
        return resp

    # Idle logout window (hours). Access tokens are treated as invalid if the
    # session has no *client-side activity* for this long.
    idle_hours = settings.get("idle_logout_hours", 8)
    try:
        idle_hours = float(idle_hours) if idle_hours is not None else 8.0
    except Exception:
        idle_hours = 8.0
    max_idle_seconds = idle_hours * 3600.0 if idle_hours and idle_hours > 0 else None

    # ------------------------------------------------------------------
    # JWT revocation / refresh rotation enforcement
    # ------------------------------------------------------------------
    @jwt.token_in_blocklist_loader
    def _token_in_blocklist(jwt_header, jwt_payload):
        """Return True if the token should be rejected.

        - Access tokens: reject only if explicitly revoked.
        - Refresh tokens: reject if missing from DB, revoked, replaced, or expired.
          (The underlying JWT library already enforces expiration, but we
          re-check for safety and for allow_expired decode paths.)
        """
        try:
            jti = jwt_payload.get("jti")
            token_type = jwt_payload.get("type") or jwt_payload.get("token_type")
            username = jwt_payload.get("sub")

            sid = jwt_payload.get("sid")

            if token_type == "access":
                if is_auth_token_revoked(jti):
                    return True
                if sid and max_idle_seconds is not None:
                    # NOTE: idle check is only enforced on access tokens.
                    if not is_auth_session_active(sid, username=username, max_idle_seconds=max_idle_seconds):
                        return True
                return False

            if token_type == "refresh":
                if not is_refresh_token_usable(username, jti):
                    return True
                # Respect explicit session revocation (logout, admin revoke, etc.).
                if sid and not is_auth_session_active(sid, username=username, max_idle_seconds=None):
                    return True
                return False

            # Unknown token types are rejected.
            return True
        except Exception:
            return True

    # ------------------------------------------------------------------
    # CORS (hardened defaults)
    # ------------------------------------------------------------------
    # Default: CORS is OFF unless explicitly configured.
    # Why: EchoChat uses cookie-based auth; "*" + credentials is unsafe.
    cors_cfg = settings.get("cors_allowed_origins")
    if cors_cfg is None:
        cors_cfg = settings.get("allowed_origins")

    cors_origins = None
    cors_enabled = False

    def _normalize_cors_origins(val):
        if val is None:
            return None
        if isinstance(val, str):
            raw = val.strip()
            if not raw:
                return None
            # Support comma-separated strings
            if "," in raw:
                items = [x.strip() for x in raw.split(",") if x.strip()]
                return items or None
            return raw
        if isinstance(val, (list, tuple, set)):
            items = [str(x).strip() for x in val if str(x).strip()]
            return items or None
        return None

    cors_candidate = _normalize_cors_origins(cors_cfg)
    if cors_candidate is not None:
        # Disallow wildcard with credentials.
        if cors_candidate == "*" or (isinstance(cors_candidate, (list, tuple)) and "*" in cors_candidate):
            logging.warning("CORS origins includes '*'. Disabling CORS because EchoChat uses credentialed cookies.")
            cors_candidate = None

    if cors_candidate is not None:
        cors_origins = cors_candidate
        cors_enabled = True
        if CORS:
            CORS(
                app,
                supports_credentials=True,
                origins=cors_origins,
            )
        else:
            print("⚠️  flask-cors not installed; CORS settings ignored.")

    storage_uri = settings.get("rate_limit_storage_uri") or settings.get("rate_limit_storage") or "memory://"
    if limiter is None:
        limiter = Limiter(
            key_func=get_remote_address,
            storage_uri=storage_uri,
        )
    limiter.init_app(app)
    app.teardown_appcontext(close_db)


    # ────────────────────────────────────────────────────────────
    # HTTP rate limiting (admin guardrail)
    # ────────────────────────────────────────────────────────────
    # For /admin/* (many endpoints), we apply a centralized per-IP guardrail
    # to avoid missing new endpoints accidentally.
    #
    # Configure via server_config.json:
    #   - admin_rate_limit_get:   "600 per minute"
    #   - admin_rate_limit_write: "120 per minute"
    #
    from security import simple_rate_limit  # local import to avoid cycles

    def _parse_limit_value(val, default_limit: int, default_window: int) -> tuple[int, int]:
        """Parse either an int (per-minute) or a human string (e.g. '10 per minute').

        Returns (limit, window_seconds).
        """
        if val is None:
            return int(default_limit), int(default_window)
        if isinstance(val, (int, float)):
            lim = int(val)
            return (lim if lim > 0 else int(default_limit)), 60
        if isinstance(val, str):
            s = val.strip().lower()
            # Accept: "10 per minute", "10/min", "10 per 60", "30@10"
            m = __import__('re').match(r"^(\d+)\s*@\s*(\d+)$", s)
            if m:
                return int(m.group(1)), int(m.group(2))
            m = __import__('re').match(r"^(\d+)\s*(?:per\s*)?(second|sec|minute|min|hour|day)s?$", s)
            if m:
                lim = int(m.group(1))
                unit = m.group(2)
                win = 1 if unit in ('second', 'sec') else 60 if unit in ('minute', 'min') else 3600 if unit == 'hour' else 86400
                return lim, win
            m = __import__('re').match(r"^(\d+)\s*/\s*(sec|second|min|minute|hour|day)s?$", s)
            if m:
                lim = int(m.group(1))
                unit = m.group(2)
                win = 1 if unit in ('sec', 'second') else 60 if unit in ('min', 'minute') else 3600 if unit == 'hour' else 86400
                return lim, win
        return int(default_limit), int(default_window)

    @app.before_request
    def _admin_rate_limit_hook():
        try:
            path = request.path or ''
            if not (path.startswith('/admin') or path.startswith('/api/debug/config')):
                return None

            ip = request.headers.get('X-Forwarded-For', '').split(',')[0].strip() or request.remote_addr or 'unknown'

            get_val = settings.get('admin_rate_limit_get') or '600 per minute'
            write_val = settings.get('admin_rate_limit_write') or '120 per minute'

            if request.method in ('GET', 'HEAD', 'OPTIONS'):
                lim, win = _parse_limit_value(get_val, default_limit=600, default_window=60)
            else:
                lim, win = _parse_limit_value(write_val, default_limit=120, default_window=60)

            ok, retry_after = simple_rate_limit(f'admin:{ip}:{request.method}', limit=lim, window_sec=win)
            if ok:
                return None

            return ('Rate limited', 429, {'Retry-After': str(int(max(1, retry_after)))})
        except Exception:
            return None

    # Boot banner (helps catch wrong config / wrong DB early)
    _log_startup_banner(settings, settings_file)

    # ───── Initialize DB ─────
    with app.app_context():
        # Defensive DSN sanitisation (common: pasted placeholder angle brackets)
        if settings.get("database_url"):
            settings["database_url"] = str(sanitize_postgres_dsn(str(settings["database_url"])))
        # Optional Postgres connection pooling (defaults are safe for dev).
        init_db_pool(
            minconn=int(settings.get("db_pool_min", 1)),
            maxconn=int(settings.get("db_pool_max", 10)),
            dsn=str(settings.get("database_url")) if settings.get("database_url") else None,
        )
        init_database()

        # Log live DB identity (detect wrong DB/role quickly)
        try:
            ident = get_db_identity()
            logging.info(
                "Connected DB: user=%s db=%s server=%s:%s",
                ident.get("current_user"),
                ident.get("current_database"),
                ident.get("server_addr"),
                ident.get("server_port"),
            )
            logging.info("Schema version: %s", get_schema_version())
        except Exception as exc:
            logging.warning("Could not read DB identity/schema version: %s", exc)

        # Optional hard switch: revoke all sessions on boot.
        # This is OFF by default because it logs everyone out after restarts.
        if bool(settings.get("revoke_all_tokens_on_start", False)):
            try:
                revoke_all_tokens_global()
                print("🔒 revoke_all_tokens_on_start=true -> revoked all sessions")
            except Exception as e:
                print(f"⚠️  Failed to revoke tokens on start: {e}")

    # ───── SocketIO Setup ─────
    # IMPORTANT: Do not reuse JWT cookie names for the Socket.IO session cookie.
    # If you set cookie="echochat_io", Engine.IO will overwrite your JWT
    # access token cookie with a non-JWT session id (no dots), which then causes:
    #   jwt.exceptions.DecodeError: Not enough segments
    # on every @jwt_required() endpoint.
    #
    # NOTE: long-polling generates a *ton* of HTTP requests (and log lines). If
    # eventlet is available, we prefer it to enable WebSockets and dramatically
    # cut request volume.
    async_mode = "threading"
    if ECHOCHAT_SOCKETIO_ASYNC == "eventlet" and not _EVENTLET_AVAILABLE:
        print("[socketio] ECHOCHAT_SOCKETIO_ASYNC=eventlet but eventlet is not installed; falling back to threading")
    if (ECHOCHAT_SOCKETIO_ASYNC in {"auto", "eventlet"}) and _EVENTLET_AVAILABLE:
        async_mode = "eventlet"

    app.config["ECHOCHAT_SOCKETIO_ASYNC_MODE"] = async_mode
    app.config["ECHOCHAT_WS_ENABLED"] = async_mode != "threading"

    # Multi-worker broadcast (recommended for scale): configure Redis message queue.
    # Supports either server_config.json or env vars (preferred for infra):
    #   - ECHOCHAT_SOCKETIO_MESSAGE_QUEUE=redis://127.0.0.1:6379/0
    #   - or set REDIS_URL and omit the above.
    message_queue = _get_socketio_message_queue(settings)
    if message_queue:
        _require_redis_connectivity(message_queue)

    socketio = SocketIO(
        app,
        async_mode=async_mode,
        cors_allowed_origins=cors_origins,
        cookie="echochat_io",
        logger=False,
        engineio_logger=False,
        ping_interval=20,
        ping_timeout=15,
        message_queue=message_queue,
    )

    # Expose the SocketIO instance to blueprints that need to emit events from
    # normal HTTP routes (e.g., invite notifications).
    app.config["ECHOCHAT_SOCKETIO"] = socketio

    # ───── Global Socket.IO Error Handler (Fix A) ─────
    # Flask-SocketIO will otherwise log/propagate JWT errors raised inside
    # event handlers (e.g., @jwt_required()) and can leave clients in a bad
    # state. We convert auth errors into a client-visible signal and then
    # disconnect so the browser can refresh/re-auth.
    @socketio.on_error_default  # applies to all namespaces
    def _socketio_default_error_handler(e):
        try:
            sid = getattr(request, "sid", None)
        except Exception:
            sid = None

        # Auth/token problems (expired, missing, CSRF) -> notify + disconnect
        if isinstance(e, ExpiredSignatureError):
            try:
                if sid:
                    emit("auth_error", {"reason": "access_token_expired"}, to=sid)
            except Exception:
                pass
            try:
                disconnect(sid=sid)
            except Exception:
                pass
            return

        if isinstance(e, (NoAuthorizationError, CSRFError, JWTExtendedException)):
            try:
                if sid:
                    emit("auth_error", {"reason": "auth_failed"}, to=sid)
            except Exception:
                pass
            try:
                disconnect(sid=sid)
            except Exception:
                pass
            return

        # Everything else: log it, but avoid crashing the server thread.
        try:
            app.logger.exception("Socket.IO handler error: %s", e)
        except Exception:
            pass
        return

    # ───── Routes ─────
    register_auth_routes(app, settings, limiter=limiter)
    register_main_routes(app, settings, socketio)
    # NOTE: Legacy HTTP DM routes performed server-side decryption.
    # EchoChat's active direct messaging path is Socket.IO ciphertext relay
    # (see socket_handlers.py). Keeping HTTP DM routes disabled avoids
    # accidental server-side plaintext handling.
    register_group_routes(app, settings, limiter=limiter)
    register_admin_tools(app, settings, socketio=socketio, limiter=limiter)
    register_moderation_routes(app, settings, limiter=limiter)
    register_livekit_routes(app, settings, limiter=limiter)
    app.register_blueprint(chat_bp)

    from socket_handlers import register_socketio_handlers
    register_socketio_handlers(socketio, settings)

    return app, socketio


def run_web_server(
    settings: Dict[str, Any],
    limiter: Optional[Limiter] | None = None,
    settings_file: Optional[Path] | None = None,
) -> None:
    """Bootstrap the Flask-SocketIO app, attach blueprints & handlers, then run it."""

    app, socketio = create_app(settings, limiter=limiter, settings_file=settings_file)

    # ───── Run Server (dev / single-process) ─────
    host = settings.get("host") or settings.get("server_host") or "0.0.0.0"
    port = int(settings.get("port") or settings.get("server_port") or 5000)
    debug = bool(settings.get("debug") or settings.get("server_debug") or False)

    # HTTPS support (required for WebCrypto/E2EE on non-localhost origins).
    https_enabled = bool(settings.get("https", False))
    ssl_cert = settings.get("ssl_cert_file") or settings.get("ssl_cert") or settings.get("cert_file")
    ssl_key = settings.get("ssl_key_file") or settings.get("ssl_key") or settings.get("key_file")
    ssl_context = None

    if https_enabled:
        if ssl_cert and ssl_key and os.path.exists(str(ssl_cert)) and os.path.exists(str(ssl_key)):
            ssl_context = (str(ssl_cert), str(ssl_key))
        else:
            print("⚠️  https=true but ssl_cert_file/ssl_key_file missing or not found. Falling back to HTTP.")
            https_enabled = False

    scheme = "https" if https_enabled else "http"
    print(f"🚀  Starting Echo Chat Server on {scheme}://{host}:{port} (debug={debug})")

    # Background janitor: cleanup inactive custom rooms + expired messages.
    # NOTE: When running under Gunicorn with multiple workers, run this as a
    # separate service (see janitor_runner.py) to avoid N janitors.
    start_janitor(settings)

    # Reduce console spam from long-polling by filtering Werkzeug access logs for /socket.io.
    # (This does not disable Socket.IO itself; it only suppresses noisy request log lines.)
    try:

        class _EchoChatSocketIOAccessFilter(logging.Filter):
            def filter(self, record: logging.LogRecord) -> bool:  # type: ignore
                try:
                    msg = record.getMessage()
                except Exception:
                    return True
                return "/socket.io/" not in msg

        logging.getLogger("werkzeug").addFilter(_EchoChatSocketIOAccessFilter())
    except Exception:
        pass

    use_reloader = bool(debug and app.config.get("ECHOCHAT_SOCKETIO_ASYNC_MODE") == "threading")
    socketio.run(
        app,
        host=host,
        port=port,
        debug=debug,
        ssl_context=ssl_context,
        use_reloader=use_reloader,
        log_output=False,
    )


# ───── Helpers ─────
def _ensure_secret_key(
    settings: Dict[str, Any],
    settings_file: Optional[Path],
) -> str:
    key = settings.get("secret_key") or os.getenv("SECRET_KEY")
    if key:
        return key

    key = secrets.token_urlsafe(64)
    settings["secret_key"] = key
    persisted = _persist_generated_key(settings, settings_file)
    if persisted:
        print("✅ secret_key generated and saved to settings.")
    else:
        print("⚠️  Generated a one-off secret_key (NOT saved). Sessions may break on restart.")
    return key



def _ensure_jwt_secret(
    settings: Dict[str, Any],
    settings_file: Optional[Path],
) -> str:
    # Prefer explicit config, then env var. Only persist if we *generated* it
    # and secret persistence is enabled.
    key = settings.get("jwt_secret") or settings.get("jwt_secret_key")  # tolerate older naming
    if key:
        return str(key)

    env_key = os.getenv("JWT_SECRET_KEY")
    if env_key and str(env_key).strip():
        return str(env_key).strip()

    key = secrets.token_hex(32)
    settings["jwt_secret"] = key
    persisted = _persist_generated_key(settings, settings_file)
    if persisted:
        print("✅ jwt_secret generated and saved to settings.")
    else:
        print("⚠️  Generated a one-off jwt_secret (NOT saved). Logins may break on restart.")
    return key


def _persist_generated_key(settings: Dict[str, Any], settings_file: Optional[Path]) -> bool:
    # If persistence is disabled, never write secrets into server_config.json.
    if not persist_secrets_enabled():
        return False
    if not settings_file:
        print("⚠️  settings_file path not supplied; cannot persist secret_key.")
        return False

    try:
        if settings_file.suffix.lower() == ".json":
            # Only write if the settings file is valid JSON or does not exist.
            # This prevents corrupting files that are encrypted / binary / partially written.
            existing: dict | None = None
            if settings_file.exists():
                try:
                    with settings_file.open("r", encoding="utf-8") as fp:
                        existing = json.load(fp)
                except Exception:
                    existing = None

            # If the settings file exists but is invalid JSON, back it up and write a fresh JSON file.
            if existing is None and settings_file.exists():
                ts = datetime.now().strftime("%Y%m%d-%H%M%S")
                bad_path = settings_file.with_suffix(settings_file.suffix + f".bad-{ts}")
                try:
                    settings_file.rename(bad_path)
                    print(f"⚠️  Backed up invalid settings file to: {bad_path}")
                except Exception as exc:
                    print(f"⚠️  Could not back up invalid settings file: {exc}")
                    return False
                existing = {}

            merged = dict(existing or {})
            merged.update(settings)

            with settings_file.open("w", encoding="utf-8") as fp:
                json.dump(merged, fp, indent=2)
        elif settings_file.suffix.lower() in {".yml", ".yaml"}:
            import yaml
            with settings_file.open("w", encoding="utf-8") as fp:
                yaml.safe_dump(settings, fp, sort_keys=False)
        else:
            print(f"⚠️  Unsupported settings file format: {settings_file}")
            return False
    except Exception as exc:
        print(f"⚠️  Could not persist secret_key to {settings_file}: {exc}", file=sys.stderr)
        return False

    return True
