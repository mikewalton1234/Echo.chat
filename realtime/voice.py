"""Socket.IO handlers: voice.

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

    @socketio.on("voice_room_join")
    @jwt_required()
    def handle_voice_room_join(data):
        username = get_jwt_identity()
        sid = request.sid
        room = (data or {}).get("room")

        if not room:
            return {"success": False, "error": "Missing room"}

        ok, err = _require_not_sanctioned(username, action="voice")
        if not ok:
            return {"success": False, "error": err}

        # Only allow voice join for the room this socket is currently joined to.
        current_room = CONNECTED_USERS.get(sid, {}).get("room")
        if current_room != room:
            return {"success": False, "error": "Not in that room"}

        ok2, err2, roster = _voice_room_add(room, username)
        limit = int(settings.get("voice_max_room_peers", 0) or 0)
        if not ok2:
            return {"success": False, "error": err2 or "Voice join denied", "users": roster, "limit": limit}

        # Push roster to the joiner; notify others.
        emit("voice_room_roster", {"room": room, "users": roster, "limit": limit}, to=sid)
        emit("voice_room_user_joined", {"room": room, "username": username}, room=room, include_self=False)
        try:
            touch_custom_room_activity(room)
        except Exception:
            pass
        return {"success": True, "users": roster, "limit": limit}


    @socketio.on("voice_room_leave")
    @jwt_required()
    def handle_voice_room_leave(data):
        username = get_jwt_identity()
        sid = request.sid
        room = (data or {}).get("room") or CONNECTED_USERS.get(sid, {}).get("room")
        if not room:
            return {"success": True}
        removed = False
        try:
            removed = _voice_room_remove(room, username)
        except Exception:
            removed = False
        if removed:
            emit("voice_room_user_left", {"room": room, "username": username}, room=room)
        try:
            touch_custom_room_activity(room)
        except Exception:
            pass
        limit = int(settings.get("voice_max_room_peers", 0) or 0)
        emit("voice_room_roster", {"room": room, "users": _voice_room_users(room), "limit": limit}, to=sid)
        return {"success": True}


    @socketio.on("voice_room_offer")
    @jwt_required()
    def handle_voice_room_offer(data):
        sender = get_jwt_identity()
        sid = request.sid
        room = (data or {}).get("room")
        to = (data or {}).get("to")
        offer = (data or {}).get("offer")
        if not room or not to or not offer:
            return {"success": False, "error": "Missing fields"}
        # Sender must be in this room and in voice.
        if CONNECTED_USERS.get(sid, {}).get("room") != room:
            return {"success": False, "error": "Not in that room"}
        if sender not in set(_voice_room_users(room)):
            return {"success": False, "error": "Not in voice"}
        if to not in set(_voice_room_users(room)):
            return {"success": False, "error": "Recipient not in voice"}
        delivered = _emit_to_user(to, "voice_room_offer", {"room": room, "sender": sender, "offer": offer})
        return {"success": True, "delivered": delivered}


    @socketio.on("voice_room_answer")
    @jwt_required()
    def handle_voice_room_answer(data):
        sender = get_jwt_identity()
        sid = request.sid
        room = (data or {}).get("room")
        to = (data or {}).get("to")
        answer = (data or {}).get("answer")
        if not room or not to or not answer:
            return {"success": False, "error": "Missing fields"}
        if CONNECTED_USERS.get(sid, {}).get("room") != room:
            return {"success": False, "error": "Not in that room"}
        if sender not in set(_voice_room_users(room)):
            return {"success": False, "error": "Not in voice"}
        if to not in set(_voice_room_users(room)):
            return {"success": False, "error": "Recipient not in voice"}
        delivered = _emit_to_user(to, "voice_room_answer", {"room": room, "sender": sender, "answer": answer})
        return {"success": True, "delivered": delivered}


    @socketio.on("voice_room_ice")
    @jwt_required()
    def handle_voice_room_ice(data):
        sender = get_jwt_identity()
        sid = request.sid
        room = (data or {}).get("room")
        to = (data or {}).get("to")
        candidate = (data or {}).get("candidate")
        if not room or not to or not candidate:
            return {"success": False, "error": "Missing fields"}
        if CONNECTED_USERS.get(sid, {}).get("room") != room:
            return {"success": False, "error": "Not in that room"}
        if sender not in set(_voice_room_users(room)):
            return {"success": False, "error": "Not in voice"}
        if to not in set(_voice_room_users(room)):
            return {"success": False, "error": "Recipient not in voice"}
        delivered = _emit_to_user(to, "voice_room_ice", {"room": room, "sender": sender, "candidate": candidate})
        return {"success": True, "delivered": delivered}


    # 1:1 voice calls (DM-like)
    # Server tracks call session state to prevent spoofed signaling.

    @socketio.on("voice_dm_invite")
    @jwt_required()
    def handle_voice_dm_invite(data):
        sender = get_jwt_identity()
        sid = request.sid
        to = (data or {}).get("to")
        call_id = (data or {}).get("call_id")

        if not to or not call_id:
            return {"success": False, "error": "Missing fields"}

        if not _valid_id(call_id):
            return {"success": False, "error": "Invalid call_id"}

        ok, err = _require_not_sanctioned(sender, action="voice")
        if not ok:
            return {"success": False, "error": err}

        if to == sender:
            return {"success": False, "error": "Cannot call yourself"}

        if _either_blocked(sender, to):
            return {"success": False, "error": "Direct message blocked"}

        # basic cooldown per socket
        now = time.time()
        cooldown = float(settings.get("voice_invite_cooldown_seconds", 2) or 2)
        last = VOICE_INVITE_LAST.get(sid, 0.0)
        if cooldown > 0 and (now - last) < cooldown:
            return {"success": False, "error": "Too many invites"}
        VOICE_INVITE_LAST[sid] = now

        _cleanup_voice_dm_sessions()

        with VOICE_DM_SESSIONS_LOCK:
            existing = VOICE_DM_SESSIONS.get(call_id)
            if existing:
                state = str(existing.get("state") or "")
                caller = existing.get("caller")
                callee = existing.get("callee")
                if state in {"invited", "active"}:
                    return {"success": False, "error": "call_id already in use"}
                # allow overwrite only if stale state got here somehow
            VOICE_DM_SESSIONS[call_id] = {
                "caller": sender,
                "callee": to,
                "state": "invited",
                "created": now,
                "updated": now,
            }

        delivered = _emit_to_user(to, "voice_dm_invite", {"sender": sender, "call_id": call_id})
        log_audit_event(sender, "voice_dm_invite", target=to)
        return {"success": True, "delivered": delivered}


    @socketio.on("voice_dm_accept")
    @jwt_required()
    def handle_voice_dm_accept(data):
        sender = get_jwt_identity()
        to = (data or {}).get("to")
        call_id = (data or {}).get("call_id")

        if not to or not call_id:
            return {"success": False, "error": "Missing fields"}

        if not _valid_id(call_id):
            return {"success": False, "error": "Invalid call_id"}

        ok, err = _require_not_sanctioned(sender, action="voice")
        if not ok:
            return {"success": False, "error": err}

        if _either_blocked(sender, to):
            return {"success": False, "error": "Direct message blocked"}

        _cleanup_voice_dm_sessions()

        with VOICE_DM_SESSIONS_LOCK:
            sess = VOICE_DM_SESSIONS.get(call_id)
            if not sess:
                return {"success": False, "error": "Unknown/expired call"}
            if sess.get("callee") != sender or sess.get("caller") != to:
                return {"success": False, "error": "Not a participant"}
            if str(sess.get("state") or "") != "invited":
                return {"success": False, "error": "Call not in invited state"}
            sess["state"] = "active"
            sess["updated"] = time.time()

        delivered = _emit_to_user(to, "voice_dm_accept", {"sender": sender, "call_id": call_id})
        log_audit_event(sender, "voice_dm_accept", target=to)
        return {"success": True, "delivered": delivered}


    @socketio.on("voice_dm_decline")
    @jwt_required()
    def handle_voice_dm_decline(data):
        sender = get_jwt_identity()
        to = (data or {}).get("to")
        call_id = (data or {}).get("call_id")
        reason = (data or {}).get("reason") or "Declined"

        if not to or not call_id:
            return {"success": False, "error": "Missing fields"}

        if not _valid_id(call_id):
            return {"success": False, "error": "Invalid call_id"}

        ok, err = _require_not_sanctioned(sender, action="voice")
        if not ok:
            return {"success": False, "error": err}

        if _either_blocked(sender, to):
            return {"success": False, "error": "Direct message blocked"}

        _cleanup_voice_dm_sessions()

        with VOICE_DM_SESSIONS_LOCK:
            sess = VOICE_DM_SESSIONS.get(call_id)
            if not sess:
                return {"success": False, "error": "Unknown/expired call"}
            if sess.get("callee") != sender or sess.get("caller") != to:
                return {"success": False, "error": "Not a participant"}
            try:
                del VOICE_DM_SESSIONS[call_id]
            except Exception:
                pass

        delivered = _emit_to_user(to, "voice_dm_decline", {"sender": sender, "call_id": call_id, "reason": reason})
        log_audit_event(sender, "voice_dm_decline", target=to)
        return {"success": True, "delivered": delivered}


    @socketio.on("voice_dm_end")
    @jwt_required()
    def handle_voice_dm_end(data):
        sender = get_jwt_identity()
        to = (data or {}).get("to")
        call_id = (data or {}).get("call_id")
        reason = (data or {}).get("reason") or "Ended"

        if not to or not call_id:
            return {"success": False, "error": "Missing fields"}

        if not _valid_id(call_id):
            return {"success": False, "error": "Invalid call_id"}

        ok, err = _require_not_sanctioned(sender, action="voice")
        if not ok:
            return {"success": False, "error": err}

        if _either_blocked(sender, to):
            return {"success": False, "error": "Direct message blocked"}

        _cleanup_voice_dm_sessions()

        with VOICE_DM_SESSIONS_LOCK:
            sess = VOICE_DM_SESSIONS.get(call_id)
            if not sess:
                # allow idempotent end
                sess_ok = True
            else:
                if {sess.get("caller"), sess.get("callee")} != {sender, to}:
                    return {"success": False, "error": "Not a participant"}
                try:
                    del VOICE_DM_SESSIONS[call_id]
                except Exception:
                    pass
                sess_ok = True

        delivered = _emit_to_user(to, "voice_dm_end", {"sender": sender, "call_id": call_id, "reason": reason})
        log_audit_event(sender, "voice_dm_end", target=to)
        return {"success": True, "delivered": delivered, "session": sess_ok}


    @socketio.on("voice_dm_offer")
    @jwt_required()
    def handle_voice_dm_offer(data):
        sender = get_jwt_identity()
        to = (data or {}).get("to")
        call_id = (data or {}).get("call_id")
        offer = (data or {}).get("offer")

        if not to or not call_id or not offer:
            return {"success": False, "error": "Missing fields"}

        if not _valid_id(call_id):
            return {"success": False, "error": "Invalid call_id"}

        ok, err = _require_not_sanctioned(sender, action="voice")
        if not ok:
            return {"success": False, "error": err}

        if _either_blocked(sender, to):
            return {"success": False, "error": "Direct message blocked"}

        _, err_resp = _voice_dm_require_active(sender, to, call_id)
        if err_resp:
            return err_resp

        delivered = _emit_to_user(to, "voice_dm_offer", {"sender": sender, "call_id": call_id, "offer": offer})
        return {"success": True, "delivered": delivered}


    @socketio.on("voice_dm_answer")
    @jwt_required()
    def handle_voice_dm_answer(data):
        sender = get_jwt_identity()
        to = (data or {}).get("to")
        call_id = (data or {}).get("call_id")
        answer = (data or {}).get("answer")

        if not to or not call_id or not answer:
            return {"success": False, "error": "Missing fields"}

        if not _valid_id(call_id):
            return {"success": False, "error": "Invalid call_id"}

        ok, err = _require_not_sanctioned(sender, action="voice")
        if not ok:
            return {"success": False, "error": err}

        if _either_blocked(sender, to):
            return {"success": False, "error": "Direct message blocked"}

        _, err_resp = _voice_dm_require_active(sender, to, call_id)
        if err_resp:
            return err_resp

        delivered = _emit_to_user(to, "voice_dm_answer", {"sender": sender, "call_id": call_id, "answer": answer})
        return {"success": True, "delivered": delivered}


    @socketio.on("voice_dm_ice")
    @jwt_required()
    def handle_voice_dm_ice(data):
        sender = get_jwt_identity()
        to = (data or {}).get("to")
        call_id = (data or {}).get("call_id")
        candidate = (data or {}).get("candidate")

        if not to or not call_id or not candidate:
            return {"success": False, "error": "Missing fields"}

        if not _valid_id(call_id):
            return {"success": False, "error": "Invalid call_id"}

        ok, err = _require_not_sanctioned(sender, action="voice")
        if not ok:
            return {"success": False, "error": err}

        if _either_blocked(sender, to):
            return {"success": False, "error": "Direct message blocked"}

        _, err_resp = _voice_dm_require_active(sender, to, call_id)
        if err_resp:
            return err_resp

        delivered = _emit_to_user(to, "voice_dm_ice", {"sender": sender, "call_id": call_id, "candidate": candidate})
        return {"success": True, "delivered": delivered}




