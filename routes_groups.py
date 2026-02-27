#!/usr/bin/env python3
"""routes_groups.py

Private Groups (PostgreSQL).

Security goals (Yahoo-style private groups):
  - No public group discovery or joining by ID alone
  - Membership enforced for ALL group-scoped reads/writes
  - Joining requires a *pending invite* for the current user
  - Invite operations restricted by group role (owner/admin/moderator)
  - No existence leaks: non-members generally receive 404

Implements:
  - GET  /api/groups/mine
  - POST /api/groups
  - GET  /api/groups/invites
  - POST /api/groups/<group_id>/invite
  - POST /api/groups/<group_id>/accept
  - POST /api/groups/<group_id>/decline
  - POST /api/groups/<group_id>/revoke_invite
  - POST /api/groups/<group_id>/join            (alias for accept; invite required)
  - POST /api/groups/<group_id>/leave
  - POST /api/groups/<group_id>/kick
  - POST /api/groups/<group_id>/set_role
  - POST /api/groups/<group_id>/transfer_ownership
  - PATCH /api/groups/<group_id>                (rename/description)
  - DELETE /api/groups/<group_id>               (owner only)
  - GET  /api/groups/<group_id>/members
  - GET  /api/groups/<group_id>/unread_count
  - POST /api/groups/<group_id>/upload
  - GET  /api/groups/<group_id>/files/<attachment_id>/meta
  - GET  /api/groups/<group_id>/files/<attachment_id>/blob

NOTE:
  - Group chat messages are stored in messages.room as "g:<group_id>".
  - For backwards-compat, unread_count also considers legacy room=str(group_id).
"""

from __future__ import annotations

import json
import os
import time
import uuid
from typing import Any

from flask import jsonify, request, send_file
from flask_jwt_extended import get_jwt_identity, jwt_required
from werkzeug.utils import secure_filename

from database import get_db
from security import log_audit_event

# Role hierarchy for group-scoped privileges
_ROLE_RANK = {"member": 0, "moderator": 1, "admin": 2, "owner": 3}
_ALLOWED_ROLES = set(_ROLE_RANK.keys())

# Very small in-process rate limiter (dev-safe; do NOT rely on this alone in prod)
# key -> deque[timestamps]
_RATE: dict[str, list[float]] = {}

def _now() -> float:
    return time.time()

def _rate_limit(key: str, limit: int, window_sec: int) -> bool:
    """Return True if allowed."""
    ts = _RATE.get(key)
    t = _now()
    if ts is None:
        _RATE[key] = [t]
        return True
    # prune
    cutoff = t - window_sec
    ts[:] = [x for x in ts if x >= cutoff]
    if len(ts) >= limit:
        return False
    ts.append(t)
    return True


def register_group_routes(app, settings: dict[str, Any], limiter=None) -> None:
    def _limit(rule, **kwargs):
        if limiter is None:
            return lambda f: f
        try:
            return limiter.limit(rule, **kwargs)
        except Exception:
            return lambda f: f

    # Store group uploads outside static so they aren't anonymously fetchable
    upload_root = os.path.join(app.instance_path, "uploads", "groups")
    os.makedirs(upload_root, exist_ok=True)

    max_group_upload = int(settings.get("max_group_upload_bytes") or (25 * 1024 * 1024))  # 25MB default

    def _get_user_id(username: str) -> int | None:
        conn = get_db()
        with conn.cursor() as cur:
            cur.execute("SELECT id FROM users WHERE username = %s;", (username,))
            row = cur.fetchone()
        return row[0] if row else None

    def _get_group_role(group_id: int, user_id: int) -> str | None:
        conn = get_db()
        with conn.cursor() as cur:
            cur.execute(
                "SELECT role FROM group_members WHERE group_id = %s AND user_id = %s;",
                (group_id, user_id),
            )
            row = cur.fetchone()
        return (row[0] or "member") if row else None

    def _is_member(group_id: int, user_id: int) -> bool:
        return _get_group_role(group_id, user_id) is not None

    def _rank(role: str | None) -> int:
        return _ROLE_RANK.get(role or "member", 0)

    def _not_found():
        # Avoid existence leaks (group ID enumeration)
        return jsonify({"error": "Not found"}), 404

    def _room_key(group_id: int) -> str:
        return f"g:{group_id}"

    def _audit(actor: str, action: str, target: str | None = None, details: str | None = None) -> None:
        try:
            log_audit_event(actor=actor, action=action, target=target, details=details)
        except Exception:
            # Do not fail requests due to audit issues
            pass

    # ─────────────────────────────────────────────────────────────────────────────
    # Group listing (member-only)
    # ─────────────────────────────────────────────────────────────────────────────

    @app.route("/api/groups/mine", methods=["GET"])
    @_limit(settings.get("rate_limit_groups_read") or "240 per minute")
    @jwt_required()
    def my_groups():
        user = get_jwt_identity()
        user_id = _get_user_id(user)
        if not user_id:
            return jsonify({"error": "Invalid user"}), 403

        conn = get_db()
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT g.id, g.group_name, g.group_description, gm.role
                  FROM group_members gm
                  JOIN groups g ON g.id = gm.group_id
                 WHERE gm.user_id = %s
                 ORDER BY LOWER(g.group_name);
                """,
                (user_id,),
            )
            rows = cur.fetchall() or []

        groups = [
            {
                "id": r[0],
                "group_name": r[1],
                "group_description": r[2] or "",
                "role": r[3] or "member",
            }
            for r in rows
        ]
        return jsonify({"groups": groups})

    # ─────────────────────────────────────────────────────────────────────────────
    # Create group
    # ─────────────────────────────────────────────────────────────────────────────

    @app.route("/api/groups", methods=["POST"])
    @_limit(settings.get("rate_limit_groups_create") or "12 per minute")
    @jwt_required()
    def create_group():
        actor = get_jwt_identity()
        data = request.get_json(silent=True) or {}
        name = (data.get("name") or "").strip()
        description = (data.get("description") or "").strip()

        if not name:
            return jsonify({"error": "Group name required."}), 400
        if len(name) > 64:
            return jsonify({"error": "Group name too long (max 64)."}), 400
        if len(description) > 512:
            return jsonify({"error": "Description too long (max 512)."}), 400

        actor_id = _get_user_id(actor)
        if not actor_id:
            return jsonify({"error": "Invalid user"}), 403

        if not _rate_limit(f"grp:create:{actor}", limit=6, window_sec=60):
            return jsonify({"error": "Rate limited"}), 429

        conn = get_db()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO groups (group_name, group_description, created_by)
                    VALUES (%s, %s, %s)
                    RETURNING id;
                    """,
                    (name, description, actor_id),
                )
                group_id = int(cur.fetchone()[0])
                cur.execute(
                    """
                    INSERT INTO group_members (group_id, user_id, role)
                    VALUES (%s, %s, 'owner')
                    ON CONFLICT (group_id, user_id) DO NOTHING;
                    """,
                    (group_id, actor_id),
                )
            conn.commit()
            _audit(actor, "group_create", target=str(group_id), details=name)
            return jsonify({"group_id": group_id, "status": "created"}), 201
        except Exception as e:
            conn.rollback()
            return jsonify({"error": str(e)}), 500

    # ─────────────────────────────────────────────────────────────────────────────
    # Invites
    # ─────────────────────────────────────────────────────────────────────────────

    @app.route("/api/groups/invites", methods=["GET"])
    @_limit(settings.get("rate_limit_groups_read") or "240 per minute")
    @jwt_required()
    def list_group_invites():
        user = get_jwt_identity()
        user_id = _get_user_id(user)
        if not user_id:
            return jsonify({"error": "Invalid user"}), 403

        conn = get_db()
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT gi.group_id, g.group_name, g.group_description, gi.from_user, gi.sent_at
                  FROM group_invites gi
                  JOIN groups g ON g.id = gi.group_id
                 WHERE gi.to_user = %s AND gi.status = 'pending'
                 ORDER BY gi.sent_at DESC;
                """,
                (user,),
            )
            rows = cur.fetchall() or []

        invites = [
            {
                "group_id": int(r[0]),
                "group_name": r[1],
                "group_description": r[2] or "",
                "from_user": r[3],
                "sent_at": r[4].isoformat() if hasattr(r[4], "isoformat") else str(r[4]),
            }
            for r in rows
        ]
        return jsonify({"invites": invites})

    @app.route("/api/groups/<int:group_id>/invite", methods=["POST"])
    @_limit(settings.get("rate_limit_groups_invite") or "20 per minute")
    @jwt_required()
    def invite_to_group(group_id: int):
        actor = get_jwt_identity()
        actor_id = _get_user_id(actor)
        if not actor_id:
            return jsonify({"error": "Invalid user"}), 403

        if not _rate_limit(f"grp:invite:{actor}", limit=20, window_sec=60):
            return jsonify({"error": "Rate limited"}), 429

        role = _get_group_role(group_id, actor_id)
        if role is None:
            return _not_found()
        if _rank(role) < _ROLE_RANK["moderator"]:
            return jsonify({"error": "Insufficient group role"}), 403

        data = request.get_json(silent=True) or {}
        to_user = (data.get("to_user") or data.get("username") or "").strip().lower()
        if not to_user:
            return jsonify({"error": "to_user required"}), 400
        if to_user == actor:
            return jsonify({"error": "Cannot invite yourself"}), 400

        # Validate recipient exists
        to_user_id = _get_user_id(to_user)
        if not to_user_id:
            # Don't leak user existence too much; but for UX, return explicit error
            return jsonify({"error": "User not found"}), 404

        conn = get_db()
        try:
            with conn.cursor() as cur:
                # If already member, do nothing
                cur.execute(
                    "SELECT 1 FROM group_members WHERE group_id = %s AND user_id = %s;",
                    (group_id, to_user_id),
                )
                if cur.fetchone():
                    return jsonify({"status": "already_member"}), 200

                # Upsert invite
                cur.execute(
                    """
                    INSERT INTO group_invites (group_id, from_user, to_user, status)
                    VALUES (%s, %s, %s, 'pending')
                    ON CONFLICT (group_id, to_user)
                    DO UPDATE SET
                      from_user = EXCLUDED.from_user,
                      status = 'pending',
                      sent_at = CURRENT_TIMESTAMP;
                    """,
                    (group_id, actor, to_user),
                )
            conn.commit()
            _audit(actor, "group_invite", target=f"{group_id}:{to_user}", details=f"role={role}")
            return jsonify({"status": "invited"}), 200
        except Exception as e:
            conn.rollback()
            return jsonify({"error": str(e)}), 500

    def _accept_invite_common(group_id: int, actor: str, actor_id: int):
        conn = get_db()
        with conn.cursor() as cur:
            cur.execute(
                "SELECT status FROM group_invites WHERE group_id = %s AND to_user = %s;",
                (group_id, actor),
            )
            row = cur.fetchone()
            if not row or (row[0] or "") != "pending":
                return None  # not invited
            # Insert membership
            cur.execute(
                """
                INSERT INTO group_members (group_id, user_id, role)
                VALUES (%s, %s, 'member')
                ON CONFLICT (group_id, user_id) DO NOTHING;
                """,
                (group_id, actor_id),
            )
            # Mark invite accepted
            cur.execute(
                "UPDATE group_invites SET status = 'accepted' WHERE group_id = %s AND to_user = %s;",
                (group_id, actor),
            )
            # fetch group meta
            cur.execute("SELECT group_name, group_description FROM groups WHERE id = %s;", (group_id,))
            g = cur.fetchone()
        conn.commit()
        return {"group_id": group_id, "group_name": (g[0] if g else ""), "group_description": (g[1] if g else "")}

    @app.route("/api/groups/<int:group_id>/accept", methods=["POST"])
    @_limit(settings.get("rate_limit_groups_write") or "60 per minute")
    @jwt_required()
    def accept_group_invite(group_id: int):
        actor = get_jwt_identity()
        actor_id = _get_user_id(actor)
        if not actor_id:
            return jsonify({"error": "Invalid user"}), 403

        if not _rate_limit(f"grp:accept:{actor}", limit=30, window_sec=60):
            return jsonify({"error": "Rate limited"}), 429

        try:
            out = _accept_invite_common(group_id, actor, actor_id)
            if out is None:
                return _not_found()
            _audit(actor, "group_invite_accept", target=str(group_id))
            return jsonify({"status": "joined", **out}), 200
        except Exception as e:
            # _accept_invite_common commits; only here for unexpected failures
            return jsonify({"error": str(e)}), 500

    @app.route("/api/groups/<int:group_id>/decline", methods=["POST"])
    @_limit(settings.get("rate_limit_groups_write") or "60 per minute")
    @jwt_required()
    def decline_group_invite(group_id: int):
        actor = get_jwt_identity()
        if not _rate_limit(f"grp:decline:{actor}", limit=30, window_sec=60):
            return jsonify({"error": "Rate limited"}), 429

        conn = get_db()
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE group_invites SET status = 'declined' WHERE group_id = %s AND to_user = %s AND status = 'pending';",
                (group_id, actor),
            )
            changed = cur.rowcount
        conn.commit()
        if not changed:
            return _not_found()
        _audit(actor, "group_invite_decline", target=str(group_id))
        return jsonify({"status": "declined"}), 200

    @app.route("/api/groups/<int:group_id>/revoke_invite", methods=["POST"])
    @_limit(settings.get("rate_limit_groups_write") or "60 per minute")
    @jwt_required()
    def revoke_group_invite(group_id: int):
        actor = get_jwt_identity()
        actor_id = _get_user_id(actor)
        if not actor_id:
            return jsonify({"error": "Invalid user"}), 403

        role = _get_group_role(group_id, actor_id)
        if role is None:
            return _not_found()
        if _rank(role) < _ROLE_RANK["moderator"]:
            return jsonify({"error": "Insufficient group role"}), 403

        data = request.get_json(silent=True) or {}
        to_user = (data.get("to_user") or data.get("username") or "").strip().lower()
        if not to_user:
            return jsonify({"error": "to_user required"}), 400

        conn = get_db()
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE group_invites SET status = 'revoked' WHERE group_id = %s AND to_user = %s AND status = 'pending';",
                (group_id, to_user),
            )
            changed = cur.rowcount
        conn.commit()
        if not changed:
            return jsonify({"status": "no_pending_invite"}), 200
        _audit(actor, "group_invite_revoke", target=f"{group_id}:{to_user}")
        return jsonify({"status": "revoked"}), 200

    # Alias: join requires invite (kept for existing UI)
    @app.route("/api/groups/<int:group_id>/join", methods=["POST"])
    @_limit(settings.get("rate_limit_groups_write") or "60 per minute")
    @jwt_required()
    def join_group(group_id: int):
        actor = get_jwt_identity()
        actor_id = _get_user_id(actor)
        if not actor_id:
            return jsonify({"error": "Invalid user"}), 403

        out = _accept_invite_common(group_id, actor, actor_id)
        if out is None:
            return _not_found()
        _audit(actor, "group_join", target=str(group_id))
        return jsonify({"status": "joined", **out}), 200

    # ─────────────────────────────────────────────────────────────────────────────
    # Membership management
    # ─────────────────────────────────────────────────────────────────────────────

    @app.route("/api/groups/<int:group_id>/leave", methods=["POST"])
    @_limit(settings.get("rate_limit_groups_write") or "60 per minute")
    @jwt_required()
    def leave_group(group_id: int):
        actor = get_jwt_identity()
        actor_id = _get_user_id(actor)
        if not actor_id:
            return jsonify({"error": "Invalid user"}), 403

        role = _get_group_role(group_id, actor_id)
        if role is None:
            return _not_found()

        conn = get_db()
        try:
            with conn.cursor() as cur:
                if role == "owner":
                    cur.execute("SELECT COUNT(*) FROM group_members WHERE group_id = %s;", (group_id,))
                    count_members = int(cur.fetchone()[0])
                    if count_members > 1:
                        return jsonify({"error": "Owner must transfer ownership before leaving."}), 400
                    # owner is last member -> delete group
                    cur.execute("DELETE FROM groups WHERE id = %s;", (group_id,))
                    conn.commit()
                    _audit(actor, "group_delete_last_owner", target=str(group_id))
                    return jsonify({"status": "deleted", "group_id": group_id}), 200

                # Normal leave
                cur.execute(
                    "DELETE FROM group_members WHERE group_id = %s AND user_id = %s;",
                    (group_id, actor_id),
                )
            conn.commit()
            _audit(actor, "group_leave", target=str(group_id))
            return jsonify({"status": "left", "group_id": group_id}), 200
        except Exception as e:
            conn.rollback()
            return jsonify({"error": str(e)}), 500

    @app.route("/api/groups/<int:group_id>/kick", methods=["POST"])
    @_limit(settings.get("rate_limit_groups_write") or "60 per minute")
    @jwt_required()
    def kick_member(group_id: int):
        actor = get_jwt_identity()
        actor_id = _get_user_id(actor)
        if not actor_id:
            return jsonify({"error": "Invalid user"}), 403

        actor_role = _get_group_role(group_id, actor_id)
        if actor_role is None:
            return _not_found()

        data = request.get_json(silent=True) or {}
        target_user = (data.get("username") or data.get("to_user") or "").strip().lower()
        if not target_user:
            return jsonify({"error": "username required"}), 400
        if target_user == actor:
            return jsonify({"error": "Cannot kick yourself"}), 400

        target_id = _get_user_id(target_user)
        if not target_id:
            return jsonify({"error": "User not found"}), 404

        target_role = _get_group_role(group_id, target_id)
        if target_role is None:
            # do not leak
            return jsonify({"status": "not_member"}), 200

        if _rank(actor_role) <= _rank(target_role):
            return jsonify({"error": "Insufficient group role"}), 403
        if target_role == "owner":
            return jsonify({"error": "Cannot kick owner"}), 403

        conn = get_db()
        with conn.cursor() as cur:
            cur.execute(
                "DELETE FROM group_members WHERE group_id = %s AND user_id = %s;",
                (group_id, target_id),
            )
        conn.commit()
        _audit(actor, "group_kick", target=f"{group_id}:{target_user}", details=f"actor_role={actor_role},target_role={target_role}")
        return jsonify({"status": "kicked"}), 200

    @app.route("/api/groups/<int:group_id>/set_role", methods=["POST"])
    @_limit(settings.get("rate_limit_groups_write") or "60 per minute")
    @jwt_required()
    def set_member_role(group_id: int):
        actor = get_jwt_identity()
        actor_id = _get_user_id(actor)
        if not actor_id:
            return jsonify({"error": "Invalid user"}), 403

        actor_role = _get_group_role(group_id, actor_id)
        if actor_role is None:
            return _not_found()
        if actor_role != "owner":
            return jsonify({"error": "Owner only"}), 403

        data = request.get_json(silent=True) or {}
        target_user = (data.get("username") or "").strip().lower()
        new_role = (data.get("role") or "").strip().lower()

        if not target_user or not new_role:
            return jsonify({"error": "username and role required"}), 400
        if new_role not in _ALLOWED_ROLES:
            return jsonify({"error": "Invalid role"}), 400
        if target_user == actor:
            return jsonify({"error": "Owner role cannot be changed here"}), 400
        if new_role == "owner":
            return jsonify({"error": "Use transfer_ownership"}), 400

        target_id = _get_user_id(target_user)
        if not target_id:
            return jsonify({"error": "User not found"}), 404

        if not _is_member(group_id, target_id):
            return jsonify({"error": "Target not in group"}), 404

        conn = get_db()
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE group_members SET role = %s WHERE group_id = %s AND user_id = %s;",
                (new_role, group_id, target_id),
            )
        conn.commit()
        _audit(actor, "group_set_role", target=f"{group_id}:{target_user}", details=new_role)
        return jsonify({"status": "role_updated"}), 200

    @app.route("/api/groups/<int:group_id>/transfer_ownership", methods=["POST"])
    @_limit(settings.get("rate_limit_groups_write") or "30 per minute")
    @jwt_required()
    def transfer_ownership(group_id: int):
        actor = get_jwt_identity()
        actor_id = _get_user_id(actor)
        if not actor_id:
            return jsonify({"error": "Invalid user"}), 403
        actor_role = _get_group_role(group_id, actor_id)
        if actor_role is None:
            return _not_found()
        if actor_role != "owner":
            return jsonify({"error": "Owner only"}), 403

        data = request.get_json(silent=True) or {}
        target_user = (data.get("username") or "").strip().lower()
        if not target_user or target_user == actor:
            return jsonify({"error": "Valid target username required"}), 400

        target_id = _get_user_id(target_user)
        if not target_id:
            return jsonify({"error": "User not found"}), 404
        target_role = _get_group_role(group_id, target_id)
        if target_role is None:
            return jsonify({"error": "Target not in group"}), 404

        conn = get_db()
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE group_members SET role = 'owner' WHERE group_id = %s AND user_id = %s;",
                (group_id, target_id),
            )
            cur.execute(
                "UPDATE group_members SET role = 'admin' WHERE group_id = %s AND user_id = %s;",
                (group_id, actor_id),
            )
        conn.commit()
        _audit(actor, "group_transfer_owner", target=f"{group_id}:{target_user}")
        return jsonify({"status": "ownership_transferred"}), 200


    # ─────────────────────────────────────────────────────────────────────────────
    # Moderation: group mutes (moderator+)
    # ─────────────────────────────────────────────────────────────────────────────

    @app.route("/api/groups/<int:group_id>/mute", methods=["POST"])
    @_limit(settings.get("rate_limit_groups_write") or "60 per minute")
    @jwt_required()
    def mute_member(group_id: int):
        actor = get_jwt_identity()
        actor_id = _get_user_id(actor)
        if not actor_id:
            return jsonify({"error": "Invalid user"}), 403

        actor_role = _get_group_role(group_id, actor_id)
        if actor_role is None:
            return _not_found()
        if _rank(actor_role) < _ROLE_RANK["moderator"]:
            return jsonify({"error": "Insufficient group role"}), 403

        data = request.get_json(silent=True) or {}
        target_user = (data.get("username") or data.get("to_user") or "").strip().lower()
        if not target_user:
            return jsonify({"error": "username required"}), 400
        if target_user == actor:
            return jsonify({"error": "Cannot mute yourself"}), 400

        target_id = _get_user_id(target_user)
        if not target_id:
            return jsonify({"error": "User not found"}), 404

        target_role = _get_group_role(group_id, target_id)
        if target_role is None:
            return jsonify({"error": "Target not in group"}), 404
        if _rank(actor_role) <= _rank(target_role):
            return jsonify({"error": "Insufficient group role"}), 403
        if target_role == "owner":
            return jsonify({"error": "Cannot mute owner"}), 403

        conn = get_db()
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO group_mutes (group_id, username)
                VALUES (%s, %s)
                ON CONFLICT (group_id, username) DO NOTHING;
                """,
                (group_id, target_user),
            )
        conn.commit()
        _audit(actor, "group_mute", target=f"{group_id}:{target_user}")
        return jsonify({"status": "muted"}), 200

    @app.route("/api/groups/<int:group_id>/unmute", methods=["POST"])
    @_limit(settings.get("rate_limit_groups_write") or "60 per minute")
    @jwt_required()
    def unmute_member(group_id: int):
        actor = get_jwt_identity()
        actor_id = _get_user_id(actor)
        if not actor_id:
            return jsonify({"error": "Invalid user"}), 403

        actor_role = _get_group_role(group_id, actor_id)
        if actor_role is None:
            return _not_found()
        if _rank(actor_role) < _ROLE_RANK["moderator"]:
            return jsonify({"error": "Insufficient group role"}), 403

        data = request.get_json(silent=True) or {}
        target_user = (data.get("username") or data.get("to_user") or "").strip().lower()
        if not target_user:
            return jsonify({"error": "username required"}), 400

        conn = get_db()
        with conn.cursor() as cur:
            cur.execute(
                "DELETE FROM group_mutes WHERE group_id = %s AND username = %s;",
                (group_id, target_user),
            )
        conn.commit()
        _audit(actor, "group_unmute", target=f"{group_id}:{target_user}")
        return jsonify({"status": "unmuted"}), 200

    @app.route("/api/groups/<int:group_id>/mutes", methods=["GET"])
    @_limit(settings.get("rate_limit_groups_read") or "240 per minute")
    @jwt_required()
    def list_group_mutes(group_id: int):
        actor = get_jwt_identity()
        actor_id = _get_user_id(actor)
        if not actor_id:
            return jsonify({"error": "Invalid user"}), 403

        actor_role = _get_group_role(group_id, actor_id)
        if actor_role is None:
            return _not_found()
        if _rank(actor_role) < _ROLE_RANK["moderator"]:
            return jsonify({"error": "Insufficient group role"}), 403

        conn = get_db()
        with conn.cursor() as cur:
            cur.execute(
                "SELECT username, muted_at FROM group_mutes WHERE group_id = %s ORDER BY muted_at DESC;",
                (group_id,),
            )
            rows = cur.fetchall() or []
        return jsonify(
            {
                "group_id": group_id,
                "mutes": [
                    {"username": r[0], "muted_at": r[1].isoformat() if hasattr(r[1], "isoformat") else str(r[1])}
                    for r in rows
                ],
            }
        ), 200

    # ─────────────────────────────────────────────────────────────────────────────
    # Group metadata changes / deletion
    # ─────────────────────────────────────────────────────────────────────────────

    @app.route("/api/groups/<int:group_id>", methods=["PATCH"])
    @_limit(settings.get("rate_limit_groups_write") or "60 per minute")
    @jwt_required()
    def update_group(group_id: int):
        actor = get_jwt_identity()
        actor_id = _get_user_id(actor)
        if not actor_id:
            return jsonify({"error": "Invalid user"}), 403

        role = _get_group_role(group_id, actor_id)
        if role is None:
            return _not_found()
        if _rank(role) < _ROLE_RANK["admin"]:
            return jsonify({"error": "Admin/Owner only"}), 403

        data = request.get_json(silent=True) or {}
        name = (data.get("name") or "").strip() if "name" in data else ""
        desc = (data.get("description") or "").strip() if "description" in data else None

        if "name" in data:
            if not name:
                return jsonify({"error": "Group name cannot be empty."}), 400
            if len(name) > 64:
                return jsonify({"error": "Group name too long (max 64)."}), 400

        if desc is not None and len(desc) > 512:
            return jsonify({"error": "Description too long (max 512)."}), 400

        if "name" not in data and "description" not in data:
            return jsonify({"error": "Nothing to update"}), 400

        conn = get_db()
        with conn.cursor() as cur:
            if name:
                cur.execute("UPDATE groups SET group_name = %s WHERE id = %s;", (name, group_id))
            if desc is not None:
                cur.execute("UPDATE groups SET group_description = %s WHERE id = %s;", (desc, group_id))
        conn.commit()
        _audit(actor, "group_update", target=str(group_id), details=json.dumps({"name": bool(name), "desc": bool(desc)}))
        return jsonify({"status": "updated"}), 200

    @app.route("/api/groups/<int:group_id>", methods=["DELETE"])
    @_limit(settings.get("rate_limit_groups_write") or "30 per minute")
    @jwt_required()
    def delete_group(group_id: int):
        actor = get_jwt_identity()
        actor_id = _get_user_id(actor)
        if not actor_id:
            return jsonify({"error": "Invalid user"}), 403

        role = _get_group_role(group_id, actor_id)
        if role is None:
            return _not_found()
        if role != "owner":
            return jsonify({"error": "Owner only"}), 403

        conn = get_db()
        with conn.cursor() as cur:
            cur.execute("DELETE FROM groups WHERE id = %s;", (group_id,))
            deleted = cur.rowcount
        conn.commit()
        if not deleted:
            return _not_found()
        _audit(actor, "group_delete", target=str(group_id))
        return jsonify({"status": "deleted", "group_id": group_id}), 200

    # ─────────────────────────────────────────────────────────────────────────────
    # Members & unread counts (member-only)
    # ─────────────────────────────────────────────────────────────────────────────

    @app.route("/api/groups/<int:group_id>/members", methods=["GET"])
    @_limit(settings.get("rate_limit_groups_read") or "240 per minute")
    @jwt_required()
    def list_members(group_id: int):
        actor = get_jwt_identity()
        actor_id = _get_user_id(actor)
        if not actor_id:
            return jsonify({"error": "Invalid user"}), 403
        if not _is_member(group_id, actor_id):
            return _not_found()

        conn = get_db()
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT u.username, gm.role
                  FROM group_members gm
                  JOIN users u ON gm.user_id = u.id
                 WHERE gm.group_id = %s
                 ORDER BY LOWER(u.username);
                """,
                (group_id,),
            )
            members = [{"username": r[0], "role": r[1] or "member"} for r in (cur.fetchall() or [])]
        return jsonify({"group_id": group_id, "members": members}), 200

    @app.route("/api/groups/<int:group_id>/unread_count", methods=["GET"])
    @_limit(settings.get("rate_limit_groups_read") or "240 per minute")
    @jwt_required()
    def group_unread_count(group_id: int):
        actor = get_jwt_identity()
        actor_id = _get_user_id(actor)
        if not actor_id:
            return jsonify({"error": "Invalid user"}), 403
        if not _is_member(group_id, actor_id):
            return _not_found()

        conn = get_db()
        room = _room_key(group_id)
        legacy_room = str(group_id)

        with conn.cursor() as cur:
            cur.execute(
                "SELECT COUNT(*) FROM messages WHERE room = %s OR room = %s;",
                (room, legacy_room),
            )
            total = int(cur.fetchone()[0] or 0)

            cur.execute(
                """
                SELECT COUNT(*)
                  FROM message_reads
                 WHERE username = %s
                   AND message_id IN (
                       SELECT id FROM messages WHERE room = %s OR room = %s
                   );
                """,
                (actor, room, legacy_room),
            )
            read = int(cur.fetchone()[0] or 0)

        return jsonify({"group_id": group_id, "unread": max(0, total - read)}), 200

    # ─────────────────────────────────────────────────────────────────────────────
    # Group file uploads & authorized download
    # ─────────────────────────────────────────────────────────────────────────────

    @app.route("/api/groups/<int:group_id>/upload", methods=["POST"])
    @_limit(settings.get("rate_limit_groups_upload") or "10 per minute")
    @jwt_required()
    def group_file_upload(group_id: int):
        actor = get_jwt_identity()
        actor_id = _get_user_id(actor)
        if not actor_id:
            return jsonify({"error": "Invalid user"}), 403
        if not _is_member(group_id, actor_id):
            return _not_found()

        if request.content_length and int(request.content_length) > max_group_upload:
            return jsonify({"error": f"File too large (max {max_group_upload} bytes)"}), 413

        if "file" not in request.files:
            return jsonify({"error": "No file provided"}), 400
        file = request.files["file"]
        if not file.filename:
            return jsonify({"error": "Empty filename"}), 400

        safe_name = secure_filename(file.filename) or "upload.bin"
        file_uuid = uuid.uuid4().hex
        group_dir = os.path.join(upload_root, str(group_id))
        os.makedirs(group_dir, exist_ok=True)
        disk_path = os.path.join(group_dir, f"{file_uuid}__{safe_name}")

        # Write to disk
        file.save(disk_path)
        fsize = os.path.getsize(disk_path)

        if fsize > max_group_upload:
            try:
                os.remove(disk_path)
            except Exception:
                pass
            return jsonify({"error": "File too large"}), 413

        # Persist as message + attachment
        conn = get_db()
        try:
            with conn.cursor() as cur:
                room = _room_key(group_id)
                msg_text = "[file] Attachment (pending)"
                cur.execute(
                    """
                    INSERT INTO messages (sender, room, message, is_encrypted)
                    VALUES (%s, %s, %s, FALSE)
                    RETURNING id;
                    """,
                    (actor, room, msg_text),
                )
                message_id = int(cur.fetchone()[0])

                attachment_payload = json.dumps(
                    {
                        "v": 1,
                        "disk_path": disk_path,
                        "download_name": safe_name,
                    }
                )

                cur.execute(
                    """
                    INSERT INTO file_attachments (message_id, file_path, file_type, file_size)
                    VALUES (%s, %s, %s, %s)
                    RETURNING id;
                    """,
                    (message_id, attachment_payload, file.content_type, fsize),
                )
                attachment_id = int(cur.fetchone()[0])

                # Update message with attachment id for easy client parsing
                cur.execute(
                    "UPDATE messages SET message = %s WHERE id = %s;",
                    (f"[file:{attachment_id}]", message_id),
                )
            conn.commit()
        except Exception as e:
            conn.rollback()
            try:
                os.remove(disk_path)
            except Exception:
                pass
            return jsonify({"error": str(e)}), 500

        _audit(actor, "group_file_upload", target=f"{group_id}:{attachment_id}", details=f"{safe_name} ({fsize})")
        return jsonify({"status": "uploaded", "attachment_id": attachment_id, "name": safe_name, "size": fsize}), 200

    def _load_attachment_for_group(group_id: int, attachment_id: int, actor: str, actor_id: int):
        if not _is_member(group_id, actor_id):
            return None
        conn = get_db()
        room = _room_key(group_id)
        legacy_room = str(group_id)
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT fa.file_path, fa.file_type, fa.file_size
                  FROM file_attachments fa
                  JOIN messages m ON m.id = fa.message_id
                 WHERE fa.id = %s
                   AND (m.room = %s OR m.room = %s);
                """,
                (attachment_id, room, legacy_room),
            )
            row = cur.fetchone()
        if not row:
            return None
        file_path_raw, mime, size = row
        try:
            payload = json.loads(file_path_raw)
            disk_path = payload.get("disk_path")
            download_name = payload.get("download_name") or "download.bin"
        except Exception:
            # Legacy: treat as direct disk path
            disk_path = file_path_raw
            download_name = os.path.basename(disk_path) if disk_path else "download.bin"
        if not disk_path or not os.path.exists(disk_path):
            return None
        return {"disk_path": disk_path, "download_name": download_name, "mime": mime, "size": int(size or 0)}

    # NOTE:
    # routes_main.py already registers endpoints named `group_file_meta` and
    # `group_file_blob` for the newer E2EE group-files API.
    # Flask endpoint names must be unique across the whole app, so we use
    # different function names here for the legacy attachment-based group files.
    @app.route(
        "/api/groups/<int:group_id>/files/<int:attachment_id>/meta",
        methods=["GET"],
        endpoint="group_attachment_meta",
    )
    @jwt_required()
    def group_attachment_meta(group_id: int, attachment_id: int):
        actor = get_jwt_identity()
        actor_id = _get_user_id(actor)
        if not actor_id:
            return jsonify({"error": "Invalid user"}), 403
        att = _load_attachment_for_group(group_id, attachment_id, actor, actor_id)
        if not att:
            return _not_found()
        return jsonify(
            {
                "attachment_id": attachment_id,
                "group_id": group_id,
                "name": att["download_name"],
                "mime_type": att["mime"],
                "size": att["size"],
            }
        ), 200

    @app.route(
        "/api/groups/<int:group_id>/files/<int:attachment_id>/blob",
        methods=["GET"],
        endpoint="group_attachment_blob",
    )
    @jwt_required()
    def group_attachment_blob(group_id: int, attachment_id: int):
        actor = get_jwt_identity()
        actor_id = _get_user_id(actor)
        if not actor_id:
            return jsonify({"error": "Invalid user"}), 403
        att = _load_attachment_for_group(group_id, attachment_id, actor, actor_id)
        if not att:
            return _not_found()

        # send_file will set Content-Length; add download name for browser
        return send_file(
            att["disk_path"],
            mimetype=att["mime"] or "application/octet-stream",
            as_attachment=True,
            download_name=att["download_name"],
        )
