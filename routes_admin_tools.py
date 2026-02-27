#!/usr/bin/env python3
"""routes_admin_tools.py

Admin tool endpoints (PostgreSQL).

This file previously used SQLite (DB_FILE). It now uses get_db() and
PostgreSQL-safe SQL.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
import json
import os
import random
from pathlib import Path

from flask import jsonify, request, session, current_app
from flask_jwt_extended import get_jwt_identity, verify_jwt_in_request

from database import get_db, get_db_identity, get_schema_version
from database import create_user_with_keys, user_exists, email_in_use, revoke_all_tokens_for_user, generate_user_keypair_for_password
from permissions import require_permission, get_user_permissions
from security import hash_password, log_audit_event
from constants import CONFIG_FILE, redact_postgres_dsn, get_db_connection_string
from secrets_policy import scrub_patch_for_persist

try:
    # Imported only to read live connection state and perform server-side disconnect/kick.
    from socket_handlers import CONNECTED_USERS, CONNECTED_USERS_LOCK, VOICE_ROOMS, VOICE_ROOMS_LOCK
except Exception:  # pragma: no cover
    CONNECTED_USERS = {}
    CONNECTED_USERS_LOCK = None
    VOICE_ROOMS = {}
    VOICE_ROOMS_LOCK = None


def _utcnow():
    return datetime.now(timezone.utc)


# Process start time (best-effort) for uptime reporting in /admin/stats.
STARTED_AT = _utcnow()


def register_admin_tools(app, settings, socketio=None, limiter=None):
    """Register admin endpoints.


    socketio is optional; if provided, global_broadcast will emit live.
    
    """

    # Snapshot existing routes/endpoints so we can add robust alias rules at the end
    # (prevents admin UI 404s when URL prefixes drift between versions).
    _ecap_pre_rules = {r.rule for r in app.url_map.iter_rules()}
    _ecap_pre_endpoints = set(app.view_functions.keys())


    # --------------------------------------------------------------
    # Debug config endpoint (super-admin only, local by default)
    # --------------------------------------------------------------
    def _is_local_request() -> bool:
        try:
            ra = (request.remote_addr or "").strip()
            return ra in ("127.0.0.1", "::1")
        except Exception:
            return False

    def _scrub(obj):
        # Redact likely-secret fields recursively.
        if isinstance(obj, dict):
            out = {}
            for k, v in obj.items():
                kl = str(k).lower()
                if any(x in kl for x in ("password", "pass", "secret", "token", "jwt", "key")):
                    # Preserve shape but redact values.
                    out[k] = "***" if v not in (None, "", False, 0) else v
                elif kl in ("database_url", "db_connection_string", "database", "dsn"):
                    out[k] = redact_postgres_dsn(str(v)) if v else v
                else:
                    out[k] = _scrub(v)
            return out
        if isinstance(obj, list):
            return [_scrub(x) for x in obj]
        return obj

    @app.get("/api/debug/config")
    @require_permission("admin:super")
    def _debug_config():
        # In production we default to local-only. Can be overridden by setting:
        #   debug_config_allow_remote: true
        allow_remote = bool(settings.get("debug_config_allow_remote", False))
        if not allow_remote and not _is_local_request():
            return jsonify({"error": "Forbidden (local requests only)"}), 403

        settings_file_path = current_app.config.get("ECHOCHAT_SETTINGS_FILE")
        runtime_settings = current_app.config.get("ECHOCHAT_SETTINGS") or {}
        dsn = get_db_connection_string(runtime_settings if isinstance(runtime_settings, dict) else settings)

        payload = {
            "app": {
                "settings_file": settings_file_path,
                "config_file_default_name": CONFIG_FILE,
            },
            "db": {
                "configured_dsn": redact_postgres_dsn(dsn),
                "identity": get_db_identity(),
                "schema_version": get_schema_version(),
            },
            "settings": _scrub(runtime_settings),
        }
        return jsonify(payload)


    def _get_user_id(username: str) -> int | None:
        conn = get_db()
        with conn.cursor() as cur:
            cur.execute("SELECT id FROM users WHERE username = %s;", (username,))
            row = cur.fetchone()
        return row[0] if row else None

    def _connected_usernames() -> list[str]:
        """Best-effort list of currently connected usernames."""
        if CONNECTED_USERS_LOCK is None:
            return []
        with CONNECTED_USERS_LOCK:
            return sorted({(u or {}).get("username") for u in CONNECTED_USERS.values() if (u or {}).get("username")})

    def _user_sids(username: str) -> list[str]:
        if CONNECTED_USERS_LOCK is None:
            return []
        with CONNECTED_USERS_LOCK:
            return [sid for sid, u in CONNECTED_USERS.items() if (u or {}).get("username") == username]

    def _room_policy_snapshot(room: str) -> dict:
        """Read current room policy flags from the DB (best-effort)."""
        room = (room or '').strip()
        locked = False
        readonly = False
        slowmode_seconds = 0
        try:
            conn = get_db()
            with conn.cursor() as cur:
                cur.execute('SELECT locked FROM room_locks WHERE room = %s;', (room,))
                row = cur.fetchone()
                if row is not None:
                    locked = bool(row[0])
        except Exception:
            pass
        try:
            conn = get_db()
            with conn.cursor() as cur:
                cur.execute('SELECT readonly FROM room_readonly WHERE room = %s;', (room,))
                row = cur.fetchone()
                if row is not None:
                    readonly = bool(row[0])
        except Exception:
            pass
        try:
            conn = get_db()
            with conn.cursor() as cur:
                cur.execute('SELECT seconds FROM room_slowmode WHERE room = %s;', (room,))
                row = cur.fetchone()
                if row is not None and row[0] is not None:
                    slowmode_seconds = int(row[0])
        except Exception:
            pass

        return {
            'room': room,
            'locked': locked,
            'readonly': readonly,
            'slowmode_seconds': max(0, int(slowmode_seconds or 0)),
            'ts': datetime.now(timezone.utc).isoformat(),
        }

    def _policy_for_user(username: str, policy: dict) -> dict:
        """Compute can_send flags for a specific user given a policy snapshot."""
        perms = set()
        try:
            perms = set(get_user_permissions(username))
        except Exception:
            perms = set()

        bypass_lock = ('admin:super' in perms) or ('room:lock' in perms)
        bypass_ro = ('admin:super' in perms) or ('room:readonly' in perms)

        locked = bool(policy.get('locked'))
        readonly = bool(policy.get('readonly'))

        can_send = (not locked or bypass_lock) and (not readonly or bypass_ro)
        block_reason = None
        if not can_send:
            if readonly and not bypass_ro:
                block_reason = 'read_only'
            elif locked and not bypass_lock:
                block_reason = 'locked'
            else:
                block_reason = 'blocked'

        return {
            'can_send': bool(can_send),
            'can_override_lock': bool(bypass_lock),
            'can_override_readonly': bool(bypass_ro),
            'block_reason': block_reason,
        }

    def _emit_room_policy(room: str, actor: str | None = None) -> None:
        """Push current room policy to every connected member (per-user can_send)."""
        if not socketio or CONNECTED_USERS_LOCK is None:
            return
        policy = _room_policy_snapshot(room)
        if actor:
            policy['set_by'] = actor

        with CONNECTED_USERS_LOCK:
            targets = [(sid, (u or {}).get('username')) for sid, u in CONNECTED_USERS.items() if (u or {}).get('room') == room]

        for sid, uname in targets:
            if not uname:
                continue
            payload = dict(policy)
            payload.update(_policy_for_user(uname, policy))
            try:
                socketio.emit('room_policy_state', payload, to=sid)
            except Exception:
                pass

    def _disconnect_user(username: str) -> int:
        """Hard-disconnect all active Socket.IO sessions for a user. Returns count."""
        if not socketio:
            return 0
        sids = _user_sids(username)
        n = 0
        for sid in sids:
            try:
                socketio.server.disconnect(sid)  # namespace '/'
                n += 1
            except Exception:
                pass
        return n

    def _kick_user_from_room(username: str, room: str) -> int:
        """Force the user to leave a room (server-side). Returns number of sids affected."""
        if not socketio:
            return 0
        sids = _user_sids(username)
        affected = 0
        for sid in sids:
            try:
                socketio.server.leave_room(sid, room)
                affected += 1
            except Exception:
                continue
            # Best-effort: clear room pointer in the in-memory registry.
            if CONNECTED_USERS_LOCK is not None:
                try:
                    with CONNECTED_USERS_LOCK:
                        if sid in CONNECTED_USERS:
                            CONNECTED_USERS[sid]["room"] = None
                except Exception:
                    pass
        return affected

    def _actor() -> str:
        """Return the best-effort acting username for audit logs.

        Important: Some admin endpoints may be allowed via the session-based
        super-admin override, which can bypass JWT verification. In those cases,
        calling get_jwt_identity() directly will raise. We therefore:
          1) optionally verify a JWT (if present) to populate context,
          2) use JWT identity if available,
          3) fall back to session username.
        """
        try:
            verify_jwt_in_request(optional=True)
            u = get_jwt_identity()
            if u:
                return str(u)
        except Exception:
            pass
        return str(session.get("username") or "unknown")

    # ── Snapshot / stats ───────────────────────────────────────────
    @app.route("/admin/stats")
    @require_permission("admin:basic")
    def admin_stats():
        """Lightweight operational stats for the injected admin panel."""
        conn = get_db()
        with conn.cursor() as cur:
            cur.execute("SELECT COUNT(*) FROM users;")
            registered = int(cur.fetchone()[0])
            cur.execute("SELECT COUNT(*) FROM users WHERE online = TRUE;")
            online_db = int(cur.fetchone()[0])
            cur.execute("SELECT COUNT(*) FROM chat_rooms;")
            rooms = int(cur.fetchone()[0])

            # Optional: Postgres version string (for diagnostics).
            pg_version = None
            try:
                cur.execute("SHOW server_version;")
                pg_version = (cur.fetchone() or [None])[0]
            except Exception:
                pg_version = None

        # Prefer live Socket.IO roster if available.
        live = _connected_usernames()
        online_live = len(live) if live else online_db

        # Voice snapshot (best-effort).
        voice_rooms = 0
        voice_total_users = 0
        voice_by_room = {}
        if VOICE_ROOMS_LOCK is not None:
            try:
                with VOICE_ROOMS_LOCK:
                    voice_rooms = len(VOICE_ROOMS or {})
                    for room, users in (VOICE_ROOMS or {}).items():
                        c = len(users or [])
                        voice_total_users += c
                        voice_by_room[str(room)] = c
            except Exception:
                voice_rooms = 0
                voice_total_users = 0
                voice_by_room = {}

        uptime_seconds = max(0, int((_utcnow() - STARTED_AT).total_seconds()))

        return jsonify(
            {
                # Back-compat keys
                "registered_users": registered,
                "online_users": online_live,
                "online_usernames": live,
                "rooms": rooms,
                "server_time": _utcnow().isoformat(),

                # Extra ops detail
                "uptime_seconds": uptime_seconds,
                "postgres_version": pg_version,
                "connected_sessions": int(len(live) or 0),
                "voice_rooms": voice_rooms,
                "voice_total_users": voice_total_users,
                "voice_by_room": voice_by_room,
                "settings_snapshot": {
                    "voice_enabled": bool(settings.get("voice_enabled", True)),
                    "voice_max_room_peers": int(settings.get("voice_max_room_peers", 0) or 0),
                    "p2p_file_enabled": bool(settings.get("p2p_file_enabled", True)),
                    "giphy_enabled": bool(settings.get("giphy_enabled", True)),
                },
            }
        )

    # ── Runtime settings (admin GUI) ──────────────────────────────
    def _settings_path() -> Path:
        """Return the live settings JSON path (best-effort)."""
        p = (current_app.config.get("ECHOCHAT_SETTINGS_FILE") or CONFIG_FILE) if current_app else CONFIG_FILE
        return Path(str(p))

    def _persist_settings_patch(patch: dict) -> bool:
        """Persist a small patch into the settings JSON without clobbering other keys."""
        try:
            patch = scrub_patch_for_persist(patch or {})
            if not patch:
                # Likely only secret keys were supplied while persistence is disabled.
                return False
            path = _settings_path()
            existing = {}
            if path.exists():
                try:
                    existing = json.loads(path.read_text(encoding="utf-8") or "{}")
                    if not isinstance(existing, dict):
                        existing = {}
                except Exception:
                    # Back up invalid settings file rather than overwriting it silently.
                    ts = datetime.now().strftime("%Y%m%d-%H%M%S")
                    try:
                        bad = path.with_suffix(path.suffix + f".bad-{ts}")
                        path.rename(bad)
                    except Exception:
                        pass
                    existing = {}

            merged = dict(existing)
            merged.update(patch or {})
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps(merged, indent=2), encoding="utf-8")
            return True
        except Exception:
            return False

    def _enforce_voice_room_limit(max_peers: int) -> dict:
        """If max_peers > 0, randomly disconnect extra voice users to satisfy the limit."""
        result = {"kicked": 0, "kicked_by_room": {}}
        if not socketio or VOICE_ROOMS_LOCK is None:
            return result
        if int(max_peers) <= 0:
            return result

        kicked: list[tuple[str, str]] = []  # (room, username)
        rosters_after: dict[str, list[str]] = {}

        with VOICE_ROOMS_LOCK:
            for room, users in list((VOICE_ROOMS or {}).items()):
                if not users:
                    continue
                if len(users) <= max_peers:
                    continue
                excess = len(users) - max_peers
                drop = random.sample(list(users), k=excess)
                for u in drop:
                    try:
                        users.discard(u)
                    except Exception:
                        pass
                    kicked.append((room, u))
                # Clean empty rooms
                if not users:
                    try:
                        del VOICE_ROOMS[room]
                    except Exception:
                        pass
                else:
                    rosters_after[room] = sorted(users)

        # Notify clients outside the lock.
        for room, u in kicked:
            result["kicked_by_room"].setdefault(room, []).append(u)
            # Tell the user(s) they were removed from voice.
            try:
                for sid in _user_sids(u):
                    socketio.emit(
                        "voice_room_forced_leave",
                        {"room": room, "reason": "voice_limit_reduced", "limit": max_peers},
                        to=sid,
                    )
            except Exception:
                pass
            # Tell everyone in the chat room that this user left voice.
            try:
                socketio.emit("voice_room_user_left", {"room": room, "username": u}, room=room)
            except Exception:
                pass

        # Broadcast updated rosters for rooms we modified.
        for room, roster in rosters_after.items():
            try:
                socketio.emit("voice_room_roster", {"room": room, "users": roster, "limit": max_peers}, room=room)
            except Exception:
                pass

        result["kicked"] = len(kicked)
        return result

    @app.route("/admin/settings/voice", methods=["GET"])
    @require_permission("admin:basic")
    def admin_get_voice_settings():
        """Return current voice settings for the injected admin panel."""
        return jsonify(
            {
                "ok": True,
                "voice_enabled": bool(settings.get("voice_enabled", True)),
                "voice_max_room_peers": int(settings.get("voice_max_room_peers", 0) or 0),
            }
        )

    @app.route("/admin/settings/voice", methods=["POST"])
    @require_permission("admin:basic")
    def admin_set_voice_settings():
        """Update voice settings.

        Security note:
          - This endpoint requires RBAC admin:basic. If you want to restrict it
            further, swap to require_permission("admin:super").
        """

        actor = _actor()

        # Accept form-encoded or JSON payloads.
        raw = None
        try:
            raw = request.form.get("voice_max_room_peers")
        except Exception:
            raw = None
        if raw is None:
            try:
                raw = (request.get_json(silent=True) or {}).get("voice_max_room_peers")
            except Exception:
                raw = None

        try:
            if raw is None or str(raw).strip() == "":
                new_limit = 0
            else:
                new_limit = int(str(raw).strip())
        except Exception:
            return jsonify({"ok": False, "error": "voice_max_room_peers must be an integer"}), 400

        # Clamp: 0 => unlimited, otherwise enforce a sane upper bound.
        if new_limit < 0:
            new_limit = 0
        if new_limit > 500:
            return jsonify({"ok": False, "error": "voice_max_room_peers too large (max 500 or 0 for unlimited)"}), 400

        settings["voice_max_room_peers"] = new_limit
        persisted = _persist_settings_patch({"voice_max_room_peers": new_limit})

        # Enforce immediately for active voice rooms.
        enforcement = _enforce_voice_room_limit(new_limit)

        try:
            log_audit_event(actor, "set_voice_room_limit", "*", f"voice_max_room_peers={new_limit} persisted={persisted} kicked={enforcement.get('kicked', 0)}")
        except Exception:
            pass

        return jsonify(
            {
                "ok": True,
                "voice_max_room_peers": new_limit,
                "persisted": bool(persisted),
                "kicked": int(enforcement.get("kicked", 0) or 0),
                "kicked_by_room": enforcement.get("kicked_by_room", {}),
            }
        )


    # ── Settings: GIFs (GIPHY) (persisted + runtime) ───────────────────
    def _has_giphy_key() -> bool:
        try:
            v = (os.getenv("ECHOCHAT_GIPHY_API_KEY") or os.getenv("GIPHY_API_KEY") or str(settings.get("giphy_api_key") or "")).strip()
            if v:
                return True
            base_dir = Path(__file__).resolve().parent
            candidates = [
                Path.cwd() / ".giphy_api_key",
                Path.cwd() / "giphy_api_key.txt",
                base_dir / ".giphy_api_key",
                base_dir / "giphy_api_key.txt",
            ]
            for p in candidates:
                try:
                    if p.exists() and p.read_text(encoding="utf-8").strip():
                        return True
                except Exception:
                    continue
        except Exception:
            pass
        return False

    @app.route("/admin/settings/gifs", methods=["GET", "POST"])
    @require_permission("admin:super")
    def admin_settings_gifs():
        """Read/patch GIF settings.

        Security note:
          - GET does NOT return the API key, only whether it is set.
          - POST can set/replace the key (persists into settings JSON).
        """
        if request.method == "GET":
            return jsonify(
                {
                    "ok": True,
                    "giphy_enabled": bool(settings.get("giphy_enabled", True)),
                    "giphy_rating": str(settings.get("giphy_rating", "pg-13") or "pg-13"),
                    "giphy_lang": str(settings.get("giphy_lang", "en") or "en"),
                    "giphy_default_limit": int(settings.get("giphy_default_limit", 24) or 24),
                    "has_key": bool(_has_giphy_key()),
                }
            )

        actor = _actor()
        payload = request.get_json(silent=True) or {}
        if not isinstance(payload, dict):
            return jsonify({"ok": False, "error": "Invalid JSON"}), 400

        patch = {}

        if "giphy_enabled" in payload:
            v = payload.get("giphy_enabled")
            patch["giphy_enabled"] = bool(v) if isinstance(v, bool) else str(v).strip().lower() in {"1", "true", "yes", "on"}

        if "giphy_rating" in payload:
            patch["giphy_rating"] = str(payload.get("giphy_rating") or "pg-13").strip()[:20] or "pg-13"

        if "giphy_lang" in payload:
            patch["giphy_lang"] = str(payload.get("giphy_lang") or "en").strip()[:10] or "en"

        if "giphy_default_limit" in payload:
            try:
                lim = int(payload.get("giphy_default_limit") or 24)
            except Exception:
                return jsonify({"ok": False, "error": "giphy_default_limit must be an integer"}), 400
            patch["giphy_default_limit"] = max(1, min(lim, 48))

        if "giphy_api_key" in payload:
            # Allow blanking the key.
            patch["giphy_api_key"] = str(payload.get("giphy_api_key") or "").strip()

        # Apply runtime
        for k, v in patch.items():
            settings[k] = v

        persisted = _persist_settings_patch(patch)

        try:
            # Don't log the raw key.
            safe_meta = ",".join([k for k in patch.keys()])
            log_audit_event(actor, "set_gif_settings", "*", f"keys={safe_meta} persisted={persisted}")
        except Exception:
            pass

        return jsonify(
            {
                "ok": True,
                "persisted": bool(persisted),
                "giphy_enabled": bool(settings.get("giphy_enabled", True)),
                "giphy_rating": str(settings.get("giphy_rating", "pg-13") or "pg-13"),
                "giphy_lang": str(settings.get("giphy_lang", "en") or "en"),
                "giphy_default_limit": int(settings.get("giphy_default_limit", 24) or 24),
                "has_key": bool(_has_giphy_key()),
            }
        )


    @app.route("/admin/users")
    @require_permission("admin:basic")
    def admin_list_users():
        """List users (prefix search) for quick admin lookups."""
        prefix = (request.args.get("prefix") or "").strip()
        limit = int(request.args.get("limit") or 50)
        limit = max(1, min(limit, 200))

        conn = get_db()
        with conn.cursor() as cur:
            if prefix:
                cur.execute(
                    """
                    SELECT username, is_admin, status, online, last_seen, presence_status, custom_status
                      FROM users
                     WHERE username ILIKE %s
                     ORDER BY username
                     LIMIT %s;
                    """,
                    (prefix + "%", limit),
                )
            else:
                cur.execute(
                    """
                    SELECT username, is_admin, status, online, last_seen, presence_status, custom_status
                      FROM users
                     ORDER BY username
                     LIMIT %s;
                    """,
                    (limit,),
                )
            rows = cur.fetchall() or []

        users = []
        for r in rows:
            users.append(
                {
                    "username": r[0],
                    "is_admin": bool(r[1]),
                    "status": r[2],
                    "online": bool(r[3]),
                    "last_seen": r[4].isoformat() if r[4] else None,
                    "presence_status": r[5],
                    "custom_status": r[6],
                }
            )

        return jsonify({"users": users})

    # ── Enhanced user search + detail (admin GUI) ─────────────────
    @app.route("/admin/user_search")
    @require_permission("admin:basic")
    def admin_user_search():
        """Search users by username/email/id with lightweight filters.

        Query params:
          - q: search string (optional)
          - mode: contains|prefix|exact|email|id (default contains)
          - online: 1/0 (online only)
          - admins: 1/0 (admins only)
          - status: any|active|deactivated (default any)
          - limit: max rows (default 50, max 200)
        """

        q = (request.args.get("q") or "").strip()
        mode = (request.args.get("mode") or "contains").strip().lower()
        online_only = (request.args.get("online") or "0").strip().lower() in {"1", "true", "yes", "on"}
        admins_only = (request.args.get("admins") or "0").strip().lower() in {"1", "true", "yes", "on"}
        status = (request.args.get("status") or "any").strip().lower()

        try:
            limit = int(request.args.get("limit") or 50)
        except Exception:
            limit = 50
        limit = max(1, min(limit, 200))

        where = []
        params = []

        if online_only:
            where.append("online = TRUE")
        if admins_only:
            where.append("is_admin = TRUE")
        if status in {"active", "deactivated"}:
            where.append("status = %s")
            params.append(status)

        if q:
            # ID search: allow exact id lookup.
            if mode == "id" and q.isdigit():
                where.append("id = %s")
                params.append(int(q))
            elif mode == "exact":
                where.append("(username = %s OR LOWER(email) = LOWER(%s))")
                params.extend([q, q])
            elif mode == "prefix":
                where.append("(username ILIKE %s OR email ILIKE %s)")
                params.extend([q + "%", q + "%"])
            elif mode == "email":
                where.append("email ILIKE %s")
                params.append("%" + q + "%")
            else:  # contains
                where.append("(username ILIKE %s OR email ILIKE %s)")
                params.extend(["%" + q + "%", "%" + q + "%"])

        sql = (
            "SELECT id, username, email, is_admin, status, online, last_seen, created_at, presence_status, custom_status, two_factor_enabled "
            "FROM users "
        )
        if where:
            sql += " WHERE " + " AND ".join(where)
        sql += " ORDER BY online DESC, LOWER(username) ASC LIMIT %s;"
        params.append(limit)

        conn = get_db()
        with conn.cursor() as cur:
            cur.execute(sql, tuple(params))
            rows = cur.fetchall() or []

        out = []
        for r in rows:
            out.append(
                {
                    "id": int(r[0]),
                    "username": r[1],
                    "email": r[2],
                    "is_admin": bool(r[3]),
                    "status": r[4],
                    "online": bool(r[5]),
                    "last_seen": r[6].isoformat() if r[6] else None,
                    "created_at": r[7].isoformat() if r[7] else None,
                    "presence_status": r[8],
                    "custom_status": r[9],
                    "two_factor_enabled": bool(r[10]),
                }
            )

        return jsonify({"users": out, "q": q, "mode": mode, "limit": limit})

    @app.route("/admin/user_detail/<username>")
    @require_permission("admin:basic")
    def admin_user_detail(username: str):
        """Return an enriched user snapshot for admin UX (no secrets)."""
        username = (username or "").strip()
        if not username:
            return jsonify({"error": "username required"}), 400

        conn = get_db()
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT id, username, email, is_admin, status, online, last_seen, created_at,
                       presence_status, custom_status, two_factor_enabled
                  FROM users
                 WHERE username = %s;
                """,
                (username,),
            )
            u = cur.fetchone()
            if not u:
                return jsonify({"error": "not_found"}), 404

            user_id = int(u[0])

            # Roles
            roles = []
            try:
                cur.execute(
                    """
                    SELECT r.name
                      FROM user_roles ur
                      JOIN roles r ON r.id = ur.role_id
                     WHERE ur.user_id = %s
                     ORDER BY LOWER(r.name);
                    """,
                    (user_id,),
                )
                roles = [r[0] for r in (cur.fetchall() or [])]
            except Exception:
                roles = []

            # Sanctions
            sanctions = []
            try:
                cur.execute(
                    """
                    SELECT sanction_type, reason, created_at, expires_at
                      FROM user_sanctions
                     WHERE username = %s
                     ORDER BY created_at DESC
                     LIMIT 25;
                    """,
                    (username,),
                )
                for s in (cur.fetchall() or []):
                    sanctions.append(
                        {
                            "type": s[0],
                            "reason": s[1],
                            "created_at": s[2].isoformat() if s[2] else None,
                            "expires_at": s[3].isoformat() if s[3] else None,
                        }
                    )
            except Exception:
                sanctions = []

            # Quota
            quota = None
            try:
                cur.execute(
                    "SELECT messages_per_hour, updated_at FROM user_quotas WHERE username = %s;",
                    (username,),
                )
                qrow = cur.fetchone()
                if qrow:
                    quota = {
                        "messages_per_hour": int(qrow[0]),
                        "updated_at": qrow[1].isoformat() if qrow[1] else None,
                    }
            except Exception:
                quota = None

            # Lightweight relationship counts
            counts = {"friends": 0, "groups": 0}
            try:
                cur.execute("SELECT COUNT(*) FROM friends WHERE user_id = %s OR friend_id = %s;", (user_id, user_id))
                counts["friends"] = int((cur.fetchone() or [0])[0] or 0)
            except Exception:
                pass
            try:
                cur.execute("SELECT COUNT(*) FROM group_members WHERE user_id = %s;", (user_id,))
                counts["groups"] = int((cur.fetchone() or [0])[0] or 0)
            except Exception:
                pass

        return jsonify(
            {
                "user": {
                    "id": user_id,
                    "username": u[1],
                    "email": u[2],
                    "is_admin": bool(u[3]),
                    "status": u[4],
                    "online": bool(u[5]),
                    "last_seen": u[6].isoformat() if u[6] else None,
                    "created_at": u[7].isoformat() if u[7] else None,
                    "presence_status": u[8],
                    "custom_status": u[9],
                    "two_factor_enabled": bool(u[10]),
                },
                "roles": roles,
                "sanctions": sanctions,
                "quota": quota,
                "counts": counts,
                "connected_sids": _user_sids(username),
            }
        )

    # ── Rooms snapshot for admin panel ───────────────────────────
    @app.route("/admin/rooms/list")
    @require_permission("admin:basic")
    def admin_rooms_list():
        # Live online counts are derived from Socket.IO session state.
        # Important: chat_rooms.member_count can drift if users have multiple tabs,
        # stale sockets, or disconnect events don’t fire in the expected order.
        # The admin panel should therefore display *online* (deduped by username)
        # rather than the persisted counter.
        live_counts: dict[str, set[str]] = {}
        if CONNECTED_USERS_LOCK is not None:
            try:
                with CONNECTED_USERS_LOCK:
                    for _sid, u in (CONNECTED_USERS or {}).items():
                        if not u:
                            continue
                        room = (u or {}).get("room")
                        uname = (u or {}).get("username")
                        if not room or not uname:
                            continue
                        live_counts.setdefault(str(room), set()).add(str(uname))
            except Exception:
                live_counts = {}

        conn = get_db()
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT r.name, r.member_count,
                       COALESCE(l.locked, FALSE) AS locked,
                       COALESCE(ro.readonly, FALSE) AS readonly,
                       COALESCE(sm.seconds, 0) AS slowmode_sec,
                       (cr.name IS NOT NULL) AS is_custom,
                       COALESCE(cr.is_private, FALSE) AS is_private,
                       cr.category, cr.subcategory,
                       cr.created_by,
                       cr.created_at,
                       cr.last_active_at
                  FROM chat_rooms r
             LEFT JOIN room_locks l ON l.room = r.name
             LEFT JOIN room_readonly ro ON ro.room = r.name
             LEFT JOIN room_slowmode sm ON sm.room = r.name
             LEFT JOIN custom_rooms cr ON cr.name = r.name
                 ORDER BY LOWER(r.name) ASC;
                """
            )
            rows = cur.fetchall() or []

        rooms = []
        for rr in rows:
            room_name = rr[0]
            live = live_counts.get(str(room_name), set()) if live_counts else set()
            rooms.append(
                {
                    "name": room_name,
                    # Persisted counter (kept for diagnostics/back-compat)
                    "member_count": int(rr[1] or 0),
                    # Live online (deduped by username)
                    "online_count": int(len(live) if live else 0),
                    "locked": bool(rr[2]),
                    "readonly": bool(rr[3]),
                    "slowmode_sec": int(rr[4] or 0),
                    "is_custom": bool(rr[5]),
                    "is_private": bool(rr[6]) if rr[5] else False,
                    "category": rr[7],
                    "subcategory": rr[8],
                    "created_by": rr[9],
                    "created_at": rr[10].isoformat() if rr[10] else None,
                    "last_active_at": rr[11].isoformat() if rr[11] else None,
                }
            )

        # Prefer sorting by live online count (more meaningful in practice).
        try:
            rooms.sort(key=lambda r: (int(r.get("online_count") or 0), str(r.get("name") or "").lower()), reverse=True)
        except Exception:
            pass

        return jsonify({"rooms": rooms, "ts": _utcnow().isoformat()})

    # ── Delete custom room (admin) ────────────────────────────────
    @app.route("/admin/rooms/delete/<path:room>", methods=["POST"])
    @require_permission("room:delete")
    def admin_room_delete(room):
        """Delete a *custom* room immediately (and force users out).

        Safety: official rooms (from chat_rooms.json) are not deletable through this endpoint.
        """
        room = (room or "").strip()
        if not room:
            return jsonify({"ok": False, "error": "missing_room"}), 400

        actor = _actor()
        reason = (request.form.get("reason") or "").strip()

        # Verify it's a custom room first (prevents accidentally deleting core rooms).
        conn = get_db()
        try:
            with conn.cursor() as cur:
                cur.execute("SELECT is_private FROM custom_rooms WHERE name=%s;", (room,))
                row = cur.fetchone()
        except Exception:
            row = None

        if not row:
            return jsonify({"ok": False, "error": "not_custom", "message": "Only custom rooms can be deleted."}), 400

        # Force-leave any connected users in this room (and voice).
        forced_leave = 0
        forced_voice_leave = 0

        # Voice first (so clients don't emit voice_room_leave when we force-leave the room UI).
        voice_users = []
        if VOICE_ROOMS_LOCK is not None:
            try:
                with VOICE_ROOMS_LOCK:
                    voice_users = sorted(list((VOICE_ROOMS or {}).get(room) or set()))
                    if room in (VOICE_ROOMS or {}):
                        try:
                            del VOICE_ROOMS[room]
                        except Exception:
                            pass
            except Exception:
                voice_users = []

        if socketio and voice_users:
            for uname in voice_users:
                for sid in _user_sids(uname):
                    try:
                        socketio.emit(
                            "voice_room_forced_leave",
                            {"room": room, "reason": "Room deleted", "limit": None},
                            to=sid,
                        )
                        forced_voice_leave += 1
                    except Exception:
                        pass

        # Now force-leave the text room.
        sids_in_room = []
        if CONNECTED_USERS_LOCK is not None:
            try:
                with CONNECTED_USERS_LOCK:
                    for sid, u in (CONNECTED_USERS or {}).items():
                        if not u:
                            continue
                        if (u or {}).get("room") == room:
                            sids_in_room.append((sid, (u or {}).get("username")))
            except Exception:
                sids_in_room = []

        if socketio and sids_in_room:
            for sid, _uname in sids_in_room:
                try:
                    socketio.emit(
                        "room_forced_leave",
                        {"room": room, "reason": "Room deleted"},
                        to=sid,
                    )
                except Exception:
                    pass
                try:
                    socketio.server.leave_room(sid, room)
                except Exception:
                    pass
                forced_leave += 1

        # Update in-memory registry so we don't show ghost membership.
        if CONNECTED_USERS_LOCK is not None and sids_in_room:
            try:
                with CONNECTED_USERS_LOCK:
                    for sid, _uname in sids_in_room:
                        if sid in CONNECTED_USERS:
                            CONNECTED_USERS[sid]["room"] = None
            except Exception:
                pass

        # Delete persisted state
        try:
            with conn.cursor() as cur:
                cur.execute("DELETE FROM custom_room_invites WHERE room_name=%s;", (room,))
                cur.execute("DELETE FROM messages WHERE room=%s;", (room,))
                cur.execute("DELETE FROM room_locks WHERE room=%s;", (room,))
                cur.execute("DELETE FROM room_readonly WHERE room=%s;", (room,))
                cur.execute("DELETE FROM room_slowmode WHERE room=%s;", (room,))
                # Optional tables (safe even if empty)
                try:
                    cur.execute("DELETE FROM room_message_expiry WHERE room=%s;", (room,))
                except Exception:
                    pass
                try:
                    cur.execute("DELETE FROM user_sanctions WHERE sanction_type=%s;", (f"room_ban:{room}",))
                except Exception:
                    pass

                cur.execute("DELETE FROM custom_rooms WHERE name=%s;", (room,))
                cur.execute("DELETE FROM chat_rooms WHERE name=%s;", (room,))
            conn.commit()
        except Exception as e:
            try:
                conn.rollback()
            except Exception:
                pass
            return jsonify({"ok": False, "error": "db", "details": str(e)}), 500

        # Audit + notify
        try:
            log_audit_event(actor, "room_delete", target=room, details=(reason or ""))
        except Exception:
            pass

        if socketio:
            try:
                socketio.emit("rooms_changed", {"deleted": room, "reason": "deleted_by_admin", "by": actor})
            except Exception:
                pass

        return jsonify({
            "ok": True,
            "room": room,
            "forced_leave": forced_leave,
            "forced_voice_leave": forced_voice_leave,
        })

    # ── Settings: general (persisted + runtime) ───────────────────
    @app.route("/admin/settings/general", methods=["GET", "POST"])
    @require_permission("admin:super")
    def admin_settings_general():
        """Read/patch a safe subset of settings from the admin panel.

        Note: Some settings take effect immediately (server-side checks), while
        some require client reload or server restart. The UI should annotate.
        """

        allow_keys = {
            # feature flags
            "voice_enabled": "bool",
            "p2p_file_enabled": "bool",
            "giphy_enabled": "bool",
            "disable_file_transfer_globally": "bool",
            "disable_group_files_globally": "bool",
            "require_dm_e2ee": "bool",
            "allow_plaintext_dm_fallback": "bool",
            # room history / cleanup
            "room_history_limit": "int",
            "room_history_page_size": "int",
            "allow_legacy_plaintext_room_history": "bool",
            "custom_room_idle_hours": "int",
            "custom_private_room_idle_hours": "int",
            "janitor_interval_seconds": "int",

            # limits
            "max_message_length": "int",
            "max_attachment_size": "int",
            "max_dm_file_bytes": "int",
            "max_group_upload_bytes": "int",
            "group_msg_rate_limit": "int",
            "group_msg_rate_window_sec": "int",
        }

        if request.method == "GET":
            out = {}
            for k in allow_keys.keys():
                out[k] = settings.get(k)
            # Some deployments still use max_group_file_bytes; mirror if present.
            if out.get("max_group_upload_bytes") is None and settings.get("max_group_file_bytes") is not None:
                out["max_group_upload_bytes"] = settings.get("max_group_file_bytes")
            return jsonify({"ok": True, "settings": out})

        actor = _actor()
        payload = request.get_json(silent=True) or {}
        if not isinstance(payload, dict):
            return jsonify({"error": "Invalid JSON"}), 400

        patch = {}
        for k, typ in allow_keys.items():
            if k not in payload:
                continue
            v = payload.get(k)
            try:
                if typ == "bool":
                    if isinstance(v, bool):
                        patch[k] = v
                    else:
                        patch[k] = str(v).strip().lower() in {"1", "true", "yes", "on"}
                else:
                    patch[k] = int(v)
            except Exception:
                return jsonify({"error": f"Invalid value for {k}"}), 400

        # Normalize and sanity-check a few.
        if "max_message_length" in patch:
            patch["max_message_length"] = max(50, min(int(patch["max_message_length"]), 20000))
        if "room_history_limit" in patch:
            patch["room_history_limit"] = max(0, min(int(patch["room_history_limit"]), 500))
        if "room_history_page_size" in patch:
            patch["room_history_page_size"] = max(1, min(int(patch["room_history_page_size"]), 500))
        if "custom_room_idle_hours" in patch:
            patch["custom_room_idle_hours"] = max(1, min(int(patch["custom_room_idle_hours"]), 24 * 365))
        if "custom_private_room_idle_hours" in patch:
            patch["custom_private_room_idle_hours"] = max(1, min(int(patch["custom_private_room_idle_hours"]), 24 * 365))
        if "janitor_interval_seconds" in patch:
            patch["janitor_interval_seconds"] = max(10, min(int(patch["janitor_interval_seconds"]), 3600))
        for key in ("max_attachment_size", "max_dm_file_bytes", "max_group_upload_bytes"):
            if key in patch:
                patch[key] = max(1024 * 256, min(int(patch[key]), 1024 * 1024 * 1024))  # 256KB..1GB
        if "group_msg_rate_limit" in patch:
            patch["group_msg_rate_limit"] = max(5, min(int(patch["group_msg_rate_limit"]), 10000))
        if "group_msg_rate_window_sec" in patch:
            patch["group_msg_rate_window_sec"] = max(10, min(int(patch["group_msg_rate_window_sec"]), 3600))

        if not patch:
            return jsonify({"error": "No changes"}), 400

        # Apply to runtime dict and persist to settings file.
        for k, v in patch.items():
            settings[k] = v
        persisted = _persist_settings_patch(patch)

        try:
            log_audit_event(actor, "set_general_settings", "*", json.dumps({"patch": patch, "persisted": bool(persisted)}))
        except Exception:
            pass

        return jsonify({"ok": True, "persisted": bool(persisted), "patch": patch})

    # ── Settings: anti-abuse (persisted + runtime) ───────────────────
    @app.route("/admin/settings/antiabuse", methods=["GET", "POST"])
    @require_permission("admin:super")
    def admin_settings_antiabuse():
        """Read/patch anti-abuse settings.

        These take effect immediately for Socket.IO handlers.
        """

        allow_keys = {
            # burst limits
            "room_msg_rate_limit": "str",
            "room_msg_rate_window_sec": "int",
            "dm_msg_rate_limit": "str",
            "dm_msg_rate_window_sec": "int",
            "file_offer_rate_limit": "str",
            "file_offer_rate_window_sec": "int",
            # slowmode
            "room_slowmode_default_sec": "int",
            # auto-mute
            "antiabuse_strikes_before_mute": "int",
            "antiabuse_strike_window_sec": "int",
            "antiabuse_auto_mute_minutes": "int",
            # join/create/friendreq flood control
            "room_join_rate_limit": "str",
            "room_join_rate_window_sec": "int",
            "room_create_rate_limit": "str",
            "room_create_rate_window_sec": "int",
            "allow_user_create_rooms": "bool",
            "max_room_name_length": "int",
            "friend_req_rate_limit": "str",
            "friend_req_rate_window_sec": "int",
            "friend_req_unique_targets_max": "int",
            "friend_req_unique_targets_window_sec": "int",
            # plaintext heuristics
            "max_links_per_message": "int",
            "max_magnets_per_message": "int",
            "max_mentions_per_message": "int",
            "dup_msg_window_sec": "int",
            "dup_msg_max": "int",
            "dup_msg_min_length": "int",
            "dup_msg_normalize": "bool",
        }

        if request.method == "GET":
            out = {k: settings.get(k) for k in allow_keys.keys()}
            return jsonify({"ok": True, "settings": out})

        actor = _actor()
        payload = request.get_json(silent=True) or {}
        if not isinstance(payload, dict):
            return jsonify({"error": "Invalid JSON"}), 400

        patch = {}
        for k, typ in allow_keys.items():
            if k not in payload:
                continue
            v = payload.get(k)
            try:
                if typ == "bool":
                    if isinstance(v, bool):
                        patch[k] = v
                    else:
                        patch[k] = str(v).strip().lower() in {"1", "true", "yes", "on"}
                elif typ == "int":
                    patch[k] = int(v)
                else:  # str
                    s = str(v).strip()
                    # Rate limit strings should be short and printable
                    if len(s) > 64:
                        return jsonify({"error": f"Value too long for {k}"}), 400
                    if any(ord(c) < 32 for c in s):
                        return jsonify({"error": f"Invalid characters for {k}"}), 400
                    patch[k] = s
            except Exception:
                return jsonify({"error": f"Invalid value for {k}"}), 400

        # Bounds/sanity
        def clamp_int(key: str, lo: int, hi: int):
            if key in patch:
                patch[key] = max(lo, min(int(patch[key]), hi))

        # windows
        for w in (
            "room_msg_rate_window_sec",
            "dm_msg_rate_window_sec",
            "file_offer_rate_window_sec",
            "room_join_rate_window_sec",
            "room_create_rate_window_sec",
            "friend_req_rate_window_sec",
            "friend_req_unique_targets_window_sec",
        ):
            clamp_int(w, 1, 3600)

        clamp_int("room_slowmode_default_sec", 0, 3600)
        clamp_int("antiabuse_strikes_before_mute", 1, 100)
        clamp_int("antiabuse_strike_window_sec", 5, 600)
        clamp_int("antiabuse_auto_mute_minutes", 1, 1440)
        clamp_int("max_room_name_length", 8, 128)

        clamp_int("max_links_per_message", 0, 100)
        clamp_int("max_magnets_per_message", 0, 50)
        clamp_int("max_mentions_per_message", 0, 100)
        clamp_int("dup_msg_window_sec", 0, 300)
        clamp_int("dup_msg_max", 1, 50)
        clamp_int("dup_msg_min_length", 1, 1000)

        if not patch:
            return jsonify({"error": "No changes"}), 400

        for k, v in patch.items():
            settings[k] = v

        persisted = _persist_settings_patch(patch)

        try:
            log_audit_event(actor, "set_antiabuse_settings", "*", json.dumps({"patch": patch, "persisted": bool(persisted)}))
        except Exception:
            pass

        return jsonify({"ok": True, "persisted": bool(persisted), "patch": patch})

    # ── Audit log viewer ──────────────────────────────────────────
    @app.route("/admin/audit/recent")
    @require_permission("admin:basic")
    def admin_audit_recent():
        q = (request.args.get("q") or "").strip()
        try:
            limit = int(request.args.get("limit") or 50)
        except Exception:
            limit = 50
        limit = max(1, min(limit, 200))

        conn = get_db()
        with conn.cursor() as cur:
            if q:
                cur.execute(
                    """
                    SELECT actor, action, target, timestamp, details
                      FROM audit_log
                     WHERE actor ILIKE %s
                        OR action ILIKE %s
                        OR COALESCE(target,'') ILIKE %s
                        OR COALESCE(details,'') ILIKE %s
                     ORDER BY timestamp DESC
                     LIMIT %s;
                    """,
                    (f"%{q}%", f"%{q}%", f"%{q}%", f"%{q}%", limit),
                )
            else:
                cur.execute(
                    """
                    SELECT actor, action, target, timestamp, details
                      FROM audit_log
                     ORDER BY timestamp DESC
                     LIMIT %s;
                    """,
                    (limit,),
                )
            rows = cur.fetchall() or []

        out = []
        for r in rows:
            out.append(
                {
                    "actor": r[0],
                    "action": r[1],
                    "target": r[2],
                    "timestamp": r[3].isoformat() if r[3] else None,
                    "details": r[4],
                }
            )
        return jsonify({"ok": True, "events": out, "q": q, "limit": limit})

    @app.route("/admin/create_user", methods=["POST"])
    @require_permission("admin:super")
    def admin_create_user():
        """Create a user (with RSA keys) from the admin panel."""
        actor = _actor()
        username = (request.form.get("username") or "").strip()
        password = (request.form.get("password") or "").strip()
        email = (request.form.get("email") or "").strip().lower() or None
        recovery_pin = (request.form.get("recovery_pin") or "").strip()
        is_admin_flag = (request.form.get("is_admin") or "0").strip() in {"1", "true", "yes", "on"}

        # Basic validation (keep it strict; UI can relax later).
        import re

        if not username or not re.match(r"^[a-zA-Z0-9_.-]{3,32}$", username):
            return jsonify({"error": "Invalid username"}), 400
        if len(password) < 8:
            return jsonify({"error": "Password too short (min 8)"}), 400
        if not email:
            return jsonify({"error": "Email required"}), 400
        if not (recovery_pin.isdigit() and len(recovery_pin) == 4):
            return jsonify({"error": "Recovery PIN must be exactly 4 digits"}), 400

        conn = get_db()
        if user_exists(conn, username):
            return jsonify({"error": "User already exists"}), 409
        if email and email_in_use(conn, email):
            return jsonify({"error": "Email already in use"}), 409

        try:
            create_user_with_keys(
                conn,
                username=username,
                raw_password=password,
                password_hash=hash_password(password),
                email=email,
                is_admin=bool(is_admin_flag),
                recovery_pin_hash=hash_password(recovery_pin),
                recovery_pin_set_at=datetime.now(timezone.utc),
            )

            # Ensure RBAC role assignment. Admin users get the seeded 'admin' role; others get 'viewer'.
            role_name = "admin" if is_admin_flag else "viewer"
            with conn.cursor() as cur:
                cur.execute("SELECT id FROM users WHERE username = %s;", (username,))
                user_row = cur.fetchone()
                cur.execute("SELECT id FROM roles WHERE name = %s;", (role_name,))
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

            log_audit_event(actor, "create_user", username, f"role={role_name}")
            return jsonify({"status": "created", "user": username, "role": role_name})
        except Exception as e:
            try:
                conn.rollback()
            except Exception:
                pass
            msg = str(e)
            low = msg.lower()
            if "unique" in low or "duplicate" in low:
                if "users_email_unique_ci" in low or "lower(email" in low or "email" in low:
                    return jsonify({"error": "Email already in use"}), 409
                return jsonify({"error": "User already exists"}), 409
            return jsonify({"error": msg}), 500

    
    @app.route("/admin/set_recovery_pin", methods=["POST"])
    @require_permission("admin:super")
    def admin_set_recovery_pin():
        """Admin: set/reset a user's 4-digit Recovery PIN."""
        actor = _actor()
        username = (request.form.get("username") or "").strip()
        pin = (request.form.get("recovery_pin") or "").strip()

        if not username:
            return jsonify({"error": "Username required"}), 400
        if not (pin.isdigit() and len(pin) == 4):
            return jsonify({"error": "Recovery PIN must be exactly 4 digits"}), 400

        conn = get_db()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    UPDATE users
                       SET recovery_pin_hash = %s,
                           recovery_pin_set_at = CURRENT_TIMESTAMP,
                           recovery_failed_attempts = 0,
                           recovery_locked_until = NULL
                     WHERE username = %s;
                    """,
                    (hash_password(pin), username),
                )
                if cur.rowcount == 0:
                    conn.rollback()
                    return jsonify({"error": "User not found"}), 404
            conn.commit()
            log_audit_event(actor, "set_recovery_pin", username, "admin_reset")
            return jsonify({"status": "ok", "user": username})
        except Exception as e:
            try:
                conn.rollback()
            except Exception:
                pass
            return jsonify({"error": str(e)}), 500

# ── User lifecycle ──────────────────────────────────────────────
    @app.route("/admin/delete_user/<username>", methods=["POST"])
    @require_permission("admin:super")
    def delete_user(username):
        actor = _actor()
        user_id = _get_user_id(username)
        if not user_id:
            return jsonify({"error": "User not found"}), 404

        conn = get_db()
        try:
            with conn.cursor() as cur:
                # Messages / DMs
                cur.execute(
                    "DELETE FROM messages WHERE sender = %s OR receiver = %s;",
                    (username, username),
                )
                cur.execute(
                    "DELETE FROM private_messages WHERE sender = %s OR recipient = %s;",
                    (username, username),
                )

                # Social graph
                cur.execute(
                    "DELETE FROM friends WHERE user_id = %s OR friend_id = %s;",
                    (user_id, user_id),
                )
                cur.execute(
                    "DELETE FROM friend_requests WHERE from_user = %s OR to_user = %s;",
                    (username, username),
                )
                cur.execute(
                    "DELETE FROM blocks WHERE blocker = %s OR blocked = %s;",
                    (username, username),
                )
                cur.execute(
                    "DELETE FROM blocked_users WHERE user_id = %s OR blocked_id = %s;",
                    (user_id, user_id),
                )

                # Groups
                cur.execute("DELETE FROM group_members WHERE user_id = %s;", (user_id,))
                cur.execute(
                    "DELETE FROM group_invites WHERE from_user = %s OR to_user = %s;",
                    (username, username),
                )
                cur.execute(
                    "DELETE FROM group_mutes WHERE username = %s;",
                    (username,),
                )

                # Moderation
                cur.execute("DELETE FROM user_sanctions WHERE username = %s;", (username,))

                # Settings/notifications
                cur.execute("DELETE FROM chat_settings WHERE user_id = %s;", (user_id,))
                cur.execute("DELETE FROM notifications WHERE user_id = %s;", (user_id,))

                # RBAC (user_roles is FK'd to users; explicit delete is fine)
                cur.execute("DELETE FROM user_roles WHERE user_id = %s;", (user_id,))

                # Finally user
                cur.execute("DELETE FROM users WHERE id = %s;", (user_id,))

            conn.commit()
            log_audit_event(actor, "delete_user", username, "Full account deleted")
            return jsonify({"status": "deleted", "user": username})
        except Exception as e:
            conn.rollback()
            return jsonify({"error": str(e)}), 500

    @app.route("/admin/suspend_user/<username>", methods=["POST"])
    @require_permission("admin:basic")
    def suspend_user(username):
        actor = _actor()
        minutes = int(request.form.get("minutes", 60))
        reason = request.form.get("reason", "Suspended by admin")
        expires_at = _utcnow() + timedelta(minutes=minutes)

        conn = get_db()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO user_sanctions (username, sanction_type, reason, expires_at)
                    VALUES (%s, 'ban', %s, %s);
                    """,
                    (username, reason, expires_at),
                )
            conn.commit()
            log_audit_event(actor, "suspend_user", username, f"{minutes} min suspension")
            return jsonify({"status": "suspended", "user": username, "duration": minutes})
        except Exception as e:
            conn.rollback()
            return jsonify({"error": str(e)}), 500

    @app.route("/admin/deactivate_user/<username>", methods=["POST"])
    @require_permission("admin:basic")
    def deactivate_user(username):
        actor = _actor()
        conn = get_db()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE users SET status = 'deactivated', online = FALSE WHERE username = %s;",
                    (username,),
                )
            conn.commit()
            log_audit_event(actor, "deactivate_user", username, "Soft deactivation")
            return jsonify({"status": "deactivated", "user": username})
        except Exception as e:
            conn.rollback()
            return jsonify({"error": str(e)}), 500

    @app.route("/admin/force_logout/<username>", methods=["POST"])
    @require_permission("admin:basic")
    def force_logout(username):
        actor = _actor()
        reason = (request.form.get("reason") or "Logged out by an admin").strip()
        log_audit_event(actor, "force_logout", username, reason)

        # Tell the client WHY, so it can show the login screen message.
        # Emit first (best effort), then revoke/disconnect.
        payload = {"username": username, "reason": reason, "by": actor, "action": "force_logout"}
        try:
            if socketio is not None:
                for sid in _user_sids(username):
                    try:
                        socketio.emit("force_logout", payload, to=sid)
                        # Back-compat for older clients
                        socketio.emit("admin_force_logout", payload, to=sid)
                    except Exception:
                        pass
        except Exception:
            pass

        # Revoke all known tokens for the user to prevent immediate reconnect.
        try:
            revoke_all_tokens_for_user(username, reason="admin_force_logout")
        except Exception:
            pass

        disconnected = _disconnect_user(username)

        return jsonify(
            {
                "status": "logout_requested",
                "user": username,
                "reason": reason,
                "disconnected_sessions": disconnected,
                "tokens_revoked": True,
            }
        )


    @app.route("/admin/ban_ip", methods=["POST"])
    @require_permission("admin:super")
    def ban_ip():
        actor = _actor()
        ip = (request.form.get("ip") or "").strip()
        reason = request.form.get("reason", "Manual IP ban")
        if not ip:
            return jsonify({"error": "Missing IP"}), 400

        conn = get_db()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO user_sanctions (username, sanction_type, reason)
                    VALUES (%s, 'ip_ban', %s);
                    """,
                    (ip, reason),
                )
            conn.commit()
            log_audit_event(actor, "ban_ip", ip, reason)
            return jsonify({"status": "ip_banned", "ip": ip})
        except Exception as e:
            conn.rollback()
            return jsonify({"error": str(e)}), 500

    @app.route("/admin/reset_password/<username>", methods=["POST"])
    @require_permission("admin:super")
    def admin_reset_password(username):
        actor = _actor()
        new_pw = (request.form.get("new_password") or "").strip()
        if not new_pw:
            return jsonify({"error": "Missing password"}), 400

        conn = get_db()
        try:
            # Password-derived encryption means we must rotate the user's E2EE keypair
            # when an admin resets their password. Otherwise login succeeds but DM unlock fails.
            new_public, new_enc_priv = generate_user_keypair_for_password(new_pw)
            with conn.cursor() as cur:
                cur.execute(
                    """
                    UPDATE users
                       SET password = %s,
                           public_key = %s,
                           encrypted_private_key = %s
                     WHERE username = %s;
                    """,
                    (hash_password(new_pw), new_public, new_enc_priv, username),
                )
            conn.commit()

            try:
                revoke_all_tokens_for_user(username, reason="admin_password_reset")
            except Exception:
                pass

            # Best-effort live disconnect + client-visible reason.
            if socketio is not None:
                payload = {
                    "username": username,
                    "reason": "Your password was reset by an admin. Please log in again.",
                    "by": actor,
                    "action": "password_reset",
                }
                try:
                    for sid in _user_sids(username):
                        try:
                            socketio.emit("force_logout", payload, to=sid)
                            socketio.emit("admin_force_logout", payload, to=sid)  # back-compat
                        except Exception:
                            pass
                except Exception:
                    pass

            # Drop any active Socket.IO sessions.
            try:
                _disconnect_user(username)
            except Exception:
                pass
            log_audit_event(actor, "reset_password", username, "Admin reset password")
            return jsonify({"status": "reset", "user": username})
        except Exception as e:
            conn.rollback()
            return jsonify({"error": str(e)}), 500

    @app.route("/admin/view_logins/<username>")
    @require_permission("admin:basic")
    def view_logins(username):
        conn = get_db()
        with conn.cursor() as cur:
            cur.execute("SELECT last_seen FROM users WHERE username = %s;", (username,))
            row = cur.fetchone()
        return jsonify({"username": username, "last_seen": row[0] if row else None})

    # ── RBAC ────────────────────────────────────────────────────────
    @app.route("/admin/assign_role/<username>", methods=["POST"])
    @require_permission("admin:super")
    def assign_role(username):
        actor = _actor()
        role_name = (request.form.get("role") or "").strip().lower()
        if not role_name:
            return jsonify({"error": "Missing role name"}), 400

        user_id = _get_user_id(username)
        if not user_id:
            return jsonify({"error": "User not found"}), 404

        conn = get_db()
        with conn.cursor() as cur:
            cur.execute("SELECT id FROM roles WHERE name = %s;", (role_name,))
            role = cur.fetchone()
            if not role:
                return jsonify({"error": "Role does not exist"}), 404

            cur.execute(
                """
                INSERT INTO user_roles (user_id, role_id)
                VALUES (%s, %s)
                ON CONFLICT (user_id, role_id) DO NOTHING;
                """,
                (user_id, role[0]),
            )

        conn.commit()
        log_audit_event(actor, "assign_role", username, f"Role: {role_name}")
        return jsonify({"status": "role_assigned", "role": role_name})

    # ── Sanctions by type ───────────────────────────────────────────
    @app.route("/admin/mute_user/<username>", methods=["POST"])
    @require_permission("admin:basic")
    def mute_user_admin(username):
        actor = _actor()
        minutes = int(request.form.get("minutes", 30))
        reason = request.form.get("reason", "Muted by admin")
        expires_at = _utcnow() + timedelta(minutes=minutes)

        conn = get_db()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO user_sanctions (username, sanction_type, reason, expires_at)
                    VALUES (%s, 'mute', %s, %s);
                    """,
                    (username, reason, expires_at),
                )
            conn.commit()
            log_audit_event(actor, "mute_user", username, f"{minutes} min mute")
            return jsonify({"status": "muted", "user": username})
        except Exception as e:
            conn.rollback()
            return jsonify({"error": str(e)}), 500

    @app.route("/admin/kick_from_room", methods=["POST"])
    @require_permission("admin:basic")
    def kick_from_room():
        actor = _actor()
        username = (request.form.get("username") or "").strip()
        room = (request.form.get("room") or "").strip()
        if not username or not room:
            return jsonify({"error": "Missing data"}), 400

        log_audit_event(actor, "kick_from_room", f"{username}@{room}", "Manual kick issued")
        affected = 0
        try:
            affected = _kick_user_from_room(username, room)
        except Exception:
            affected = 0

        # Real-time UX: tell the target client(s) to close/leave the room immediately.
        try:
            if socketio:
                for sid in _user_sids(username):
                    socketio.emit("room_forced_leave", {"room": room, "reason": "kicked", "by": actor}, to=sid)
                # Room-wide heads-up for UIs
                socketio.emit("admin_kick", {"username": username, "room": room, "by": actor}, room=room)
                socketio.emit("notification", f"👢 {actor} kicked {username} from {room}", to=room)
        except Exception:
            pass

        return jsonify({"status": "kick_requested", "user": username, "room": room, "affected_sessions": affected})


    @app.route("/admin/ban_from_room", methods=["POST"])
    @require_permission("admin:basic")
    def ban_from_room():
        actor = _actor()
        username = (request.form.get("username") or "").strip()
        room = (request.form.get("room") or "").strip()
        reason = (request.form.get("reason") or "Banned from room").strip()
        if not username or not room:
            return jsonify({"error": "Missing data"}), 400

        conn = get_db()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO user_sanctions (username, sanction_type, reason)
                    VALUES (%s, %s, %s);
                    """,
                    (username, f"room_ban:{room}", reason),
                )
            conn.commit()
        except Exception as e:
            try:
                conn.rollback()
            except Exception:
                pass
            return jsonify({"error": str(e)}), 500

        affected = 0
        # Real-time UX: if the user is currently in the room, kick them out now.
        try:
            affected = _kick_user_from_room(username, room)
        except Exception:
            affected = 0

        try:
            if socketio:
                for sid in _user_sids(username):
                    socketio.emit("room_forced_leave", {"room": room, "reason": "banned", "by": actor}, to=sid)
                socketio.emit("notification", f"⛔ {actor} banned {username} from {room}", to=room)
        except Exception:
            pass

        log_audit_event(actor, "ban_from_room", f"{username}@{room}", reason)
        return jsonify({"status": "room_banned", "user": username, "room": room, "affected_sessions": affected})


    @app.route("/admin/shadowban_user/<username>", methods=["POST"])
    @require_permission("admin:super")
    def shadowban_user(username):
        actor = _actor()
        reason = request.form.get("reason", "Shadowban issued")
        conn = get_db()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO user_sanctions (username, sanction_type, reason)
                    VALUES (%s, 'shadowban', %s);
                    """,
                    (username, reason),
                )
            conn.commit()
            log_audit_event(actor, "shadowban", username, reason)
            return jsonify({"status": "shadowbanned", "user": username})
        except Exception as e:
            conn.rollback()
            return jsonify({"error": str(e)}), 500

    # ── Room controls ───────────────────────────────────────────────
    @app.route("/admin/lock_room/<room>", methods=["POST"])
    @require_permission("admin:basic")
    def lock_room(room):
        actor = _actor()
        conn = get_db()
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO room_locks (room, locked, locked_by)
                VALUES (%s, TRUE, %s)
                ON CONFLICT (room) DO UPDATE SET locked = EXCLUDED.locked, locked_by = EXCLUDED.locked_by, locked_at = NOW();
                """,
                (room, actor),
            )
        conn.commit()
        log_audit_event(actor, "lock_room", room, "Room locked")
        try:
            _emit_room_policy(room, actor)
        except Exception:
            pass
        return jsonify({"status": "locked", "room": room})

    @app.route("/admin/unlock_room/<room>", methods=["POST"])
    @require_permission("admin:basic")
    def unlock_room(room):
        actor = _actor()
        conn = get_db()
        with conn.cursor() as cur:
            cur.execute("DELETE FROM room_locks WHERE room = %s;", (room,))
        conn.commit()
        log_audit_event(actor, "unlock_room", room, "Room unlocked")
        try:
            _emit_room_policy(room, actor)
        except Exception:
            pass
        return jsonify({"status": "unlocked", "room": room})

    @app.route("/admin/clear_room/<room>", methods=["POST"])
    @require_permission("admin:super")
    def clear_room(room):
        actor = _actor()
        conn = get_db()
        with conn.cursor() as cur:
            cur.execute("DELETE FROM messages WHERE room = %s;", (room,))
        conn.commit()
        log_audit_event(actor, "clear_room", room, "All messages deleted")
        return jsonify({"status": "cleared", "room": room})

    @app.route("/admin/set_room_readonly/<room>", methods=["POST"])
    @require_permission("admin:basic")
    def set_room_readonly(room):
        actor = _actor()
        mode = (request.form.get("readonly", "1") == "1")
        conn = get_db()
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO room_readonly (room, readonly, set_by)
                VALUES (%s, %s, %s)
                ON CONFLICT (room) DO UPDATE SET readonly = EXCLUDED.readonly, set_by = EXCLUDED.set_by, set_at = NOW();
                """,
                (room, bool(mode), actor),
            )
        conn.commit()
        log_audit_event(actor, "set_readonly", room, f"Read-only: {mode}")
        try:
            _emit_room_policy(room, actor)
        except Exception:
            pass
        return jsonify({"status": "readonly_set", "room": room, "readonly": bool(mode)})


    @app.route("/admin/set_room_slowmode/<room>", methods=["POST"])
    @require_permission("admin:basic")
    def set_room_slowmode(room):
        """Set per-room slowmode (seconds between messages per user).

        Form fields:
          - seconds: integer >= 0 (0 disables)
        """
        actor = _actor()
        raw = request.form.get("seconds") or request.form.get("slowmode") or "0"
        try:
            seconds = int(str(raw).strip())
        except Exception:
            seconds = 0
        seconds = max(0, min(seconds, 3600))

        conn = get_db()
        with conn.cursor() as cur:
            if seconds <= 0:
                cur.execute("DELETE FROM room_slowmode WHERE room = %s;", (room,))
            else:
                cur.execute(
                    """
                    INSERT INTO room_slowmode (room, seconds, set_by)
                    VALUES (%s, %s, %s)
                    ON CONFLICT (room) DO UPDATE
                        SET seconds = EXCLUDED.seconds,
                            set_by = EXCLUDED.set_by,
                            set_at = NOW();
                    """,
                    (room, seconds, actor),
                )
        conn.commit()

        log_audit_event(actor, "set_slowmode", room, f"seconds={seconds}")

        # Best-effort push of state to the room for live UIs
        try:
            if socketio:
                socketio.emit("slowmode_state", {"room": room, "seconds": seconds, "set_by": actor}, room=room)
                if seconds:
                    socketio.emit("notification", f"{actor} set slowmode to {seconds}s", to=room)
                else:
                    socketio.emit("notification", f"{actor} disabled slowmode", to=room)
        except Exception:
            pass

        try:
            _emit_room_policy(room, actor)
        except Exception:
            pass

        return jsonify({"status": "slowmode_set", "room": room, "seconds": seconds})

    # ── Broadcast ───────────────────────────────────────────────────
    @app.route("/admin/global_broadcast", methods=["POST"])
    @require_permission("admin:basic")
    def global_broadcast():
        actor = _actor()
        message = (request.form.get("message") or "").strip()
        if not message:
            return jsonify({"error": "Missing message"}), 400
        if not socketio:
            return jsonify({"error": "SocketIO not available"}), 500

        socketio.emit("global_announcement", {"message": message}, broadcast=True)
        log_audit_event(actor, "broadcast", "*", message[:100])
        return jsonify({"status": "broadcast_sent"})

    # ── Account flags ───────────────────────────────────────────────
    @app.route("/admin/revoke_2fa/<username>", methods=["POST"])
    @require_permission("admin:super")
    def revoke_2fa(username):
        actor = _actor()
        conn = get_db()
        with conn.cursor() as cur:
            cur.execute(
                """
                UPDATE users
                   SET two_factor_secret = NULL,
                       two_factor_enabled = FALSE
                 WHERE username = %s;
                """,
                (username,),
            )
        conn.commit()
        log_audit_event(actor, "revoke_2fa", username, "2FA revoked")
        return jsonify({"status": "2fa_revoked"})

    @app.route("/admin/set_user_quota/<username>", methods=["POST"])
    @require_permission("admin:basic")
    def set_user_quota(username):
        actor = _actor()
        limit = int(request.form.get("messages_per_hour", 60))
        conn = get_db()
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO user_quotas (username, messages_per_hour)
                VALUES (%s, %s)
                ON CONFLICT (username) DO UPDATE SET messages_per_hour = EXCLUDED.messages_per_hour, updated_at = NOW();
                """,
                (username, limit),
            )
        conn.commit()
        log_audit_event(actor, "set_quota", username, f"{limit} msg/hr")
        return jsonify({"status": "quota_set", "limit": limit})

    @app.route("/admin/set_user_status/<username>", methods=["POST"])
    @require_permission("admin:basic")
    def set_user_status(username):
        actor = _actor()
        status = (request.form.get("status") or "").strip()
        if len(status) > 128:
            return jsonify({"error": "Status too long"}), 400

        conn = get_db()
        with conn.cursor() as cur:
            cur.execute("UPDATE users SET custom_status = %s WHERE username = %s;", (status, username))
        conn.commit()
        log_audit_event(actor, "override_status", username, status)
        return jsonify({"status": "status_set", "value": status})

    # ── Role/permission management ──────────────────────────────────
    @app.route("/admin/role/create", methods=["POST"])
    @require_permission("admin:manage_roles")
    def create_role():
        name = (request.form.get("name") or "").strip().lower()
        if not name:
            return jsonify({"error": "Missing role name"}), 400

        conn = get_db()
        with conn.cursor() as cur:
            cur.execute("INSERT INTO roles (name) VALUES (%s) ON CONFLICT (name) DO NOTHING;", (name,))
            created = cur.rowcount
        conn.commit()
        if not created:
            return jsonify({"error": "Role already exists"}), 409
        return jsonify({"status": "role_created", "name": name})

    @app.route("/admin/role/delete", methods=["POST"])
    @require_permission("admin:manage_roles")
    def delete_role():
        name = (request.form.get("name") or "").strip().lower()
        if not name:
            return jsonify({"error": "Missing role name"}), 400

        conn = get_db()
        with conn.cursor() as cur:
            cur.execute("DELETE FROM roles WHERE name = %s;", (name,))
            deleted = cur.rowcount
        conn.commit()
        if not deleted:
            return jsonify({"error": "Role not found"}), 404
        return jsonify({"status": "role_deleted", "name": name})

    @app.route("/admin/role/add_permission", methods=["POST"])
    @require_permission("admin:manage_roles")
    def add_permission_to_role():
        role = (request.form.get("role") or "").strip().lower()
        perm = (request.form.get("permission") or "").strip().lower()
        if not role or not perm:
            return jsonify({"error": "Missing role or permission"}), 400

        conn = get_db()
        with conn.cursor() as cur:
            # Ensure permission exists
            cur.execute("INSERT INTO permissions (name) VALUES (%s) ON CONFLICT (name) DO NOTHING;", (perm,))
            cur.execute("SELECT id FROM permissions WHERE name = %s;", (perm,))
            perm_id = cur.fetchone()[0]

            cur.execute("SELECT id FROM roles WHERE name = %s;", (role,))
            role_id_row = cur.fetchone()
            if not role_id_row:
                return jsonify({"error": "Role not found"}), 404
            role_id = role_id_row[0]

            cur.execute(
                """
                INSERT INTO role_permissions (role_id, permission_id)
                VALUES (%s, %s)
                ON CONFLICT (role_id, permission_id) DO NOTHING;
                """,
                (role_id, perm_id),
            )
        conn.commit()
        return jsonify({"status": "permission_added", "role": role, "permission": perm})

    @app.route("/admin/role/remove_permission", methods=["POST"])
    @require_permission("admin:manage_roles")
    def remove_permission_from_role():
        role = (request.form.get("role") or "").strip().lower()
        perm = (request.form.get("permission") or "").strip().lower()
        if not role or not perm:
            return jsonify({"error": "Missing role or permission"}), 400

        conn = get_db()
        with conn.cursor() as cur:
            cur.execute("SELECT id FROM permissions WHERE name = %s;", (perm,))
            perm_id_row = cur.fetchone()
            cur.execute("SELECT id FROM roles WHERE name = %s;", (role,))
            role_id_row = cur.fetchone()
            if not perm_id_row or not role_id_row:
                return jsonify({"error": "Role or permission not found"}), 404
            perm_id = perm_id_row[0]
            role_id = role_id_row[0]
            cur.execute(
                "DELETE FROM role_permissions WHERE role_id = %s AND permission_id = %s;",
                (role_id, perm_id),
            )
            removed = cur.rowcount
        conn.commit()
        if not removed:
            return jsonify({"error": "Permission mapping not found"}), 404
        return jsonify({"status": "permission_removed", "role": role, "permission": perm})

    @app.route("/admin/role/<role_name>/permissions", methods=["GET"])
    @require_permission("admin:manage_roles")
    def list_role_permissions(role_name):
        conn = get_db()
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT p.name
                  FROM role_permissions rp
                  JOIN permissions p ON rp.permission_id = p.id
                  JOIN roles r ON rp.role_id = r.id
                 WHERE r.name = %s
                 ORDER BY p.name;
                """,
                (role_name,),
            )
            results = [row[0] for row in cur.fetchall()]
        return jsonify({"role": role_name, "permissions": results})

    @app.route("/admin/user/<username>/permissions", methods=["GET"])
    @require_permission("admin:manage_roles")
    def list_user_permissions(username):
        from permissions import get_user_permissions

        perms = get_user_permissions(username)
        return jsonify({"username": username, "permissions": sorted(list(perms))})


    # ── Diagnostics: list admin routes (super-admin only) ───────────
    @app.route('/admin/_routes', methods=['GET'])
    @require_permission('admin:super')
    def admin_list_routes():
        routes = []
        try:
            for r in app.url_map.iter_rules():
                if r.rule.startswith('/admin') or r.rule.startswith('/api/admin'):
                    methods = sorted([m for m in (r.methods or set()) if m not in {'HEAD','OPTIONS'}])
                    routes.append({'rule': r.rule, 'methods': methods})
        except Exception:
            pass
        routes.sort(key=lambda x: x['rule'])
        return jsonify({'ok': True, 'routes': routes})

    # ── Alias rules to eliminate admin 404s across UI/server versions ─
    # We automatically mirror any newly-registered /admin/* routes from
    # this module under /api/admin/* as well, and add a few extra
    # compatibility paths for room controls.
    def _ecap_add_alias(rule_src: str, rule_dst: str, endpoint: str):
        try:
            existing = {r.rule for r in app.url_map.iter_rules()}
            if rule_dst in existing:
                return
            vf = app.view_functions.get(endpoint)
            if not vf:
                return
            # Try to reuse method set from the source rule
            methods = None
            defaults = None
            for r in app.url_map.iter_rules():
                if r.rule == rule_src and r.endpoint == endpoint:
                    methods = sorted([m for m in (r.methods or set()) if m not in {'HEAD','OPTIONS'}])
                    defaults = r.defaults
                    break
            if not methods:
                # Fallback: allow GET+POST to avoid surprises
                methods = ['GET','POST']
            app.add_url_rule(
                rule_dst,
                endpoint=f'ecap_alias_{endpoint}_{abs(hash(rule_dst))}',
                view_func=vf,
                methods=methods,
                defaults=defaults,
            )
        except Exception:
            return

    # Determine which endpoints were added by this register() call
    _ecap_post_endpoints = set(app.view_functions.keys())
    _ecap_new_endpoints = _ecap_post_endpoints - _ecap_pre_endpoints

    # 1) Mirror /admin/* -> /api/admin/* for all new endpoints
    try:
        for r in list(app.url_map.iter_rules()):
            if r.endpoint not in _ecap_new_endpoints:
                continue
            if not r.rule.startswith('/admin/'):
                continue
            dst = '/api' + r.rule
            _ecap_add_alias(r.rule, dst, r.endpoint)
    except Exception:
        pass

    # 2) Extra compatibility for room controls (common alternate URL shapes)
    _room_aliases = [
        ('/admin/lock_room/<room>', '/admin/rooms/lock/<path:room>', 'lock_room'),
        ('/admin/unlock_room/<room>', '/admin/rooms/unlock/<path:room>', 'unlock_room'),
        ('/admin/set_room_readonly/<room>', '/admin/rooms/readonly/<path:room>', 'set_room_readonly'),
        ('/admin/set_room_readonly/<room>', '/admin/rooms/read_only/<path:room>', 'set_room_readonly'),
        ('/admin/set_room_slowmode/<room>', '/admin/rooms/slowmode/<path:room>', 'set_room_slowmode'),
        ('/admin/clear_room/<room>', '/admin/rooms/clear/<path:room>', 'clear_room'),
        ('/admin/rooms/delete/<path:room>', '/admin/rooms/delete/<path:room>', 'admin_room_delete'),
        ('/admin/delete_room/<room>', '/admin/rooms/delete/<path:room>', 'admin_room_delete'),
    ]
    for src, dst, ep in _room_aliases:
        _ecap_add_alias(src, dst, ep)
        _ecap_add_alias(src, '/api' + dst, ep)
