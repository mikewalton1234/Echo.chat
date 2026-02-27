#!/usr/bin/env python3
"""moderation.py

Moderation helpers (PostgreSQL).

Writes sanctions to user_sanctions and audit events to audit_log.
SQLite support has been removed.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import List, Optional, Tuple

from database import get_db
from security import log_audit_event


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _add_sanction(
    username: str,
    sanction_type: str,
    reason: str | None = None,
    duration_minutes: int | None = None,
    actor: str = "system",
) -> None:
    """Insert a sanction row.

    If duration_minutes is None, expires_at is NULL (permanent) .
    """
    expires_at = None
    if duration_minutes is not None:
        expires_at = _utcnow() + timedelta(minutes=int(duration_minutes))

    conn = get_db()
    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO user_sanctions (username, sanction_type, reason, expires_at)
            VALUES (%s, %s, %s, %s);
            """,
            (username, sanction_type, reason, expires_at),
        )
    conn.commit()

    detail = f"reason={reason or ''}; duration_minutes={duration_minutes}; expires_at={expires_at}"
    log_audit_event(actor, f"sanction:{sanction_type}", username, detail)


def ban_user(
    username: str,
    reason: str = "Violation of rules",
    duration_minutes: int = 1440,
    actor: str = "system",
) -> None:
    _add_sanction(username, "ban", reason, duration_minutes, actor=actor)


def mute_user(
    username: str,
    reason: str = "Spamming or abusive content",
    duration_minutes: int = 60,
    actor: str = "system",
) -> None:
    _add_sanction(username, "mute", reason, duration_minutes, actor=actor)


def kick_user(
    username: str,
    reason: str = "Disruptive behavior",
    duration_minutes: int = 15,
    actor: str = "system",
) -> None:
    # Kick is modeled as a short-lived sanction
    _add_sanction(username, "kick", reason, duration_minutes, actor=actor)


def is_user_sanctioned(username: str, sanction_type: str) -> bool:
    """Return True if the newest sanction of the type is active."""
    conn = get_db()
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT expires_at
              FROM user_sanctions
             WHERE username = %s
               AND sanction_type = %s
             ORDER BY created_at DESC
             LIMIT 1;
            """,
            (username, sanction_type),
        )
        row = cur.fetchone()

    if not row:
        return False

    expires_at = row[0]
    if expires_at is None:
        return True
    return _utcnow() < expires_at


def list_active_sanctions(username: str | None = None, limit: int = 200):
    """List active sanctions.

    If username is None or '*', returns all active sanctions (up to limit).
    Returns rows shaped as tuples: (username, sanction_type, reason, expires_at)
    """
    conn = get_db()
    with conn.cursor() as cur:
        if not username or username == "*":
            cur.execute(
                """
                SELECT username, sanction_type, reason, expires_at
                  FROM user_sanctions
                 WHERE (expires_at IS NULL OR expires_at > NOW())
                 ORDER BY created_at DESC
                 LIMIT %s;
                """,
                (int(limit),),
            )
        else:
            cur.execute(
                """
                SELECT username, sanction_type, reason, expires_at
                  FROM user_sanctions
                 WHERE username = %s
                   AND (expires_at IS NULL OR expires_at > NOW())
                 ORDER BY created_at DESC
                 LIMIT %s;
                """,
                (username, int(limit)),
            )
        rows = cur.fetchall()

    return rows
