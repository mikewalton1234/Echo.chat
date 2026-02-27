#!/usr/bin/env python3
"""routes_chat.py

Chat-related HTTP endpoints.

Notes:
  - The chat HTML page is served by routes_auth.py at /chat.
  - This blueprint provides API endpoints like /api/rooms.

SQLite support removed; Postgres only.
"""

from __future__ import annotations

import json
import os
import re

from flask import Blueprint, jsonify, request, current_app
from flask_jwt_extended import get_jwt_identity, jwt_required

from database import (
    create_room_if_missing,
    get_db,
    is_user_verified,
    cleanup_expired_custom_rooms,
    can_user_access_custom_room,
)


chat_bp = Blueprint("chat", __name__)


def _emit_to_username(username: str, event: str, payload: dict) -> bool:
    """Best-effort emit to all active Socket.IO sessions for a username.

    Used from HTTP routes that need to push realtime UX updates.
    Returns True if at least one session was targeted.
    """
    try:
        socketio = current_app.config.get("ECHOCHAT_SOCKETIO")
        if not socketio:
            return False
        from socket_handlers import CONNECTED_USERS, CONNECTED_USERS_LOCK

        sids = []
        with CONNECTED_USERS_LOCK:
            for sid, sess in (CONNECTED_USERS or {}).items():
                if (sess or {}).get("username") == username:
                    sids.append(sid)

        for sid in sids:
            try:
                socketio.emit(event, payload, to=sid)
            except Exception:
                pass
        return bool(sids)
    except Exception:
        return False




def _is_user_in_room_live(username: str, room: str) -> bool:
    """Return True if any active Socket.IO session for `username` is currently in `room`."""
    username = (username or "").strip()
    room = (room or "").strip()
    if not username or not room:
        return False
    try:
        from socket_handlers import CONNECTED_USERS, CONNECTED_USERS_LOCK
    except Exception:
        return False
    try:
        with CONNECTED_USERS_LOCK:
            for _sid, sess in (CONNECTED_USERS or {}).items():
                if (sess or {}).get("username") == username and (sess or {}).get("room") == room:
                    return True
    except Exception:
        return False
    return False

def _get_live_counts() -> dict[str, int]:
    """Best-effort live counts (unique usernames per room) from Socket.IO sessions."""
    try:
        from socket_handlers import CONNECTED_USERS, CONNECTED_USERS_LOCK
    except Exception:
        return {}
    per_room: dict[str, set[str]] = {}
    try:
        with CONNECTED_USERS_LOCK:
            for _sid, sess in CONNECTED_USERS.items():
                room = str((sess or {}).get("room") or "").strip()
                user = str((sess or {}).get("username") or "").strip()
                if not room or not user:
                    continue
                per_room.setdefault(room, set()).add(user)
    except Exception:
        return {}
    return {r: len(u) for r, u in per_room.items()}


_ROOM_NAME_MAX = 48
_CTRL_RE = re.compile(r"[\x00-\x1f]")


def _validate_room_name(name: str) -> tuple[bool, str | None]:
    name = (name or "").strip()
    if not name:
        return False, "Room name missing"
    if len(name) > _ROOM_NAME_MAX:
        return False, f"Room name too long (max {_ROOM_NAME_MAX})"
    if _CTRL_RE.search(name):
        return False, "Invalid room name"
    return True, None


def _read_room_catalog() -> dict:
    """Read chat_rooms.json and normalize into a v2-style catalog dict."""
    file_path = os.path.join(os.path.dirname(__file__), "chat_rooms.json")
    if not os.path.exists(file_path):
        return {"version": 2, "categories": []}

    try:
        with open(file_path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception:
        return {"version": 2, "categories": []}

    # v2
    if isinstance(data, dict) and int(data.get("version", 0) or 0) >= 2:
        cats = data.get("categories") or []
        if not isinstance(cats, list):
            cats = []
        # ensure stable shape
        norm = []
        for c in cats:
            if not isinstance(c, dict) or not (c.get("name") or "").strip():
                continue
            subs = c.get("subcategories") or []
            if not isinstance(subs, list):
                subs = []
            sub_norm = []
            for s in subs:
                if not isinstance(s, dict) or not (s.get("name") or "").strip():
                    continue
                rooms = s.get("rooms") or []
                if not isinstance(rooms, list):
                    rooms = []
                rooms_norm = [r.strip() for r in rooms if isinstance(r, str) and r.strip()]
                sub_norm.append({"name": s.get("name").strip(), "rooms": rooms_norm})
            norm.append({"name": c.get("name").strip(), "subcategories": sub_norm})
        return {"version": 2, "categories": norm}

    # v1 legacy list -> wrap into one category/subcategory
    if isinstance(data, list):
        rooms = []
        for entry in data:
            if isinstance(entry, str) and entry.strip():
                rooms.append(entry.strip())
            elif isinstance(entry, dict) and (entry.get("name") or "").strip():
                rooms.append(entry.get("name").strip())
        return {"version": 2, "categories": [{"name": "Rooms", "subcategories": [{"name": "All", "rooms": rooms}]}]}

    return {"version": 2, "categories": []}


def _catalog_has_path(catalog: dict, category: str, subcategory: str) -> bool:
    category = (category or "").strip()
    subcategory = (subcategory or "").strip()
    if not category or not subcategory:
        return False
    for c in catalog.get("categories") or []:
        if (c.get("name") or "") == category:
            for s in c.get("subcategories") or []:
                if (s.get("name") or "") == subcategory:
                    return True
    return False


def _catalog_has_roomname(catalog: dict, room_name: str) -> bool:
    """True if room_name appears in the official room catalog (case-insensitive)."""
    rn = (room_name or "").strip().lower()
    if not rn:
        return False
    for c in catalog.get("categories") or []:
        for s in c.get("subcategories") or []:
            for r in s.get("rooms") or []:
                if isinstance(r, str) and r.strip().lower() == rn:
                    return True
    return False


@chat_bp.route("/api/rooms", methods=["GET"])
@jwt_required(optional=True)
def api_get_rooms():
    """Return all rooms (name + member_count).

    NOTE: We overlay Socket.IO live counts to avoid stale DB member_count drift.
    """
    try:
        live = _get_live_counts()
        conn = get_db()
        with conn.cursor() as cur:
            cur.execute("SELECT name FROM chat_rooms ORDER BY LOWER(name);")
            rows = cur.fetchall()
        return jsonify({"rooms": [{"name": r[0], "member_count": int(live.get(r[0], 0) or 0)} for r in rows]})
    except Exception:
        return jsonify({"rooms": []})


@chat_bp.route("/api/rooms", methods=["POST"])
@jwt_required()
def api_create_room():
    """Create a room if missing."""
    actor = get_jwt_identity() or "unknown"
    data = request.get_json(silent=True) or {}
    name = (data.get("name") or "").strip()
    if not name:
        return jsonify({"error": "Room name required"}), 400

    try:
        # Creating "official" rooms is admin-only. Custom rooms must be created via /api/custom_rooms.
        conn = get_db()
        with conn.cursor() as cur:
            cur.execute("SELECT is_admin FROM users WHERE username=%s;", (actor,))
            row = cur.fetchone()
        if not row or not bool(row[0]):
            return jsonify({"error": "Admin only"}), 403

        create_room_if_missing(name)
        return jsonify({"status": "ok", "room": name, "created_by": actor}), 201
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@chat_bp.route("/api/room_catalog", methods=["GET"])
@jwt_required(optional=True)
def api_room_catalog():
    """Return the official room catalog (categories/subcategories/rooms)."""
    return jsonify(_read_room_catalog())


@chat_bp.route("/api/custom_rooms", methods=["GET"])
@jwt_required()
def api_list_custom_rooms():
    """List custom rooms for a category/subcategory.

    Private rooms are only returned if the caller is the owner or invited.
    """
    actor = get_jwt_identity() or ""
    category = (request.args.get("category") or "").strip()
    subcategory = (request.args.get("subcategory") or "").strip()

    # opportunistic cleanup (uses admin-configurable TTLs)
    try:
        cfg = (current_app.config.get("ECHOCHAT_SETTINGS") or {})
    except Exception:
        cfg = {}
    try:
        idle_hours = int(cfg.get("custom_room_idle_hours", 168))
    except Exception:
        idle_hours = 168
    try:
        private_idle_hours = int(cfg.get("custom_private_room_idle_hours", idle_hours))
    except Exception:
        private_idle_hours = idle_hours
    try:
        cleanup_expired_custom_rooms(idle_hours=idle_hours, private_idle_hours=private_idle_hours)
    except Exception:
        pass

    try:
        live = _get_live_counts()
        conn = get_db()
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT cr.name, cr.created_by, cr.is_private, cr.is_18_plus, cr.is_nsfw,
                       COALESCE(r.member_count, 0) AS member_count
                  FROM custom_rooms cr
                  LEFT JOIN chat_rooms r
                         ON r.name = cr.name
                 WHERE cr.category = %s
                   AND cr.subcategory = %s
                   AND (
                        cr.is_private = FALSE
                        OR cr.created_by = %s
                        OR EXISTS (
                            SELECT 1 FROM custom_room_invites i
                             WHERE i.room_name = cr.name
                               AND i.invited_user = %s
                        )
                   )
                 ORDER BY LOWER(cr.name);
                """,
                (category, subcategory, actor, actor),
            )
            rows = cur.fetchall()
        rooms = [
            {
                "name": r[0],
                "created_by": r[1],
                "is_private": bool(r[2]),
                "is_18_plus": bool(r[3]),
                "is_nsfw": bool(r[4]),
                "member_count": int(live.get(r[0], r[5] or 0) or 0),
            }
            for r in (rows or [])
        ]
        return jsonify({"rooms": rooms})
    except Exception as e:
        return jsonify({"rooms": [], "error": str(e)}), 200


@chat_bp.route("/api/custom_rooms", methods=["POST"])
@jwt_required()
def api_create_custom_room():
    """Create a custom room (Postgres-backed)."""
    actor = get_jwt_identity() or ""
    data = request.get_json(silent=True) or {}
    name = (data.get("name") or "").strip()
    category = (data.get("category") or "").strip()
    subcategory = (data.get("subcategory") or "").strip()
    is_private = bool(data.get("is_private", False))
    is_18_plus = bool(data.get("is_18_plus", False))
    is_nsfw = bool(data.get("is_nsfw", False))
    if is_nsfw:
        is_18_plus = True

    ok, err = _validate_room_name(name)
    if not ok:
        return jsonify({"error": err or "Invalid name"}), 400

    if not actor:
        return jsonify({"error": "Not authenticated"}), 401

    if not is_user_verified(actor):
        return jsonify({"error": "Only verified users can create rooms"}), 403

    catalog = _read_room_catalog()
    if not _catalog_has_path(catalog, category, subcategory):
        return jsonify({"error": "Invalid category/subcategory"}), 400

    try:
        conn = get_db()
        with conn.cursor() as cur:
            # Prevent collisions with existing rooms.
            #
            # IMPORTANT: We want users to be able to re-create a custom room that was auto-deleted.
            # Sometimes a stale chat_rooms row can remain (or the room exists under a different category).
            cur.execute("SELECT 1 FROM chat_rooms WHERE name=%s LIMIT 1;", (name,))
            if cur.fetchone() is not None:
                # If a custom_rooms record exists, provide a helpful conflict message (including its path).
                cur.execute(
                    "SELECT category, subcategory, created_by, is_private FROM custom_rooms WHERE name=%s LIMIT 1;",
                    (name,),
                )
                row = cur.fetchone()
                if row is not None:
                    ex_cat, ex_sub, ex_owner, ex_private = row
                    invited = False
                    if bool(ex_private) and (ex_owner != actor):
                        cur.execute(
                            "SELECT 1 FROM custom_room_invites WHERE room_name=%s AND invited_user=%s LIMIT 1;",
                            (name, actor),
                        )
                        invited = cur.fetchone() is not None

                    visible = (not bool(ex_private)) or (ex_owner == actor) or invited
                    if visible:
                        return (
                            jsonify(
                                {
                                    "error": f"Room already exists in {ex_cat} › {ex_sub}",
                                    "existing": {
                                        "name": name,
                                        "category": ex_cat,
                                        "subcategory": ex_sub,
                                        "created_by": ex_owner,
                                        "is_private": bool(ex_private),
                                    },
                                }
                            ),
                            409,
                        )
                    return jsonify({"error": "Room name already in use (private room)"}), 409

                # No custom_rooms record exists, but chat_rooms row does.
                # If it's an official room (from catalog), block it; otherwise treat as a stale orphan and allow revive.
                if _catalog_has_roomname(catalog, name):
                    return jsonify({"error": "Room name already in use"}), 409
                # else: proceed to insert into custom_rooms (revive)

            cur.execute(
                """
                INSERT INTO custom_rooms (name, category, subcategory, created_by, is_private, is_18_plus, is_nsfw)
                VALUES (%s, %s, %s, %s, %s, %s, %s);
                """,
                (name, category, subcategory, actor, is_private, is_18_plus, is_nsfw),
            )
        conn.commit()
        # Ensure it exists in chat_rooms for member_count tracking
        create_room_if_missing(name)
        return jsonify({"status": "ok", "room": name}), 201
    except Exception as e:
        try:
            conn.rollback()
        except Exception:
            pass
        return jsonify({"error": str(e)}), 500



@chat_bp.route("/api/custom_rooms/invite", methods=["POST"])
@jwt_required()
def api_invite_to_custom_room():
    """Invite a user to a *private custom room* (access-granting).

    Note: This endpoint is used by the room-browser invite modal.
    Anyone who already has access to the private room may invite others.
    """
    actor = get_jwt_identity() or ""
    data = request.get_json(silent=True) or {}
    room = (data.get("room") or "").strip()
    invitee = (data.get("invitee") or "").strip()
    if not room or not invitee:
        return jsonify({"error": "room and invitee required"}), 400
    if invitee == actor:
        return jsonify({"error": "Cannot invite yourself"}), 400

    try:
        conn = get_db()
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT created_by, is_private
                  FROM custom_rooms
                 WHERE name=%s;
                """,
                (room,),
            )
            row = cur.fetchone()
            if not row:
                return jsonify({"error": "Not a custom room"}), 404
            _created_by, is_private = row
            if not bool(is_private):
                return jsonify({"error": "Room is public (no invite needed)"}), 400

            # Anyone with access can invite (owner, invited users, etc.)
            if not can_user_access_custom_room(room, actor):
                return jsonify({"error": "No access to invite for this room"}), 403

            cur.execute("SELECT 1 FROM users WHERE username=%s LIMIT 1;", (invitee,))
            if cur.fetchone() is None:
                return jsonify({"error": "User not found"}), 404

            cur.execute(
                """
                INSERT INTO custom_room_invites (room_name, invited_user, invited_by)
                VALUES (%s, %s, %s)
                ON CONFLICT (room_name, invited_user) DO NOTHING;
                """,
                (room, invitee, actor),
            )
        conn.commit()

        # Realtime notification to invitee (if online)
        _emit_to_username(invitee, "custom_room_invite", {"room": room, "by": actor})
        return jsonify({"status": "ok"}), 200
    except Exception as e:
        try:
            conn.rollback()
        except Exception:
            pass
        return jsonify({"error": str(e)}), 500


@chat_bp.route("/api/custom_rooms/invites", methods=["GET"])
@jwt_required()
def api_list_custom_room_invites():
    """Return private custom-room invites for the current user.

    This is used so clients can show invite notifications even if the realtime
    socket event was missed (e.g., user was offline).
    """
    username = get_jwt_identity() or ""
    try:
        conn = get_db()
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT i.room_name, i.invited_by, i.created_at
                  FROM custom_room_invites i
                  JOIN custom_rooms r ON r.name = i.room_name
                 WHERE i.invited_user = %s
                   AND r.is_private = TRUE
                 ORDER BY i.created_at DESC;
                """,
                (username,),
            )
            rows = cur.fetchall() or []
        invites = [
            {
                "room": r[0],
                "by": r[1],
                "created_at": (r[2].isoformat() if hasattr(r[2], "isoformat") else str(r[2])),
            }
            for r in rows
        ]
        return jsonify({"invites": invites}), 200
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@chat_bp.route("/api/rooms/invite", methods=["POST"])
@jwt_required()
def api_invite_to_room_any():
    """Invite a user to the current room via /invite.

    - For *private custom rooms*, this also creates an access-granting invite row.
    - For all other rooms, this stores an invite notification (UX only).
    """
    actor = get_jwt_identity() or ""
    data = request.get_json(silent=True) or {}
    room = (data.get("room") or "").strip()
    invitee = (data.get("invitee") or "").strip()

    if not room or not invitee:
        return jsonify({"error": "room and invitee required"}), 400
    if invitee == actor:
        return jsonify({"error": "Cannot invite yourself"}), 400

    # /invite is intended to be used *from inside the room*.
    # NOTE: We do NOT hard-enforce a live "in-room" check here because in multi-worker setups
    # the HTTP process may not share in-memory Socket.IO session state. The Socket.IO handler
    # still enforces in-room for plaintext /invite commands. For private rooms we enforce access below.

    conn = None
    try:
        conn = get_db()
        with conn.cursor() as cur:
            # Invitee must exist (case-insensitive lookup; preserve canonical username)
            cur.execute("SELECT username FROM users WHERE LOWER(username)=LOWER(%s) LIMIT 1;", (invitee,))
            _urow = cur.fetchone()
            if _urow is None:
                return jsonify({"error": "User not found"}), 404
            invitee = str(_urow[0])

            # Is it a custom room? (and if so, private?)
            cur.execute(
                """
                SELECT created_by, is_private
                  FROM custom_rooms
                 WHERE name=%s;
                """,
                (room,),
            )
            row = cur.fetchone()

            # Ensure room exists in chat_rooms (for both official and custom)
            cur.execute("SELECT 1 FROM chat_rooms WHERE name=%s LIMIT 1;", (room,))
            has_chat_room = cur.fetchone() is not None
            if not has_chat_room:
                # Allow custom rooms to be revived if chat_rooms row was pruned
                if row:
                    create_room_if_missing(room)
                else:
                    return jsonify({"error": "Room not found"}), 404

            if row and bool(row[1]):
                # Private custom room: inviter must already have access
                if not can_user_access_custom_room(room, actor):
                    return jsonify({"error": "No access to invite for this room"}), 403

                cur.execute(
                    """
                    INSERT INTO custom_room_invites (room_name, invited_user, invited_by)
                    VALUES (%s, %s, %s)
                    ON CONFLICT (room_name, invited_user) DO NOTHING;
                    """,
                    (room, invitee, actor),
                )
                conn.commit()
                _emit_to_username(invitee, "custom_room_invite", {"room": room, "by": actor})
                return jsonify({"status": "ok", "kind": "custom_private"}), 200

            # Otherwise: store a generic invite notification
            cur.execute(
                """
                INSERT INTO room_invites (room_name, invited_user, invited_by)
                VALUES (%s, %s, %s)
                ON CONFLICT (room_name, invited_user) DO NOTHING;
                """,
                (room, invitee, actor),
            )
        conn.commit()
        _emit_to_username(invitee, "room_invite", {"room": room, "by": actor})
        return jsonify({"status": "ok", "kind": "room"}), 200
    except Exception as e:
        try:
            if conn:
                conn.rollback()
        except Exception:
            pass
        return jsonify({"error": str(e)}), 500


@chat_bp.route("/api/rooms/invites", methods=["GET"])
@jwt_required()
def api_list_room_invites():
    """Return room invites for the current user (UX notifications)."""
    username = get_jwt_identity() or ""
    try:
        conn = get_db()
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT room_name, invited_by, created_at
                  FROM room_invites
                 WHERE invited_user = %s
                 ORDER BY created_at DESC
                 LIMIT 200;
                """,
                (username,),
            )
            rows = cur.fetchall() or []
        invites = [
            {
                "room": r[0],
                "by": r[1],
                "created_at": (r[2].isoformat() if hasattr(r[2], "isoformat") else str(r[2])),
            }
            for r in rows
        ]
        return jsonify({"invites": invites}), 200
    except Exception as e:
        return jsonify({"error": str(e)}), 500