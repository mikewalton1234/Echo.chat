"""Socket.IO handlers: files.

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

    @socketio.on("p2p_file_offer")
    @jwt_required()
    def handle_p2p_file_offer(data):
        sender = get_jwt_identity()

        # Rate limit signalling to prevent abuse/spam.
        try:
            lim = int(settings.get("p2p_file_signal_rate_limit") or 600)
            win = int(settings.get("p2p_file_signal_rate_window_sec") or 60)
        except Exception:
            lim, win = 600, 60
        okrl, retry = _rl(f"p2p_sig:{sender}", lim, win)
        if not okrl:
            return {"success": False, "error": "Rate limited", "retry_after": retry}

        to = (data or {}).get("to")
        transfer_id = (data or {}).get("transfer_id")
        offer = (data or {}).get("offer")
        meta = _sanitize_file_meta((data or {}).get("meta") or {})

        if not to or not transfer_id or not offer:
            return {"success": False, "error": "Missing fields"}

        if not _valid_id(transfer_id):
            return {"success": False, "error": "Invalid transfer_id"}

        ok, err = _require_not_sanctioned(sender, action="dm")
        if not ok:
            return {"success": False, "error": err}

        if to == sender:
            return {"success": False, "error": "Cannot signal yourself"}

        if _either_blocked(sender, to):
            return {"success": False, "error": "Direct message blocked"}



        # Anti-abuse: file offer signaling burst rate limiting (staff exempt)
        is_staff = False
        try:
            is_staff = bool(check_user_permission(sender, "admin:super") or check_user_permission(sender, "admin:basic"))
        except Exception:
            is_staff = False

        if not is_staff:
            lim, win = _parse_rate_limit(settings.get("file_offer_rate_limit"), default_limit=5, default_window=60)
            try:
                win = int(settings.get("file_offer_rate_window_sec") or win)
            except Exception:
                pass
            okrl, retry = _rl(f"fileoffer:{sender}", lim, win)
            if not okrl:
                if _abuse_strike(sender, "file_offer_rate"):
                    return {"success": False, "error": "Auto-muted for spamming. Try again later."}
                return {"success": False, "error": f"Rate limited (wait {retry:.1f}s)"}
        _cleanup_p2p_file_sessions()

        # Basic meta sanity (avoid UI spoof / absurd numbers)
        max_size = int(settings.get("max_attachment_size", 10485760) or 10485760)
        if meta.get("size") is not None:
            if meta["size"] < 0 or meta["size"] > max_size:
                return {"success": False, "error": f"File too large (max {max_size} bytes)"}

        with P2P_FILE_SESSIONS_LOCK:
            existing = P2P_FILE_SESSIONS.get(transfer_id)
            if existing:
                a = existing.get("a")
                b = existing.get("b")
                state = str(existing.get("state") or "")
                if state in {"offered", "accepted"} and {a, b} != {sender, to}:
                    return {"success": False, "error": "transfer_id already in use"}
            P2P_FILE_SESSIONS[transfer_id] = {
                "a": sender,
                "b": to,
                "state": "offered",
                "created": time.time(),
                "updated": time.time(),
                "meta": meta,
            }

        delivered = _emit_to_user(to, "p2p_file_offer", {
            "sender": sender,
            "transfer_id": transfer_id,
            "offer": offer,
            "meta": meta,
        })
        return {"success": True, "delivered": delivered}


    @socketio.on("p2p_file_answer")
    @jwt_required()
    def handle_p2p_file_answer(data):
        sender = get_jwt_identity()

        # Rate limit signalling to prevent abuse/spam.
        try:
            lim = int(settings.get("p2p_file_signal_rate_limit") or 600)
            win = int(settings.get("p2p_file_signal_rate_window_sec") or 60)
        except Exception:
            lim, win = 600, 60
        okrl, retry = _rl(f"p2p_sig:{sender}", lim, win)
        if not okrl:
            return {"success": False, "error": "Rate limited", "retry_after": retry}

        to = (data or {}).get("to")
        transfer_id = (data or {}).get("transfer_id")
        answer = (data or {}).get("answer")

        if not to or not transfer_id or not answer:
            return {"success": False, "error": "Missing fields"}

        if not _valid_id(transfer_id):
            return {"success": False, "error": "Invalid transfer_id"}

        ok, err = _require_not_sanctioned(sender, action="dm")
        if not ok:
            return {"success": False, "error": err}

        if to == sender:
            return {"success": False, "error": "Cannot signal yourself"}

        if _either_blocked(sender, to):
            return {"success": False, "error": "Direct message blocked"}

        _cleanup_p2p_file_sessions()

        with P2P_FILE_SESSIONS_LOCK:
            sess = P2P_FILE_SESSIONS.get(transfer_id)
            if not sess:
                return {"success": False, "error": "Unknown/expired transfer"}
            if sess.get("b") != sender or sess.get("a") != to:
                return {"success": False, "error": "Not a participant"}
            sess["state"] = "accepted"
            sess["updated"] = time.time()

        delivered = _emit_to_user(to, "p2p_file_answer", {
            "sender": sender,
            "transfer_id": transfer_id,
            "answer": answer,
        })
        return {"success": True, "delivered": delivered}


    @socketio.on("p2p_file_ice")
    @jwt_required()
    def handle_p2p_file_ice(data):
        sender = get_jwt_identity()

        # Rate limit signalling to prevent abuse/spam.
        try:
            lim = int(settings.get("p2p_file_signal_rate_limit") or 600)
            win = int(settings.get("p2p_file_signal_rate_window_sec") or 60)
        except Exception:
            lim, win = 600, 60
        okrl, retry = _rl(f"p2p_sig:{sender}", lim, win)
        if not okrl:
            return {"success": False, "error": "Rate limited", "retry_after": retry}

        to = (data or {}).get("to")
        transfer_id = (data or {}).get("transfer_id")
        candidate = (data or {}).get("candidate")

        if not to or not transfer_id or not candidate:
            return {"success": False, "error": "Missing fields"}

        if not _valid_id(transfer_id):
            return {"success": False, "error": "Invalid transfer_id"}

        ok, err = _require_not_sanctioned(sender, action="dm")
        if not ok:
            return {"success": False, "error": err}

        if to == sender:
            return {"success": False, "error": "Cannot signal yourself"}

        if _either_blocked(sender, to):
            return {"success": False, "error": "Direct message blocked"}

        _cleanup_p2p_file_sessions()

        with P2P_FILE_SESSIONS_LOCK:
            sess = P2P_FILE_SESSIONS.get(transfer_id)
            if not sess:
                return {"success": False, "error": "Unknown/expired transfer"}
            if {sess.get("a"), sess.get("b")} != {sender, to}:
                return {"success": False, "error": "Not a participant"}
            sess["updated"] = time.time()

        delivered = _emit_to_user(to, "p2p_file_ice", {
            "sender": sender,
            "transfer_id": transfer_id,
            "candidate": candidate,
        })
        return {"success": True, "delivered": delivered}


    @socketio.on("p2p_file_decline")
    @jwt_required()
    def handle_p2p_file_decline(data):
        sender = get_jwt_identity()

        # Rate limit signalling to prevent abuse/spam.
        try:
            lim = int(settings.get("p2p_file_signal_rate_limit") or 600)
            win = int(settings.get("p2p_file_signal_rate_window_sec") or 60)
        except Exception:
            lim, win = 600, 60
        okrl, retry = _rl(f"p2p_sig:{sender}", lim, win)
        if not okrl:
            return {"success": False, "error": "Rate limited", "retry_after": retry}

        to = (data or {}).get("to")
        transfer_id = (data or {}).get("transfer_id")
        reason = (data or {}).get("reason") or "Declined"

        if not to or not transfer_id:
            return {"success": False, "error": "Missing fields"}

        if not _valid_id(transfer_id):
            return {"success": False, "error": "Invalid transfer_id"}

        ok, err = _require_not_sanctioned(sender, action="dm")
        if not ok:
            return {"success": False, "error": err}

        if to == sender:
            return {"success": False, "error": "Cannot signal yourself"}

        if _either_blocked(sender, to):
            return {"success": False, "error": "Direct message blocked"}

        _cleanup_p2p_file_sessions()

        with P2P_FILE_SESSIONS_LOCK:
            sess = P2P_FILE_SESSIONS.get(transfer_id)
            if not sess:
                # still notify peer (client may be waiting) but don't treat as failure
                sess_ok = True
            else:
                if {sess.get("a"), sess.get("b")} != {sender, to}:
                    return {"success": False, "error": "Not a participant"}
                try:
                    del P2P_FILE_SESSIONS[transfer_id]
                except Exception:
                    pass
                sess_ok = True

        delivered = _emit_to_user(to, "p2p_file_decline", {
            "sender": sender,
            "transfer_id": transfer_id,
            "reason": reason,
        })
        return {"success": True, "delivered": delivered, "session": sess_ok}

    # ------------------------------------------------------------------
    # Voice chat (WebRTC audio) signaling + room roster
    # ------------------------------------------------------------------

    @socketio.on("list_files_in_room")
    @jwt_required()
    def handle_list_files_in_room(data):
        room = (data or {}).get("room")
        user = get_jwt_identity()

        if not room:
            return {"success": False, "error": "Missing room"}

        if not (check_user_permission(user, "admin:basic") or check_user_permission(user, "admin:super")):
            return {"success": False, "error": "No permission"}

        # Placeholder (no server-side file inventory yet)
        emit("notification", f"Listing files in room {room}", to=request.sid)
        return {"success": True}


    @socketio.on("share_image")
    @jwt_required()
    def handle_share_image(data):
        room = data.get("room")
        image_url = data.get("image_url")
        user = get_jwt_identity()

        if not room or not image_url:
            return {"success": False}

        emit("notification", f"{user} shared an image", to=room)
        emit("image_shared", {"from": user, "url": image_url}, to=room)
        return {"success": True}


