#!/usr/bin/env python3
"""
routes_auth.py

Authentication and user‐management routes, updated for PostgreSQL.
All references to 'password_hash' have been replaced with 'password'
to match an existing users(password) column.
"""

import logging
import hashlib
import secrets
import os
from datetime import datetime, timezone, timedelta

from flask import (
    request,
    redirect,
    render_template,
    render_template_string,
    session,
    jsonify,
    url_for,
    make_response,
)
from flask_jwt_extended import (
    jwt_required,
    get_jwt,
    get_jwt_identity,
    create_access_token,
    create_refresh_token,
    set_access_cookies,
    set_refresh_cookies,
    unset_jwt_cookies,
)
from flask_jwt_extended.utils import decode_token
from flask_wtf.csrf import validate_csrf
from wtforms.validators import ValidationError

from constants import KEY_FILE, APP_VERSION
from database import get_db
from database import (
    create_user_with_keys,
    get_public_key_for_username,
    get_encrypted_private_key_for_username,
    ensure_user_has_keys,
    generate_user_keypair_for_password,
    user_exists,
    email_in_use,

    # Token store
    store_auth_token,
    rotate_refresh_token,
    is_refresh_token_active,
    get_refresh_token_meta,
    revoke_auth_token,
    revoke_all_tokens_for_user,

    # Session Truth (device/session tracking)
    create_auth_session,
    touch_auth_session,
    touch_auth_session_activity,
    is_auth_session_active,
    get_auth_session_state,
    get_session_id_for_token,
    attach_session_to_token,
    revoke_auth_session,
    revoke_other_sessions_for_user,
    revoke_all_sessions_for_user,
    list_auth_sessions,
)
from security import hash_password, verify_password, verify_password_and_upgrade, log_audit_event
from encryption import load_or_generate_key
from admin_panel_inject import inject_admin_panel
from permissions import check_user_permission, get_user_permissions
from emailer import send_email


def register_auth_routes(app, settings, limiter=None):
    def _limit(rule, **kwargs):
        """Apply Flask-Limiter rule if available."""
        if limiter is None:
            return lambda f: f
        try:
            return limiter.limit(rule, **kwargs)
        except Exception:
            return lambda f: f

    # NOTE: Password reset tokens are stored server-side in PostgreSQL.

    @app.route("/chat")
    def chat_page():
        """Render the chat UI.

        NOTE: We intentionally do **not** protect this HTML route with
        @jwt_required(), because access tokens are short-lived. If the user
        refreshes their browser after the access token expires, we still want to
        return the page so the client can call /token/refresh using the refresh
        token cookie.
        """

        # Auth gating:
        # - Prefer access cookie when present (even if expired).
        # - If access cookie is missing/corrupt, serve a tiny bootstrap page that
        #   attempts /token/refresh and then reloads /chat.
        #
        # NOTE: The refresh token cookie is path-restricted to /token/refresh, so
        # /chat cannot see it. However the CSRF cookie (csrf_refresh_token) is
        # available on '/', so we use it as a signal that a refresh cookie likely
        # exists.
        access_cookie_name = app.config.get("JWT_ACCESS_COOKIE_NAME", "echochat_access")
        access_token = request.cookies.get(access_cookie_name)
        refresh_csrf_cookie = request.cookies.get("csrf_refresh_token")

        if not access_token:
            if refresh_csrf_cookie:
                return make_response(
                    render_template("chat_bootstrap.html", app_version=APP_VERSION)
                )
            return redirect("/login")

        try:
            access_decoded = decode_token(access_token, allow_expired=True)
            username = access_decoded.get("sub")
            sid = access_decoded.get("sid")
        except Exception:
            if refresh_csrf_cookie:
                return make_response(
                    render_template("chat_bootstrap.html", app_version=APP_VERSION)
                )
            return redirect("/login")

        if not username:
            if refresh_csrf_cookie:
                return make_response(
                    render_template("chat_bootstrap.html", app_version=APP_VERSION)
                )
            return redirect("/login")

        # Require a Session Truth sid. If missing (legacy/partial cookies), try
        # refresh-based recovery.
        if not sid:
            if refresh_csrf_cookie:
                return make_response(
                    render_template("chat_bootstrap.html", app_version=APP_VERSION)
                )
            return redirect("/login")

        # Session Truth: sid must still be active.
        try:
            if not is_auth_session_active(sid, username=username):
                if refresh_csrf_cookie:
                    return make_response(
                        render_template("chat_bootstrap.html", app_version=APP_VERSION)
                    )
                return redirect("/login")
        except Exception:
            if refresh_csrf_cookie:
                return make_response(
                    render_template("chat_bootstrap.html", app_version=APP_VERSION)
                )
            return redirect("/login")

        # Look up user info + encrypted key in PostgreSQL
        try:
            conn = get_db()
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT is_admin, encrypted_private_key FROM users WHERE username = %s;",
                    (username,),
                )
                row = cur.fetchone()
        except Exception as e:
            logging.error("DB error in chat_page: %s", e)
            return redirect("/login")

        if not row:
            return redirect("/login")
        is_admin_db = bool(row[0])
        encrypted_priv = row[1] if (row and row[1]) else None

        # Admin UI injection should follow the same source-of-truth as backend guards:
        #   - users.is_admin (legacy UI flag)
        #   - session super-admin/admin flags (first-run override)
        #   - RBAC permissions (admin:basic/admin:super)
        rbac_admin = False
        try:
            rbac_admin = bool(
                check_user_permission(username, "admin:super")
                or check_user_permission(username, "admin:basic")
            )
        except Exception:
            rbac_admin = False

        is_admin = bool(is_admin_db or session.get("is_admin") or session.get("is_super_admin") or rbac_admin)

        # For client-side UX (e.g., room policy banners), expose the user's effective RBAC permissions.
        try:
            user_perms = sorted(get_user_permissions(username))
        except Exception:
            user_perms = []

        # Fetch all rooms, ordered case‐insensitive
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT name, member_count FROM chat_rooms ORDER BY LOWER(name);"
                )
                rooms_data = cur.fetchall()
        except Exception as e:
            logging.error("DB error fetching rooms: %s", e)
            rooms_data = []

        
        # Overlay live room counts from active Socket.IO sessions (prevents stale DB drift)
        live_counts = {}
        try:
            from socket_handlers import CONNECTED_USERS, CONNECTED_USERS_LOCK
            per_room = {}
            with CONNECTED_USERS_LOCK:
                for _sid2, sess in CONNECTED_USERS.items():
                    rname = str((sess or {}).get("room") or "").strip()
                    uname = str((sess or {}).get("username") or "").strip()
                    if not rname or not uname:
                        continue
                    per_room.setdefault(rname, set()).add(uname)
            live_counts = {r: len(u) for r, u in per_room.items()}
        except Exception:
            live_counts = {}
        rooms = [
            {"name": r[0], "member_count": int(live_counts.get(r[0], r[1] or 0) or 0)}
            for r in rooms_data
        ]

        # Client-side feature/config flags (small + non-secret).
        # The goal is to keep client limits in sync with server settings.
        def _normalize_ice_servers(val):
            # Accept:
            #  - None
            #  - ["stun:...", "turn:..."]
            #  - [{"urls": "stun:..."}, {"urls": ["stun:...", ...]}]
            if not val:
                return []
            out = []
            if isinstance(val, (list, tuple)):
                for item in val:
                    if isinstance(item, str) and item.strip():
                        out.append({"urls": item.strip()})
                    elif isinstance(item, dict) and item.get("urls"):
                        out.append(item)
            elif isinstance(val, str) and val.strip():
                out.append({"urls": val.strip()})
            return out

        # Idle logout window (seconds). 0 disables.
        idle_hours = settings.get("idle_logout_hours", 8)
        try:
            idle_hours = float(idle_hours) if idle_hours is not None else 8.0
        except Exception:
            idle_hours = 8.0
        idle_logout_seconds = int(idle_hours * 3600) if idle_hours and idle_hours > 0 else 0

        client_cfg = {
            "idle_logout_seconds": idle_logout_seconds,
            "max_dm_file_bytes": int(settings.get("max_dm_file_bytes", 10 * 1024 * 1024)),
            "max_group_file_bytes": int(settings.get("max_group_file_bytes", settings.get("max_dm_file_bytes", 10 * 1024 * 1024))),
            "allow_plaintext_dm_fallback": bool(settings.get("allow_plaintext_dm_fallback", True)),
            "require_dm_e2ee": bool(settings.get("require_dm_e2ee", False)),
            "disable_group_files_globally": bool(settings.get("disable_group_files_globally", False) or settings.get("disable_file_transfer_globally", False)),
            "p2p_file_enabled": bool(settings.get("p2p_file_enabled", True)),
            "p2p_chunk_bytes": int(settings.get("p2p_file_chunk_bytes", 64 * 1024)),
            "p2p_handshake_timeout_ms": int(settings.get("p2p_file_handshake_timeout_ms", 7000)),
            "p2p_transfer_timeout_ms": int(settings.get("p2p_file_transfer_timeout_ms", 60000)),
            "p2p_ice_servers": _normalize_ice_servers(
                settings.get("p2p_ice_servers")
                or settings.get("p2p_ice")
                or settings.get("ice_servers")
            )
            or [{"urls": "stun:stun.l.google.com:19302"}],

            # Voice chat (WebRTC audio)
            # Uses the same ICE server list as P2P file transfers by default.
            "voice_enabled": bool(settings.get("voice_enabled", True)),
            # 0 (or <=0) means unlimited.
            "voice_max_room_peers": int(settings.get("voice_max_room_peers", 0) or 0),
            "voice_ice_servers": _normalize_ice_servers(
                settings.get("voice_ice_servers")
                or settings.get("webrtc_ice_servers")
                or settings.get("p2p_ice_servers")
                or settings.get("ice_servers")
            )
            or [{"urls": "stun:stun.l.google.com:19302"}],

            # Auth/session
            "idle_logout_seconds": idle_logout_seconds,

            # Socket transport preference. When true, the browser will prefer WebSockets
            # (far fewer requests than long-polling).
                        # LiveKit (scalable audio/video)
            "livekit_enabled": bool(settings.get("livekit_enabled", False)),
            "livekit_subrooms_enabled": bool(settings.get("livekit_subrooms_enabled", True)),
            "livekit_subroom_capacity": int(settings.get("livekit_subroom_capacity", 50) or 50),

            "ws_enabled": bool(app.config.get("ECHOCHAT_WS_ENABLED", False)),
        }

        html = render_template(
            "chat.html",
            username=username,
            is_admin=is_admin,
            rooms=rooms,
            encrypted_private_key=encrypted_priv,
            csrf_token=session.get("csrf_token"),
            client_cfg=client_cfg,
            user_perms=user_perms,
            app_version=APP_VERSION,

        )

        # Admin UI is injected server-side to keep it out of static end-user assets.
        if is_admin:
            html = inject_admin_panel(html)

        resp = make_response(html)
        return resp

    @app.route("/token/refresh", methods=["POST"])
    @_limit(settings.get("rate_limit_refresh") or "30 per minute")
    @jwt_required(refresh=True)
    def token_refresh():
        """Rotate refresh token + mint a new access token (session-aware).

        Security:
          - Refresh tokens are single-use (rotated on every refresh)
          - Reuse of an already-rotated refresh token is treated as replay
          - Refresh tokens are bound to an auth session (device/session tracking)
        """

        username = get_jwt_identity()
        claims = get_jwt()
        old_refresh_jti = claims.get("jti")

        ua = request.headers.get("User-Agent")
        ip = (request.headers.get("X-Forwarded-For") or request.remote_addr or "").split(",")[0].strip() or None

        # Determine refresh token state (handles replay vs race conditions).
        meta = get_refresh_token_meta(username, old_refresh_jti)
        if not meta:
            resp = jsonify({"ok": False, "error": "refresh_unknown"})
            unset_jwt_cookies(resp)
            return resp, 401

        revoked_at, replaced_by, expires_at, last_used_at, meta_sid = meta
        if revoked_at is not None:
            resp = jsonify({"ok": False, "error": "refresh_revoked"})
            unset_jwt_cookies(resp)
            return resp, 401

        # Session Truth: sid must be consistent between JWT claim and DB row.
        sid_claim = claims.get("sid")
        if sid_claim and meta_sid and sid_claim != meta_sid:
            try:
                revoke_all_sessions_for_user(username, reason="sid_mismatch")
            except Exception:
                pass
            resp = jsonify({"ok": False, "error": "sid_mismatch"})
            unset_jwt_cookies(resp)
            return resp, 401

        sid = sid_claim or meta_sid

        # Legacy refresh tokens (pre-session tracking): create + bind a session on first refresh.
        if not sid:
            try:
                sid = create_auth_session(username=username, user_agent=ua, ip_address=ip)
                attach_session_to_token(username=username, jti=old_refresh_jti, session_id=sid)
            except Exception:
                resp = jsonify({"ok": False, "error": "session_create_failed"})
                unset_jwt_cookies(resp)
                return resp, 401

        # Session must be active (and enforce idle logout)
        try:
            idle_hours = settings.get("idle_logout_hours", 8)
            try:
                idle_hours = float(idle_hours) if idle_hours is not None else 8.0
            except Exception:
                idle_hours = 8.0
            max_idle_seconds = (idle_hours * 3600.0) if idle_hours and idle_hours > 0 else None

            state = get_auth_session_state(sid)
            if state is None or state.get("revoked_at") is not None:
                resp = jsonify({"ok": False, "error": "session_revoked"})
                unset_jwt_cookies(resp)
                return resp, 401

            if max_idle_seconds is not None:
                last_activity = state.get("last_activity_at")
                if last_activity is not None:
                    now = datetime.now(timezone.utc)
                    idle_for = (now - last_activity).total_seconds()
                    if idle_for > max_idle_seconds:
                        try:
                            revoke_auth_session(sid, reason="idle_timeout")
                        except Exception:
                            pass
                        resp = jsonify({"ok": False, "error": "idle_timeout"})
                        unset_jwt_cookies(resp)
                        return resp, 401

            # Touch *seen* time (does not extend idle window)
            touch_auth_session(sid)
        except Exception:
            resp = jsonify({"ok": False, "error": "session_check_failed"})
            unset_jwt_cookies(resp)
            return resp, 401

        # If the refresh token was already rotated, it might be:
        #  - a legitimate race (two refresh attempts close together)
        #  - a stolen-token replay
        if replaced_by is not None:
            now = datetime.now(timezone.utc)
            grace = int(settings.get("refresh_rotation_grace_seconds", 10))
            if last_used_at and (now - last_used_at).total_seconds() <= grace:
                # Graceful response: don't modify cookies; client should retry.
                return jsonify({"ok": False, "error": "stale_refresh"}), 409

            # Outside grace window -> treat as replay and hard-kill sessions.
            try:
                revoke_all_sessions_for_user(username, reason="refresh_token_reuse")
            except Exception:
                pass
            resp = jsonify({"ok": False, "error": "refresh_token_reuse"})
            unset_jwt_cookies(resp)
            return resp, 401

        # Mint new tokens (bind to the same session)
        new_access = create_access_token(identity=username, additional_claims={"sid": sid})
        new_refresh = create_refresh_token(identity=username, additional_claims={"sid": sid})

        # Extract JTIs/exp for storage
        access_decoded = decode_token(new_access, allow_expired=False)
        refresh_decoded = decode_token(new_refresh, allow_expired=False)
        new_access_jti = access_decoded.get("jti")
        new_refresh_jti = refresh_decoded.get("jti")

        # Convert exp (unix seconds) -> aware UTC timestamp
        access_exp = access_decoded.get("exp")
        refresh_exp = refresh_decoded.get("exp")
        access_expires_at = (
            datetime.fromtimestamp(access_exp, tz=timezone.utc) if isinstance(access_exp, (int, float)) else None
        )
        refresh_expires_at = (
            datetime.fromtimestamp(refresh_exp, tz=timezone.utc) if isinstance(refresh_exp, (int, float)) else None
        )

        # Atomic rotation: revoke old refresh + insert new refresh
        if not rotate_refresh_token(
            username=username,
            old_jti=old_refresh_jti,
            new_jti=new_refresh_jti,
            new_expires_at=refresh_expires_at,
            session_id=sid,
            user_agent=ua,
            ip_address=ip,
        ):
            # Likely race: another refresh already rotated this token.
            # Do NOT unset cookies (a parallel successful refresh might have
            # already set a new refresh cookie).
            return jsonify({"ok": False, "error": "stale_refresh"}), 409

        # Store access token so logout can revoke immediately.
        try:
            store_auth_token(
                jti=new_access_jti,
                username=username,
                token_type="access",
                expires_at=access_expires_at,
                session_id=sid,
                user_agent=ua,
                ip_address=ip,
            )
        except Exception:
            pass

        resp = jsonify({"ok": True, "sid": sid})
        set_access_cookies(resp, new_access)
        set_refresh_cookies(resp, new_refresh)
        return resp


    @app.route("/api/activity", methods=["POST"])
    @_limit(settings.get("rate_limit_activity") or "120 per minute")
    @jwt_required()
    def api_activity():
        """Client-side activity ping used for idle logout."""
        claims = get_jwt() or {}
        sid = claims.get("sid")
        if not sid:
            return jsonify({"ok": False, "error": "no_session"}), 401
        touch_auth_session_activity(sid)
        return jsonify({"ok": True})

    @app.route("/login", methods=["GET", "POST"])
    @_limit(settings.get("rate_limit_login") or "10 per minute", methods=["POST"])
    def login():
        if request.method == "POST":
            try:
                validate_csrf(request.form.get("csrf_token"))
            except ValidationError:
                return "Invalid CSRF token", 400

            username = request.form.get("username", "").strip().lower()
            password = request.form.get("password", "").strip()

            if not username or not password:
                return render_template("login.html", error="Username and password required")

            # Superadmin override
            if (
                username == settings.get("admin_user")
                and verify_password(password, settings.get("admin_pass"))
            ):
                # Ensure the superadmin exists in DB and has E2EE keys (DM encryption needs a public key in users table)
                try:
                    conn = get_db()
                    with conn.cursor() as cur:
                        cur.execute("SELECT 1 FROM users WHERE username = %s;", (username,))
                        exists = cur.fetchone() is not None
                    if not exists:
                        create_user_with_keys(
                            conn,
                            username=username,
                            raw_password=password,
                            password_hash=settings.get("admin_pass"),
                            is_admin=True,
                        )
                    else:
                        ensure_user_has_keys(conn, username, password)
                except Exception as e:
                    logging.error("Failed to ensure superadmin DB row/keys: %s", e)

                session.update(
                    {
                        "username": username,
                        "is_admin": True,
                        "is_super_admin": True,
                    }
                )
                ua = request.headers.get("User-Agent")
                ip = (request.headers.get("X-Forwarded-For") or request.remote_addr or "").split(",")[0].strip() or None
                sid = create_auth_session(username=username, user_agent=ua, ip_address=ip)

                access_token = create_access_token(identity=username, additional_claims={"sid": sid})
                refresh_token = create_refresh_token(identity=username, additional_claims={"sid": sid})

                # Store issued token JTIs (required for refresh rotation + revocation)
                try:
                    from datetime import datetime, timezone

                    a = decode_token(access_token, allow_expired=False)
                    r = decode_token(refresh_token, allow_expired=False)
                    a_exp = a.get("exp")
                    r_exp = r.get("exp")
                    store_auth_token(
                        jti=a.get("jti"),
                        username=username,
                        token_type="access",
                        expires_at=(datetime.fromtimestamp(a_exp, tz=timezone.utc) if isinstance(a_exp, (int, float)) else None),
                        session_id=sid,
                        user_agent=ua,
                        ip_address=ip,
                    )
                    store_auth_token(
                        jti=r.get("jti"),
                        username=username,
                        token_type="refresh",
                        expires_at=(datetime.fromtimestamp(r_exp, tz=timezone.utc) if isinstance(r_exp, (int, float)) else None),
                        session_id=sid,
                        user_agent=ua,
                        ip_address=ip,
                    )
                except Exception:
                    pass
                resp = make_response(redirect("/chat"))
                set_access_cookies(resp, access_token)
                set_refresh_cookies(resp, refresh_token)
                return resp

            # Lookup regular user in PostgreSQL
            try:
                conn = get_db()
                with conn.cursor() as cur:
                    cur.execute(
                        "SELECT password, is_admin FROM users WHERE username = %s;",
                        (username,),
                    )
                    row = cur.fetchone()
            except Exception as e:
                logging.error("DB error in login lookup: %s", e)
                row = None

            ok, upgraded_hash = (False, None)
            if row:
                ok, upgraded_hash = verify_password_and_upgrade(password, row[0])

            if ok:
                # Upgrade legacy password hash (rehash-on-login)
                if upgraded_hash:
                    try:
                        with conn.cursor() as cur:
                            cur.execute(
                                "UPDATE users SET password = %s WHERE username = %s;",
                                (upgraded_hash, username),
                            )
                        conn.commit()
                    except Exception as e:
                        logging.warning("Could not upgrade password hash for %s: %s", username, e)

                is_admin = bool(row[1])
                # Backfill missing E2EE keys for older accounts (so /get_public_key works)
                try:
                    ensure_user_has_keys(conn, username, password)
                except Exception as e:
                    logging.error("Failed to ensure user keys for %s: %s", username, e)
                session.update(
                    {
                        "username": username,
                        "is_admin": is_admin,
                        "is_super_admin": False,
                    }
                )
                ua = request.headers.get("User-Agent")
                ip = (request.headers.get("X-Forwarded-For") or request.remote_addr or "").split(",")[0].strip() or None
                sid = create_auth_session(username=username, user_agent=ua, ip_address=ip)

                access_token = create_access_token(identity=username, additional_claims={"sid": sid})
                refresh_token = create_refresh_token(identity=username, additional_claims={"sid": sid})

                # Store issued token JTIs (required for refresh rotation + revocation)
                try:
                    from datetime import datetime, timezone

                    a = decode_token(access_token, allow_expired=False)
                    r = decode_token(refresh_token, allow_expired=False)
                    a_exp = a.get("exp")
                    r_exp = r.get("exp")
                    store_auth_token(
                        jti=a.get("jti"),
                        username=username,
                        token_type="access",
                        expires_at=(datetime.fromtimestamp(a_exp, tz=timezone.utc) if isinstance(a_exp, (int, float)) else None),
                        session_id=sid,
                        user_agent=ua,
                        ip_address=ip,
                    )
                    store_auth_token(
                        jti=r.get("jti"),
                        username=username,
                        token_type="refresh",
                        expires_at=(datetime.fromtimestamp(r_exp, tz=timezone.utc) if isinstance(r_exp, (int, float)) else None),
                        session_id=sid,
                        user_agent=ua,
                        ip_address=ip,
                    )
                except Exception:
                    pass
                resp = make_response(redirect("/chat"))
                set_access_cookies(resp, access_token)
                set_refresh_cookies(resp, refresh_token)
                return resp
            else:
                return render_template("login.html", error="Invalid username or password")

        return render_template("login.html", error=None)

    @app.route("/logout")
    def logout():
        """Revoke the current access/refresh tokens (if present) and clear cookies."""

        access_cookie_name = app.config.get("JWT_ACCESS_COOKIE_NAME", "echochat_access")
        refresh_cookie_name = app.config.get("JWT_REFRESH_COOKIE_NAME", "echochat_refresh")

        access_token = request.cookies.get(access_cookie_name)
        refresh_token = request.cookies.get(refresh_cookie_name)

        # Best-effort: revoke the session (preferred), otherwise revoke JTIs.
        sid = None
        try:
            if refresh_token:
                r = decode_token(refresh_token, allow_expired=True)
                sid = r.get("sid")
        except Exception:
            sid = None

        if not sid:
            try:
                if access_token:
                    a = decode_token(access_token, allow_expired=True)
                    sid = a.get("sid") or sid
            except Exception:
                pass

        if sid:
            try:
                revoke_auth_session(sid, reason="logout")
            except Exception:
                pass
        else:
            try:
                if access_token:
                    a = decode_token(access_token, allow_expired=True)
                    revoke_auth_token(a.get("jti"))
            except Exception:
                pass
            try:
                if refresh_token:
                    r = decode_token(refresh_token, allow_expired=True)
                    revoke_auth_token(r.get("jti"))
            except Exception:
                pass

        # If the user hits /logout in a normal browser navigation, send them back to /login.
        # Keep JSON for programmatic callers (fetch/XHR).
        wants_html = False
        try:
            wants_html = (request.args.get("redirect") == "1") or (request.accept_mimetypes.best == "text/html")
        except Exception:
            wants_html = False

        if wants_html:
            resp = make_response(redirect("/login?reason=logged_out"))
        else:
            resp = jsonify({"msg": "Logout successful"})

        unset_jwt_cookies(resp)
        session.clear()
        return resp


    # ------------------------------------------------------------------
    # Session Truth APIs (optional client/admin UI can call these)
    # ------------------------------------------------------------------
    @app.route("/auth/ping", methods=["GET"])
    @jwt_required()
    def auth_ping():
        """Lightweight auth check (useful for client keep-alives / debugging)."""
        user = get_jwt_identity()
        claims = get_jwt() or {}
        return jsonify({"ok": True, "user": user, "sid": claims.get("sid")})

    @app.route("/auth/sessions", methods=["GET"])
    @_limit(settings.get("rate_limit_sessions") or "120 per minute")
    @jwt_required()
    def auth_sessions():
        user = get_jwt_identity()
        claims = get_jwt() or {}
        sid = claims.get("sid")
        try:
            sessions = list_auth_sessions(user)
        except Exception:
            sessions = []
        return jsonify({"ok": True, "current_sid": sid, "sessions": sessions})

    @app.route("/auth/logout-others", methods=["POST"])
    @_limit(settings.get("rate_limit_logout_others") or "10 per minute")
    @jwt_required()
    def auth_logout_others():
        user = get_jwt_identity()
        claims = get_jwt() or {}
        sid = claims.get("sid")
        if not sid:
            return jsonify({"ok": False, "error": "no_sid"}), 400
        try:
            revoked = revoke_other_sessions_for_user(user, keep_session_id=sid, reason="logout_others")
        except Exception:
            revoked = 0
        return jsonify({"ok": True, "revoked_sessions": revoked})

    @app.route("/auth/logout-all", methods=["POST"])
    @_limit(settings.get("rate_limit_logout_all") or "5 per minute")
    @jwt_required()
    def auth_logout_all():
        user = get_jwt_identity()
        try:
            revoke_all_sessions_for_user(user, reason="logout_all")
        except Exception:
            pass
        resp = jsonify({"ok": True})
        unset_jwt_cookies(resp)
        session.clear()
        return resp


    @app.route("/register", methods=["GET", "POST"])
    @_limit(settings.get("rate_limit_register") or "3 per minute", methods=["POST"])
    def register():
        if request.method == "POST":
            try:
                validate_csrf(request.form.get("csrf_token"))
            except ValidationError:
                return "Invalid CSRF token", 400

            username = request.form.get("username", "").strip().lower()
            email = (request.form.get("email", "") or "").strip().lower()
            phone = (request.form.get("phone", "") or "").strip()
            recovery_pin = (request.form.get("recovery_pin", "") or "").strip()
            recovery_pin_confirm = (request.form.get("recovery_pin_confirm", "") or "").strip()
            password = request.form.get("password", "")
            confirm = request.form.get("confirm", "")
            age_str = request.form.get("age", "").strip()

            if not all([username, email, recovery_pin, recovery_pin_confirm, password, confirm, age_str]):
                return "All fields required", 400
            if len(password) < 8:
                return "Password too short (min 8)", 400
            if password != confirm:
                return "Passwords must match", 400
            if recovery_pin != recovery_pin_confirm:
                return "Recovery PINs must match", 400
            if not (recovery_pin.isdigit() and len(recovery_pin) == 4):
                return "Recovery PIN must be exactly 4 digits", 400
            try:
                age = int(age_str)
                if age < 0:
                    raise ValueError
            except ValueError:
                return "Invalid age", 400

            # Basic phone normalization (optional).
            if phone:
                cleaned = "".join(ch for ch in phone if ch.isdigit() or ch == "+")
                phone = cleaned

            try:
                conn = get_db()

                # Friendly pre-checks for clearer errors (DB still enforces constraints).
                if user_exists(conn, username):
                    return "Username already exists", 409
                if email_in_use(conn, email):
                    return "Email already in use", 409

                # Use helper to generate RSA keys, encrypt private key, and INSERT
                pwd_hash = hash_password(password)
                pin_hash = hash_password(recovery_pin)
                create_user_with_keys(
                    conn=conn,
                    username=username,
                    raw_password=password,   # plaintext used to encrypt private key
                    password_hash=pwd_hash,  # hashed password stored in DB
                    email=email,
                    phone=phone or None,
                    address=None,
                    age=age,
                    is_admin=False,
                    recovery_pin_hash=pin_hash,
                    recovery_pin_set_at=datetime.now(timezone.utc),
                )

                # Assign default RBAC role (viewer) if roles are present.
                try:
                    with conn.cursor() as cur:
                        cur.execute("SELECT id FROM users WHERE username = %s;", (username,))
                        user_row = cur.fetchone()
                        cur.execute("SELECT id FROM roles WHERE name = 'viewer';")
                        role_row = cur.fetchone()
                        if user_row and role_row:
                            cur.execute(
                                """
                                INSERT INTO user_roles (user_id, role_id)
                                VALUES (%s, %s)
                                ON CONFLICT (user_id, role_id) DO NOTHING;
                                """,
                                (user_row[0], role_row[0]),
                            )
                    conn.commit()
                except Exception:
                    pass
                return redirect("/login")
            except Exception as e:
                # Try to provide a deterministic error when a DB uniqueness constraint trips.
                msg = str(e)
                low = msg.lower()
                if "unique" in low or "duplicate" in low:
                    if "users_email_unique_ci" in low or "lower(email" in low or "email" in low:
                        return "Email already in use", 409
                    return "Username already exists", 409
                logging.exception("Registration failed")
                return f"Error: {e}", 500

        return render_template("register.html")

    @app.route("/forgot-password", methods=["GET", "POST"])
    @_limit(settings.get("rate_limit_forgot_password") or "3 per minute", methods=["POST"])
    def forgot_password():
        """Begin password reset.

        Flow:
          1) User submits email (+ optional username)
          2) Server sends a high-entropy, single-use reset link to that email
          3) User must also provide their 4-digit Recovery PIN to complete the reset

        Security:
          - Always respond generically to avoid account enumeration.
          - Token expires quickly and is single-use.
        """

        if request.method == "POST":
            try:
                validate_csrf(request.form.get("csrf_token"))
            except ValidationError:
                return "Invalid CSRF token", 400

            email = (request.form.get("email", "") or "").strip().lower()
            username_hint = (request.form.get("username", "") or "").strip().lower()
            if not email:
                return render_template("forgot_password.html", error="Email required", message=None), 400

            conn = get_db()
            username = None
            recovery_pin_hash = None
            lookup_note = None
            email_send_info = None

            def _client_ip() -> str:
                xff = (request.headers.get("X-Forwarded-For") or "").split(",")[0].strip()
                return xff or (request.remote_addr or "").strip()

            def _is_localish(ip: str) -> bool:
                # Localhost
                if ip in ("127.0.0.1", "::1"):
                    return True
                # RFC1918 private ranges
                if ip.startswith("10.") or ip.startswith("192.168."):
                    return True
                if ip.startswith("172."):
                    try:
                        second = int(ip.split(".")[1])
                        if 16 <= second <= 31:
                            return True
                    except Exception:
                        pass
                return False

            def _is_localhost(ip: str) -> bool:
                return ip in ("127.0.0.1", "::1")

            client_ip = _client_ip()

            # Lookup (best-effort; response is generic either way).
            try:
                with conn.cursor() as cur:
                    if username_hint:
                        cur.execute(
                            "SELECT username, email, recovery_pin_hash FROM users WHERE username = %s;",
                            (username_hint,),
                        )
                        row = cur.fetchone()
                        if row and (row[1] or "").strip().lower() == email:
                            username, _, recovery_pin_hash = row
                            lookup_note = "matched_username_email"
                    else:
                        # If emails are not unique (legacy DBs), avoid selecting an arbitrary
                        # account by email alone. If multiple users share the same email,
                        # require a username hint (but still respond generically).
                        cur.execute(
                            "SELECT COUNT(*) FROM users WHERE LOWER(email) = %s;",
                            (email,),
                        )
                        count = int((cur.fetchone() or [0])[0])

                        if count == 1:
                            cur.execute(
                                "SELECT username, email, recovery_pin_hash FROM users WHERE LOWER(email) = %s LIMIT 1;",
                                (email,),
                            )
                            row = cur.fetchone()
                            if row:
                                username, _, recovery_pin_hash = row
                                lookup_note = "matched_email_unique"
                        elif count > 1:
                            logging.warning(
                                "Password reset requested for non-unique email; refusing email-only lookup (email=%s)",
                                email,
                            )
                            lookup_note = "non_unique_email_requires_username"
            except Exception as e:
                logging.warning("DB error in forgot_password lookup: %s", e)
                username = None
                lookup_note = "db_error"

            require_pin = bool(recovery_pin_hash)

            # UX helper: if an email matches multiple accounts, prompt for username (prevents ambiguous resets).
            if lookup_note == "non_unique_email_requires_username" and not username_hint:
                # Still avoid account enumeration on the public internet; this hint is only shown on localhost/LAN.
                if _is_localish(client_ip):
                    return render_template(
                        "forgot_password.html",
                        message=None,
                        error="Multiple accounts share that email. Please also enter the username for the account you want to reset.")


            # If we found an account, generate a token (PIN is required only if configured on the account).
            reset_url = None
            if username:
                try:
                    now = datetime.now(timezone.utc)
                    ttl_min = int(settings.get("password_reset_token_minutes", 15))
                    expires_at = now + timedelta(minutes=ttl_min)

                    # Throttle: at most 3 active tokens per user in last 15 minutes.
                    with conn.cursor() as cur:
                        cur.execute(
                            """
                            SELECT COUNT(*)
                              FROM password_reset_tokens
                             WHERE username = %s
                               AND created_at > (CURRENT_TIMESTAMP - INTERVAL '15 minutes')
                               AND used_at IS NULL;
                            """,
                            (username,),
                        )
                        active_count = int((cur.fetchone() or [0])[0])

                    if active_count < 3:
                        token = secrets.token_urlsafe(32)
                        token_hash = hashlib.sha256(token.encode("utf-8")).hexdigest()

                        with conn.cursor() as cur:
                            cur.execute(
                                """
                                INSERT INTO password_reset_tokens (username, token_hash, expires_at, request_ip, user_agent)
                                VALUES (%s, %s, %s, %s, %s);
                                """,
                                (
                                    username,
                                    token_hash,
                                    expires_at,
                                    request.headers.get("X-Forwarded-For", request.remote_addr),
                                    request.headers.get("User-Agent"),
                                ),
                            )
                        conn.commit()

                        try:
                            log_audit_event('anon', 'password_reset_request', username, f"ip={request.headers.get('X-Forwarded-For', request.remote_addr)} ua={request.headers.get('User-Agent')} note={lookup_note}")
                        except Exception:
                            pass

                        # IMPORTANT: server_host is often 0.0.0.0 (bind-all) which is not a usable link.
                        # Prefer an explicit public_base_url, otherwise derive from the actual Host header.
                        base_url = (settings.get("public_base_url") or request.host_url).rstrip("/")
                        reset_url = f"{base_url}/reset-password/{token}"
                        pin_note = (
                            "To complete the reset, you will also need your 4-digit Recovery PIN.\n\n"
                            if require_pin
                            else (
                                "This account does not have a Recovery PIN set, so the reset link alone is sufficient.\n"
                                "After logging in, consider setting a Recovery PIN for extra protection.\n\n"
                            )
                        )

                        body = (
                            "You requested a password reset for EchoChat.\n\n"
                            f"Reset link (expires in {ttl_min} minutes, single-use):\n{reset_url}\n\n"
                            f"{pin_note}"
                            "If you did not request this, you can ignore this email."
                        )
                        ok, email_send_info = send_email(settings, to_email=email, subject="EchoChat password reset", body_text=body)

                        # Dev UX: if SMTP isn't configured, write the reset link to a local log file so
                        # developers on localhost/LAN can retrieve it without weakening the public UX.
                        if not ok and email_send_info == "not_configured":
                            try:
                                spool_ok = False

                                # Default: only spool for localhost/LAN to avoid leaking reset links in production.
                                allow_remote = bool(settings.get("password_reset_spool_allow_remote", False))
                                if allow_remote or _is_localish(client_ip):
                                    os.makedirs("logs", exist_ok=True)
                                    spool_path = settings.get("password_reset_spool_file") or os.path.join("logs", "reset_links.log")
                                    ts = datetime.now(timezone.utc).isoformat()
                                    with open(spool_path, "a", encoding="utf-8") as f:
                                        f.write(f"{ts}\tuser={username}\temail={email}\tip={client_ip}\turl={reset_url}\n")
                                    spool_ok = True

                                    # Console helper: only print the link when the request came from localhost.
                                    if _is_localhost(client_ip):
                                        logging.warning("[DEV] Password reset link for %s: %s", username, reset_url)

                                if spool_ok:
                                    logging.warning(
                                        "Password reset email not sent (SMTP not configured). Reset link spooled to %s",
                                        settings.get("password_reset_spool_file") or os.path.join("logs", "reset_links.log"),
                                    )
                                else:
                                    logging.error(
                                        "Password reset email not sent (SMTP not configured). Spooling disabled for non-local IP %s",
                                        client_ip,
                                    )
                            except Exception as e2:
                                logging.error("Failed to spool password reset link: %s", e2)
                except Exception as e:
                    try:
                        conn.rollback()
                    except Exception:
                        pass
                    logging.warning("Failed to create/send reset token: %s", e)

            # Always respond generically (avoid account enumeration).
            msg = "If an account matches that email, a reset link has been sent."

            if email_send_info == "not_configured":
                logging.error("Password reset email not sent: SMTP not configured.")
            elif isinstance(email_send_info, str) and email_send_info.startswith("smtp_error:"):
                logging.warning("Password reset email send failed: %s", email_send_info)

            return render_template("forgot_password.html", message=msg, error=None)

        return render_template("forgot_password.html", message=None, error=None)

    @app.route("/reset-password/<token>", methods=["GET", "POST"])
    @_limit(settings.get("rate_limit_reset_password") or "6 per minute", methods=["POST"])
    def reset_password(token):
        """Complete the reset using token + Recovery PIN."""

        token_hash = hashlib.sha256((token or "").encode("utf-8")).hexdigest()
        conn = get_db()
        now = datetime.now(timezone.utc)

        # Validate token
        try:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT username, expires_at, used_at
                      FROM password_reset_tokens
                     WHERE token_hash = %s;
                    """,
                    (token_hash,),
                )
                row = cur.fetchone()
        except Exception as e:
            logging.warning("DB error loading reset token: %s", e)
            row = None

        if not row:
            return render_template("reset_password.html", error="Invalid or expired reset link", message=None, require_pin=True), 400

        username, expires_at, used_at = row[0], row[1], row[2]
        if used_at is not None or (expires_at and expires_at <= now):
            return render_template("reset_password.html", error="Invalid or expired reset link", message=None, require_pin=True), 400

        # Determine whether this account requires a Recovery PIN.
        require_pin = False
        try:
            with conn.cursor() as cur:
                cur.execute("SELECT recovery_pin_hash FROM users WHERE username = %s;", (username,))
                prow = cur.fetchone()
            require_pin = bool(prow and prow[0])
        except Exception as e:
            logging.warning('DB error checking recovery pin presence: %s', e)
            require_pin = True  # fail-closed

        if request.method == "POST":
            try:
                validate_csrf(request.form.get("csrf_token"))
            except ValidationError:
                return "Invalid CSRF token", 400

            pin = (request.form.get("recovery_pin") or "").strip()
            pw = request.form.get("new_password", "")
            confirm = request.form.get("confirm_password", "")
            if len(pw) < 8:
                return render_template("reset_password.html", error="Password too short (min 8)", message=None, require_pin=require_pin), 400
            if pw != confirm:
                return render_template("reset_password.html", error="Passwords must match", message=None, require_pin=require_pin), 400
            if require_pin and not (pin.isdigit() and len(pin) == 4):
                return render_template("reset_password.html", error="PIN must be 4 digits", message=None, require_pin=require_pin), 400

            # Load recovery state
            try:
                with conn.cursor() as cur:
                    cur.execute(
                        """
                        SELECT recovery_pin_hash, recovery_failed_attempts, recovery_locked_until
                          FROM users
                         WHERE username = %s;
                        """,
                        (username,),
                    )
                    urow = cur.fetchone()
            except Exception as e:
                logging.warning("DB error loading user recovery state: %s", e)
                urow = None

            if not urow:
                return render_template("reset_password.html", error="Account not found", message=None, require_pin=require_pin), 400

            if require_pin and not urow[0]:
                # Can't reset with PIN requirement if none is configured.
                return render_template("reset_password.html", error="Recovery PIN required but not configured. Contact an admin.", message=None, require_pin=require_pin), 400

            stored_pin_hash, failed_attempts, locked_until = urow[0], int(urow[1] or 0), urow[2]
            if require_pin and locked_until and locked_until > now:
                return render_template("reset_password.html", error="Too many incorrect PIN attempts. Try again later.", message=None, require_pin=require_pin), 429
            # Verify PIN
            if require_pin:
                ok_pin, upgraded_pin_hash = verify_password_and_upgrade(pin, stored_pin_hash)
                if not ok_pin:
                    failed_attempts += 1
                    new_locked_until = None
                    max_attempts = int(settings.get("recovery_pin_max_attempts", 5))
                    lock_min = int(settings.get("recovery_pin_lock_minutes", 15))
                    if failed_attempts >= max_attempts:
                        new_locked_until = now + timedelta(minutes=lock_min)
            
                    try:
                        with conn.cursor() as cur:
                            cur.execute(
                                """
                                UPDATE users
                                   SET recovery_failed_attempts = %s,
                                       recovery_locked_until = %s
                                 WHERE username = %s;
                                """,
                                (failed_attempts, new_locked_until, username),
                            )
                        conn.commit()
                    except Exception:
                        try:
                            conn.rollback()
                        except Exception:
                            pass
            
                    return render_template("reset_password.html", error="Invalid PIN", message=None, require_pin=require_pin), 400
            
                # Optional: upgrade stored PIN hash (legacy -> Argon2id)
                if upgraded_pin_hash:
                    try:
                        with conn.cursor() as cur:
                            cur.execute(
                                "UPDATE users SET recovery_pin_hash = %s WHERE username = %s;",
                                (upgraded_pin_hash, username),
                            )
                        conn.commit()
                    except Exception as e:
                        logging.warning("Could not upgrade recovery PIN hash for %s: %s", username, e)
            
            # Success: set password, consume token(s), reset counters, rotate E2EE keys, revoke sessions
            try:
                # Password-derived encryption means we must regenerate encrypted_private_key on reset.
                new_public, new_enc_priv = generate_user_keypair_for_password(pw)

                with conn.cursor() as cur:
                    cur.execute(
                        """
                        UPDATE users
                           SET password = %s,
                               public_key = %s,
                               encrypted_private_key = %s,
                               recovery_failed_attempts = 0,
                               recovery_locked_until = NULL
                         WHERE username = %s;
                        """,
                        (hash_password(pw), new_public, new_enc_priv, username),
                    )
                    # Consume *all* outstanding reset tokens for this user
                    cur.execute(
                        "UPDATE password_reset_tokens SET used_at = CURRENT_TIMESTAMP WHERE username = %s AND used_at IS NULL;",
                        (username,),
                    )
                conn.commit()

                try:
                    log_audit_event('anon', 'password_reset_complete', username, f"token={token_hash[:12]}...")
                except Exception:
                    pass

                try:
                    revoke_all_sessions_for_user(username, reason="password_reset")
                except Exception:
                    pass
            except Exception as e:
                logging.warning('DB error completing reset: %s', e)
                try:
                    conn.rollback()
                except Exception:
                    pass
                return render_template('reset_password.html', error='Error resetting password', message=None, require_pin=require_pin), 500

            resp = make_response(render_template('reset_password.html', message='Password reset. You may log in now.', error=None, require_pin=require_pin))
            # Clear any existing auth cookies so the browser doesn't try to reuse an old session.
            try:
                unset_jwt_cookies(resp)
            except Exception:
                pass
            return resp
        return render_template('reset_password.html', message=None, error=None, require_pin=require_pin)

    @app.route("/enable-2fa", methods=["GET", "POST"])
    @_limit(settings.get("rate_limit_enable_2fa") or "3 per minute", methods=["POST"])
    @jwt_required()
    def enable_2fa():
        import pyotp

        user = get_jwt_identity()
        try:
            conn = get_db()
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT two_factor_secret FROM users WHERE username = %s;",
                    (user,),
                )
                row = cur.fetchone()
        except Exception as e:
            logging.error("DB error in enable_2fa lookup: %s", e)
            return "Error", 500

        if row and row[0]:
            secret = row[0]
        else:
            secret = pyotp.random_base32()
            try:
                with conn.cursor() as cur:
                    cur.execute(
                        "UPDATE users SET two_factor_secret = %s WHERE username = %s;",
                        (secret, user),
                    )
                conn.commit()
            except Exception as e:
                logging.error("DB error setting two_factor_secret: %s", e)
                return "Error", 500

        if request.method == "POST":
            code = request.form.get("code", "")
            if pyotp.TOTP(secret).verify(code):
                try:
                    with conn.cursor() as cur:
                        cur.execute(
                            "UPDATE users SET two_factor_enabled = TRUE WHERE username = %s;",
                            (user,),
                        )
                    conn.commit()
                except Exception as e:
                    logging.error("DB error enabling 2FA: %s", e)
                    return "Error", 500
                return "2FA Enabled ✅", 200
            else:
                return "Invalid code", 400

        uri = pyotp.TOTP(secret).provisioning_uri(
            name=user, issuer_name=settings.get("server_name")
        )
        return f"""
        <h2>Enable 2FA</h2>
        <p>Scan in Google Authenticator:</p>
        <pre>{uri}</pre>
        <form method="post">
            <input name="code" placeholder="123456" required>
            <button type="submit">Enable</button>
        </form>
        """

    @app.route("/get_public_key", methods=["GET"])
    @jwt_required()
    def get_public_key():
        target = request.args.get("username", "").strip()
        if not target:
            return jsonify({"error": "username required"}), 400

        conn = get_db()
        public_pem = get_public_key_for_username(conn, target)
        if not public_pem:
            if user_exists(conn, target):
                return jsonify({"error": "no_public_key"}), 409
            return jsonify({"error": "user not found"}), 404
        return jsonify({"public_key": public_pem}), 200
