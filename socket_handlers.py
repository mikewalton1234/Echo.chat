#!/usr/bin/env python3
"""
socket_handlers.py

PostgreSQL‐adapted Socket.IO event handlers for Echo Chat Server.
All SQLite usages have been replaced with get_db() (PostgreSQL via psycopg2).
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

# Shared in-memory state is centralized in realtime.state so handler modules can be split safely.
from realtime.state import (
    _SEND_HISTORY,
    CONNECTED_USERS, CONNECTED_USERS_LOCK,
    TYPING_STATUS, TYPING_STATUS_LOCK, TYPING_EXPIRY_SECONDS,
    P2P_FILE_SESSIONS, P2P_FILE_SESSIONS_LOCK,
    VOICE_DM_SESSIONS, VOICE_DM_SESSIONS_LOCK,
    MESSAGE_REACTIONS, MESSAGE_REACTIONS_LOCK,
    VOICE_ROOMS, VOICE_ROOMS_LOCK,
    VOICE_INVITE_LAST,
    ALLOWED_REACTION_EMOJIS,
)


def register_socketio_handlers(socketio, settings):
    """
    Registers all Socket.IO event handlers. Uses PostgreSQL via get_db() for persistence.
    """

    def _user_sids(username: str) -> list[str]:
        """Return all active Socket.IO session IDs for a given username."""
        with CONNECTED_USERS_LOCK:
            return [sid for sid, u in CONNECTED_USERS.items() if u.get("username") == username]

    def _emit_to_user(username: str, event: str, payload) -> bool:
        """Emit an event to all connected sessions for a username. Returns True if delivered."""
        sids = _user_sids(username)
        for sid in sids:
            emit(event, payload, to=sid)
        return bool(sids)

    def _is_blocked(blocker: str, blocked: str) -> bool:
        """True if `blocker` has blocked `blocked`."""
        conn = get_db()
        with conn.cursor() as cur:
            cur.execute(
                "SELECT 1 FROM blocks WHERE blocker = %s AND blocked = %s LIMIT 1;",
                (blocker, blocked),
            )
            return cur.fetchone() is not None

    def _either_blocked(a: str, b: str) -> bool:
        """True if either direction is blocked."""
        return _is_blocked(a, b) or _is_blocked(b, a)



    # ───────────────────────────────────────────────────────────────────────
    # Live room counts (computed from active sessions)
    #
    # More reliable than DB member_count because Socket.IO events can execute
    # outside a normal Flask request lifecycle (no Flask app context), and
    # users may have multiple tabs. We count UNIQUE usernames per room.
    # ───────────────────────────────────────────────────────────────────────
    def _live_room_counts() -> dict[str, int]:
        per_room: dict[str, set[str]] = {}
        with CONNECTED_USERS_LOCK:
            for _sid, sess in CONNECTED_USERS.items():
                try:
                    r = sess.get("room")
                    u = sess.get("username")
                except Exception:
                    continue
                if not r or not u:
                    continue
                per_room.setdefault(str(r), set()).add(str(u))
        return {room: len(users) for room, users in per_room.items()}
    
    def _emit_room_counts_snapshot(*, to_sid: str | None = None) -> None:
        payload = {"counts": _live_room_counts(), "ts": time.time()}
        try:
            if to_sid:
                emit("room_counts", payload, to=to_sid)
            else:
                socketio.emit("room_counts", payload)
        except Exception:
            pass
    
    
    # Live room user lists (computed from active sessions)
    def _live_room_users(room: str) -> list[str]:
        room = str(room or "").strip()
        if not room:
            return []
        users: set[str] = set()
        with CONNECTED_USERS_LOCK:
            for _sid, sess in CONNECTED_USERS.items():
                try:
                    if str(sess.get("room") or "") != room:
                        continue
                    u = sess.get("username")
                    if u:
                        users.add(str(u))
                except Exception:
                    continue
        return sorted(users)

    def _emit_room_users_snapshot(room: str, *, to_sid: str | None = None) -> None:
        try:
            payload = {"room": str(room or ""), "users": _live_room_users(room)}
            if to_sid:
                emit("room_users", payload, to=to_sid)
            else:
                socketio.emit("room_users", payload, room=room)
        except Exception:
            pass

    def _active_sanction_detail(username: str, sanction_type: str) -> tuple[str | None, str | None]:
        """Return (reason, expires_at_iso) for the most recent active sanction of this type."""
        try:
            conn = get_db()
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT reason, expires_at
                      FROM user_sanctions
                     WHERE username = %s
                       AND sanction_type = %s
                       AND (expires_at IS NULL OR expires_at > NOW())
                     ORDER BY created_at DESC
                     LIMIT 1;
                    """,
                    (username, sanction_type),
                )
                row = cur.fetchone()
            if not row:
                return None, None
            reason = row[0]
            expires_at = row[1]
            exp_iso = None
            try:
                exp_iso = expires_at.isoformat() if expires_at else None
            except Exception:
                exp_iso = None
            return (str(reason).strip() if reason else None), exp_iso
        except Exception:
            return None, None

    def _format_sanction_message(username: str, sanction_type: str, base: str) -> str:
        reason, exp_iso = _active_sanction_detail(username, sanction_type)
        msg = base
        if reason:
            msg += f" Reason: {reason}"
        if exp_iso:
            msg += f" Until: {exp_iso}"
        return msg

    def _require_not_sanctioned(username: str, action: str) -> tuple[bool, str | None]:
        """Gate actions on sanctions.

        Returns (ok, error_message).
        """
        if is_user_sanctioned(username, "ban"):
            return False, "You are banned."
        if action in {"send", "dm", "voice"} and is_user_sanctioned(username, "mute"):
            return False, "You are muted."
        if action == "join" and is_user_sanctioned(username, "kick"):
            return False, "You are temporarily kicked."
        return True, None


    # ------------------------------------------------------------------
    # In-memory session registries (P2P file transfer + 1:1 voice calls)
    # ------------------------------------------------------------------
    _ID_RE = re.compile(r"^[a-zA-Z0-9_.\-]{8,80}$")

    def _valid_id(val) -> bool:
        try:
            return bool(val) and bool(_ID_RE.match(str(val)))
        except Exception:
            return False

    def _sanitize_file_meta(meta: dict) -> dict:
        meta = meta or {}
        name = str(meta.get("name") or "").strip()
        if name:
            name = name[:200]

        mime = str(meta.get("mime") or meta.get("type") or "").strip()
        if mime:
            mime = mime[:100]

        size_raw = meta.get("size")
        size = None
        try:
            if size_raw is not None:
                size = int(size_raw)
        except Exception:
            size = None

        out = {}
        if name:
            out["name"] = name
        if mime:
            out["mime"] = mime
        if size is not None:
            out["size"] = size
        return out

    def _cleanup_p2p_file_sessions() -> None:
        ttl = float(settings.get("p2p_file_session_ttl_seconds", 900) or 900)
        now = time.time()
        with P2P_FILE_SESSIONS_LOCK:
            stale = [
                tid for tid, s in P2P_FILE_SESSIONS.items()
                if (now - float(s.get("updated", s.get("created", now)))) > ttl
            ]
            for tid in stale:
                try:
                    del P2P_FILE_SESSIONS[tid]
                except Exception:
                    pass

    def _cleanup_voice_dm_sessions() -> None:
        invite_ttl = float(settings.get("voice_dm_invite_ttl_seconds", 90) or 90)
        active_ttl = float(settings.get("voice_dm_active_ttl_seconds", 3600) or 3600)
        now = time.time()
        with VOICE_DM_SESSIONS_LOCK:
            stale = []
            for cid, s in VOICE_DM_SESSIONS.items():
                state = str(s.get("state") or "")
                updated = float(s.get("updated", s.get("created", now)))
                ttl = invite_ttl if state == "invited" else active_ttl
                if (now - updated) > ttl:
                    stale.append(cid)
            for cid in stale:
                try:
                    del VOICE_DM_SESSIONS[cid]
                except Exception:
                    pass

    def _voice_dm_end_for_users(a: str, b: str, call_id: str, reason: str) -> None:
        # Best-effort notify both sides (other side will ignore if not in UI state).
        payload = {"sender": a, "call_id": call_id, "reason": reason}
        _emit_to_user(b, "voice_dm_end", payload)


    # ------------------------------------------------------------------
    # Voice helpers (in-memory roster)
    # ------------------------------------------------------------------
    def _voice_room_users(room: str) -> list[str]:
        with VOICE_ROOMS_LOCK:
            users = VOICE_ROOMS.get(room) or set()
            return sorted(users)

    def _voice_room_add(room: str, username: str) -> tuple[bool, str | None, list[str]]:
        """Add user to voice roster. Returns (ok, error, roster)."""
        # 0 (or <=0) means unlimited.
        max_peers = int(settings.get("voice_max_room_peers", 0) or 0)
        with VOICE_ROOMS_LOCK:
            s = VOICE_ROOMS.setdefault(room, set())
            if username in s:
                return True, None, sorted(s)
            if max_peers > 0 and len(s) >= max_peers:
                return False, "Voice room is full.", sorted(s)
            s.add(username)
            return True, None, sorted(s)

    def _voice_room_remove(room: str, username: str) -> bool:
        with VOICE_ROOMS_LOCK:
            s = VOICE_ROOMS.get(room)
            if not s or username not in s:
                return False
            s.discard(username)
            if not s:
                try:
                    del VOICE_ROOMS[room]
                except Exception:
                    pass
            return True


    # ------------------------------------------------------------------
    # Presence / status helpers
    # ------------------------------------------------------------------
    _ALLOWED_PRESENCE = {"online", "away", "busy", "invisible"}

    def _normalize_presence(val):
        """Normalize/validate presence strings. Returns a valid value or None."""
        if val is None:
            return None
        v = str(val).strip().lower()
        if v in {"available", "default"}:
            v = "online"
        return v if v in _ALLOWED_PRESENCE else None

    def _sanitize_custom_status(val):
        """Trim + clamp to 128 chars. Returns None for empty/whitespace."""
        if val is None:
            return None
        s = str(val).strip()
        if not s:
            return None
        if len(s) > 128:
            return s[:128]
        return s

    def _public_presence_snapshot_from_row(username, online, presence_status, custom_status, last_seen):
        pres = _normalize_presence(presence_status) or "online"
        visible_online = bool(online) and pres != "invisible"
        visible_presence = "offline" if not visible_online else pres
        visible_custom = custom_status if visible_online else None
        ls = last_seen.isoformat() if last_seen else None
        return {
            "username": str(username),
            "online": bool(visible_online),
            "presence": str(visible_presence),
            "custom_status": visible_custom,
            "last_seen": ls,
        }

    def _get_user_presence_row(username: str):
        conn = get_db()
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT online, presence_status, custom_status, last_seen
                  FROM users
                 WHERE username = %s;
                """,
                (username,),
            )
            row = cur.fetchone()
        if not row:
            return {"online": False, "presence_status": "offline", "custom_status": None, "last_seen": None}
        online, presence_status, custom_status, last_seen = row
        return {
            "online": bool(online),
            "presence_status": _normalize_presence(presence_status) or "online",
            "custom_status": custom_status,
            "last_seen": last_seen,
        }

    def _public_presence_snapshot(username: str):
        row = _get_user_presence_row(username)
        return _public_presence_snapshot_from_row(
            username,
            row.get("online"),
            row.get("presence_status"),
            row.get("custom_status"),
            row.get("last_seen"),
        )

    def _self_presence_snapshot(username: str):
        row = _get_user_presence_row(username)
        return {
            "presence": row.get("presence_status") or "online",
            "custom_status": row.get("custom_status") or "",
        }

    def _broadcast_presence_to_friends(username: str) -> None:
        """Send the viewer-safe presence snapshot to all of the user's friends."""
        try:
            friends = get_friends_for_user(username) or []
            snap = _public_presence_snapshot(username)
            for f in friends:
                _emit_to_user(f, "friend_presence_update", snap)
        except Exception:
            return

    def _room_locked(room: str) -> bool:
        conn = get_db()
        with conn.cursor() as cur:
            cur.execute(
                "SELECT locked FROM room_locks WHERE room = %s;",
                (room,),
            )
            row = cur.fetchone()
        return bool(row and row[0])

    def _room_readonly(room: str) -> bool:
        conn = get_db()
        with conn.cursor() as cur:
            cur.execute(
                "SELECT readonly FROM room_readonly WHERE room = %s;",
                (room,),
            )
            row = cur.fetchone()
        return bool(row and row[0])

    # Slowmode cache + per-user last-sent tracking
    # room -> (seconds, fetched_at_epoch)
    _ROOM_SLOWMODE_CACHE: dict[str, tuple[int, float]] = {}
    _ROOM_SLOWMODE_CACHE_LOCK = threading.Lock()
    # (username, room) -> last_sent_epoch
    _SLOWMODE_LAST_SENT: dict[tuple[str, str], float] = {}
    _SLOWMODE_LAST_SENT_LOCK = threading.Lock()

    def _room_slowmode_seconds(room: str) -> int:
        """Return slowmode interval in seconds for a room (0 => off).

        Backed by the room_slowmode table; falls back to settings['room_slowmode_default_sec']
        if no row exists. Cached briefly to reduce DB pressure.
        """
        try:
            ttl = float(settings.get('room_slowmode_cache_ttl_sec') or 10)
        except Exception:
            ttl = 10.0
        now = time.time()
        with _ROOM_SLOWMODE_CACHE_LOCK:
            hit = _ROOM_SLOWMODE_CACHE.get(room)
            if hit and (now - float(hit[1])) < ttl:
                try:
                    return int(hit[0])
                except Exception:
                    return 0

        sec = 0
        try:
            conn = get_db()
            with conn.cursor() as cur:
                cur.execute('SELECT seconds FROM room_slowmode WHERE room = %s;', (room,))
                row = cur.fetchone()
            if row and row[0] is not None:
                sec = int(row[0])
        except Exception:
            sec = 0

        if sec <= 0:
            try:
                sec = int(settings.get('room_slowmode_default_sec') or 0)
            except Exception:
                sec = 0

        sec = max(0, min(int(sec), 3600))
        with _ROOM_SLOWMODE_CACHE_LOCK:
            _ROOM_SLOWMODE_CACHE[room] = (sec, now)
        return sec


    def _push_room_policy_state(room: str, set_by: str | None = None) -> None:
        """Emit per-user room policy state to all connected members of a room."""
        room = (room or '').strip()
        if not room:
            return

        try:
            locked = _room_locked(room)
        except Exception:
            locked = False
        try:
            readonly = _room_readonly(room)
        except Exception:
            readonly = False
        try:
            slow = _room_slowmode_seconds(room)
        except Exception:
            slow = 0

        # Snapshot targets without holding the lock during emits
        targets: list[tuple[str, str]] = []
        try:
            with CONNECTED_USERS_LOCK:
                for sid, u in CONNECTED_USERS.items():
                    if (u or {}).get("room") != room:
                        continue
                    uname = (u or {}).get("username")
                    if uname:
                        targets.append((sid, uname))
        except Exception:
            targets = []

        for sid, uname in targets:
            # Per-user override rules (RBAC)
            try:
                bypass_lock = bool(
                    check_user_permission(uname, "admin:super")
                    or check_user_permission(uname, "room:lock")
                )
            except Exception:
                bypass_lock = False
            try:
                bypass_ro = bool(
                    check_user_permission(uname, "admin:super")
                    or check_user_permission(uname, "room:readonly")
                )
            except Exception:
                bypass_ro = False

            can_send = (not locked or bypass_lock) and (not readonly or bypass_ro)
            block_reason = None
            if not can_send:
                if readonly and not bypass_ro:
                    block_reason = "read_only"
                elif locked and not bypass_lock:
                    block_reason = "locked"
                else:
                    block_reason = "blocked"

            payload = {
                "room": room,
                "locked": bool(locked),
                "readonly": bool(readonly),
                "slowmode_seconds": int(slow or 0),
                "can_send": bool(can_send),
                "can_override_lock": bool(bypass_lock),
                "can_override_readonly": bool(bypass_ro),
                "block_reason": block_reason,
            }
            if set_by:
                payload["set_by"] = set_by

            try:
                emit("room_policy_state", payload, to=sid)
            except Exception:
                pass

    def _store_offline_pm(sender: str, receiver: str, cipher: str) -> None:
        """Persist ciphertext for later delivery (server never decrypts)."""
        conn = get_db()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO offline_messages (sender, receiver, message, delivered)
                    VALUES (%s, %s, %s, FALSE);
                    """,
                    (sender, receiver, cipher),
                )
            conn.commit()
        except Exception as e:
            print(f"[DB ERROR] store_offline_pm: {e}")


    def _emit_missed_pm_summary(username: str, sid: str | None = None) -> None:
        """Send per-sender counts of offline PMs that have not been delivered yet."""
        conn = get_db()
        target_sid = sid or request.sid
        try:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT sender, COUNT(*)::int AS cnt, MAX(timestamp) AS last_ts
                      FROM offline_messages
                     WHERE receiver = %s
                       AND delivered = FALSE
                     GROUP BY sender
                     ORDER BY last_ts DESC;
                    """,
                    (username,),
                )
                rows = cur.fetchall() or []

            items = []
            for sender, cnt, last_ts in rows:
                try:
                    epoch = float(last_ts.timestamp()) if last_ts else None
                except Exception:
                    epoch = None
                items.append({"sender": sender, "count": int(cnt), "last_ts": epoch})

            emit("missed_pm_summary", {"items": items}, to=target_sid)
        except Exception as e:
            print(f"[DB ERROR] missed_pm_summary: {e}")
            try:
                emit("missed_pm_summary", {"items": []}, to=target_sid)
            except Exception:
                pass

    def _group_rl(key: str, limit: int, window_sec: int) -> bool:
        now = time.time()
        with _GROUP_RATE_LOCK:
            dq = _GROUP_RATE.get(key)
            if dq is None:
                dq = deque()
                _GROUP_RATE[key] = dq
            cutoff = now - window_sec
            while dq and dq[0] < cutoff:
                dq.popleft()
            if len(dq) >= limit:
                return False
            dq.append(now)
            return True

    def _parse_rate_limit(val, *, default_limit: int = 60, default_window: int = 60) -> tuple[int, int]:
        """Parse a human-friendly rate limit value.

        Accepts either a bare integer (treated as per-minute), or strings like:
          - '60 per minute'
          - '10/sec', '10 per second'
          - '120/hour', '120 per hour'
          - '30@10' (30 per 10 seconds)

        Returns: (limit, window_seconds)
        """
        try:
            if val is None:
                return int(default_limit), int(default_window)
            if isinstance(val, bool):
                return int(default_limit), int(default_window)
            if isinstance(val, (int, float)):
                lim = int(val)
                return (lim if lim > 0 else int(default_limit)), 60
            if isinstance(val, str):
                s = val.strip().lower()
                import re
                m = re.search(r'(\d+)', s)
                lim = int(m.group(1)) if m else int(default_limit)
                window = 60
                if 'per second' in s or '/sec' in s or s.endswith('sec'):
                    window = 1
                elif 'per minute' in s or '/min' in s or 'minute' in s or s.endswith('min'):
                    window = 60
                elif 'per hour' in s or '/hour' in s or 'hour' in s:
                    window = 3600
                if '@' in s:
                    a, b = s.split('@', 1)
                    m1 = re.search(r'(\d+)', a)
                    m2 = re.search(r'(\d+)', b)
                    if m1:
                        lim = int(m1.group(1))
                    if m2:
                        window = max(1, int(m2.group(1)))
                return (lim if lim > 0 else int(default_limit)), int(window)
        except Exception:
            pass
        return int(default_limit), int(default_window)

    # ───────────────────────────────────────────────────────────────────────────
    # Anti-abuse guardrails (rooms + DMs + file offers)
    #   - per-user rate limiting (burst windows)
    #   - optional per-user hourly quotas (admin-set via /admin/set_user_quota)
    #   - auto-mute when a user repeatedly hits limits
    # ───────────────────────────────────────────────────────────────────────────

    _RATE: dict[str, deque] = {}
    _RATE_LOCK = threading.Lock()

    _ABUSE_STRIKES: dict[str, deque] = {}
    _ABUSE_LOCK = threading.Lock()

    _AUTO_MUTE_LAST: dict[str, float] = {}
    _AUTO_MUTE_LAST_LOCK = threading.Lock()

    _QUOTA_CACHE: dict[str, tuple[int | None, float]] = {}
    _QUOTA_CACHE_LOCK = threading.Lock()

    # Duplicate-message heuristics (plaintext only)
    _DUP_MSG: dict[tuple[str, str], deque] = {}
    _DUP_LOCK = threading.Lock()

    # Friend request target spread (anti-harassment)
    _FR_TARGETS: dict[str, deque] = {}
    _FR_LOCK = threading.Lock()

    # Room-existence cache (reduce DB hits when checking room creation policy)
    _ROOM_EXISTS_CACHE: dict[str, tuple[bool, float]] = {}
    _ROOM_EXISTS_LOCK = threading.Lock()

    def _rl(key: str, limit: int, window_sec: int) -> tuple[bool, float]:
        """Sliding-window rate limiter.

        Returns (ok, retry_after_seconds).
        """
        now = time.time()
        try:
            limit = int(limit)
        except Exception:
            limit = 0
        try:
            window_sec = int(window_sec)
        except Exception:
            window_sec = 0

        if limit <= 0 or window_sec <= 0:
            return True, 0.0

        with _RATE_LOCK:
            dq = _RATE.get(key)
            if dq is None:
                dq = deque()
                _RATE[key] = dq
            cutoff = now - window_sec
            while dq and dq[0] < cutoff:
                dq.popleft()
            if len(dq) >= limit:
                retry = (dq[0] + window_sec) - now
                return False, max(0.0, float(retry))
            dq.append(now)
            return True, 0.0

    def _get_user_quota_per_hour(username: str) -> int | None:
        """Return messages/hour quota if explicitly set for the user, else None.

        This is intentionally opt-in: default is unlimited unless an admin sets a quota.
        Cached briefly to avoid DB hits on every message.
        """
        now = time.time()
        try:
            ttl = float(settings.get('quota_cache_ttl_sec') or 60)
        except Exception:
            ttl = 60.0

        with _QUOTA_CACHE_LOCK:
            hit = _QUOTA_CACHE.get(username)
            if hit and (now - float(hit[1])) < ttl:
                return hit[0]

        limit = None
        try:
            conn = get_db()
            with conn.cursor() as cur:
                cur.execute('SELECT messages_per_hour FROM user_quotas WHERE username = %s;', (username,))
                row = cur.fetchone()
            if row and row[0] is not None:
                limit = int(row[0])
        except Exception:
            limit = None

        with _QUOTA_CACHE_LOCK:
            _QUOTA_CACHE[username] = (limit, now)
        return limit

    def _abuse_strike(username: str, reason: str) -> bool:
        """Record a limit-hit strike; may auto-mute if configured.

        Returns True if an auto-mute was triggered.
        """
        # Don't auto-mute staff
        try:
            if check_user_permission(username, 'admin:super') or check_user_permission(username, 'admin:basic'):
                return False
        except Exception:
            pass

        now = time.time()
        try:
            max_strikes = int(settings.get('antiabuse_strikes_before_mute') or 6)
        except Exception:
            max_strikes = 6
        try:
            strike_window = int(settings.get('antiabuse_strike_window_sec') or 30)
        except Exception:
            strike_window = 30
        try:
            mute_minutes = int(settings.get('antiabuse_auto_mute_minutes') or 2)
        except Exception:
            mute_minutes = 2

        if max_strikes <= 0 or strike_window <= 0 or mute_minutes <= 0:
            return False

        with _ABUSE_LOCK:
            dq = _ABUSE_STRIKES.get(username)
            if dq is None:
                dq = deque()
                _ABUSE_STRIKES[username] = dq
            cutoff = now - strike_window
            while dq and dq[0] < cutoff:
                dq.popleft()
            dq.append(now)
            count = len(dq)

        if count < max_strikes:
            return False

        # Avoid re-applying mute repeatedly within the same window
        with _AUTO_MUTE_LAST_LOCK:
            last = float(_AUTO_MUTE_LAST.get(username, 0.0) or 0.0)
            if (now - last) < strike_window:
                return False
            _AUTO_MUTE_LAST[username] = now

        try:
            if not is_user_sanctioned(username, 'mute'):
                mute_user(username, reason=f'Auto-mute: {reason}', duration_minutes=mute_minutes, actor='system')
                _emit_to_user(username, 'notification', f'🚫 You were auto-muted for {mute_minutes} minutes (spam/abuse guard).')
        except Exception:
            pass

        return True

    def _room_exists(room: str) -> bool:
        """Check if a room exists (cached)."""
        now = time.time()
        try:
            ttl = float(settings.get('room_exists_cache_ttl_sec') or 10)
        except Exception:
            ttl = 10.0

        with _ROOM_EXISTS_LOCK:
            hit = _ROOM_EXISTS_CACHE.get(room)
            if hit and (now - float(hit[1])) < ttl:
                return bool(hit[0])

        exists = False
        try:
            conn = get_db()
            with conn.cursor() as cur:
                cur.execute('SELECT 1 FROM chat_rooms WHERE name = %s LIMIT 1;', (room,))
                exists = bool(cur.fetchone())
        except Exception:
            exists = False

        # Cache only positive lookups. Negative caching can block immediate joins
        # right after a room is created via the REST API.
        if exists:
            with _ROOM_EXISTS_LOCK:
                _ROOM_EXISTS_CACHE[room] = (True, now)
        return exists

    _URL_TOKEN_RE = re.compile(r'(https?://|www\.)', re.IGNORECASE)
    _MAGNET_RE = re.compile(r'magnet:\?', re.IGNORECASE)
    _MENTION_RE = re.compile(r'@[a-zA-Z0-9_.-]{2,32}')

    def _antiabuse_plaintext_checks(username: str, room: str, message: str) -> tuple[bool, str | None]:
        """Heuristic spam checks for *plaintext* room messages.

        This is intentionally conservative to avoid false positives.
        """
        # Link / magnet / mention limits
        try:
            max_links = int(settings.get('max_links_per_message') or 0)
        except Exception:
            max_links = 0
        try:
            max_magnets = int(settings.get('max_magnets_per_message') or 0)
        except Exception:
            max_magnets = 0
        try:
            max_mentions = int(settings.get('max_mentions_per_message') or 0)
        except Exception:
            max_mentions = 0

        if max_links > 0:
            lc = len(_URL_TOKEN_RE.findall(message))
            if lc > max_links:
                _abuse_strike(username, 'link_spam')
                return False, f'Too many links (max {max_links})'

        if max_magnets > 0:
            mc = len(_MAGNET_RE.findall(message))
            if mc > max_magnets:
                _abuse_strike(username, 'magnet_spam')
                return False, f'Too many magnet links (max {max_magnets})'

        if max_mentions > 0:
            ment = len(_MENTION_RE.findall(message))
            if ment > max_mentions:
                _abuse_strike(username, 'mention_spam')
                return False, f'Too many mentions (max {max_mentions})'

        # Duplicate message heuristic (same message repeated rapidly in same room)
        try:
            win = int(settings.get('dup_msg_window_sec') or 0)
        except Exception:
            win = 0
        try:
            mx = int(settings.get('dup_msg_max') or 0)
        except Exception:
            mx = 0
        try:
            minlen = int(settings.get('dup_msg_min_length') or 0)
        except Exception:
            minlen = 0
        norm = bool(settings.get('dup_msg_normalize', True))

        if win > 0 and mx > 0 and len(message) >= max(1, minlen):
            msg = message
            if norm:
                msg = re.sub(r'\s+', ' ', msg.strip().lower())
            sig = hash(msg)
            now = time.time()
            key = (username, room)
            with _DUP_LOCK:
                dq = _DUP_MSG.get(key)
                if dq is None:
                    dq = deque()
                    _DUP_MSG[key] = dq
                cutoff = now - win
                while dq and dq[0][0] < cutoff:
                    dq.popleft()
                dq.append((now, sig))
                count = sum(1 for ts, s in dq if s == sig)
            if count > mx:
                if _abuse_strike(username, 'dup_msg'):
                    return False, 'Auto-muted for spamming. Try again later.'
                return False, f'Duplicate message spam (slow down)'

        return True, None

    def _friend_req_target_spread_ok(from_user: str, to_user: str) -> tuple[bool, str | None]:
        """Limit how many *unique* friend request targets a user can hit in a window."""
        try:
            mx = int(settings.get('friend_req_unique_targets_max') or 0)
        except Exception:
            mx = 0
        try:
            win = int(settings.get('friend_req_unique_targets_window_sec') or 0)
        except Exception:
            win = 0
        if mx <= 0 or win <= 0:
            return True, None

        now = time.time()
        with _FR_LOCK:
            dq = _FR_TARGETS.get(from_user)
            if dq is None:
                dq = deque()
                _FR_TARGETS[from_user] = dq
            cutoff = now - win
            while dq and dq[0][0] < cutoff:
                dq.popleft()
            dq.append((now, to_user))
            uniq = {t for _, t in dq}
            if len(uniq) > mx:
                _abuse_strike(from_user, 'friendreq_spread')
                return False, f'Too many different targets in a short time (max {mx} per {win}s)'
        return True, None

    def _validate_room_name(room: str) -> tuple[bool, str | None]:
        """Basic room name validation to prevent abuse."""
        try:
            mx = int(settings.get('max_room_name_length') or 48)
        except Exception:
            mx = 48
        room = (room or '').strip()
        if not room:
            return False, 'Room name missing'
        if len(room) > mx:
            return False, f'Room name too long (max {mx})'
        # Keep permissive, but disallow control chars.
        if any(ord(c) < 32 for c in room):
            return False, 'Invalid room name'
        return True, None


    # ───────────────────────────────────────────────────────────────────────────
    # Autoscaled public rooms (Lobby -> Lobby (2) -> ...)
    # Accept both "Lobby(2)" and "Lobby (2)". Canonical form is "Lobby (2)".
    # ───────────────────────────────────────────────────────────────────────────

    _ROOM_SHARD_RE = re.compile(r"^(?P<base>.+?)\s*\(\s*(?P<n>\d+)\s*\)\s*$")

    def _parse_room_shard(name: str) -> tuple[str, int] | None:
        s = (name or "").strip()
        m = _ROOM_SHARD_RE.match(s)
        if not m:
            return None
        base = (m.group("base") or "").strip()
        try:
            n = int(m.group("n"))
        except Exception:
            return None
        if not base or n < 2:
            return None
        return base, n

    def _canonical_room_name(name: str) -> str:
        s = (name or "").strip()
        p = _parse_room_shard(s)
        if not p:
            return s
        base, n = p
        return f"{base} ({n})"

    def _autoscale_enabled() -> bool:
        return bool(settings.get("autoscale_rooms_enabled", True))

    def _autoscale_capacity() -> int:
        try:
            cap = int(settings.get("autoscale_room_capacity", 30))
        except Exception:
            cap = 30
        return max(2, min(cap, 5000))

    def _select_autoscaled_room(requested_room: str) -> tuple[str, bool]:
        """Return (actual_room, created_new).

        - If requested room is a shard, canonicalize it and ensure it exists.
        - If requested room is a base room and is full, route to an existing shard with space
          or create the next shard.
        """
        req = _canonical_room_name(requested_room)
        if not _autoscale_enabled():
            return req, False

        cap = _autoscale_capacity()

        # If user explicitly requested a shard, honor it (ensure exists)
        parsed = _parse_room_shard(req)
        if parsed:
            if not _room_exists(req):
                # Create the shard if base exists
                base, _n = parsed
                if _room_exists(base):
                    create_autoscaled_room_if_missing(req, base)
                    return req, True
            return req, False

        # Base room request
        base = req
        # Only autoscale rooms that exist
        if not _room_exists(base):
            return base, False

        live = {}
        try:
            live = _live_room_counts() or {}
        except Exception:
            live = {}

        if int(live.get(base, 0) or 0) < cap:
            return base, False

        # Find a shard with space or create next
        i = 2
        created = False
        while i < 500:
            candidate = f"{base} ({i})"
            if not _room_exists(candidate):
                create_autoscaled_room_if_missing(candidate, base)
                created = True
                return candidate, created
            if int(live.get(candidate, 0) or 0) < cap:
                return candidate, False
            i += 1
        # Fallback: if pathological, just return base
        return base, False

    def _join_rate_ok(username: str) -> tuple[bool, float]:
        lim, win = _parse_rate_limit(settings.get('room_join_rate_limit'), default_limit=15, default_window=30)
        try:
            win = int(settings.get('room_join_rate_window_sec') or win)
        except Exception:
            pass
        return _rl(f'join:{username}', lim, win)

    def _room_create_rate_ok(username: str) -> tuple[bool, float]:
        lim, win = _parse_rate_limit(settings.get('room_create_rate_limit'), default_limit=5, default_window=300)
        try:
            win = int(settings.get('room_create_rate_window_sec') or win)
        except Exception:
            pass
        return _rl(f'roomcreate:{username}', lim, win)

    def _friend_req_rate_ok(username: str) -> tuple[bool, float]:
        lim, win = _parse_rate_limit(settings.get('friend_req_rate_limit'), default_limit=5, default_window=60)
        try:
            win = int(settings.get('friend_req_rate_window_sec') or win)
        except Exception:
            pass
        return _rl(f'friendreq:{username}', lim, win)

    def _get_user_id_by_username(username: str) -> int | None:
        try:
            conn = get_db()
            with conn.cursor() as cur:
                cur.execute("SELECT id FROM users WHERE username = %s;", (username,))
                row = cur.fetchone()
            return int(row[0]) if row else None
        except Exception:
            return None

    def _is_group_member(group_id: int, user_id: int) -> bool:
        try:
            conn = get_db()
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT 1 FROM group_members WHERE group_id = %s AND user_id = %s;",
                    (group_id, user_id),
                )
                return cur.fetchone() is not None
        except Exception:
            return False

    def _is_group_muted(group_id: int, username: str) -> bool:
        try:
            conn = get_db()
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT 1 FROM group_mutes WHERE group_id = %s AND username = %s;",
                    (group_id, username),
                )
                return cur.fetchone() is not None
        except Exception:
            return False

    def _group_room(group_id: int) -> str:
        return f"group_{group_id}"

    def _group_store_room(group_id: int) -> str:
        return f"g:{group_id}"

    def _format_group_history_rows(rows, *, require_e2ee: bool, allow_legacy: bool):
        """Convert DB rows -> wire-safe history items.

        We never emit plaintext group history when require_e2ee is enabled unless
        allow_legacy_plaintext_history is explicitly set.
        """
        out = []
        for r in rows or []:
            try:
                mid = int(r[0])
                sender = r[1]
                msg = r[2]
                is_enc = bool(r[3])
                ts = r[4]
            except Exception:
                continue

            item = {
                "message_id": mid,
                "sender": sender,
                "is_encrypted": is_enc,
                "timestamp": ts.isoformat() if hasattr(ts, "isoformat") else str(ts),
            }

            if is_enc:
                # message column stores the envelope string
                item["cipher"] = msg
                item["message"] = "🔒 Encrypted message"
            else:
                if require_e2ee and not allow_legacy:
                    item["message"] = "⚠️ Legacy plaintext message hidden"
                    item["hidden_legacy"] = True
                else:
                    item["message"] = msg

            out.append(item)
        return out

    def _format_room_history_rows(rows, require_e2ee: bool, allow_legacy_plaintext: bool):
        """Normalize DB rows into payloads the room UI already knows how to render."""
        out = []
        for r in (rows or []):
            mid, sender, msg, is_enc, ts = r
            item = {
                "message_id": int(mid),
                "username": sender,
                "timestamp": ts.isoformat() if hasattr(ts, "isoformat") else None,
            }
            if bool(is_enc):
                item["cipher"] = msg
                item["message"] = "🔒 Encrypted message"
                item["encrypted"] = True
            else:
                if require_e2ee and not allow_legacy_plaintext:
                    item["message"] = "⚠️ Legacy plaintext message hidden"
                    item["legacy_hidden"] = True
                else:
                    item["message"] = msg
                item["encrypted"] = False
            out.append(item)
        return out

    def _voice_dm_require_active(sender: str, to: str, call_id: str):
        _cleanup_voice_dm_sessions()
        with VOICE_DM_SESSIONS_LOCK:
            sess = VOICE_DM_SESSIONS.get(call_id)
            if not sess:
                return None, {"success": False, "error": "Unknown/expired call"}
            if {sess.get("caller"), sess.get("callee")} != {sender, to}:
                return None, {"success": False, "error": "Not a participant"}
            if str(sess.get("state") or "") != "active":
                return None, {"success": False, "error": "Call not active"}
            sess["updated"] = time.time()
            return sess, None


    # ───────────────────────────────────────────────────────────────────
    # Register split handler modules (see realtime/*.py)
    # ───────────────────────────────────────────────────────────────────
    from types import SimpleNamespace
    ctx = SimpleNamespace(**{k: v for k, v in locals().items() if k.startswith("_") and callable(v)})
    from realtime import dm, presence_social, rooms, groups, files, voice, admin
    dm.register(socketio, settings, ctx)
    presence_social.register(socketio, settings, ctx)
    rooms.register(socketio, settings, ctx)
    groups.register(socketio, settings, ctx)
    files.register(socketio, settings, ctx)
    voice.register(socketio, settings, ctx)
    admin.register(socketio, settings, ctx)

