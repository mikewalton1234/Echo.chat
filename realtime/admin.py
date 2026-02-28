"""Socket.IO handlers: admin.

Auto-split from the legacy monolithic socket_handlers.py.
"""

import json
import re
import time
import uuid
import threading
from collections import deque

from flask import request
from flask_jwt_extended import jwt_required, get_jwt_identity
from flask_socketio import join_room, leave_room, emit, disconnect

from database import (
    get_all_rooms,
    get_friends_for_user,
    create_room_if_missing,
    create_autoscaled_room_if_missing,
    increment_room_count,
    get_pending_friend_requests,
    get_blocked_users,
    get_db,
    get_custom_room_meta,
    can_user_access_custom_room,
    touch_custom_room_activity,
    consume_room_invites,
    set_room_message_expiry,
    get_room_message_expiry,
)
from security import log_audit_event
from permissions import check_user_permission
from moderation import is_user_sanctioned, mute_user

from realtime.state import *

def register(socketio, settings, ctx):
    """Register Socket.IO event handlers for this module."""
    # Make helper functions from socket_handlers available as module globals
    globals().update(ctx.__dict__)

    @socketio.on("get_usage_stats")
    @jwt_required()
    def handle_get_usage_stats(data=None):
        user = get_jwt_identity()

        try:
            lim = int(settings.get("admin_socket_read_rate_limit") or 120)
            win = int(settings.get("admin_socket_read_rate_window_sec") or 60)
        except Exception:
            lim, win = 120, 60
        okrl, retry = _rl(f"adminsock:r:{user}", lim, win)
        if not okrl:
            return {"success": False, "error": "Rate limited", "retry_after": retry}

        if not (check_user_permission(user, "admin:basic") or check_user_permission(user, "admin:super")):
            return {"success": False, "error": "No permission"}
        emit("notification", f"Usage stats retrieved for {user}", to=request.sid)
        return {"success": True}


    @socketio.on("get_audit_logs")
    @jwt_required()
    def handle_get_audit_logs(data=None):
        user = get_jwt_identity()

        try:
            lim = int(settings.get("admin_socket_read_rate_limit") or 120)
            win = int(settings.get("admin_socket_read_rate_window_sec") or 60)
        except Exception:
            lim, win = 120, 60
        okrl, retry = _rl(f"adminsock:r:{user}", lim, win)
        if not okrl:
            return {"success": False, "error": "Rate limited", "retry_after": retry}

        if not (check_user_permission(user, "admin:basic") or check_user_permission(user, "admin:super")):
            return {"success": False, "error": "No permission"}
        emit("notification", f"Audit logs fetched for {user}", to=request.sid)
        return {"success": True}


    @socketio.on("refresh_server_settings")
    @jwt_required()
    def handle_refresh_server_settings(data=None):
        user = get_jwt_identity()

        try:
            lim = int(settings.get("admin_socket_read_rate_limit") or 120)
            win = int(settings.get("admin_socket_read_rate_window_sec") or 60)
        except Exception:
            lim, win = 120, 60
        okrl, retry = _rl(f"adminsock:r:{user}", lim, win)
        if not okrl:
            return {"success": False, "error": "Rate limited", "retry_after": retry}

        if not (check_user_permission(user, "admin:basic") or check_user_permission(user, "admin:super")):
            return {"success": False, "error": "No permission"}
        emit("notification", f"Server settings refreshed by {user}", to=request.sid)
        return {"success": True}


    @socketio.on("purge_user")
    @jwt_required()
    def handle_purge_user(data):
        username = (data or {}).get("username")
        admin = get_jwt_identity()

        if not username:
            return {"success": False, "error": "Missing username"}

        if not check_user_permission(admin, "admin:super"):
            return {"success": False, "error": "Super admin required"}

        # NOTE: placeholder action — implement real purge logic in routes_admin_tools.py
        emit("notification", f"{admin} purged user {username}", broadcast=True)
        log_audit_event(admin, "purge_user", target=username)
        return {"success": True}


    @socketio.on("update_user_role")
    @jwt_required()
    def handle_update_user_role(data):
        username = (data or {}).get("username")
        role = (data or {}).get("role")
        admin = get_jwt_identity()

        if not username or not role:
            return {"success": False, "error": "Missing fields"}

        if not (check_user_permission(admin, "admin:super") or check_user_permission(admin, "admin:manage_roles")):
            return {"success": False, "error": "No permission"}

        # NOTE: placeholder action — implement real RBAC changes via admin routes/tools
        emit(
            "notification",
            f"{admin} updated {username}'s role to {role}",
            broadcast=True,
        )
        log_audit_event(admin, "update_user_role", target=username)
        return {"success": True}

    @socketio.on("set_message_expiry")
    @jwt_required()
    def handle_set_message_expiry(data):
        """Set per-room message expiry (admin/mod). expiry <= 0 disables."""
        room = (data or {}).get("room")
        expiry = (data or {}).get("expiry")
        user = get_jwt_identity()

        if not room:
            return {"success": False, "error": "Missing room"}

        if not check_user_permission(user, "room:lock"):
            return {"success": False, "error": "Permission denied"}

        try:
            expiry_seconds = int(expiry or 0)
        except Exception:
            expiry_seconds = 0

        set_room_message_expiry(room, expiry_seconds, set_by=user)

        emit(
            "room_policy_state",
            {"room": room, "message_expiry_seconds": expiry_seconds},
            to=room,
        )
        return {"success": True, "expiry_seconds": expiry_seconds}

    @socketio.on("delete_all_messages")
    @jwt_required()
    def handle_delete_all_messages(data):
        room = (data or {}).get("room")
        user = get_jwt_identity()

        if not room:
            return {"success": False, "error": "Missing room"}
        if not check_user_permission(user, "room:lock"):
            return {"success": False, "error": "Permission denied"}

        try:
            conn = get_db()
            with conn.cursor() as cur:
                cur.execute("DELETE FROM messages WHERE room=%s;", (room,))
                deleted = int(cur.rowcount or 0)
            conn.commit()
        except Exception as e:
            try:
                conn.rollback()
            except Exception:
                pass
            return {"success": False, "error": str(e)}

        emit("notification", {"room": room, "message": f"🧹 Messages cleared by admin ({deleted} removed)."}, to=room)
        return {"success": True, "deleted": deleted}

    @socketio.on("clear_room")
    @jwt_required()
    def handle_clear_room(data):
        room = (data or {}).get("room")
        user = get_jwt_identity()

        if not room:
            return {"success": False, "error": "Missing room"}
        if not check_user_permission(user, "room:lock"):
            return {"success": False, "error": "Permission denied"}

        try:
            conn = get_db()
            with conn.cursor() as cur:
                cur.execute("DELETE FROM messages WHERE room=%s;", (room,))
                deleted = int(cur.rowcount or 0)
            conn.commit()
        except Exception as e:
            try:
                conn.rollback()
            except Exception:
                pass
            return {"success": False, "error": str(e)}

        emit("notification", {"room": room, "message": f"🧹 Room cleared ({deleted} messages removed)."}, to=room)
        return {"success": True, "deleted": deleted}


    @socketio.on("lock_room")
    @jwt_required()
    def handle_lock_room(data):
        room = data.get("room")
        user = get_jwt_identity()
        locked = bool((data or {}).get("locked", True))

        if not room:
            return {"success": False, "error": "Missing room"}

        if not (check_user_permission(user, "room:lock") or check_user_permission(user, "admin:super")):
            return {"success": False, "error": "No permission"}

        try:
            create_room_if_missing(room)
            conn = get_db()
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO room_locks (room, locked, locked_by)
                    VALUES (%s, %s, %s)
                    ON CONFLICT (room)
                    DO UPDATE SET locked = EXCLUDED.locked,
                                  locked_by = EXCLUDED.locked_by,
                                  locked_at = CURRENT_TIMESTAMP;
                    """,
                    (room, locked, user),
                )
            conn.commit()
        except Exception as e:
            print(f"[DB ERROR] lock_room: {e}")
            return {"success": False, "error": "Database error"}

        state = "locked" if locked else "unlocked"
        emit("notification", f"{user} {state} room {room}", to=room)

        try:
            _push_room_policy_state(room, user)
        except Exception:
            pass
        return {"success": True}


    @socketio.on("set_room_readonly")
    @jwt_required()
    def handle_set_room_readonly(data):
        room = (data or {}).get("room")
        user = get_jwt_identity()
        readonly = bool((data or {}).get("readonly", True))

        if not room:
            return {"success": False, "error": "Missing room"}

        if not (check_user_permission(user, "room:readonly") or check_user_permission(user, "admin:super")):
            return {"success": False, "error": "No permission"}

        try:
            create_room_if_missing(room)
            conn = get_db()
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO room_readonly (room, readonly, set_by)
                    VALUES (%s, %s, %s)
                    ON CONFLICT (room)
                    DO UPDATE SET readonly = EXCLUDED.readonly,
                                  set_by = EXCLUDED.set_by,
                                  set_at = CURRENT_TIMESTAMP;
                    """,
                    (room, readonly, user),
                )
            conn.commit()
        except Exception as e:
            print(f"[DB ERROR] set_room_readonly: {e}")
            return {"success": False, "error": "Database error"}

        state = "read-only" if readonly else "writable"
        emit("notification", f"{user} set {room} to {state}", to=room)

        try:
            _push_room_policy_state(room, user)
        except Exception:
            pass
        return {"success": True}

    @socketio.on("slowmode_toggle")
    @jwt_required()
    def handle_slowmode_toggle(data):
        data = data or {}
        room = data.get("room")
        enabled = bool(data.get("enabled", True))
        seconds = data.get("seconds")
        user = get_jwt_identity()

        if not room:
            return {"success": False, "error": "Missing room"}

        # Only staff can change slowmode
        if not (
            check_user_permission(user, "admin:super")
            or check_user_permission(user, "admin:basic")
            or check_user_permission(user, "room:lock")
        ):
            return {"success": False, "error": "Permission denied"}

        if not enabled:
            sec = 0
        else:
            try:
                if seconds is not None:
                    sec = int(seconds)
                else:
                    sec = int(settings.get("room_slowmode_default_on_sec") or settings.get("room_slowmode_default_sec") or 3)
            except Exception:
                sec = 3

        sec = max(0, min(int(sec), 3600))

        try:
            conn = get_db()
            with conn.cursor() as cur:
                if sec <= 0:
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
                        (room, sec, user),
                    )
            conn.commit()
        except Exception as e:
            try:
                conn.rollback()
            except Exception:
                pass
            print(f"[DB ERROR] slowmode_toggle: {e}")
            return {"success": False, "error": "Database error"}

        # refresh cache immediately
        try:
            with _ROOM_SLOWMODE_CACHE_LOCK:
                _ROOM_SLOWMODE_CACHE[room] = (sec, time.time())
        except Exception:
            pass

        emit("slowmode_state", {"room": room, "seconds": sec, "set_by": user}, to=room)

        try:
            _push_room_policy_state(room, user)
        except Exception:
            pass
        if sec > 0:
            emit("notification", f"{user} set slow mode to {sec}s", to=room)
        else:
            emit("notification", f"{user} disabled slow mode", to=room)

        return {"success": True, "room": room, "seconds": sec}


