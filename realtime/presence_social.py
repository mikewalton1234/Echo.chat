"""Socket.IO handlers: presence_social.

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

    @socketio.on("connect")

    @jwt_required()
    def handle_connect(auth=None):
        username = get_jwt_identity()
        sid = request.sid
        # If banned/kicked, force the client back to the login screen with a reason.
        if is_user_sanctioned(username, "ban"):
            msg = _format_sanction_message(username, "ban", "You were signed out because you are banned.")
            try:
                emit("force_logout", {"username": username, "reason": msg, "code": "ban"}, to=sid)
            except Exception:
                pass
            try:
                disconnect(sid=sid)
            except Exception:
                pass
            return False

        if is_user_sanctioned(username, "kick"):
            msg = _format_sanction_message(username, "kick", "You were signed out because you were kicked.")
            try:
                emit("force_logout", {"username": username, "reason": msg, "code": "kick"}, to=sid)
            except Exception:
                pass
            try:
                disconnect(sid=sid)
            except Exception:
                pass
            return False

        ok, err = _require_not_sanctioned(username, action="connect")
        if not ok:
            emit("notification", err or "Connection denied", to=sid)
            return False  # drop

        # Track this session first
        with CONNECTED_USERS_LOCK:
            CONNECTED_USERS[sid] = {"username": username, "room": None}

        # Mark online only if this is the first active session
        first_session = (len(_user_sids(username)) == 1)
        if first_session:
            try:
                conn = get_db()
                with conn.cursor() as cur:
                    cur.execute("UPDATE users SET online = TRUE WHERE username = %s;", (username,))
                conn.commit()
            except Exception:
                pass

        # Push user's own presence to their UI
        try:
            emit("my_presence", _self_presence_snapshot(username), to=sid)
        except Exception:
            pass

        # Viewer-safe presence push to friends (best-effort)
        if first_session:
            _broadcast_presence_to_friends(username)

        log_audit_event(username, "connected")
        

        # Prime the client with live room counts (for room browser badges).
        try:
            _emit_room_counts_snapshot(to_sid=sid)
        except Exception:
            pass

        # Deliver any queued ciphertext PMs for this user.
        _emit_missed_pm_summary(username, sid)


    @socketio.on("disconnect")
    def handle_disconnect(*args, **kwargs):
        # Socket.IO may pass a reason or sid depending on version.
        reason = args[0] if args else kwargs.get("reason")
        sid = request.sid

        # Snapshot + remove this session safely (avoid dict-size-change during iteration).
        with CONNECTED_USERS_LOCK:
            session = CONNECTED_USERS.get(sid)
            user = session.get("username") if session else None
            room = session.get("room") if session else None
            if session:
                try:
                    del CONNECTED_USERS[sid]
                except Exception:
                    pass

        if not user:
            print(f"🔌 Disconnect from unknown SID: {sid}")
            return

        log_audit_event(user, "disconnected")

        if room:
            # Voice roster cleanup (best-effort)
            try:
                if _voice_room_remove(room, user):
                    emit("voice_room_user_left", {"room": room, "username": user}, room=room)
            except Exception:
                pass

            try:
                leave_room(room)
            except Exception:
                pass

            # Maintain member_count (best-effort)
            try:
                increment_room_count(room, -1)
            except Exception:
                pass


            try:
                touch_custom_room_activity(room)
            except Exception:
                pass

            emit("notification", f"{user} disconnected", room=room)

            # Broadcast updated live room counts
            try:
                _emit_room_counts_snapshot()
            except Exception:
                pass

            # Broadcast updated room user list (keeps the USERS panel accurate).
            try:
                _emit_room_users_snapshot(room)
            except Exception:
                pass

        # If user still has other live sessions, do NOT flip them offline or end calls.
        if _user_sids(user):
            return

        # Mark offline in DB (best-effort)
        try:
            conn = get_db()
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE users SET online = FALSE, last_seen = NOW() WHERE username = %s;",
                    (user,),
                )
            conn.commit()
        except Exception:
            pass

        # Viewer-safe presence push to friends (best-effort)
        _broadcast_presence_to_friends(user)

        # End any active/invited voice DM sessions when a user goes fully offline (best-effort)
        try:
            _cleanup_voice_dm_sessions()
            notify = []
            with VOICE_DM_SESSIONS_LOCK:
                for cid, s in list(VOICE_DM_SESSIONS.items()):
                    if s.get("caller") == user or s.get("callee") == user:
                        other = s.get("callee") if s.get("caller") == user else s.get("caller")
                        state = str(s.get("state") or "")
                        if state in {"active", "invited"}:
                            notify.append((cid, other))
                        try:
                            del VOICE_DM_SESSIONS[cid]
                        except Exception:
                            pass

            for cid, other in notify:
                _emit_to_user(other, "voice_dm_end", {"sender": user, "call_id": cid, "reason": "peer_disconnected"})
        except Exception:
            pass



    @socketio.on("remove_friend")
    @jwt_required()
    def handle_remove_friend(data):
        username = get_jwt_identity()

        try:
            lim = int(settings.get("social_action_rate_limit") or 60)
            win = int(settings.get("social_action_rate_window_sec") or 60)
        except Exception:
            lim, win = 60, 60
        okrl, retry = _rl(f"rmfriend:{username}", lim, win)
        if not okrl:
            return {"success": False, "error": "Rate limited", "retry_after": retry}

        friend = (data or {}).get("friend")
        if not friend:
            return {"success": False, "error": "No friend specified"}

        try:
            conn = get_db()
            with conn.cursor() as cur:
                cur.execute(
                    """
                    DELETE FROM friend_requests
                     WHERE ((from_user = %s AND to_user = %s)
                            OR (from_user = %s AND to_user = %s))
                       AND request_status = 'accepted';
                    """,
                    (username, friend, friend, username),
                )
                affected = cur.rowcount
            conn.commit()
        except Exception as e:
            try:
                conn.rollback()
            except Exception:
                pass
            print(f"[DB ERROR] Failed to remove friend: {e}")
            return {"success": False, "error": "Database error"}

        if affected:
            updated_friends = get_friends_for_user(username)
            emit("friends_list", updated_friends, to=request.sid)
            return {"success": True}
        return {"success": False, "error": "Friendship not found"}
    



    @socketio.on("get_pending_friend_requests")
    @jwt_required()
    def handle_get_pending_friend_requests(data=None):
        username = get_jwt_identity()
        try:
            pending = get_pending_friend_requests(username)
            emit("pending_friend_requests", pending, to=request.sid)
        except Exception as e:
            print(f"[DB ERROR] get_pending_friend_requests: {e}")
            emit("pending_friend_requests", [], to=request.sid)

        return {"success": True}


    @socketio.on("get_blocked_users")
    @jwt_required()
    def handle_get_blocked_users(data=None):
        username = get_jwt_identity()
        try:
            blocked = get_blocked_users(username)
        except Exception as e:
            print(f"[DB ERROR] get_blocked_users: {e}")
            blocked = []

        emit("blocked_users_list", blocked, to=request.sid)
        # Also return for Socket.IO callback (client expects an array).
        return blocked


    @socketio.on("get_user_profile")
    @jwt_required()
    def handle_get_user_profile(data=None):
        """Return a *safe* public-ish profile for a user.

        Intentionally excludes private fields like email/phone/address/age.
        """
        viewer = get_jwt_identity()
        target = (data or {}).get("username")
        target = str(target).strip() if target is not None else ""

        if not target:
            return {"success": False, "error": "missing_username"}
        if len(target) > 64 or any(c.isspace() for c in target):
            return {"success": False, "error": "invalid_username"}

        try:
            conn = get_db()
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT username, bio, avatar_url, custom_status,
                           presence_status, online, last_seen, created_at, status
                      FROM users
                     WHERE username = %s
                     LIMIT 1;
                    """,
                    (target,),
                )
                row = cur.fetchone()
                if not row:
                    return {"success": False, "error": "not_found"}

                (uname, bio, avatar_url, custom_status, presence_status, online, last_seen, created_at, status) = row

                # Relationship checks (viewer-relative)
                cur.execute(
                    """
                    SELECT 1
                      FROM friend_requests
                     WHERE ((from_user = %s AND to_user = %s)
                         OR (from_user = %s AND to_user = %s))
                       AND request_status = 'accepted'
                     LIMIT 1;
                    """,
                    (viewer, uname, uname, viewer),
                )
                is_friend = cur.fetchone() is not None

                cur.execute(
                    "SELECT 1 FROM blocks WHERE blocker = %s AND blocked = %s LIMIT 1;",
                    (viewer, uname),
                )
                blocked_by_me = cur.fetchone() is not None

                cur.execute(
                    "SELECT 1 FROM blocks WHERE blocker = %s AND blocked = %s LIMIT 1;",
                    (uname, viewer),
                )
                blocks_me = cur.fetchone() is not None

            profile = {
                "username": uname,
                "bio": bio or "",
                "avatar_url": avatar_url or "",
                "custom_status": custom_status or "",
                "presence": presence_status or ("online" if bool(online) else "offline"),
                "online": bool(online),
                "last_seen": last_seen.isoformat() if hasattr(last_seen, "isoformat") else (str(last_seen) if last_seen else None),
                "created_at": created_at.isoformat() if hasattr(created_at, "isoformat") else (str(created_at) if created_at else None),
                "account_status": status or "active",
                "is_friend": bool(is_friend),
                "blocked_by_me": bool(blocked_by_me),
                "blocks_me": bool(blocks_me),
            }

            return {"success": True, "profile": profile}
        except Exception as e:
            print(f"[DB ERROR] get_user_profile: {e}")
            return {"success": False, "error": "db"}


    @socketio.on("accept_friend_request")
    @jwt_required()
    def handle_accept_friend_request(data):
        username = get_jwt_identity()
        from_user = (data or {}).get("from_user")

        if not from_user:
            emit("notification", "Invalid friend request to accept", to=request.sid)
            return {"success": False}

        if _either_blocked(username, from_user):
            return {"success": False, "error": "Blocked"}

        try:
            conn = get_db()
            with conn.cursor() as cur:
                # Step 1: Update request status
                cur.execute(
                    """
                    UPDATE friend_requests
                       SET request_status = 'accepted'
                     WHERE from_user = %s
                       AND to_user = %s
                       AND request_status = 'pending';
                    """,
                    (from_user, username),
                )
                affected = cur.rowcount

                # Step 2: Insert bidirectional friendship
                if affected:
                    cur.execute(
                        """
                        INSERT INTO friends (user_id, friend_id)
                        VALUES (
                            (SELECT id FROM users WHERE username = %s),
                            (SELECT id FROM users WHERE username = %s)
                        ),
                        (
                            (SELECT id FROM users WHERE username = %s),
                            (SELECT id FROM users WHERE username = %s)
                        )
                        ON CONFLICT DO NOTHING;
                        """,
                        (from_user, username, username, from_user),
                    )

            conn.commit()
        except Exception as e:
            print(f"[DB ERROR] accept_friend_request: {e}")
            return {"success": False, "error": "Database error"}

        if affected:
            pending = get_pending_friend_requests(username)
            emit("pending_friend_requests", pending, to=request.sid)

            updated_friends = get_friends_for_user(username)
            emit("friends_list", updated_friends, to=request.sid)

            # Let the requester know, if they're online
            _emit_to_user(from_user, "friend_request_accepted", {"by": username})

            # Also push an updated friends list to the requester so they don't
            # need to refresh their page to see the new friend.
            try:
                _emit_to_user(from_user, "friends_list", get_friends_for_user(from_user))
            except Exception:
                pass

            return {"success": True}

        return {"success": False, "error": "Request not found"}




    @socketio.on("block_user")
    @jwt_required()
    def handle_block_user(data):
        blocker = get_jwt_identity()
        blocked = data.get("blocked")

        if not blocked or blocked == blocker:
            return {"success": False, "error": "Invalid user"}

        try:
            conn = get_db()
            with conn.cursor() as cur:
                # Prevent double-block
                cur.execute(
                    """
                    SELECT 1
                      FROM blocks
                     WHERE blocker = %s
                       AND blocked = %s;
                    """,
                    (blocker, blocked),
                )
                if cur.fetchone():
                    return {"success": False, "error": "Already blocked"}

                cur.execute(
                    """
                    INSERT INTO blocks (blocker, blocked)
                    VALUES (%s, %s);
                    """,
                    (blocker, blocked),
                )
            conn.commit()
        except Exception as e:
            print(f"[DB ERROR] block_user: {e}")
            return {"success": False, "error": "Database error"}

        try:
            blocked_list = get_blocked_users(blocker)
            emit("blocked_users_list", blocked_list, to=request.sid)
        except Exception:
            pass
        return {"success": True}


    @socketio.on("unblock_user")
    @jwt_required()
    def handle_unblock_user(data):
        blocker = get_jwt_identity()
        blocked = data.get("blocked")

        if not blocked or blocked == blocker:
            return {"success": False, "error": "Invalid user"}

        try:
            conn = get_db()
            with conn.cursor() as cur:
                cur.execute(
                    """
                    DELETE FROM blocks
                     WHERE blocker = %s
                       AND blocked = %s;
                    """,
                    (blocker, blocked),
                )
            conn.commit()
            affected = cur.rowcount
        except Exception as e:
            print(f"[DB ERROR] unblock_user: {e}")
            return {"success": False, "error": "Database error"}

        if affected:
            try:
                blocked_list = get_blocked_users(blocker)
                emit("blocked_users_list", blocked_list, to=request.sid)
            except Exception:
                pass
            return {"success": True}
        return {"success": False, "error": "Not blocked"}


    @socketio.on("get_friends")
    @jwt_required()
    def handle_get_friends(data=None):
        username = get_jwt_identity()
        friends = get_friends_for_user(username)
        emit("friends_list", friends, to=request.sid)
        return {"friends": friends}


    @socketio.on("get_my_presence")
    @jwt_required()
    def handle_get_my_presence(data=None):
        username = get_jwt_identity()
        emit("my_presence", _self_presence_snapshot(username), to=request.sid)
        return {"success": True}



    @socketio.on("set_my_presence")
    @jwt_required()
    def handle_set_my_presence(data):
        """Update the caller's presence_status and/or custom_status.

        Data:
          presence: online|away|busy|invisible
          custom_status: optional text (<=128; empty clears)
        """
        username = get_jwt_identity()
        data = data or {}

        # Determine what fields were explicitly provided
        presence_provided = any(k in data for k in ("presence", "status"))
        custom_provided = any(k in data for k in ("custom_status", "customStatus", "custom"))

        presence = _normalize_presence(data.get("presence") if "presence" in data else data.get("status"))
        if presence_provided and not presence:
            return {"success": False, "error": "Invalid presence"}

        raw_custom = None
        if "custom_status" in data:
            raw_custom = data.get("custom_status")
        elif "customStatus" in data:
            raw_custom = data.get("customStatus")
        elif "custom" in data:
            raw_custom = data.get("custom")

        custom_status = _sanitize_custom_status(raw_custom)
        if custom_provided and raw_custom is not None and isinstance(raw_custom, str) and len(raw_custom.strip()) > 128:
            # Note: we clamp, but also tell caller we truncated.
            pass

        if not (presence_provided or custom_provided):
            return {"success": False, "error": "No updates"}

        try:
            conn = get_db()
            sets = []
            params = []
            if presence_provided:
                sets.append("presence_status = %s")
                params.append(presence)
            if custom_provided:
                sets.append("custom_status = %s")
                params.append(custom_status)  # None clears
            params.append(username)
            with conn.cursor() as cur:
                cur.execute(f"UPDATE users SET {', '.join(sets)} WHERE username = %s;", tuple(params))
            conn.commit()
        except Exception as e:
            return {"success": False, "error": "Database error"}

        # Update caller UI (all sessions)
        try:
            _emit_to_user(username, "my_presence", _self_presence_snapshot(username))
        except Exception:
            pass

        # Push viewer-safe snapshot to friends
        _broadcast_presence_to_friends(username)
        return {"success": True}



    @socketio.on("get_friend_presence")
    @jwt_required()
    def handle_get_friend_presence(data=None):
        """Return viewer-safe presence for all friends.

        Emitted payload (array):
          [{username, online, presence, custom_status, last_seen}, ...]

        Notes:
          - If a friend is in "invisible", they appear as offline.
          - custom_status is hidden when offline/invisible.
        """
        username = get_jwt_identity()
        friends = get_friends_for_user(username) or []
        presence_payload = []

        if friends:
            conn = get_db()
            try:
                with conn.cursor() as cur:
                    cur.execute(
                        """
                        SELECT username, online, presence_status, custom_status, last_seen
                          FROM users
                         WHERE username = ANY(%s);
                        """,
                        (friends,),
                    )
                    rows = cur.fetchall() or []

                row_map = {str(r[0]): r for r in rows}
                for u in friends:
                    r = row_map.get(u)
                    if r:
                        presence_payload.append(_public_presence_snapshot_from_row(r[0], r[1], r[2], r[3], r[4]))
                    else:
                        presence_payload.append({"username": u, "online": False, "presence": "offline", "custom_status": None, "last_seen": None})
            except Exception:
                presence_payload = [{"username": u, "online": False, "presence": "offline", "custom_status": None, "last_seen": None} for u in friends]

        emit("friends_presence", presence_payload, to=request.sid)
        return {"friends_presence": presence_payload}


    @socketio.on("send_friend_request")
    @jwt_required()
    def handle_send_friend_request(data):
        to_username = data.get("to_username")
        from_username = get_jwt_identity()

        if not to_username:
            return {"success": False, "error": "Missing recipient"}

        if to_username == from_username:
            return {"success": False, "error": "Cannot friend yourself"}

        ok, err = _require_not_sanctioned(from_username, action="send")
        if not ok:
            return {"success": False, "error": err}


        # Rate limit friend request sends (per-user) + optional target-spread guard.
        try:
            lim = int(settings.get("friend_req_rate_limit") or 5)
            win = int(settings.get("friend_req_rate_window_sec") or 60)
        except Exception:
            lim, win = 5, 60
        okrl, retry = _rl(f"friendreq:{from_username}", lim, win)
        if not okrl:
            return {"success": False, "error": "Rate limited", "retry_after": retry}

        okspread, errspread = _friend_req_target_spread_ok(from_username, to_username)
        if not okspread:
            return {"success": False, "error": errspread or "Rate limited"}

        if _either_blocked(from_username, to_username):
            return {"success": False, "error": "Blocked"}

        # Anti-abuse: friend request flood control (staff exempt)
        is_staff = False
        try:
            is_staff = bool(check_user_permission(from_username, "admin:super") or check_user_permission(from_username, "admin:basic"))
        except Exception:
            is_staff = False

        if not is_staff:
            okrl, retry = _friend_req_rate_ok(from_username)
            if not okrl:
                if _abuse_strike(from_username, "friendreq_rate"):
                    return {"success": False, "error": "Auto-muted for spamming. Try again later."}
                return {"success": False, "error": f"Rate limited (wait {retry:.1f}s)"}

            okspread, serr = _friend_req_target_spread_ok(from_username, to_username)
            if not okspread:
                return {"success": False, "error": serr or "Too many targets"}

        try:
            conn = get_db()
            with conn.cursor() as cur:
                # Ensure the target exists
                cur.execute("SELECT 1 FROM users WHERE username = %s LIMIT 1;", (to_username,))
                if not cur.fetchone():
                    return {"success": False, "error": "User not found"}

                # Already friends?
                cur.execute(
                    """
                    SELECT 1
                      FROM friends f
                      JOIN users u1 ON u1.id = f.user_id
                      JOIN users u2 ON u2.id = f.friend_id
                     WHERE u1.username = %s AND u2.username = %s
                     LIMIT 1;
                    """,
                    (from_username, to_username),
                )
                if cur.fetchone():
                    return {"success": False, "error": "Already friends"}

                # Prevent duplicate pending requests
                cur.execute(
                    """
                    SELECT 1
                      FROM friend_requests
                     WHERE from_user = %s AND to_user = %s AND request_status = 'pending'
                     LIMIT 1;
                    """,
                    (from_username, to_username),
                )
                if cur.fetchone():
                    return {"success": False, "error": "Request already pending"}

                cur.execute(
                    """
                    INSERT INTO friend_requests (from_user, to_user, request_status)
                    VALUES (%s, %s, 'pending');
                    """,
                    (from_username, to_username),
                )
            conn.commit()
        except Exception as e:
            print(f"[DB ERROR] send_friend_request: {e}")
            return {"success": False, "error": "Database error"}

        _emit_to_user(to_username, "friend_request", {"from": from_username})
        return {"success": True}


    @socketio.on("reject_friend_request")
    @jwt_required()
    def handle_reject_friend_request(data):
        username = get_jwt_identity()
        from_user = data.get("from_user")

        if not from_user:
            emit("notification", "Invalid friend request to reject", to=request.sid)
            return {"success": False}

        try:
            conn = get_db()
            with conn.cursor() as cur:
                cur.execute(
                    """
                    UPDATE friend_requests
                       SET request_status = 'rejected'
                     WHERE from_user = %s
                       AND to_user = %s
                       AND request_status = 'pending';
                    """,
                    (from_user, username),
                )
            conn.commit()
            affected = cur.rowcount
        except Exception as e:
            print(f"[DB ERROR] reject_friend_request: {e}")
            return {"success": False, "error": "Database error"}

        if affected:
            pending = get_pending_friend_requests(username)
            emit("pending_friend_requests", pending, to=request.sid)
            return {"success": True}
        else:
            return {"success": False, "error": "Request not found"}
