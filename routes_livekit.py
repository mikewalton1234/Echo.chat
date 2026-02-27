"""
LiveKit token endpoint for EchoChat clients.

Client flow:
- Browser calls POST /api/livekit/token with {room: "<EchoChat room>"}
- Server validates EchoChat room access + sanctions
- Server chooses a LiveKit room sub-shard (Lobby -> Lobby(2) ...) if enabled
- Server returns {url, room, token}
"""
from __future__ import annotations

from typing import Any, Dict, Optional

from flask import jsonify, request
from flask_jwt_extended import jwt_required, get_jwt_identity

from database import (
    get_all_rooms,
    get_custom_room_meta,
    can_user_access_custom_room,
    get_db,
)
from moderation import is_user_sanctioned
from permissions import check_user_permission

from livekit_bridge import get_livekit_config, choose_subroom, mint_access_token


def register_livekit_routes(app, settings: Dict[str, Any], limiter=None) -> None:
    # Local limit helper (no-op if limiter not present)
    def _limit(rule: str):
        try:
            if limiter is None:
                lim = app.extensions.get("limiter")
            else:
                lim = limiter
            if lim:
                return lim.limit(rule)
        except Exception:
            pass

        def deco(fn):
            return fn

        return deco

    @app.route("/api/livekit/token", methods=["POST"])
    @_limit(settings.get("rate_limit_livekit_token") or "120 per minute")
    @jwt_required()
    def livekit_token():
        cfg = get_livekit_config(settings)
        if not cfg.enabled:
            return jsonify({"ok": False, "error": "livekit_disabled"}), 503

        username = get_jwt_identity() or ""
        data = request.get_json(silent=True) or {}
        room = (data.get("room") or "").strip()
        if not room:
            return jsonify({"ok": False, "error": "missing_room"}), 400

        # Basic allowlist: requested room must exist in catalog OR be a custom room
        # (custom room metadata will be returned by get_custom_room_meta if it exists)
        try:
            all_rooms = [r.get("name") for r in (get_all_rooms() or []) if isinstance(r, dict)]
        except Exception:
            all_rooms = []

        meta = None
        try:
            meta = get_custom_room_meta(room)
        except Exception:
            meta = None

        if room not in all_rooms and not meta:
            return jsonify({"ok": False, "error": "room_not_found"}), 404

        # Sanctions
        try:
            if is_user_sanctioned(username, "ban"):
                return jsonify({"ok": False, "error": "banned"}), 403
        except Exception:
            pass
        try:
            if is_user_sanctioned(username, f"room_ban:{room}"):
                return jsonify({"ok": False, "error": "room_banned"}), 403
        except Exception:
            pass

        # Custom room privacy + 18+ gate
        if meta:
            if bool(meta.get("is_private")):
                try:
                    if not can_user_access_custom_room(room, username):
                        return jsonify({"ok": False, "error": "invite_required"}), 403
                except Exception:
                    return jsonify({"ok": False, "error": "invite_required"}), 403

            if bool(meta.get("is_18_plus") or meta.get("is_nsfw")):
                age = 0
                try:
                    conn = get_db()
                    with conn.cursor() as cur:
                        cur.execute("SELECT age FROM users WHERE username=%s;", (username,))
                        row = cur.fetchone()
                    age = int(row[0] or 0) if row else 0
                except Exception:
                    age = 0
                if age < 18:
                    return jsonify({"ok": False, "error": "age_restricted"}), 403

        # Choose LiveKit sub-room shard if enabled
        lk_room = None
        shard_index = 1
        counts = {}
        if cfg.subrooms_enabled:
            try:
                lk_room, shard_index, counts = choose_subroom(cfg, room)
            except Exception:
                lk_room = None

        if not lk_room:
            lk_room = f"{cfg.room_prefix}{room}"

        # If user is a staff/admin, we allow future moderation features (room admin grant)
        is_staff = False
        try:
            is_staff = bool(
                check_user_permission(username, "admin:super")
                or check_user_permission(username, "admin:basic")
            )
        except Exception:
            is_staff = False

        token = mint_access_token(
            cfg,
            identity=username,
            display_name=username,
            livekit_room=lk_room,
            metadata={
                "echochat_room": room,
                "livekit_room": lk_room,
                "shard": shard_index,
                "is_staff": bool(is_staff),
            },
        )

        return jsonify(
            {
                "ok": True,
                "url": cfg.ws_url,
                "room": lk_room,
                "token": token,
                "ttl_seconds": int(cfg.token_ttl_seconds),
                "shard_index": shard_index,
                "occupancy": counts if bool(settings.get("livekit_debug_counts", False)) else None,
            }
        )
