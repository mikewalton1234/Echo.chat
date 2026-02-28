# app_init.py
import os
from datetime import timedelta
from flask import Flask, request
from flask_socketio import SocketIO
from flask_wtf import CSRFProtect
from flask_jwt_extended import JWTManager

socketio = SocketIO(cors_allowed_origins="*")
jwt = JWTManager()
csrf = CSRFProtect()


def create_app(settings):
    app = Flask(__name__, static_folder="static")

    # Prevent stale JS/CSS during rapid iteration. Browsers can aggressively cache /static
    # even when the server is restarted. Disable caching for static assets by default.
    app.config["SEND_FILE_MAX_AGE_DEFAULT"] = 0

    app.secret_key = settings.get("secret_key", "change_this_default")
    app.config["SESSION_COOKIE_SECURE"] = False
    app.config["SESSION_COOKIE_SAMESITE"] = "Lax"
    app.permanent_session_lifetime = timedelta(days=7)

    app.config.update({
        "JWT_SECRET_KEY": settings.get("jwt_secret_key", "super-secret"),
        "JWT_TOKEN_LOCATION": ["cookies"],
        "JWT_ACCESS_COOKIE_PATH": "/",
        "JWT_REFRESH_COOKIE_PATH": "/token/refresh",
        "JWT_COOKIE_CSRF_PROTECT": True,
        "WTF_CSRF_TIME_LIMIT": None,
        "WTF_CSRF_CHECK_DEFAULT": True,
        "WTF_CSRF_HEADERS": ['X-CSRFToken'],
        "SESSION_COOKIE_SECURE": False,
        "SESSION_COOKIE_SAMESITE": "Lax",
    })

    # ⏳ Token expiration config
    app.config["JWT_ACCESS_TOKEN_EXPIRES"] = timedelta(minutes=30)
    app.config["JWT_REFRESH_TOKEN_EXPIRES"] = timedelta(days=7)

    jwt.init_app(app)
    csrf.init_app(app)
    socketio.init_app(app)

    @app.after_request
    def _no_cache_static(resp):
        try:
            if request.path.startswith("/static/"):
                resp.headers["Cache-Control"] = "no-store, max-age=0"
                resp.headers["Pragma"] = "no-cache"
                resp.headers["Expires"] = "0"
        except Exception:
            pass
        return resp

    return app
