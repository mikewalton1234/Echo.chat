"""Socket.IO handlers: dm.

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

    @socketio.on("get_missed_pm_summary")
    @jwt_required()
    def handle_get_missed_pm_summary(data=None):
        username = get_jwt_identity()
        _emit_missed_pm_summary(username, request.sid)
        return {"success": True}

    @socketio.on("fetch_offline_pms")
    @jwt_required()
    def handle_fetch_offline_pms(data):
        """Fetch offline PMs.

        By default this marks messages as delivered (consumes the queue).
        If the client passes {peek: true}, the server returns messages
        without marking them delivered. The client can later call
        ack_offline_pms with the IDs it successfully processed.
        """
        username = get_jwt_identity()
        from_user = (data or {}).get("from_user")
        peek = bool((data or {}).get("peek", False))
        conn = get_db()
        try:
            with conn.cursor() as cur:
                if from_user:
                    cur.execute(
                        """
                        SELECT id, sender, message, EXTRACT(EPOCH FROM timestamp)::float AS ts
                          FROM offline_messages
                         WHERE receiver = %s
                           AND delivered = FALSE
                           AND sender = %s
                         ORDER BY timestamp ASC;
                        """,
                        (username, from_user),
                    )
                else:
                    cur.execute(
                        """
                        SELECT id, sender, message, EXTRACT(EPOCH FROM timestamp)::float AS ts
                          FROM offline_messages
                         WHERE receiver = %s
                           AND delivered = FALSE
                         ORDER BY timestamp ASC;
                        """,
                        (username,),
                    )
                rows = cur.fetchall() or []

                msg_ids = [int(r[0]) for r in rows]
                messages = [
                    {"id": int(mid), "sender": sender, "cipher": cipher, "ts": float(ts) if ts is not None else None}
                    for (mid, sender, cipher, ts) in rows
                ]

                if msg_ids and not peek:
                    cur.execute(
                        "UPDATE offline_messages SET delivered = TRUE WHERE receiver=%s AND id = ANY(%s::int[]);",
                        (username, msg_ids),
                    )
            conn.commit()

            if not peek:
                try:
                    _emit_missed_pm_summary(username, request.sid)
                except Exception:
                    pass

            return {"success": True, "messages": messages, "peek": peek}
        except Exception as e:
            print(f"[DB ERROR] fetch_offline_pms: {e}")
            try:
                conn.rollback()
            except Exception:
                pass
            return {"success": False, "error": "Failed to fetch offline messages"}



    @socketio.on("ack_offline_pms")
    @jwt_required()
    def handle_ack_offline_pms(data):
        """Mark specific offline PM IDs as delivered for the current user.

        Used together with fetch_offline_pms(peek=true) so clients only consume
        messages they successfully decrypted/rendered.
        """
        username = get_jwt_identity()
        ids = (data or {}).get("ids") or []
        if not isinstance(ids, (list, tuple)):
            return {"success": False, "error": "bad_ids"}

        msg_ids = []
        for x in ids:
            try:
                msg_ids.append(int(x))
            except Exception:
                continue
        msg_ids = list(dict.fromkeys([i for i in msg_ids if i > 0]))

        if not msg_ids:
            return {"success": True, "updated": 0}

        conn = get_db()
        updated = 0
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE offline_messages SET delivered = TRUE WHERE receiver=%s AND id = ANY(%s::int[]);",
                    (username, msg_ids),
                )
                updated = int(cur.rowcount or 0)
            conn.commit()
        except Exception as e:
            print(f"[DB ERROR] ack_offline_pms: {e}")
            try:
                conn.rollback()
            except Exception:
                pass
            return {"success": False, "error": "db"}

        try:
            _emit_missed_pm_summary(username, request.sid)
        except Exception:
            pass

        return {"success": True, "updated": updated}


    @socketio.on("send_direct_message")
    @jwt_required()
    def handle_send_direct_message(data):
        """Send a private message (DM).

        Security model:
          - Normal path: client sends ciphertext-only in data['cipher'] (EC1:... envelope).
          - Compatibility: older clients may send ciphertext in data['message'].
          - Optional plaintext wrapper (ECP1:...) is allowed only if enabled via settings.

        The server NEVER decrypts DM payloads.
        """

        data = data or {}
        to = data.get("to")
        sender = get_jwt_identity()

        cipher = data.get("cipher")
        if not cipher:
            # legacy/compat: allow older clients to send ciphertext in "message"
            cipher = data.get("message")

        if not to or not cipher:
            return {"success": False, "error": "Missing recipient or message"}

        require_e2ee = bool(settings.get("require_dm_e2ee", False))
        allow_plain = bool(settings.get("allow_plaintext_dm_fallback", True))
        plain_prefix = "ECP1:"

        if require_e2ee:
            # Require that the client used the explicit ciphertext field
            if not data.get("cipher"):
                return {"success": False, "error": "dm_requires_e2ee"}
            if isinstance(cipher, str) and cipher.startswith(plain_prefix):
                return {"success": False, "error": "dm_requires_e2ee"}

        if not allow_plain:
            if isinstance(cipher, str) and cipher.startswith(plain_prefix):
                return {"success": False, "error": "plaintext_dm_disabled"}

        if not isinstance(cipher, str):
            return {"success": False, "error": "bad_cipher"}

        max_len = int(settings.get("max_dm_cipher_length") or 140000)
        if len(cipher) > max_len:
            return {"success": False, "error": f"Ciphertext too large (max {max_len})"}

        ok, err = _require_not_sanctioned(sender, action="dm")
        if not ok:
            return {"success": False, "error": err}

        if to == sender:
            return {"success": False, "error": "Cannot DM yourself"}

        if _either_blocked(sender, to):
            return {"success": False, "error": "Direct message blocked"}



        # Anti-abuse: DM burst rate limiting + optional per-user quota (staff exempt)
        is_staff = False
        try:
            is_staff = bool(check_user_permission(sender, "admin:super") or check_user_permission(sender, "admin:basic"))
        except Exception:
            is_staff = False

        if not is_staff:
            quota = _get_user_quota_per_hour(sender)
            if quota and int(quota) > 0:
                okq, _raq = _rl(f"quota:{sender}", int(quota), 3600)
                if not okq:
                    _abuse_strike(sender, "quota")
                    return {"success": False, "error": f"Quota exceeded ({int(quota)}/hour). Try later."}

            lim, win = _parse_rate_limit(settings.get("dm_msg_rate_limit"), default_limit=15, default_window=10)
            try:
                win = int(settings.get("dm_msg_rate_window_sec") or win)
            except Exception:
                pass
            okrl, retry = _rl(f"dmmsg:{sender}", lim, win)
            if not okrl:
                if _abuse_strike(sender, "dm_rate"):
                    return {"success": False, "error": "Auto-muted for spamming. Try again later."}
                return {"success": False, "error": f"Rate limited (wait {retry:.1f}s)"}
        delivered = _emit_to_user(to, "private_message", {"sender": sender, "cipher": cipher})
        if not delivered:
            _store_offline_pm(sender, to, cipher)
        return {"success": True, "delivered": delivered}

    # ------------------------------------------------------------------
    # WebRTC P2P file transfer signaling (offer/answer/ICE)
    # ------------------------------------------------------------------
    # ------------------------------------------------------------------
    # WebRTC P2P file transfer signaling (offer/answer/ICE)
    # ------------------------------------------------------------------

