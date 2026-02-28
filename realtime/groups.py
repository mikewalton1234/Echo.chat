"""Socket.IO handlers: groups.

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

    @socketio.on("group_message")
    @jwt_required()
    def handle_group_message(data):
        sender = get_jwt_identity()

        data = data or {}
        try:
            group_id = int(data.get("group_id"))
        except Exception:
            return {"success": False, "error": "bad_group_id"}

        cipher = data.get("cipher")
        message = data.get("message")

        require_e2ee = bool(settings.get("require_group_e2ee", False))
        if require_e2ee and not cipher:
            return {"success": False, "error": "This group requires encrypted messages"}

        # Validate payload size/types
        if cipher:
            if not isinstance(cipher, str):
                return {"success": False, "error": "bad_cipher"}
            max_cipher_len = int(settings.get("max_group_cipher_length") or 120000)
            if len(cipher) > max_cipher_len:
                return {"success": False, "error": f"Ciphertext too large (max {max_cipher_len})"}
        else:
            if not isinstance(message, str):
                return {"success": False, "error": "bad_message"}
            message = message.strip()
            if not message:
                return {"success": False, "error": "empty"}
            if len(message) > int(settings.get("max_group_message_chars") or 2000):
                return {"success": False, "error": "too_long"}

        # rate limit per sender + group
        # Accept either an int (treated as per-minute) or strings like "60 per minute".
        g_lim, g_win = _parse_rate_limit(settings.get("group_msg_rate_limit"), default_limit=60, default_window=60)
        # Optional explicit override for the window (seconds)
        try:
            if settings.get("group_msg_rate_window_sec") is not None:
                g_win = int(settings.get("group_msg_rate_window_sec"))
        except Exception:
            pass
        if not _group_rl(
            f"gmsg:{sender}:{group_id}",
            limit=g_lim,
            window_sec=g_win,
        ):
            return {"success": False, "error": "rate_limited"}

        user_id = _get_user_id_by_username(sender)
        if not user_id:
            return {"success": False, "error": "unauthorized"}

        if not _is_group_member(group_id, user_id):
            # Do not leak group existence
            return {"success": False}

        if _is_group_muted(group_id, sender):
            return {"success": False, "error": "muted"}

        # Persist message (ciphertext-only if cipher provided)
        message_id = None
        try:
            conn = get_db()
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO messages (sender, room, message, is_encrypted)
                    VALUES (%s, %s, %s, %s)
                    RETURNING id;
                    """,
                    (
                        sender,
                        _group_store_room(group_id),
                        cipher if cipher else message,
                        True if cipher else False,
                    ),
                )
                message_id = int(cur.fetchone()[0])
            conn.commit()
        except Exception as e:
            try:
                conn.rollback()
            except Exception:
                pass
            print(f"[DB ERROR] group_message insert failed: {e}")
            return {"success": False, "error": "db"}

        payload = {
            "group_id": group_id,
            "sender": sender,
            "message_id": message_id,
        }

        if cipher:
            payload["cipher"] = cipher
            payload["message"] = "🔒 Encrypted message"
        else:
            payload["message"] = message

        emit("group_message", payload, room=_group_room(group_id))
        return {"success": True, "message_id": message_id}


    @socketio.on("join_group_chat")
    @jwt_required()
    def handle_join_group_chat(data):
        username = get_jwt_identity()
        try:
            group_id = int((data or {}).get("group_id"))
        except Exception:
            return {"success": False}
    
        if not _group_rl(f"gjoin:{username}:{group_id}", limit=10, window_sec=30):
            return {"success": False, "error": "rate_limited"}
    
        user_id = _get_user_id_by_username(username)
        if not user_id or not _is_group_member(group_id, user_id):
            return {"success": False}  # no leaks
    
        join_room(_group_room(group_id))

        # Load recent group history (ciphertext-safe).
        history = []
        try:
            require_e2ee = bool(settings.get("require_group_e2ee", False))
            allow_legacy = bool(settings.get("allow_legacy_plaintext_history", False))
            limit = int(settings.get("max_group_history") or 200)
            limit = max(0, min(limit, 500))

            conn = get_db()
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT id, sender, message, is_encrypted, timestamp
                      FROM messages
                     WHERE room = %s
                     ORDER BY id DESC
                     LIMIT %s;
                    """,
                    (_group_store_room(group_id), limit),
                )
                rows = cur.fetchall() or []
            rows.reverse()
            history = _format_group_history_rows(rows, require_e2ee=require_e2ee, allow_legacy=allow_legacy)
        except Exception:
            history = []
        try:
            conn = get_db()
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO message_reads (message_id, username)
                    SELECT id, %s
                      FROM messages
                     WHERE room = %s
                     ORDER BY id DESC
                     LIMIT 500
                    ON CONFLICT (message_id, username) DO NOTHING;
                    """,
                    (username, _group_store_room(group_id)),
                )
            conn.commit()
        except Exception:
            try:
                conn.rollback()
            except Exception:
                pass
    
        # Provide member list for client-side group E2EE key wrapping (no extra endpoint).
        members = []
        try:
            conn = get_db()
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT u.username
                      FROM group_members gm
                      JOIN users u ON u.id = gm.user_id
                     WHERE gm.group_id = %s
                     ORDER BY u.username;
                    """,
                    (group_id,),
                )
                members = [r[0] for r in (cur.fetchall() or []) if r and r[0]]
        except Exception:
            members = []
    
        _audit_details = f"sid={request.sid}"
        try:
            log_audit_event(username, "group_socket_join", target=str(group_id), details=_audit_details)
        except Exception:
            pass
        return {"success": True, "members": members, "history": history}


    @socketio.on("get_group_history")
    @jwt_required()
    def handle_get_group_history(data):
        """Fetch older group history (pagination)."""
        username = get_jwt_identity()
        data = data or {}
        try:
            group_id = int(data.get("group_id"))
        except Exception:
            return {"success": False, "error": "bad_group_id"}

        before_id = None
        try:
            if data.get("before_id") is not None:
                before_id = int(data.get("before_id"))
        except Exception:
            before_id = None

        if not _group_rl(f"ghist:{username}:{group_id}", limit=12, window_sec=30):
            return {"success": False, "error": "rate_limited"}

        user_id = _get_user_id_by_username(username)
        if not user_id or not _is_group_member(group_id, user_id):
            return {"success": False}

        require_e2ee = bool(settings.get("require_group_e2ee", False))
        allow_legacy = bool(settings.get("allow_legacy_plaintext_history", False))
        limit = int(data.get("limit") or settings.get("max_group_history_page") or 200)
        limit = max(1, min(limit, 500))

        try:
            conn = get_db()
            with conn.cursor() as cur:
                if before_id is not None:
                    cur.execute(
                        """
                        SELECT id, sender, message, is_encrypted, timestamp
                          FROM messages
                         WHERE room = %s AND id < %s
                         ORDER BY id DESC
                         LIMIT %s;
                        """,
                        (_group_store_room(group_id), before_id, limit),
                    )
                else:
                    cur.execute(
                        """
                        SELECT id, sender, message, is_encrypted, timestamp
                          FROM messages
                         WHERE room = %s
                         ORDER BY id DESC
                         LIMIT %s;
                        """,
                        (_group_store_room(group_id), limit),
                    )
                rows = cur.fetchall() or []
            rows.reverse()
            history = _format_group_history_rows(rows, require_e2ee=require_e2ee, allow_legacy=allow_legacy)
            return {"success": True, "history": history}
        except Exception:
            return {"success": False, "error": "db"}
    

    @socketio.on("get_group_members")
    @jwt_required()
    def handle_get_group_members(data):
        username = get_jwt_identity()
        data = data or {}
        try:
            group_id = int(data.get("group_id"))
        except Exception:
            return {"success": False, "error": "bad_group_id"}
    
        if not _group_rl(f"gmembers:{username}:{group_id}", limit=12, window_sec=30):
            return {"success": False, "error": "rate_limited"}
    
        user_id = _get_user_id_by_username(username)
        if not user_id or not _is_group_member(group_id, user_id):
            return {"success": False}
    
        members = []
        try:
            conn = get_db()
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT u.username
                      FROM group_members gm
                      JOIN users u ON u.id = gm.user_id
                     WHERE gm.group_id = %s
                     ORDER BY u.username;
                    """,
                    (group_id,),
                )
                members = [r[0] for r in (cur.fetchall() or []) if r and r[0]]
        except Exception:
            members = []
    
        return {"success": True, "members": members}
    

    @socketio.on("leave_group_chat")
    @jwt_required()
    def handle_leave_group_chat(data):
        username = get_jwt_identity()
        try:
            group_id = int((data or {}).get("group_id"))
        except Exception:
            return {"success": False}
        leave_room(_group_room(group_id))
        try:
            log_audit_event(username, "group_socket_leave", target=str(group_id), details=f"sid={request.sid}")
        except Exception:
            pass
        return {"success": True}


