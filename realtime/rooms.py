"""Socket.IO handlers: rooms.

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

    @socketio.on("get_rooms")
    @jwt_required()
    def handle_get_rooms(data=None):
        """
        Emit the list of all rooms (fetched from DB).
        """
        sid = request.sid
        try:
            rooms = get_all_rooms()
            try:
                live = _live_room_counts()
                for rr in rooms:
                    name = rr.get("name")
                    if not name:
                        continue
                    c = live.get(str(name), None)
                    if c is None:
                        c = rr.get("member_count") if rr.get("member_count") is not None else rr.get("members")
                    rr["member_count"] = int(c or 0)
                    rr["members"] = int(c or 0)
            except Exception:
                pass
            emit("room_list", {"rooms": rooms}, to=sid)

        except Exception as e:
            print("Error in get_rooms:", e)
            emit("room_list", {"rooms": [], "error": str(e)}, to=sid)




    @socketio.on("get_room_counts")
    @jwt_required(optional=True)
    def handle_get_room_counts(data=None):
        """Return live room counts (unique users per room)."""
        try:
            return {"success": True, "counts": _live_room_counts(), "ts": time.time()}
        except Exception:
            return {"success": True, "counts": {}, "ts": time.time()}

    
    # ───────────────────────────────────────────────────────────────────────────
    # Private Groups (Socket.IO)
    # Hardened:
    #   - membership enforcement for join/send
    #   - mute enforcement
    #   - message length limits
    #   - persistence to messages table using room key "g:<group_id>" (for unread)
    #   - basic rate limiting
    # ───────────────────────────────────────────────────────────────────────────

    _GROUP_RATE: dict[str, deque] = {}
    _GROUP_RATE_LOCK = threading.Lock()


    @socketio.on("join")
    @jwt_required()
    def handle_join(data):
        room = (data or {}).get("room")
        username = get_jwt_identity()
        sid = request.sid

        if not room:
            emit("notification", {"room": None, "message": "Room name missing"}, to=sid)
            return {"success": False, "error": "missing_room"}

        try:
            okname, nameerr = _validate_room_name(room)
            if not okname:
                emit("notification", {"room": None, "message": nameerr or "Invalid room"}, to=sid)
                return {"success": False, "error": nameerr or "invalid_room"}

            requested_room = (room or "").strip()
            requested_room = _canonical_room_name(requested_room)

            # Autoscale: Lobby full -> Lobby (2) etc.
            room, created_new = _select_autoscaled_room(requested_room)

            # Notify clients that the room list may have changed (new shard)
            if created_new:
                try:
                    socketio.emit("rooms_changed", {"base": requested_room, "created": room})
                except Exception:
                    pass

            # Anti-abuse: join flood control (staff exempt)
            try:
                is_staff = bool(check_user_permission(username, "admin:super") or check_user_permission(username, "admin:basic"))
            except Exception:
                is_staff = False

            if not is_staff:
                okj, retry = _join_rate_ok(username)
                if not okj:
                    if _abuse_strike(username, "join_rate"):
                        emit("notification", {"room": room, "message": "🚫 Auto-muted for spam/abuse guard."}, to=sid)
                    else:
                        emit("notification", {"room": room, "message": f"⏳ Join rate limited (wait {retry:.1f}s)"}, to=sid)
                    return {"success": False, "error": "join_rate_limited"}

            existed = _room_exists(room)
            if not existed:
                emit("notification", {"room": room, "message": "🚫 Room does not exist."}, to=sid)
                return {"success": False, "error": "room_not_found"}

            # If this is a custom room, enforce privacy + 18+ rules.
            try:
                meta = get_custom_room_meta(room)
            except Exception:
                meta = None

            if meta:
                if meta.get("is_private"):
                    try:
                        if not can_user_access_custom_room(room, username):
                            emit("notification", {"room": room, "message": "🔒 Private room (invite required)."}, to=sid)
                            return {"success": False, "error": "invite_required"}
                    except Exception:
                        emit("notification", {"room": room, "message": "🔒 Private room (invite required)."}, to=sid)
                        return {"success": False, "error": "invite_required"}

                if meta.get("is_18_plus") or meta.get("is_nsfw"):
                    try:
                        conn = get_db()
                        with conn.cursor() as cur:
                            cur.execute("SELECT age FROM users WHERE username=%s;", (username,))
                            row = cur.fetchone()
                        age = int(row[0] or 0) if row else 0
                    except Exception:
                        age = 0
                    if age < 18:
                        emit("notification", {"room": room, "message": "⛔ 18+ room (age restriction)."}, to=sid)
                        return {"success": False, "error": "age_restricted"}

            ok, err = _require_not_sanctioned(username, action="join")
            if not ok:
                emit("notification", {"room": room, "message": err or "Join denied"}, to=sid)
                return {"success": False, "error": err or "join_denied"}

            if is_user_sanctioned(username, f"room_ban:{room}"):
                emit("notification", {"room": room, "message": "⛔ You are banned from this room."}, to=sid)
                return {"success": False, "error": "room_banned"}

            if _room_locked(room) and not (
                check_user_permission(username, "room:lock") or check_user_permission(username, "admin:super")
            ):
                emit("notification", {"room": room, "message": "🔒 Room is locked."}, to=sid)
                return {"success": False, "error": "room_locked"}

            previous_room = CONNECTED_USERS.get(sid, {}).get("room")

            # helper: recent room history
            def _load_history():
                require_room_e2ee = bool(settings.get("require_room_e2ee", False))
                allow_legacy = bool(settings.get("allow_legacy_plaintext_room_history", False))
                try:
                    limit = int(settings.get("room_history_limit", 60))
                except Exception:
                    limit = 60
                limit2 = max(0, min(limit, 200))
                if limit2 <= 0:
                    return []
                try:
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
                            (room, limit2),
                        )
                        rows = cur.fetchall() or []
                    rows.reverse()
                    return _format_room_history_rows(rows, require_room_e2ee, allow_legacy)
                except Exception:
                    return []

            # No-op if already in that room
            if previous_room == room:
                # Send current policy state (UI toggles)
                try:
                    locked = _room_locked(room)
                    readonly = _room_readonly(room)
                    slow = _room_slowmode_seconds(room)
                    bypass_lock = bool(check_user_permission(username, "admin:super") or check_user_permission(username, "room:lock"))
                    bypass_ro = bool(check_user_permission(username, "admin:super") or check_user_permission(username, "room:readonly"))
                    can_send = (not locked or bypass_lock) and (not readonly or bypass_ro)

                    block_reason = None
                    if not can_send:
                        if readonly and not bypass_ro:
                            block_reason = "read_only"
                        elif locked and not bypass_lock:
                            block_reason = "locked"
                        else:
                            block_reason = "blocked"

                    emit(
                        "room_policy_state",
                        {
                            "room": room,
                            "locked": bool(locked),
                            "readonly": bool(readonly),
                            "slowmode_seconds": int(slow or 0),
                            "can_send": bool(can_send),
                            "can_override_lock": bool(bypass_lock),
                            "can_override_readonly": bool(bypass_ro),
                            "block_reason": block_reason,
                        },
                        to=sid,
                    )
                except Exception:
                    pass

                return {"success": True, "room": room, "history": _load_history()}

            # Leave previous room
            if previous_room:
                try:
                    if _voice_room_remove(previous_room, username):
                        emit(
                            "voice_room_user_left",
                            {"room": previous_room, "username": username},
                            room=previous_room,
                        )
                except Exception:
                    pass

                leave_room(previous_room)
                try:
                    increment_room_count(previous_room, -1)
                except Exception:
                    pass

                try:
                    touch_custom_room_activity(previous_room)
                except Exception:
                    pass
                emit("notification", {"room": previous_room, "message": f"{username} has left {previous_room}."}, room=previous_room)

                # Update in-memory room membership immediately (prevents ghost users/counts).
                try:
                    with CONNECTED_USERS_LOCK:
                        if sid in CONNECTED_USERS:
                            CONNECTED_USERS[sid]["room"] = None
                    _emit_room_users_snapshot(previous_room)
                except Exception:
                    pass

            join_room(room)
            try:
                increment_room_count(room, 1)
            except Exception:
                pass

            # If this join came from an invite, consume it so we don't keep
            # re-notifying the user on future reconnects.
            try:
                consume_room_invites(room, username)
            except Exception:
                pass

            try:
                touch_custom_room_activity(room)
            except Exception:
                pass

            with CONNECTED_USERS_LOCK:
                CONNECTED_USERS.setdefault(sid, {"username": username, "room": None})
                CONNECTED_USERS[sid]["username"] = username
                CONNECTED_USERS[sid]["room"] = room

            # Broadcast updated room user list (keeps the USERS panel accurate).
            try:
                _emit_room_users_snapshot(room)
            except Exception:
                pass

            # Send current room policy to the joining user
            try:
                locked = _room_locked(room)
                readonly = _room_readonly(room)
                slow = _room_slowmode_seconds(room)
                bypass_lock = bool(check_user_permission(username, "admin:super") or check_user_permission(username, "room:lock"))
                bypass_ro = bool(check_user_permission(username, "admin:super") or check_user_permission(username, "room:readonly"))
                can_send = (not locked or bypass_lock) and (not readonly or bypass_ro)

                block_reason = None
                if not can_send:
                    if readonly and not bypass_ro:
                        block_reason = "read_only"
                    elif locked and not bypass_lock:
                        block_reason = "locked"
                    else:
                        block_reason = "blocked"

                emit(
                    "room_policy_state",
                    {
                        "room": room,
                        "locked": bool(locked),
                        "readonly": bool(readonly),
                        "slowmode_seconds": int(slow or 0),
                        "can_send": bool(can_send),
                        "can_override_lock": bool(bypass_lock),
                        "can_override_readonly": bool(bypass_ro),
                        "block_reason": block_reason,
                    },
                    to=sid,
                )
            except Exception:
                pass

            log_audit_event(username, f"joined room {room}")
            emit("notification", {"room": room, "message": f"{username} has entered {room}."}, room=room)

            # Broadcast updated live room counts for room browser UI
            try:
                _emit_room_counts_snapshot()
            except Exception:
                pass

            return {"success": True, "room": room, "history": _load_history()}

        except Exception as e:
            print(f"[ERROR] handle_join: {e}")
            return {"success": False, "error": "server_error"}



    @socketio.on("get_room_history")
    @jwt_required()
    def handle_get_room_history(data):
        """Page room history. Clients pass before_id to fetch older."""
        user = get_jwt_identity()
        room = (data or {}).get("room")
        before_id = (data or {}).get("before_id")
        try:
            limit = int((data or {}).get("limit") or settings.get("room_history_page_size", 60))
        except Exception:
            limit = int(settings.get("room_history_page_size", 60) or 60)
        limit = max(1, min(limit, 200))

        if not room:
            return {"success": False, "error": "Missing room"}

        # Must be in the room
        sid = request.sid
        current_room = CONNECTED_USERS.get(sid, {}).get("room")
        if current_room != room:
            return {"success": False, "error": "Not in that room"}

        require_room_e2ee = bool(settings.get("require_room_e2ee", False))
        allow_legacy = bool(settings.get("allow_legacy_plaintext_room_history", False))

        try:
            before_id_int = int(before_id) if before_id is not None else None
        except Exception:
            before_id_int = None

        try:
            conn = get_db()
            with conn.cursor() as cur:
                if before_id_int:
                    cur.execute(
                        """
                        SELECT id, sender, message, is_encrypted, timestamp
                          FROM messages
                         WHERE room = %s
                           AND id < %s
                         ORDER BY id DESC
                         LIMIT %s;
                        """,
                        (room, before_id_int, limit),
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
                        (room, limit),
                    )
                rows = cur.fetchall() or []
            rows.reverse()
            history = _format_room_history_rows(rows, require_room_e2ee, allow_legacy)
            return {"success": True, "history": history}
        except Exception as e:
            return {"success": False, "error": str(e)}

    @socketio.on("leave")
    @jwt_required()
    def handle_leave(data):
        room = data.get("room")
        username = get_jwt_identity()
        sid = request.sid

        if not room:
            return {"success": False, "error": "Room name missing"}

        current_room = CONNECTED_USERS.get(sid, {}).get("room")
        if current_room != room:
            # Already not in that room (treat as idempotent)
            return {"success": True}

        # If user was in voice for this room, drop them from voice roster first.
        try:
            if _voice_room_remove(room, username):
                emit("voice_room_user_left", {"room": room, "username": username}, room=room)
        except Exception:
            pass

        leave_room(room)
        try:
            increment_room_count(room, -1)
        except Exception:
            pass

        try:
            touch_custom_room_activity(room)
        except Exception:
            pass

        with CONNECTED_USERS_LOCK:
            CONNECTED_USERS.setdefault(sid, {"username": username, "room": None})
            CONNECTED_USERS[sid]["username"] = username
            CONNECTED_USERS[sid]["room"] = None

        # Broadcast updated room user list (keeps the USERS panel accurate).
        try:
            _emit_room_users_snapshot(room)
        except Exception:
            pass

        # Broadcast updated live room counts for room browser UI
        try:
            _emit_room_counts_snapshot()
        except Exception:
            pass

        log_audit_event(username, f"left room {room}")
        emit("notification", {"room": room, "message": f"🔌 {username} has left {room}."}, to=room)
        return {"success": True}



    @socketio.on("send_message")
    @jwt_required()
    def handle_send_message(data):
        # Room messages:
        # - Legacy clients send {"room","message"} (plaintext).
        # - New clients may send {"room","cipher","keys"} (ciphertext-only envelope).
        data = data or {}
        room = data.get("room")
        cipher = data.get("cipher")
        message = data.get("message")
        keys = data.get("keys") or data.get("key_map") or None
        username = get_jwt_identity()

        if not room:
            return {"success": False, "error": "Missing room"}

        # Touch activity for custom rooms (cleanup TTL)
        try:
            touch_custom_room_activity(room)
        except Exception:
            pass

        require_e2ee = bool(settings.get("require_room_e2ee", False))

        if require_e2ee and not cipher:
            # Allow slash commands like /invite in plaintext, even when the room requires E2EE for messages.
            if isinstance(message, str) and message.strip().lower().startswith("/invite"):
                pass
            else:
                return {"success": False, "error": "This room requires encrypted messages"}

        if (not cipher) and (message is None):
            return {"success": False, "error": "Missing message"}

        ok, err = _require_not_sanctioned(username, action="send")
        if not ok:
            return {"success": False, "error": err}

        sid = request.sid
        current_room = CONNECTED_USERS.get(sid, {}).get("room")
        if current_room != room:
            return {"success": False, "error": "Not in that room"}

        # Slash command: /invite <username> (plaintext rooms only).
        # Server-side safety net: never broadcast /invite into chat history even if a client fails to intercept.
        if cipher is None and isinstance(message, str):
            m = message.strip()
            if m.lower().startswith("/invite"):
                parts = m.split()
                if len(parts) < 2:
                    return {"success": False, "error": "Usage: /invite <username>"}
                invitee = parts[1].lstrip("@").strip()
                if not invitee:
                    return {"success": False, "error": "Usage: /invite <username>"}
                if invitee == username:
                    return {"success": False, "error": "Cannot invite yourself"}
                try:
                    if _either_blocked(username, invitee):
                        return {"success": False, "error": "You cannot invite this user"}
                except Exception:
                    pass

                # Persist invite (so offline users still see it) + push realtime notification
                kind = "room"
                event = "room_invite"
                delivered = False
                conn = None
                try:
                    conn = get_db()
                    with conn.cursor() as cur:
                        cur.execute("SELECT username FROM users WHERE LOWER(username)=LOWER(%s) LIMIT 1;", (invitee,))
                        _urow = cur.fetchone()
                        if _urow is None:
                            return {"success": False, "error": "User not found"}
                        invitee = str(_urow[0])
                        # If this is a custom room, detect privacy
                        cur.execute("SELECT created_by, is_private FROM custom_rooms WHERE name=%s;", (room,))
                        crow = cur.fetchone()
                        is_private = bool(crow[1]) if crow else False

                        # Ensure the room exists in chat_rooms for join UI
                        cur.execute("SELECT 1 FROM chat_rooms WHERE name=%s LIMIT 1;", (room,))
                        if cur.fetchone() is None:
                            if crow:
                                create_room_if_missing(room)
                            else:
                                return {"success": False, "error": "Room not found"}

                        if is_private:
                            # Anyone currently in the private room is allowed to invite (policy choice).
                            if not can_user_access_custom_room(room, username):
                                return {"success": False, "error": "No access to invite for this room"}
                            cur.execute(
                                """
                                INSERT INTO custom_room_invites (room_name, invited_user, invited_by)
                                VALUES (%s, %s, %s)
                                ON CONFLICT (room_name, invited_user) DO NOTHING;
                                """,
                                (room, invitee, username),
                            )
                            kind = "custom_private"
                            event = "custom_room_invite"
                        else:
                            cur.execute(
                                """
                                INSERT INTO room_invites (room_name, invited_user, invited_by)
                                VALUES (%s, %s, %s)
                                ON CONFLICT (room_name, invited_user) DO NOTHING;
                                """,
                                (room, invitee, username),
                            )
                    conn.commit()
                    delivered = bool(_emit_to_user(invitee, event, {"room": room, "by": username}))
                except Exception as e:
                    try:
                        if conn: conn.rollback()
                    except Exception:
                        pass
                    return {"success": False, "error": str(e)}

                return {"success": True, "command": "invite", "room": room, "invitee": invitee, "kind": kind, "delivered": delivered}

        # Validate payload size
        if cipher:
            if not isinstance(cipher, str):
                return {"success": False, "error": "bad_cipher"}
            max_cipher_len = int(settings.get("max_room_cipher_length") or 120000)
            if len(cipher) > max_cipher_len:
                return {"success": False, "error": f"Ciphertext too large (max {max_cipher_len})"}

            if keys is not None and not isinstance(keys, dict):
                return {"success": False, "error": "bad_keys"}
            if isinstance(keys, dict):
                max_keys = int(settings.get("max_room_key_recipients") or 120)
                if len(keys) > max_keys:
                    return {"success": False, "error": f"Too many recipients (max {max_keys})"}
        else:
            if not isinstance(message, str):
                return {"success": False, "error": "bad_message"}
            max_len = int(settings.get("max_message_length", 1000))
            if len(message) > max_len:
                return {"success": False, "error": f"Message too long (max {max_len})"}

        # Read-only rooms: allow only users with room:readonly (admins) or admin:super
        if _room_readonly(room) and not (
            check_user_permission(username, "room:readonly") or check_user_permission(username, "admin:super")
        ):
            return {"success": False, "error": "Room is read-only"}

        # Locked rooms: allow messages only for lock-capable users
        if _room_locked(room) and not (
            check_user_permission(username, "room:lock") or check_user_permission(username, "admin:super")
        ):
            return {"success": False, "error": "Room is locked"}



        # Anti-abuse: room slowmode + burst rate limiting + optional per-user quota
        # Staff accounts (admin:basic/admin:super) are exempt.
        is_staff = False
        try:
            is_staff = bool(check_user_permission(username, "admin:super") or check_user_permission(username, "admin:basic"))
        except Exception:
            is_staff = False

        slowmode_stamp = None

        # Anti-spam content heuristics (plaintext rooms only; staff exempt)
        if not is_staff and cipher is None:
            okc, cerr = _antiabuse_plaintext_checks(username, room, message)
            if not okc:
                return {"success": False, "error": cerr or "Message blocked"}

        if not is_staff:
            # Optional per-user quota (messages/hour) – only enforced when explicitly configured for the user.
            quota = _get_user_quota_per_hour(username)
            if quota and int(quota) > 0:
                okq, _raq = _rl(f"quota:{username}", int(quota), 3600)
                if not okq:
                    _abuse_strike(username, "quota")
                    return {"success": False, "error": f"Quota exceeded ({int(quota)}/hour). Try later."}

            # Burst rate limit for room messages
            lim, win = _parse_rate_limit(settings.get("room_msg_rate_limit"), default_limit=20, default_window=10)
            try:
                win = int(settings.get("room_msg_rate_window_sec") or win)
            except Exception:
                pass
            okrl, retry = _rl(f"roommsg:{username}", lim, win)
            if not okrl:
                if _abuse_strike(username, "room_rate"):
                    return {"success": False, "error": "Auto-muted for spamming. Try again later."}
                return {"success": False, "error": f"Rate limited (wait {retry:.1f}s)"}

            # Room slowmode (per user per room)
            slow = _room_slowmode_seconds(room)
            if slow > 0:
                now = time.time()
                with _SLOWMODE_LAST_SENT_LOCK:
                    last = float(_SLOWMODE_LAST_SENT.get((username, room), 0.0) or 0.0)
                if (now - last) < float(slow):
                    remaining = float(slow) - (now - last)
                    if _abuse_strike(username, "slowmode"):
                        return {"success": False, "error": "Auto-muted for spamming. Try again later."}
                    return {"success": False, "error": f"Slow mode (wait {remaining:.1f}s)"}
                slowmode_stamp = now

        if slowmode_stamp is not None:
            with _SLOWMODE_LAST_SENT_LOCK:
                _SLOWMODE_LAST_SENT[(username, room)] = float(slowmode_stamp)
        # Persist room messages for history/paging (ciphertext-only safe).
        # We use the DB row id as the canonical message_id when possible.
        message_id = None
        try:
            conn = get_db()
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO messages (room, sender, message, is_encrypted)
                    VALUES (%s, %s, %s, %s)
                    RETURNING id;
                    """,
                    (room, username, (cipher if cipher is not None else message), bool(cipher)),
                )
                row = cur.fetchone()
                message_id = int(row[0]) if row else None
            conn.commit()
        except Exception:
            # Fail open: do not drop the chat message if persistence fails.
            try:
                conn.rollback()
            except Exception:
                pass
            message_id = uuid.uuid4().hex

        if cipher:
            emit(
                "chat_message",
                {
                    "room": room,
                    "message_id": message_id,
                    "username": username,
                    # Compatibility text for older clients (does not reveal plaintext).
                    "message": "🔒 Encrypted message",
                    "encrypted": True,
                    "cipher": cipher,
                    "keys": keys,
                    "ts": time.time(),
                },
                to=room,
            )
        else:
            emit(
                "chat_message",
                {
                    "room": room,
                    "message_id": message_id,
                    "username": username,
                    "message": message,
                    "encrypted": False,
                    "ts": time.time(),
                },
                to=room,
            )
        return {"success": True, "message_id": message_id}


    @socketio.on("get_users_in_room")
    @jwt_required()
    def handle_get_users_in_room(data):
        room = (data or {}).get("room")
        # Always respond with a snapshot. This keeps the USERS panel correct even after reconnects.
        _emit_room_users_snapshot(room, to_sid=request.sid)



    @socketio.on("typing")
    @jwt_required()
    def handle_typing(data):
        room = (data or {}).get("room")
        user = get_jwt_identity()
        sid = request.sid

        if not room:
            return {"success": False, "error": "Missing room"}

        # Only broadcast typing if this socket is actually in the room
        current_room = CONNECTED_USERS.get(sid, {}).get("room")
        if current_room != room:
            return {"success": False, "error": "Not in that room"}

        with TYPING_STATUS_LOCK:
            TYPING_STATUS[user] = time.time()

        emit("notification", f"{user} is typing...", to=room)
        return {"success": True}


    @socketio.on("stop_typing")
    @jwt_required()
    def handle_stop_typing(data):
        room = (data or {}).get("room")
        user = get_jwt_identity()
        sid = request.sid

        if not room:
            return {"success": False, "error": "Missing room"}

        current_room = CONNECTED_USERS.get(sid, {}).get("room")
        if current_room != room:
            return {"success": False, "error": "Not in that room"}

        with TYPING_STATUS_LOCK:
            if user in TYPING_STATUS:
                try:
                    del TYPING_STATUS[user]
                except Exception:
                    pass

        emit("notification", f"{user} stopped typing", to=room)
        return {"success": True}


    @socketio.on("react_to_message")
    @jwt_required()
    def handle_react_to_message(data):
        room = (data or {}).get("room")
        message_id = (data or {}).get("message_id")
        emoji = (data or {}).get("emoji") or (data or {}).get("reaction") or "👍"
        user = get_jwt_identity()

        if not room or not message_id:
            return {"success": False, "error": "Missing room or message_id"}

        # Must be in the room to react
        sid = request.sid
        current_room = CONNECTED_USERS.get(sid, {}).get("room")
        if current_room != room:
            return {"success": False, "error": "Not in that room"}

        emoji = str(emoji)
        if emoji not in ALLOWED_REACTION_EMOJIS:
            return {"success": False, "error": "Unsupported reaction"}

        counts = None
        try:
            mid_int = int(message_id)
        except Exception:
            mid_int = None

        # DB-backed (preferred)
        if mid_int is not None:
            try:
                conn = get_db()
                with conn.cursor() as cur:
                    cur.execute(
                        "SELECT emoji FROM message_reactions WHERE message_id=%s AND username=%s LIMIT 1;",
                        (mid_int, user),
                    )
                    existing = cur.fetchone()
                    if existing:
                        cur.execute(
                            "SELECT emoji, COUNT(*) FROM message_reactions WHERE message_id=%s GROUP BY emoji;",
                            (mid_int,),
                        )
                        rows = cur.fetchall() or []
                        counts = {r[0]: int(r[1] or 0) for r in rows}
                        return {
                            "success": False,
                            "error": "Reaction is final. You cannot change or undo it.",
                            "counts": counts,
                            "current": existing[0],
                        }

                    cur.execute(
                        "INSERT INTO message_reactions (message_id, username, emoji) VALUES (%s, %s, %s);",
                        (mid_int, user, emoji),
                    )
                    cur.execute(
                        "SELECT emoji, COUNT(*) FROM message_reactions WHERE message_id=%s GROUP BY emoji;",
                        (mid_int,),
                    )
                    rows = cur.fetchall() or []
                conn.commit()
                counts = {r[0]: int(r[1] or 0) for r in rows}
            except Exception:
                try:
                    conn.rollback()
                except Exception:
                    pass
                counts = None

        # Fallback to in-memory for non-numeric ids or if DB failed
        if counts is None:
            mid_key = str(message_id)
            with MESSAGE_REACTIONS_LOCK:
                entry = MESSAGE_REACTIONS.get(mid_key)
                if not entry:
                    entry = {"room": room, "reactions": {}, "by_user": {}, "ts": time.time()}
                    MESSAGE_REACTIONS[mid_key] = entry

                if entry.get("room") != room:
                    return {"success": False, "error": "Message not in this room"}

                rx = entry.setdefault("reactions", {})
                by_user = entry.setdefault("by_user", {})
                existing = by_user.get(user)

                if existing:
                    counts = {e: len(u_set) for e, u_set in rx.items()}
                    return {
                        "success": False,
                        "error": "Reaction is final. You cannot change or undo it.",
                        "counts": counts,
                        "current": existing,
                    }

                users = rx.setdefault(emoji, set())
                users.add(user)
                by_user[user] = emoji
                counts = {e: len(u_set) for e, u_set in rx.items()}

        emit(
            "message_reactions",
            {"room": room, "message_id": message_id, "counts": counts},
            to=room,
        )
        return {"success": True, "counts": counts}


    @socketio.on("pin_message")
    @jwt_required()
    def handle_pin_message(data):
        message_id = data.get("message_id")
        room = data.get("room")
        user = get_jwt_identity()

        if not message_id or not room:
            return {"success": False}

        emit("notification", f"{user} pinned message {message_id}", to=room)
        return {"success": True}


    @socketio.on("unpin_message")
    @jwt_required()
    def handle_unpin_message(data):
        message_id = data.get("message_id")
        room = data.get("room")
        user = get_jwt_identity()

        if not message_id or not room:
            return {"success": False}

        emit("notification", f"{user} unpinned message {message_id}", to=room)
        return {"success": True}


    @socketio.on("edit_message")
    @jwt_required()
    def handle_edit_message(data):
        message_id = data.get("message_id")
        new_text = data.get("new_text")
        user = get_jwt_identity()

        if not message_id or not new_text:
            return {"success": False}

        emit("notification", f"{user} edited message {message_id}", to=request.sid)
        return {"success": True}


    @socketio.on("delete_message")
    @jwt_required()
    def handle_delete_message(data):
        message_id = data.get("message_id")
        room = data.get("room")
        user = get_jwt_identity()

        if not message_id or not room:
            return {"success": False}

        emit("notification", f"{user} deleted message {message_id}", to=room)
        return {"success": True}


    @socketio.on("highlight_message")
    @jwt_required()
    def handle_highlight_message(data):
        message_id = data.get("message_id")
        room = data.get("room")
        user = get_jwt_identity()

        if not message_id or not room:
            return {"success": False}

        emit("notification", f"{user} highlighted message {message_id}", to=room)
        return {"success": True}


    @socketio.on("wave_user")
    @jwt_required()
    def handle_wave_user(data):
        target = data.get("target")
        sender = get_jwt_identity()

        if not target:
            return {"success": False}

        ok, err = _require_not_sanctioned(sender, action="send")
        if not ok:
            return {"success": False, "error": err}

        if _either_blocked(sender, target):
            return {"success": False, "error": "Blocked"}

        _emit_to_user(target, "notification", f"{sender} 👋 waved at you!")
        return {"success": True}


    @socketio.on("vote_poll")
    @jwt_required()
    def handle_vote_poll(data):
        poll_id = data.get("poll_id")
        option = data.get("option")
        voter = get_jwt_identity()

        if not poll_id or not option:
            return {"success": False}

        emit("notification", f"{voter} voted in poll {poll_id}", to=request.sid)
        return {"success": True}


    @socketio.on("get_active_polls")
    @jwt_required()
    def handle_get_active_polls(data=None):
        emit("notification", "Active polls retrieved", to=request.sid)


    @socketio.on("room_navigation_shortcuts")
    @jwt_required()
    def handle_room_navigation_shortcuts(data=None):
        user = get_jwt_identity()
        emit("notification", f"{user} requested room navigation shortcuts", to=request.sid)
        return {"success": True}


