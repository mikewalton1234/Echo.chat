#!/usr/bin/env python3
"""
Echo Chat Server – database helpers (PostgreSQL version)

• PostgreSQL via Flask g
• Full table set from user’s original schema (adapted for Postgres)
• Auto-adds users.online column if missing
• Ensures chat_rooms.member_count column if missing
• Pre-loads rooms from chat_rooms.json (idempotent)
• Full RBAC seeding
• Public helpers:
    get_friends_for_user, get_all_rooms,
    create_room_if_missing, increment_room_count
"""

import os
import json
import logging
from datetime import datetime, timezone
import psycopg2
from psycopg2.extras import RealDictCursor
from psycopg2.pool import ThreadedConnectionPool
from flask import g
from constants import get_db_connection_string, sanitize_postgres_dsn, redact_postgres_dsn, postgres_dsn_parts


def _log_table_owner_mismatch(conn, table_name: str) -> None:
    """Log actionable guidance when the connected DB user can't ALTER a table.

    Most common cause: tables were created by a different Postgres role (owner),
    but the DSN in server_config.json uses another role.
    """
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT current_user, current_database();")
            current_user, current_db = cur.fetchone()
            cur.execute(
                """
                SELECT tableowner
                  FROM pg_tables
                 WHERE schemaname = 'public'
                   AND tablename = %s;
                """,
                (table_name,),
            )
            row = cur.fetchone()
            owner = row[0] if row else None

        logging.error(
            "DB migration blocked: connected as '%s' but public.%s is owned by '%s'.",
            current_user,
            table_name,
            owner,
        )
        logging.error("Fix (run as a superuser / postgres):")
        logging.error(
            "  sudo -u postgres psql -d %s -c \"ALTER TABLE public.%s OWNER TO %s;\"",
            current_db,
            table_name,
            current_user,
        )
        if owner and owner != current_user:
            logging.error(
                "Optional: reassign everything owned by '%s' to '%s':",
                owner,
                current_user,
            )
            logging.error(
                "  sudo -u postgres psql -d %s -c \"REASSIGN OWNED BY %s TO %s;\"",
                current_db,
                owner,
                current_user,
            )
    except Exception as exc:
        logging.error("Could not inspect table ownership for troubleshooting: %s", exc)

# ----------------------------------------------------------------------
# JSON file containing default rooms (same location as this file)
# ----------------------------------------------------------------------
JSON_ROOMS_PATH = os.path.join(os.path.dirname(__file__), "chat_rooms.json")


# ----------------------------------------------------------------------
# Connection helpers
# ----------------------------------------------------------------------

# Optional global connection pool. Enabled by calling init_db_pool().
_POOL: ThreadedConnectionPool | None = None
_DSN: str | None = None


def init_db_pool(minconn: int = 1, maxconn: int = 10, dsn: str | None = None) -> None:
    """Initialise a global ThreadedConnectionPool.

    Safe to call multiple times (no-op after first init).
    """
    global _POOL
    if _POOL is not None:
        return

    global _DSN
    _DSN = str(sanitize_postgres_dsn(dsn or get_db_connection_string()))

    try:
        _POOL = ThreadedConnectionPool(
            minconn=int(minconn),
            maxconn=int(maxconn),
            dsn=_DSN,
        )
        logging.info("✅  Postgres connection pool ready (min=%s max=%s)", minconn, maxconn)
    except Exception as e:
        _POOL = None
        logging.warning("⚠️  Could not initialise Postgres pool; falling back to direct connects: %s", e)


def _acquire_conn():
    """Acquire a connection either from the pool or by direct connect.

    Returns (conn, from_pool: bool)
    """
    if _POOL is not None:
        return _POOL.getconn(), True
    return psycopg2.connect(_DSN or get_db_connection_string()), False


def _release_conn(conn, from_pool: bool) -> None:
    if conn is None:
        return
    if _POOL is not None and from_pool:
        try:
            # Ensure a clean connection is returned to the pool.
            conn.rollback()
        except Exception:
            pass
        _POOL.putconn(conn)
    else:
        conn.close()

def get_db() -> psycopg2.extensions.connection:
    """
    Return one psycopg2 connection per Flask request context (stored in g.db).
    Uses get_db_connection_string() for runtime evaluation.
    """
    if not hasattr(g, "db"):
        conn, from_pool = _acquire_conn()
        g.db = conn
        g.db_from_pool = from_pool
    return g.db


def close_db(error=None):
    """
    Teardown: close the connection stored in g.db (if any).
    Called automatically via app.teardown_appcontext.
    """
    db_conn = g.pop("db", None)
    from_pool = bool(g.pop("db_from_pool", False))
    if db_conn is not None:
        try:
            _release_conn(db_conn, from_pool)
        except Exception as e:
            logging.error("Error releasing DB connection: %s", e)
    if error:
        logging.error("DB teardown error: %s", error)


# ----------------------------------------------------------------------
# Simple lookups that use a fresh connection (for non-request contexts)
# ----------------------------------------------------------------------
def get_blocked_users(username: str) -> list[str]:
    """
    Return a list of usernames that the given user has blocked.
    """
    conn, from_pool = _acquire_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT blocked FROM blocks WHERE blocker = %s;",
                (username,)
            )
            blocked = [row[0] for row in cur.fetchall()]
    finally:
        _release_conn(conn, from_pool)
    return blocked


def get_pending_friend_requests(username: str) -> list[str]:
    """
    Return a list of usernames who have sent a 'pending' friend request to the given user.
    """
    conn, from_pool = _acquire_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT from_user
                  FROM friend_requests
                 WHERE to_user = %s
                   AND request_status = 'pending';
                """,
                (username,)
            )
            requests = [row[0] for row in cur.fetchall()]
    finally:
        _release_conn(conn, from_pool)
    return requests


# ----------------------------------------------------------------------
# Column / table patch helpers
# ----------------------------------------------------------------------
def ensure_online_column():
    """
    Add an 'online BOOLEAN DEFAULT FALSE' column to users if it does not exist.
    """
    conn = get_db()
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT column_name
              FROM information_schema.columns
             WHERE table_name = 'users'
               AND column_name = 'online';
            """
        )
        if cur.fetchone() is None:
            logging.warning("Adding users.online column")
            cur.execute(
                "ALTER TABLE users ADD COLUMN online BOOLEAN DEFAULT FALSE;"
            )
            conn.commit()

def ensure_presence_columns():
    """Ensure presence-related columns exist on users.

    - presence_status: user's chosen availability state (online/away/busy/invisible)
    - custom_status: optional short text (enforced in app logic)

    These are separate from users.online (transport-level connectedness) and users.status
    (account/admin state).
    """
    conn = get_db()
    try:
        with conn.cursor() as cur:
            # presence_status
            cur.execute(
                """
                SELECT column_name
                  FROM information_schema.columns
                 WHERE table_name = 'users'
                   AND column_name = 'presence_status';
                """
            )
            if cur.fetchone() is None:
                logging.warning("Adding users.presence_status column")
                cur.execute(
                    "ALTER TABLE users ADD COLUMN presence_status TEXT NOT NULL DEFAULT 'online';"
                )

            # custom_status (older DBs may not have it)
            cur.execute(
                """
                SELECT column_name
                  FROM information_schema.columns
                 WHERE table_name = 'users'
                   AND column_name = 'custom_status';
                """
            )
            if cur.fetchone() is None:
                logging.warning("Adding users.custom_status column")
                cur.execute(
                    "ALTER TABLE users ADD COLUMN custom_status TEXT;"
                )

        conn.commit()
    except psycopg2.errors.InsufficientPrivilege:
        conn.rollback()
        _log_table_owner_mismatch(conn, "users")
        raise



def ensure_chat_rooms_table():
    """
    Create chat_rooms table and ensure 'member_count' column exists.
    """
    conn = get_db()
    with conn.cursor() as cur:
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS chat_rooms (
                id            SERIAL PRIMARY KEY,
                name          TEXT UNIQUE NOT NULL,
                created_by    TEXT NOT NULL DEFAULT 'system',
                member_count  INTEGER DEFAULT 0,
                created_at    TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                last_active_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
            );
            """
        )
        cur.execute(
            """
            SELECT column_name
              FROM information_schema.columns
             WHERE table_name = 'chat_rooms'
               AND column_name = 'member_count';
            """
        )
        if cur.fetchone() is None:
            logging.warning("Adding chat_rooms.member_count column")
            cur.execute(
                "ALTER TABLE chat_rooms ADD COLUMN member_count INTEGER DEFAULT 0;"
            )

        # Track last time the room was non-empty (used for autoscaled room cleanup)
        cur.execute(
            """
            SELECT column_name
              FROM information_schema.columns
             WHERE table_name = 'chat_rooms'
               AND column_name = 'last_active_at';
            """
        )
        if cur.fetchone() is None:
            logging.warning("Adding chat_rooms.last_active_at column")
            cur.execute(
                "ALTER TABLE chat_rooms ADD COLUMN last_active_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP;"
            )
            # Best-effort backfill from created_at
            try:
                cur.execute("UPDATE chat_rooms SET last_active_at = created_at WHERE last_active_at IS NULL;")
            except Exception:
                pass
        conn.commit()


def ensure_users_key_columns():
    """
    If the 'users' table already exists but lacks:
      • a column 'password' (only 'password_hash' exists), rename password_hash → password,
      • columns 'public_key' and 'encrypted_private_key', add them now.
    """
    conn = get_db()
    with conn.cursor() as cur:
        # 1) Rename password_hash → password if needed
        cur.execute(
            """
            SELECT column_name
              FROM information_schema.columns
             WHERE table_name = 'users'
               AND column_name = 'password_hash';
            """
        )
        if cur.fetchone() is not None:
            cur.execute(
                """
                SELECT column_name
                  FROM information_schema.columns
                 WHERE table_name = 'users'
                   AND column_name = 'password';
                """
            )
            if cur.fetchone() is None:
                cur.execute("ALTER TABLE users RENAME COLUMN password_hash TO password;")

        # 2) Add public_key if missing
        cur.execute(
            """
            SELECT column_name
              FROM information_schema.columns
             WHERE table_name = 'users'
               AND column_name = 'public_key';
            """
        )
        if cur.fetchone() is None:
            cur.execute("ALTER TABLE users ADD COLUMN public_key TEXT;")

        # 3) Add encrypted_private_key if missing
        cur.execute(
            """
            SELECT column_name
              FROM information_schema.columns
             WHERE table_name = 'users'
               AND column_name = 'encrypted_private_key';
            """
        )
        if cur.fetchone() is None:
            cur.execute("ALTER TABLE users ADD COLUMN encrypted_private_key TEXT;")

    conn.commit()


def ensure_account_recovery_schema() -> None:
    """Ensure account recovery fields and tables exist.

    This adds low-entropy recovery support (4-digit PIN) in a *safe* way:
      - the PIN is stored hashed (PBKDF2 via security.hash_password)
      - failed attempts are tracked and can be locked out

    It also creates a password_reset_tokens table for high-entropy, single-use,
    expiring reset tokens.

    Safe to call repeatedly.
    """

    conn = get_db()
    with conn.cursor() as cur:
        # ── users recovery columns ───────────────────────────────────────
        def _ensure_user_col(col: str, ddl: str) -> None:
            cur.execute(
                """
                SELECT column_name
                  FROM information_schema.columns
                 WHERE table_name = 'users'
                   AND column_name = %s;
                """,
                (col,),
            )
            if cur.fetchone() is None:
                logging.warning("Adding users.%s column", col)
                cur.execute(ddl)

        _ensure_user_col("recovery_pin_hash", "ALTER TABLE users ADD COLUMN recovery_pin_hash TEXT;")
        _ensure_user_col(
            "recovery_pin_set_at",
            "ALTER TABLE users ADD COLUMN recovery_pin_set_at TIMESTAMP WITH TIME ZONE;",
        )
        _ensure_user_col(
            "recovery_failed_attempts",
            "ALTER TABLE users ADD COLUMN recovery_failed_attempts INTEGER NOT NULL DEFAULT 0;",
        )
        _ensure_user_col(
            "recovery_locked_until",
            "ALTER TABLE users ADD COLUMN recovery_locked_until TIMESTAMP WITH TIME ZONE;",
        )

        # Optional but useful: a case-insensitive unique index for email.
        #
        # If an existing DB has duplicates, this will fail.
        # IMPORTANT: In PostgreSQL, a failed statement aborts the whole transaction
        # until it is rolled back. Use a SAVEPOINT so we can continue cleanly.
        try:
            cur.execute(
                """
                SELECT COUNT(*)
                  FROM (
                        SELECT LOWER(email) AS e
                          FROM users
                         WHERE email IS NOT NULL AND BTRIM(email) <> ''
                         GROUP BY LOWER(email)
                        HAVING COUNT(*) > 1
                       ) d;
                """
            )
            dup_cnt = int((cur.fetchone() or [0])[0])
        except Exception:
            dup_cnt = 0

        if dup_cnt > 0:
            logging.warning(
                "Email uniqueness index not created: found %s duplicate email(s). ",
                dup_cnt,
            )
            logging.warning(
                "Fix duplicates then restart. Helpful script: tools/dedupe_duplicate_emails.py (use --dry-run first)."
            )
        else:
            try:
                cur.execute("SAVEPOINT sp_users_email_unique_ci;")
                cur.execute(
                    """
                    CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique_ci
                    ON users (LOWER(email))
                    WHERE email IS NOT NULL AND BTRIM(email) <> '';
                    """
                )
                cur.execute("RELEASE SAVEPOINT sp_users_email_unique_ci;")
            except Exception as e:
                try:
                    cur.execute("ROLLBACK TO SAVEPOINT sp_users_email_unique_ci;")
                    cur.execute("RELEASE SAVEPOINT sp_users_email_unique_ci;")
                except Exception:
                    # If rollback-to-savepoint fails for any reason, we fall back
                    # to continuing and letting the outer commit/rollback handle it.
                    pass
                logging.warning("Could not create users_email_unique_ci index (continuing): %s", e)

        # ── password_reset_tokens table ──────────────────────────────────
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS password_reset_tokens (
                id          SERIAL PRIMARY KEY,
                username    TEXT NOT NULL,
                token_hash  TEXT UNIQUE NOT NULL,
                created_at  TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                expires_at  TIMESTAMP WITH TIME ZONE NOT NULL,
                used_at     TIMESTAMP WITH TIME ZONE,
                request_ip  TEXT,
                user_agent  TEXT
            );
            """
        )
        cur.execute(
            """
            CREATE INDEX IF NOT EXISTS prt_username_created_idx
            ON password_reset_tokens (username, created_at);
            """
        )
        cur.execute(
            """
            CREATE INDEX IF NOT EXISTS prt_expires_used_idx
            ON password_reset_tokens (expires_at, used_at);
            """
        )

    conn.commit()



def ensure_auth_session_schema() -> None:
    """Ensure auth session tracking schema exists.

    - Adds auth_sessions table (one row per device/session)
    - Adds auth_tokens.session_id column (ties tokens to a session)
    Safe to call repeatedly.
    """
    conn = get_db()
    with conn.cursor() as cur:
        # auth_sessions table
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS auth_sessions (
                session_id  TEXT PRIMARY KEY,
                username    TEXT NOT NULL,
                created_at  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
                last_seen_at TIMESTAMP WITH TIME ZONE,
                last_activity_at TIMESTAMP WITH TIME ZONE,
                revoked_at  TIMESTAMP WITH TIME ZONE,
                revoked_reason TEXT,
                user_agent  TEXT,
                ip_address  TEXT
            );
            """
        )
        cur.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_auth_sessions_username
            ON auth_sessions(username);
            """
        )
        cur.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_auth_sessions_revoked
            ON auth_sessions(revoked_at);
            """
        )

        # auth_sessions.last_activity_at column (used for idle logout)
        cur.execute(
            """
            SELECT column_name
              FROM information_schema.columns
             WHERE table_name = 'auth_sessions'
               AND column_name = 'last_activity_at';
            """
        )
        if cur.fetchone() is None:
            logging.warning("Adding auth_sessions.last_activity_at column")
            cur.execute("ALTER TABLE auth_sessions ADD COLUMN last_activity_at TIMESTAMPTZ NULL;")
        # Backfill nulls (older DBs) to avoid treating existing sessions as instantly idle
        cur.execute(
            """
            UPDATE auth_sessions
               SET last_activity_at = COALESCE(last_seen_at, created_at, NOW())
             WHERE last_activity_at IS NULL;
            """
        )

        # auth_tokens.session_id column
        cur.execute(
            """
            SELECT column_name
              FROM information_schema.columns
             WHERE table_name = 'auth_tokens'
               AND column_name = 'session_id';
            """
        )
        if cur.fetchone() is None:
            logging.warning("Adding auth_tokens.session_id column")
            cur.execute("ALTER TABLE auth_tokens ADD COLUMN session_id TEXT;")

        cur.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_auth_tokens_session
            ON auth_tokens(session_id);
            """
        )
    conn.commit()



def load_rooms_from_json():
    """Seed *official* chat_rooms from chat_rooms.json.

    Supports two formats:

    v1 (legacy):
      ["General", {"name":"Tech"}, ...]

    v2 (catalog):
      {
        "version": 2,
        "categories": [
          {
            "name": "General",
            "subcategories": [
              {"name": "Main", "rooms": ["Lobby", "Support"]}
            ]
          }
        ]
      }

    Behavior:
      - Inserts room names into chat_rooms(name, member_count) with member_count=0.
      - Idempotent (ON CONFLICT DO NOTHING).
    """
    if not os.path.exists(JSON_ROOMS_PATH):
        logging.warning("chat_rooms.json not found – skipping preload")
        return

    try:
        with open(JSON_ROOMS_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception as exc:
        logging.error("Bad chat_rooms.json: %s", exc)
        return

    rooms: list[tuple[str, int]] = []

    # v2 catalog schema
    if isinstance(data, dict) and int(data.get("version", 0) or 0) >= 2:
        cats = data.get("categories") or []
        for c in (cats if isinstance(cats, list) else []):
            subs = (c or {}).get("subcategories") or []
            for s in (subs if isinstance(subs, list) else []):
                for r in ((s or {}).get("rooms") or []):
                    if isinstance(r, str) and r.strip():
                        rooms.append((r.strip(), 0))
    # v1 legacy list
    elif isinstance(data, list):
        for entry in data:
            if isinstance(entry, str):
                rooms.append((entry.strip(), 0))
            elif isinstance(entry, dict) and "name" in entry:
                count_val = int(entry.get("count", 0))
                rooms.append((entry["name"].strip(), count_val))
    if not rooms:
        return

    conn = get_db()
    with conn.cursor() as cur:
        cur.executemany(
            """
            INSERT INTO chat_rooms (name, member_count)
            VALUES (%s, %s)
            ON CONFLICT (name) DO NOTHING;
            """,
            rooms
        )
    conn.commit()


def ensure_user_verified_column():
    """Ensure users.is_verified exists.

    EchoChat doesn't yet have an explicit email verification workflow, but the
    room browser requires a server-side "verified" gate for creating custom rooms.
    We default existing users to TRUE for backward compatibility.
    """
    conn = get_db()
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT column_name
              FROM information_schema.columns
             WHERE table_name='users'
               AND column_name='is_verified';
            """
        )
        if cur.fetchone() is None:
            logging.warning("Adding users.is_verified column")
            cur.execute("ALTER TABLE users ADD COLUMN is_verified BOOLEAN NOT NULL DEFAULT TRUE;")
    conn.commit()


def ensure_custom_rooms_schema():
    """Create/patch schema for custom rooms + private invites."""
    conn = get_db()
    with conn.cursor() as cur:
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS custom_rooms (
                name           TEXT PRIMARY KEY,
                category       TEXT NOT NULL,
                subcategory    TEXT NOT NULL,
                created_by     TEXT NOT NULL,
                is_private     BOOLEAN NOT NULL DEFAULT FALSE,
                is_18_plus     BOOLEAN NOT NULL DEFAULT FALSE,
                is_nsfw        BOOLEAN NOT NULL DEFAULT FALSE,
                created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                last_active_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );
            """
        )
        cur.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_custom_rooms_cat
            ON custom_rooms(category, subcategory);
            """
        )
        cur.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_custom_rooms_last_active
            ON custom_rooms(last_active_at);
            """
        )
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS custom_room_invites (
                id           SERIAL PRIMARY KEY,
                room_name    TEXT NOT NULL,
                invited_user TEXT NOT NULL,
                invited_by   TEXT NOT NULL,
                created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                UNIQUE(room_name, invited_user)
            );
            """
        )
        cur.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_custom_room_invites_user
            ON custom_room_invites(invited_user);
            """
        )

        # Generic room invite notifications (for public/official rooms)
        # NOTE: these invites do *not* grant access control; they are used for UX only.
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS room_invites (
                id           SERIAL PRIMARY KEY,
                room_name    TEXT NOT NULL,
                invited_user TEXT NOT NULL,
                invited_by   TEXT NOT NULL,
                created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                UNIQUE(room_name, invited_user)
            );
            """
        )
        cur.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_room_invites_user
            ON room_invites(invited_user);
            """
        )
    conn.commit()


def consume_room_invites(room_name: str, username: str) -> None:
    """Delete any outstanding invites for (room_name, username).

    This prevents invite notifications from re-appearing after the user has
    already joined the room.
    """
    if not room_name or not username:
        return
    conn, from_pool = _acquire_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "DELETE FROM room_invites WHERE room_name=%s AND invited_user=%s;",
                (room_name, username),
            )
            cur.execute(
                "DELETE FROM custom_room_invites WHERE room_name=%s AND invited_user=%s;",
                (room_name, username),
            )
        conn.commit()
    finally:
        _release_conn(conn, from_pool)


def ensure_room_message_expiry_schema() -> None:
    """Create/patch schema for per-room message expiry + supporting indexes."""
    conn = get_db()
    with conn.cursor() as cur:
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS room_message_expiry (
                room           TEXT PRIMARY KEY,
                expiry_seconds INTEGER NOT NULL,
                set_by         TEXT,
                set_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );
            """
        )

        # History lookups (room history) should be fast.
        cur.execute("CREATE INDEX IF NOT EXISTS idx_messages_room_id ON messages(room, id);")
        cur.execute("CREATE INDEX IF NOT EXISTS idx_messages_room_ts ON messages(room, timestamp);")

        # Reaction fanout aggregates should be fast.
        cur.execute("CREATE INDEX IF NOT EXISTS idx_message_reactions_message_id ON message_reactions(message_id);")
    conn.commit()


def set_room_message_expiry(room: str, expiry_seconds: int, set_by: str | None = None) -> None:
    """Set per-room message expiry. expiry_seconds <= 0 disables expiry for that room."""
    room = (room or '').strip()
    if not room:
        return
    try:
        expiry_seconds = int(expiry_seconds)
    except Exception:
        expiry_seconds = 0

    conn = get_db()
    with conn.cursor() as cur:
        if expiry_seconds <= 0:
            cur.execute("DELETE FROM room_message_expiry WHERE room=%s;", (room,))
        else:
            cur.execute(
                """
                INSERT INTO room_message_expiry (room, expiry_seconds, set_by)
                VALUES (%s, %s, %s)
                ON CONFLICT (room)
                DO UPDATE SET expiry_seconds=EXCLUDED.expiry_seconds,
                              set_by=EXCLUDED.set_by,
                              set_at=NOW();
                """,
                (room, expiry_seconds, set_by),
            )
    conn.commit()


def get_room_message_expiry(room: str) -> int | None:
    room = (room or '').strip()
    if not room:
        return None
    conn = get_db()
    with conn.cursor() as cur:
        cur.execute("SELECT expiry_seconds FROM room_message_expiry WHERE room=%s;", (room,))
        row = cur.fetchone()
    if not row:
        return None
    try:
        return int(row[0])
    except Exception:
        return None


def cleanup_expired_room_messages() -> int:
    """Delete messages older than per-room expiry. Returns number of messages deleted."""
    # Must be callable from janitor thread (no Flask context).
    conn, from_pool = _acquire_conn()
    try:
        deleted = 0
        with conn.cursor() as cur:
            # Use a single set-based delete; Postgres will apply per-row interval.
            cur.execute(
                """
                WITH del AS (
                    DELETE FROM messages m
                     USING room_message_expiry e
                     WHERE m.room = e.room
                       AND e.expiry_seconds > 0
                       AND m.timestamp < (NOW() - (e.expiry_seconds || ' seconds')::interval)
                    RETURNING 1
                )
                SELECT COUNT(*) FROM del;
                """
            )
            row = cur.fetchone()
            deleted = int(row[0] or 0) if row else 0
        if deleted:
            conn.commit()
        else:
            conn.rollback()
        return deleted
    except Exception:
        try:
            conn.rollback()
        except Exception:
            pass
        logging.exception("cleanup_expired_room_messages failed")
        return 0
    finally:
        _release_conn(conn, from_pool)


def is_user_verified(username: str) -> bool:
    if not username:
        return False
    conn = get_db()
    with conn.cursor() as cur:
        cur.execute("SELECT is_verified FROM users WHERE username=%s;", (username,))
        row = cur.fetchone()
    if not row:
        return False
    return bool(row[0])


def get_custom_room_meta(room_name: str) -> dict | None:
    """Return custom room metadata or None if not a custom room."""
    if not room_name:
        return None
    # Must be callable from Socket.IO and janitor contexts.
    conn, from_pool = _acquire_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT name, category, subcategory, created_by, is_private, is_18_plus, is_nsfw, created_at, last_active_at
                  FROM custom_rooms
                 WHERE name = %s;
                """,
                (room_name,),
            )
            row = cur.fetchone()
    finally:
        _release_conn(conn, from_pool)
    if not row:
        return None
    return {
        "name": row[0],
        "category": row[1],
        "subcategory": row[2],
        "created_by": row[3],
        "is_private": bool(row[4]),
        "is_18_plus": bool(row[5]),
        "is_nsfw": bool(row[6]),
        "created_at": row[7],
        "last_active_at": row[8],
    }


def can_user_access_custom_room(room_name: str, username: str) -> bool:
    """Return True if user can see/join the custom room.

    Rules:
      - Public custom rooms: anyone.
      - Private custom rooms: owner or invited users only.
    """
    meta = get_custom_room_meta(room_name)
    if not meta:
        return False
    if not meta.get("is_private"):
        return True
    if username and meta.get("created_by") == username:
        return True
    if not username:
        return False
    conn, from_pool = _acquire_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT 1 FROM custom_room_invites
                 WHERE room_name=%s AND invited_user=%s
                 LIMIT 1;
                """,
                (room_name, username),
            )
            return cur.fetchone() is not None
    finally:
        _release_conn(conn, from_pool)


def touch_custom_room_activity(room_name: str) -> None:
    """Update last_active_at for a custom room (no-op for non-custom)."""
    if not room_name:
        return
    # Must be callable from Socket.IO contexts.
    conn, from_pool = _acquire_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                UPDATE custom_rooms
                   SET last_active_at = NOW()
                 WHERE name = %s;
                """,
                (room_name,),
            )
            touched = cur.rowcount
        if touched:
            conn.commit()
        else:
            conn.rollback()
    except Exception:
        try:
            conn.rollback()
        except Exception:
            pass
        raise
    finally:
        _release_conn(conn, from_pool)


def cleanup_expired_custom_rooms(idle_hours: int = 168, private_idle_hours: int | None = None) -> int:
    """Delete empty custom rooms that have been inactive beyond their TTL.

    Rooms are eligible if:
      - they exist in custom_rooms
      - they are empty (chat_rooms.member_count == 0, or missing row treated as 0)
      - their last_active_at is older than NOW() - TTL

    TTL policy:
      - public rooms use `idle_hours`
      - private rooms use `private_idle_hours` when provided (fallback: `idle_hours`)

    Returns number of deleted rooms.

    This must be callable outside of Flask request/app context (e.g. janitor).
    """
    try:
        idle_hours = int(idle_hours or 168)
    except Exception:
        idle_hours = 168
    if idle_hours <= 0:
        return 0

    try:
        priv_hours = int(private_idle_hours) if private_idle_hours is not None else idle_hours
    except Exception:
        priv_hours = idle_hours

    idle_hours = max(1, min(idle_hours, 24 * 365))
    priv_hours = max(1, min(priv_hours, 24 * 365))

    conn, from_pool = _acquire_conn()
    try:
        deleted = 0
        with conn.cursor() as cur:
            cur.execute(
                """
                WITH expired AS (
                    SELECT cr.name
                      FROM custom_rooms cr
                      LEFT JOIN chat_rooms r ON r.name = cr.name
                     WHERE COALESCE(r.member_count, 0) = 0
                       AND (
                            (cr.is_private = TRUE  AND cr.last_active_at < (NOW() - (%s || ' hours')::interval))
                         OR (cr.is_private = FALSE AND cr.last_active_at < (NOW() - (%s || ' hours')::interval))
                       )
                )
                DELETE FROM custom_room_invites i
                 WHERE i.room_name IN (SELECT name FROM expired);
                """,
                (priv_hours, idle_hours),
            )
            cur.execute(
                """
                WITH expired AS (
                    SELECT cr.name
                      FROM custom_rooms cr
                      LEFT JOIN chat_rooms r ON r.name = cr.name
                     WHERE COALESCE(r.member_count, 0) = 0
                       AND (
                            (cr.is_private = TRUE  AND cr.last_active_at < (NOW() - (%s || ' hours')::interval))
                         OR (cr.is_private = FALSE AND cr.last_active_at < (NOW() - (%s || ' hours')::interval))
                       )
                )
                DELETE FROM custom_rooms cr
                 WHERE cr.name IN (SELECT name FROM expired)
                RETURNING cr.name;
                """,
                (priv_hours, idle_hours),
            )
            rows = cur.fetchall() or []
            deleted = len(rows)
            if deleted:
                cur.execute("DELETE FROM chat_rooms WHERE name = ANY(%s);", ([r[0] for r in rows],))
        conn.commit()
        return deleted
    except Exception:
        try:
            conn.rollback()
        except Exception:
            pass
        logging.exception("cleanup_expired_custom_rooms failed")
        return 0
    finally:
        _release_conn(conn, from_pool)


# ----------------------------------------------------------------------
# Full schema creation (all tables adapted for PostgreSQL)
# ----------------------------------------------------------------------
def _create_full_schema():
    """
    Create all tables from the original SQLite schema, adapted for PostgreSQL.
    Uses SERIAL for auto-increment IDs, TIMESTAMP WITH TIME ZONE for date columns, and ON CONFLICT where needed.
    """
    conn, from_pool = _acquire_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                /* ── Core user & messaging tables ─────────────────────────── */
                CREATE TABLE IF NOT EXISTS users (
                    id                    SERIAL PRIMARY KEY,
                    username              TEXT UNIQUE NOT NULL,
                    password              TEXT NOT NULL,
                    email                 TEXT,
                    phone                 TEXT,
                    address               TEXT,
                    age                   INTEGER,
                    is_admin              BOOLEAN NOT NULL DEFAULT FALSE,
                    last_seen             TIMESTAMP WITH TIME ZONE,
                    status                TEXT DEFAULT 'active',
                    presence_status       TEXT NOT NULL DEFAULT 'online',
                    two_factor_enabled    BOOLEAN NOT NULL DEFAULT FALSE,
                    two_factor_secret     TEXT,
                    custom_status         TEXT,
                    recovery_pin_hash     TEXT,
                    recovery_pin_set_at   TIMESTAMP WITH TIME ZONE,
                    recovery_failed_attempts INTEGER NOT NULL DEFAULT 0,
                    recovery_locked_until TIMESTAMP WITH TIME ZONE,
                    bio                   TEXT,
                    avatar_url            TEXT,
                    public_key            TEXT,
                    encrypted_private_key TEXT,
                    online                BOOLEAN DEFAULT FALSE,
                    created_at            TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
                );

                /* ── Account recovery (password reset tokens) ─────────── */
                CREATE TABLE IF NOT EXISTS password_reset_tokens (
                    id          SERIAL PRIMARY KEY,
                    username    TEXT NOT NULL,
                    token_hash  TEXT UNIQUE NOT NULL,
                    created_at  TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                    expires_at  TIMESTAMP WITH TIME ZONE NOT NULL,
                    used_at     TIMESTAMP WITH TIME ZONE,
                    request_ip  TEXT,
                    user_agent  TEXT
                );

                CREATE TABLE IF NOT EXISTS messages (
                    id            SERIAL PRIMARY KEY,
                    room          TEXT,
                    sender        TEXT NOT NULL,
                    receiver      TEXT,
                    message       TEXT NOT NULL,
                    timestamp     TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                    is_encrypted  BOOLEAN DEFAULT FALSE,
                    is_read       BOOLEAN DEFAULT FALSE,
                    is_edited     BOOLEAN DEFAULT FALSE,
                    is_deleted    BOOLEAN DEFAULT FALSE
                );

                CREATE TABLE IF NOT EXISTS offline_messages (
                    id            SERIAL PRIMARY KEY,
                    sender        TEXT NOT NULL,
                    receiver      TEXT NOT NULL,
                    message       TEXT NOT NULL,
                    timestamp     TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                    delivered     BOOLEAN DEFAULT FALSE
                );

                CREATE TABLE IF NOT EXISTS pending_messages (
                    id                  SERIAL PRIMARY KEY,
                    receiver_username   TEXT NOT NULL,
                    sender_username     TEXT NOT NULL,
                    message             TEXT NOT NULL,
                    created_at          TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
                );

                CREATE TABLE IF NOT EXISTS private_messages (
                    id            SERIAL PRIMARY KEY,
                    sender        TEXT NOT NULL,
                    recipient     TEXT NOT NULL,
                    message       TEXT NOT NULL,
                    timestamp     TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
                );

                /* ── Social tables ─────────────────────────────────────────── */
                CREATE TABLE IF NOT EXISTS friend_requests (
                    id              SERIAL PRIMARY KEY,
                    from_user       TEXT NOT NULL,
                    to_user         TEXT NOT NULL,
                    request_status  TEXT DEFAULT 'pending',
                    timestamp       TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
                );

                CREATE TABLE IF NOT EXISTS friends (
                    id            SERIAL PRIMARY KEY,
                    user_id       INTEGER NOT NULL,
                    friend_id     INTEGER NOT NULL,
                    created_at    TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE(user_id, friend_id)
                );

                CREATE TABLE IF NOT EXISTS blocked_users (
                    id            SERIAL PRIMARY KEY,
                    user_id       INTEGER NOT NULL,
                    blocked_id    INTEGER NOT NULL,
                    UNIQUE(user_id, blocked_id)
                );

                CREATE TABLE IF NOT EXISTS blocks (
                    id           SERIAL PRIMARY KEY,
                    blocker      TEXT NOT NULL,
                    blocked      TEXT NOT NULL,
                    timestamp    TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
                );

                /* ── Encrypted DM file transfers (ciphertext-only) ─────────── */
                /*
                   The server never decrypts DM files.

                   Client uploads an AES-GCM ciphertext blob plus:
                     - iv_b64
                     - ek_to_b64   (AES key wrapped to recipient RSA-OAEP key)
                     - ek_from_b64 (AES key wrapped to sender RSA-OAEP key)

                   A DM "file message" is sent separately (as encrypted JSON)
                   containing file_id + display metadata.
                */
                CREATE TABLE IF NOT EXISTS dm_files (
                    file_id        TEXT PRIMARY KEY,
                    sender         TEXT NOT NULL,
                    receiver       TEXT NOT NULL,
                    original_name  TEXT NOT NULL,
                    mime_type      TEXT,
                    file_size      INTEGER NOT NULL,
                    sha256         TEXT,
                    storage_path   TEXT NOT NULL,
                    iv_b64         TEXT NOT NULL,
                    ek_to_b64      TEXT NOT NULL,
                    ek_from_b64    TEXT NOT NULL,
                    revoked        BOOLEAN DEFAULT FALSE,
                    uploaded_at    TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
                );

                CREATE INDEX IF NOT EXISTS idx_dm_files_receiver ON dm_files(receiver);
                CREATE INDEX IF NOT EXISTS idx_dm_files_sender   ON dm_files(sender);

                
                

/* ── Attachments & reactions ───────────────────────────────── */
                CREATE TABLE IF NOT EXISTS file_attachments (
                    id            SERIAL PRIMARY KEY,
                    message_id    INTEGER,
                    file_path     TEXT NOT NULL,
                    file_type     TEXT,
                    file_size     INTEGER,
                    uploaded_at   TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
                );

                CREATE TABLE IF NOT EXISTS message_reactions (
                    id            SERIAL PRIMARY KEY,
                    message_id    INTEGER NOT NULL,
                    username      TEXT NOT NULL,
                    emoji         TEXT NOT NULL,
                    reacted_at    TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE(message_id, username, emoji),
                    FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
                );

                CREATE TABLE IF NOT EXISTS message_reads (
                    id            SERIAL PRIMARY KEY,
                    message_id    INTEGER NOT NULL,
                    username      TEXT NOT NULL,
                    read_at       TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE(message_id, username),
                    FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
                );

                /* ── Notifications & settings ─────────────────────────────── */
                CREATE TABLE IF NOT EXISTS notifications (
                    id            SERIAL PRIMARY KEY,
                    user_id       INTEGER NOT NULL,
                    notification  TEXT NOT NULL,
                    type          TEXT,
                    is_read       BOOLEAN DEFAULT FALSE,
                    timestamp     TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
                );

                CREATE TABLE IF NOT EXISTS chat_settings (
                    id              SERIAL PRIMARY KEY,
                    user_id         INTEGER NOT NULL,
                    setting_name    TEXT NOT NULL,
                    setting_value   TEXT,
                    UNIQUE(user_id, setting_name)
                );

                /* ── Group / room tables ───────────────────────────────────── */
                CREATE TABLE IF NOT EXISTS groups (
                    id                SERIAL PRIMARY KEY,
                    group_name        TEXT NOT NULL,
                    group_description TEXT,
                    created_by        INTEGER NOT NULL,
                    created_at        TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
                );

                CREATE TABLE IF NOT EXISTS group_members (
                    id            SERIAL PRIMARY KEY,
                    group_id      INTEGER NOT NULL,
                    user_id       INTEGER NOT NULL,
                    role          TEXT DEFAULT 'member',
                    joined_at     TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE(group_id, user_id),
                    FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE
                );

                CREATE TABLE IF NOT EXISTS group_mutes (
                    group_id    INTEGER NOT NULL,
                    username    TEXT NOT NULL,
                    muted_at    TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                    PRIMARY KEY (group_id, username)
                );

                CREATE TABLE IF NOT EXISTS group_invites (
                    id          SERIAL PRIMARY KEY,
                    group_id    INTEGER NOT NULL,
                    from_user   TEXT NOT NULL,
                    to_user     TEXT NOT NULL,
                    sent_at     TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                    status      TEXT DEFAULT 'pending',
                    UNIQUE(group_id, to_user),
                    FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE
                );

                CREATE TABLE IF NOT EXISTS group_pins (
                    group_id    INTEGER PRIMARY KEY,
                    pinned_by   TEXT NOT NULL,
                    content     TEXT NOT NULL,
                    pinned_at   TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE
                );

                

                /* ── Encrypted Group file storage (NOT publicly served) ────── */
                CREATE TABLE IF NOT EXISTS group_files (
                    file_id        TEXT PRIMARY KEY,
                    group_id       INTEGER NOT NULL,
                    sender         TEXT NOT NULL,
                    original_name  TEXT NOT NULL,
                    mime_type      TEXT,
                    file_size      BIGINT NOT NULL,
                    sha256         TEXT,
                    storage_path   TEXT NOT NULL,
                    iv_b64         TEXT NOT NULL,
                    ek_map_json    TEXT NOT NULL,
                    revoked        BOOLEAN DEFAULT FALSE,
                    uploaded_at    TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE
                );

                CREATE INDEX IF NOT EXISTS idx_group_files_group  ON group_files(group_id);
                CREATE INDEX IF NOT EXISTS idx_group_files_sender ON group_files(sender);

                /* ── Moderation & audit ───────────────────────────────────── */
                CREATE TABLE IF NOT EXISTS user_sanctions (
                    id            SERIAL PRIMARY KEY,
                    username      TEXT NOT NULL,
                    sanction_type TEXT NOT NULL,
                    reason        TEXT,
                    created_at    TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                    expires_at    TIMESTAMP WITH TIME ZONE
                );

                CREATE TABLE IF NOT EXISTS audit_log (
                    id            SERIAL PRIMARY KEY,
                    actor         TEXT NOT NULL,
                    action        TEXT NOT NULL,
                    target        TEXT,
                    timestamp     TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                    details       TEXT
                );

                /* ── RBAC tables ──────────────────────────────────────────── */
                CREATE TABLE IF NOT EXISTS roles (
                    id      SERIAL PRIMARY KEY,
                    name    TEXT UNIQUE NOT NULL
                );

                CREATE TABLE IF NOT EXISTS permissions (
                    id      SERIAL PRIMARY KEY,
                    name    TEXT UNIQUE NOT NULL
                );

                CREATE TABLE IF NOT EXISTS role_permissions (
                    role_id       INTEGER NOT NULL,
                    permission_id INTEGER NOT NULL,
                    PRIMARY KEY (role_id, permission_id),
                    FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE CASCADE,
                    FOREIGN KEY (permission_id) REFERENCES permissions(id) ON DELETE CASCADE
                );

                CREATE TABLE IF NOT EXISTS user_roles (
                    user_id       INTEGER NOT NULL,
                    role_id       INTEGER NOT NULL,
                    PRIMARY KEY (user_id, role_id),
                    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
                    FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE CASCADE
                );

                /* ── Admin / moderation helper tables ─────────────────── */
                CREATE TABLE IF NOT EXISTS room_locks (
                    room       TEXT PRIMARY KEY,
                    locked     BOOLEAN NOT NULL DEFAULT TRUE,
                    locked_by  TEXT,
                    locked_at  TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                    reason     TEXT
                );

                CREATE TABLE IF NOT EXISTS room_readonly (
                    room      TEXT PRIMARY KEY,
                    readonly  BOOLEAN NOT NULL DEFAULT FALSE,
                    set_by    TEXT,
                    set_at    TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
                );

                CREATE TABLE IF NOT EXISTS room_slowmode (
                    room      TEXT PRIMARY KEY,
                    seconds   INTEGER NOT NULL DEFAULT 0,
                    set_by    TEXT,
                    set_at    TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
                );

                CREATE TABLE IF NOT EXISTS user_quotas (
                    username           TEXT PRIMARY KEY,
                    messages_per_hour  INTEGER NOT NULL DEFAULT 60,
                    updated_at         TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
                );

                /* ── Auth token store (refresh rotation + revocation) ────── */
                /*
                   We persist *issued* JWT JTIs so we can:
                    - rotate refresh tokens on every refresh (single-use refresh)
                    - detect refresh token replay/reuse
                    - revoke tokens on logout / password change / admin action

                   Notes:
                    - Access tokens are short-lived but still stored so logout can
                      revoke them immediately.
                    - A refresh token is considered ACTIVE only if:
                        revoked_at IS NULL AND replaced_by IS NULL
                */
                
                /* ── Auth sessions (device/session tracking) ─────────── */
                CREATE TABLE IF NOT EXISTS auth_sessions (
                    session_id  TEXT PRIMARY KEY,
                    username    TEXT NOT NULL,
                    created_at  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
	                    last_seen_at TIMESTAMP WITH TIME ZONE,
	                    last_activity_at TIMESTAMP WITH TIME ZONE,
                    revoked_at  TIMESTAMP WITH TIME ZONE,
                    revoked_reason TEXT,
                    user_agent  TEXT,
                    ip_address  TEXT
                );

                CREATE INDEX IF NOT EXISTS idx_auth_sessions_username ON auth_sessions(username);
                CREATE INDEX IF NOT EXISTS idx_auth_sessions_revoked  ON auth_sessions(revoked_at);

CREATE TABLE IF NOT EXISTS auth_tokens (
                    jti         TEXT PRIMARY KEY,
                    username    TEXT NOT NULL,
                    session_id  TEXT,
                    token_type  TEXT NOT NULL,
                    created_at  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    expires_at  TIMESTAMP WITH TIME ZONE,
                    revoked_at  TIMESTAMP WITH TIME ZONE,
                    replaced_by TEXT,
                    last_used_at TIMESTAMP WITH TIME ZONE,
                    user_agent  TEXT,
                    ip_address  TEXT
                );

                /*
                   Back-compat / partial-schema safety:
                   If an older DB already has an auth_tokens table without
                   the new session_id column, CREATE TABLE IF NOT EXISTS is a
                   no-op. Ensure the column exists before creating indexes or
                   writing tokens.
                */
                ALTER TABLE auth_tokens
                    ADD COLUMN IF NOT EXISTS session_id TEXT;

                CREATE INDEX IF NOT EXISTS idx_auth_tokens_username ON auth_tokens(username);
                CREATE INDEX IF NOT EXISTS idx_auth_tokens_expires  ON auth_tokens(expires_at);
                CREATE INDEX IF NOT EXISTS idx_auth_tokens_session  ON auth_tokens(session_id);

                /* chat_rooms handled in ensure_chat_rooms_table() */
                """
            )
        conn.commit()
    finally:
        _release_conn(conn, from_pool)


import base64
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.hazmat.primitives import serialization, hashes
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.backends import default_backend

def _pbkdf2_key(password: str, salt: bytes, iterations: int = 390_000, length: int = 32) -> bytes:
    """PBKDF2-HMAC-SHA256 key derivation (used for client-compatible key wrapping)."""
    kdf = PBKDF2HMAC(
        algorithm=hashes.SHA256(),
        length=length,
        salt=salt,
        iterations=iterations,
        backend=default_backend(),
    )
    return kdf.derive(password.encode("utf-8"))


_E2EE_KEYBLOB_AAD = b"echochat:keyblob:v2"


def _encrypt_private_key_v2(private_pem_bytes: bytes, raw_password: str) -> str:
    """Encrypt a PKCS8 private key PEM using PBKDF2->AES-256-GCM (client-compatible).

    Format:
      v2:<salt_b64>:<nonce_b64>:<cipher_b64>

    Where cipher_b64 contains ciphertext||tag (standard AESGCM output).
    """
    salt = os.urandom(16)
    nonce = os.urandom(12)  # AES-GCM recommended nonce size
    key = _pbkdf2_key(raw_password, salt, iterations=390_000, length=32)
    aes = AESGCM(key)
    ct = aes.encrypt(nonce, private_pem_bytes, _E2EE_KEYBLOB_AAD)
    return "v2:" + ":".join([
        base64.b64encode(salt).decode("utf-8"),
        base64.b64encode(nonce).decode("utf-8"),
        base64.b64encode(ct).decode("utf-8"),
    ])


def _decrypt_private_key_blob(raw_password: str, encrypted_blob: str) -> bytes:
    """Decrypt user encrypted_private_key.

    Supports:
      - v2: PBKDF2->AES-256-GCM (v2:<salt>:<nonce>:<cipher>)
      - legacy v1: PBKDF2->XOR (salt:cipher)  (no prefix)
    """
    if not encrypted_blob:
        raise ValueError("empty key blob")

    # v2 (AES-GCM)
    if encrypted_blob.startswith("v2:"):
        parts = encrypted_blob.split(":")
        if len(parts) != 4:
            raise ValueError("invalid v2 key blob format")
        _, salt_b64, nonce_b64, cipher_b64 = parts
        salt = base64.b64decode(salt_b64)
        nonce = base64.b64decode(nonce_b64)
        ct = base64.b64decode(cipher_b64)
        key = _pbkdf2_key(raw_password, salt, iterations=390_000, length=32)
        aes = AESGCM(key)
        return aes.decrypt(nonce, ct, _E2EE_KEYBLOB_AAD)

    # legacy v1 (XOR)
    salt_b64, cipher_b64 = encrypted_blob.split(":", 1)
    salt = base64.b64decode(salt_b64)
    encrypted_priv = base64.b64decode(cipher_b64)

    derived_key = _pbkdf2_key(raw_password, salt, iterations=390_000, length=32)
    key_repeated = derived_key * (len(encrypted_priv) // len(derived_key) + 1)
    plain = bytes(a ^ b for a, b in zip(encrypted_priv, key_repeated))
    return plain


def _generate_and_encrypt_rsa_keypair(raw_password: str):
    """Generate a 2048-bit RSA keypair and encrypt the private key for browser unlock.

    Returns:
      (public_pem_str, encrypted_private_key_str)

    encrypted_private_key_str is versioned:
      - v2:<salt_b64>:<nonce_b64>:<cipher_b64>  (PBKDF2->AES-256-GCM)
      - legacy: <salt_b64>:<cipher_b64>         (PBKDF2->XOR)  [only for back-compat]
    """
    # 1) Generate RSA keypair
    private_key_obj = rsa.generate_private_key(
        public_exponent=65537,
        key_size=2048,
        backend=default_backend(),
    )
    public_key_obj = private_key_obj.public_key()

    # 2) Serialize public key to PEM (UTF-8 text)
    public_pem = public_key_obj.public_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PublicFormat.SubjectPublicKeyInfo,
    ).decode("utf-8")

    # 3) Serialize private key to raw PEM bytes (no encryption)
    private_pem_bytes = private_key_obj.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    )

    # 4) Encrypt for storage (v2)
    encrypted_blob = _encrypt_private_key_v2(private_pem_bytes, raw_password)
    return public_pem, encrypted_blob


def generate_user_keypair_for_password(raw_password: str) -> tuple[str, str]:
    """Generate a fresh RSA keypair and encrypt the private key under raw_password.

    Returns (public_pem, encrypted_private_key_blob).

    NOTE: This is used during password resets because the encrypted private key
    is derived from the user password; without the old password we cannot re-encrypt
    the existing private key.
    """
    return _generate_and_encrypt_rsa_keypair(raw_password)


def create_user_with_keys(
    conn,
    username: str,
    raw_password: str,
    password_hash: str,
    email: str = None,
    phone: str = None,
    address: str = None,
    age: int = None,
    is_admin: bool = False,
    recovery_pin_hash: str | None = None,
    recovery_pin_set_at: datetime | None = None,
) -> None:
    """
    Generate an RSA keypair for this user, encrypt the private key under raw_password,
    then INSERT a new row into users(
        username, password, email, phone, address, age, is_admin,
        public_key, encrypted_private_key,
        recovery_pin_hash, recovery_pin_set_at
    ).
    `conn` must be a psycopg2 connection. Raises on any constraint violation.
    """
    public_pem, encrypted_priv_b64 = _generate_and_encrypt_rsa_keypair(raw_password)

    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO users
              (username, password, email, phone, address, age, is_admin,
               public_key, encrypted_private_key,
               recovery_pin_hash, recovery_pin_set_at)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s);
            """,
            (
                username,
                password_hash,       # goes into “password” column
                email,
                phone,
                address,
                age,
                is_admin,
                public_pem,
                encrypted_priv_b64,
                recovery_pin_hash,
                recovery_pin_set_at,
            ),
        )
    conn.commit()


def get_public_key_for_username(conn, username: str) -> str:
    """
    Return the PEM string of public_key for `username`, or None if user doesn’t exist.
    """
    with conn.cursor() as cur:
        cur.execute(
            "SELECT public_key FROM users WHERE username = %s;",
            (username,)
        )
        row = cur.fetchone()
    return row[0] if row else None



def user_exists(conn, username: str) -> bool:
    with conn.cursor() as cur:
        cur.execute("SELECT 1 FROM users WHERE username = %s LIMIT 1;", (username,))
        return cur.fetchone() is not None


def email_in_use(conn, email: str, exclude_user_id: int | None = None) -> bool:
    """Return True if `email` is already in use (case-insensitive).

    This is a *friendly* pre-check used by routes to return a clear 409
    before hitting a database uniqueness constraint.

    Notes:
      - Treats blank/None emails as "not in use" (caller should validate).
      - Uses LOWER(email) for case-insensitive matching.
    """
    if not email:
        return False
    email = str(email).strip()
    if not email:
        return False

    with conn.cursor() as cur:
        if exclude_user_id is not None:
            cur.execute(
                "SELECT 1 FROM users WHERE LOWER(email) = LOWER(%s) AND id <> %s LIMIT 1;",
                (email, int(exclude_user_id)),
            )
        else:
            cur.execute(
                "SELECT 1 FROM users WHERE LOWER(email) = LOWER(%s) LIMIT 1;",
                (email,),
            )
        return cur.fetchone() is not None


def ensure_user_has_keys(conn, username: str, raw_password: str) -> bool:
    """Ensure an existing user row has (public_key, encrypted_private_key).

    Returns True if user exists (and now has keys), False if user does not exist.

    Also opportunistically migrates legacy key blobs:
      - legacy v1: salt_b64:cipher_b64 (PBKDF2->XOR)
      - v2: v2:salt_b64:nonce_b64:cipher_b64 (PBKDF2->AES-256-GCM)
    """
    with conn.cursor() as cur:
        cur.execute(
            "SELECT public_key, encrypted_private_key FROM users WHERE username = %s;",
            (username,),
        )
        row = cur.fetchone()

    if not row:
        return False

    public_key, encrypted_priv = row[0], row[1]

    # If keys exist, validate that the blob can be decrypted with the *current* password.
    # Why: admin password resets (or manual password edits) can change the login password
    # without re-wrapping the E2EE private key. That makes login succeed but DM unlock fail.
    #
    # Behavior:
    #   - If decrypt succeeds and blob is legacy v1 -> upgrade to v2.
    #   - If decrypt fails (but login already succeeded) -> rotate E2EE keys to match password.
    if public_key and encrypted_priv:
        blob = str(encrypted_priv)
        try:
            plain = _decrypt_private_key_blob(raw_password, blob)
            # Opportunistic upgrade: v1 XOR -> v2 AES-GCM
            if not blob.startswith("v2:"):
                upgraded = _encrypt_private_key_v2(plain, raw_password)
                with conn.cursor() as cur:
                    cur.execute(
                        "UPDATE users SET encrypted_private_key = %s WHERE username = %s;",
                        (upgraded, username),
                    )
                conn.commit()
            return True
        except Exception as e:
            logging.warning(
                "encrypted_private_key mismatch/corruption for %s (will rotate keys): %s",
                username,
                e,
            )
            try:
                public_pem, encrypted_priv_blob = _generate_and_encrypt_rsa_keypair(raw_password)
                with conn.cursor() as cur:
                    cur.execute(
                        "UPDATE users SET public_key = %s, encrypted_private_key = %s WHERE username = %s;",
                        (public_pem, encrypted_priv_blob, username),
                    )
                conn.commit()
            except Exception as e2:
                try:
                    conn.rollback()
                except Exception:
                    pass
                logging.error("Failed rotating E2EE keys for %s: %s", username, e2)
            return True

    public_pem, encrypted_priv_blob = _generate_and_encrypt_rsa_keypair(raw_password)
    with conn.cursor() as cur:
        cur.execute(
            "UPDATE users SET public_key = %s, encrypted_private_key = %s WHERE username = %s;",
            (public_pem, encrypted_priv_blob, username),
        )
    conn.commit()
    return True

def get_encrypted_private_key_for_username(conn, username: str) -> str:
    """
    Return the TEXT value of encrypted_private_key.

    Formats:
      - v2:<salt_b64>:<nonce_b64>:<cipher_b64>   (PBKDF2->AES-256-GCM)
      - legacy: <salt_b64>:<cipher_b64>          (PBKDF2->XOR)
    for `username`, or None if no such user.
    """
    with conn.cursor() as cur:
        cur.execute(
            "SELECT encrypted_private_key FROM users WHERE username = %s;",
            (username,)
        )
        row = cur.fetchone()
    return row[0] if row else None


# ----------------------------------------------------------------------
# RBAC seeding
# ----------------------------------------------------------------------
def _seed_roles_permissions():
    """
    Insert default roles and permissions, then map them.
    """
    conn, from_pool = _acquire_conn()
    try:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            roles = ["admin", "moderator", "viewer"]
            perms = [
                "admin:super", "admin:basic", "admin:assign_role", "admin:manage_roles",
                "admin:ban_ip", "admin:reset_password", "admin:logout_user",
                "moderation:mute_user", "moderation:kick_user", "moderation:ban_room",
                "moderation:suspend_user", "moderation:shadowban",
                "room:lock", "room:readonly",
                "room:delete",
                "user:delete_self", "user:edit_profile"
            ]

            for r in roles:
                cur.execute(
                    "INSERT INTO roles (name) VALUES (%s) ON CONFLICT (name) DO NOTHING;",
                    (r,)
                )

            for p in perms:
                cur.execute(
                    "INSERT INTO permissions (name) VALUES (%s) ON CONFLICT (name) DO NOTHING;",
                    (p,)
                )

            cur.execute("SELECT id, name FROM roles;")
            role_map = {row["name"]: row["id"] for row in cur.fetchall()}

            cur.execute("SELECT id, name FROM permissions;")
            perm_map = {row["name"]: row["id"] for row in cur.fetchall()}

            def map_role_perm(role_name: str, perm_name: str):
                cur.execute(
                    """
                    INSERT INTO role_permissions (role_id, permission_id)
                    VALUES (%s, %s)
                    ON CONFLICT (role_id, permission_id) DO NOTHING;
                    """,
                    (role_map[role_name], perm_map[perm_name])
                )

            for p in perms:
                map_role_perm("admin", p)

            for p in ("moderation:mute_user", "moderation:kick_user",
                      "moderation:ban_room", "room:readonly"):
                map_role_perm("moderator", p)

            map_role_perm("viewer", "user:edit_profile")

        conn.commit()
    finally:
        _release_conn(conn, from_pool)


# ----------------------------------------------------------------------
# Database initialization sequence
# ----------------------------------------------------------------------
def init_database():
    """
    Create or patch the entire schema and seed initial data.
    Called once at application startup.
    """
    logging.info("🔧  Initialising DB…")
    # 1) Create all tables if missing
    _create_full_schema()

    # 2) Patch any missing columns/tables
    conn = get_db()
    ensure_online_column()
    ensure_presence_columns()
    ensure_chat_rooms_table()
    ensure_users_key_columns()
    ensure_user_verified_column()
    ensure_account_recovery_schema()
    ensure_auth_session_schema()
    ensure_custom_rooms_schema()
    ensure_room_message_expiry_schema()

    # 3) RBAC seeding and room preload
    _seed_roles_permissions()
    load_rooms_from_json()

    logging.info("✅  DB ready at %s", redact_postgres_dsn(get_db_connection_string()))


def get_db_identity() -> dict:
    """Return runtime identity information for the current DB connection.

    Helps detect 'wrong database / wrong role' mistakes quickly.
    """
    conn = get_db()
    out = {
        "current_user": None,
        "current_database": None,
        "server_addr": None,
        "server_port": None,
        "server_version": None,
    }
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT current_user, current_database(), inet_server_addr(), inet_server_port(), version();"
            )
            row = cur.fetchone()
        if row:
            out["current_user"] = row[0]
            out["current_database"] = row[1]
            out["server_addr"] = str(row[2]) if row[2] is not None else None
            out["server_port"] = int(row[3]) if row[3] is not None else None
            out["server_version"] = str(row[4]) if row[4] is not None else None
    except Exception as exc:
        out["error"] = str(exc)
    return out


def get_schema_version() -> str:
    """Best-effort schema version string.

    EchoChat currently patches schema via init_database() rather than migrations.
    If a future migrations table exists, read from it; otherwise return 'legacy'.
    """
    conn = get_db()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT to_regclass('public.echochat_schema_meta');")
            row = cur.fetchone()
            reg = row[0] if row else None
            if reg:
                cur.execute("SELECT version FROM echochat_schema_meta ORDER BY applied_at DESC LIMIT 1;")
                r2 = cur.fetchone()
                if r2 and r2[0]:
                    return str(r2[0])
            # Fallback: count public tables as a simple fingerprint
            cur.execute(
                "SELECT count(*) FROM pg_tables WHERE schemaname='public';"
            )
            n_tables = cur.fetchone()[0]
        return f"legacy (no migrations table; public tables={n_tables})"
    except Exception as exc:
        return f"unknown ({exc})"


# ----------------------------------------------------------------------
# Auth token store helpers (refresh rotation + revocation)
# ----------------------------------------------------------------------

def store_auth_token(
    jti: str,
    username: str,
    token_type: str,
    expires_at: datetime | None,
    session_id: str | None = None,
    user_agent: str | None = None,
    ip_address: str | None = None,
) -> None:
    """Persist an issued JWT's JTI.

    We store both access and refresh tokens. Access tokens are short-lived but
    storing them allows immediate logout revocation.
    """
    if not jti or not username or not token_type:
        return

    conn = get_db()
    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO auth_tokens (jti, username, session_id, token_type, expires_at, user_agent, ip_address)
            VALUES (%s, %s, %s, %s, %s, %s, %s)
            ON CONFLICT (jti) DO NOTHING;
            """,
            (jti, username, session_id, token_type, expires_at, user_agent, ip_address),
        )
    conn.commit()


def revoke_auth_token(jti: str) -> None:
    """Revoke a specific token by JTI."""
    if not jti:
        return
    conn = get_db()
    with conn.cursor() as cur:
        cur.execute(
            """
            UPDATE auth_tokens
               SET revoked_at = COALESCE(revoked_at, CURRENT_TIMESTAMP)
             WHERE jti = %s;
            """,
            (jti,),
        )
    conn.commit()


def revoke_all_tokens_for_user(username: str, token_type: str | None = None) -> None:
    """Revoke all tokens for a user (optionally filtered by type)."""
    if not username:
        return
    conn = get_db()
    with conn.cursor() as cur:
        if token_type:
            cur.execute(
                """
                UPDATE auth_tokens
                   SET revoked_at = COALESCE(revoked_at, CURRENT_TIMESTAMP)
                 WHERE username = %s
                   AND token_type = %s
                   AND revoked_at IS NULL;
                """,
                (username, token_type),
            )
        else:
            cur.execute(
                """
                UPDATE auth_tokens
                   SET revoked_at = COALESCE(revoked_at, CURRENT_TIMESTAMP)
                 WHERE username = %s
                   AND revoked_at IS NULL;
                """,
                (username,),
            )
    conn.commit()


def is_auth_token_revoked(jti: str) -> bool:
    """Return True if an issued token should be treated as revoked.

    IMPORTANT SECURITY BEHAVIOR:
      - If we *don't* have a DB record for a JTI, we treat it as revoked.
      - We also treat server-side expiry as revoked (defense in depth).
      - If the token is associated with a revoked session, it is revoked.
    """
    if not jti:
        return True

    conn = get_db()
    now = datetime.now(timezone.utc)
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT t.revoked_at, t.expires_at, t.session_id, s.revoked_at
              FROM auth_tokens t
              LEFT JOIN auth_sessions s
                     ON s.session_id = t.session_id
             WHERE t.jti = %s;
            """,
            (jti,),
        )
        row = cur.fetchone()

    # Unknown JTI => reject.
    if not row:
        return True

    revoked_at, expires_at, session_id, session_revoked_at = row
    if revoked_at is not None:
        return True
    if expires_at is not None and expires_at <= now:
        return True

    # If the token is session-bound, the session must exist and be active.
    if session_id:
        if session_revoked_at is not None:
            return True
        if session_revoked_at is None:
            # session_revoked_at None could still be because the LEFT JOIN didn't match.
            # Fail closed if session row is missing.
            # (We can't distinguish missing vs active without a separate select, so do one.)
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT revoked_at FROM auth_sessions WHERE session_id = %s;",
                    (session_id,),
                )
                srow = cur.fetchone()
            if not srow:
                return True
            if srow[0] is not None:
                return True

    return False



# ----------------------------------------------------------------------
# Auth session helpers (device/session tracking)
# ----------------------------------------------------------------------

import uuid


def create_auth_session(username: str, user_agent: str | None = None, ip_address: str | None = None) -> str:
    """Create a new auth session and return session_id."""
    if not username:
        raise ValueError("username required")
    sid = uuid.uuid4().hex
    conn = get_db()
    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO auth_sessions (session_id, username, last_seen_at, last_activity_at, user_agent, ip_address)
            VALUES (%s, %s, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, %s, %s)
            ON CONFLICT (session_id) DO NOTHING;
            """,
            (sid, username, user_agent, ip_address),
        )
    conn.commit()
    return sid


def touch_auth_session(session_id: str) -> None:
    """Update last_seen_at for a session."""
    if not session_id:
        return
    conn = get_db()
    with conn.cursor() as cur:
        cur.execute(
            """
            UPDATE auth_sessions
               SET last_seen_at = CURRENT_TIMESTAMP
             WHERE session_id = %s
               AND revoked_at IS NULL;
            """,
            (session_id,),
        )
    conn.commit()


def touch_auth_session_activity(session_id: str) -> None:
    """Update last_activity_at for a session (used for idle timeout)."""
    if not session_id:
        return
    conn = get_db()
    with conn.cursor() as cur:
        cur.execute(
            """
            UPDATE auth_sessions
               SET last_activity_at = CURRENT_TIMESTAMP
             WHERE session_id = %s
               AND revoked_at IS NULL;
            """,
            (session_id,),
        )
    conn.commit()


def is_auth_session_active(
    session_id: str,
    username: str | None = None,
    max_idle_seconds: float | None = None,
) -> bool:
    """Return True if session exists, is not revoked, and (optionally) not idle."""
    if not session_id:
        return False
    conn = get_db()
    with conn.cursor() as cur:
        if username:
            cur.execute(
                """
                SELECT revoked_at,
                       COALESCE(last_activity_at, last_seen_at, created_at) AS last_act
                  FROM auth_sessions
                 WHERE session_id = %s AND username = %s;
                """,
                (session_id, username),
            )
        else:
            cur.execute(
                """
                SELECT revoked_at,
                       COALESCE(last_activity_at, last_seen_at, created_at) AS last_act
                  FROM auth_sessions
                 WHERE session_id = %s;
                """,
                (session_id,),
            )
        row = cur.fetchone()
    if not row:
        return False
    revoked_at, last_act = row[0], row[1]
    if revoked_at is not None:
        return False

    # Idle timeout is enforced on client-activity, not on background refresh/polling.
    if max_idle_seconds and max_idle_seconds > 0 and last_act is not None:
        from datetime import datetime, timezone

        now = datetime.now(timezone.utc)
        idle_s = (now - last_act).total_seconds()
        if idle_s > max_idle_seconds:
            return False

    return True


def get_auth_session_state(session_id: str):
    """Return minimal session timing info for UX/reason codes."""
    if not session_id:
        return None
    conn = get_db()
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT
              revoked_at,
              created_at,
              last_seen_at,
              COALESCE(last_activity_at, last_seen_at, created_at) AS last_activity
            FROM auth_sessions
            WHERE session_id = %s
            """,
            (session_id,),
        )
        row = cur.fetchone()
    if not row:
        return None
    revoked_at, created_at, last_seen_at, last_activity = row
    return {
        "revoked_at": revoked_at,
        "created_at": created_at,
        "last_seen_at": last_seen_at,
        "last_activity": last_activity,
    }


def get_session_id_for_token(jti: str) -> str | None:
    """Return the session_id bound to a token JTI, if any."""
    if not jti:
        return None
    conn = get_db()
    with conn.cursor() as cur:
        cur.execute("SELECT session_id FROM auth_tokens WHERE jti = %s;", (jti,))
        row = cur.fetchone()
    return row[0] if row else None


def attach_session_to_token(username: str, jti: str, session_id: str) -> None:
    """Bind an existing token row to a session_id (used for legacy tokens)."""
    if not username or not jti or not session_id:
        return
    conn = get_db()
    with conn.cursor() as cur:
        cur.execute(
            """
            UPDATE auth_tokens
               SET session_id = %s
             WHERE jti = %s
               AND username = %s
               AND session_id IS NULL;
            """,
            (session_id, jti, username),
        )
    conn.commit()


def revoke_auth_session(session_id: str, reason: str | None = None) -> None:
    """Revoke a session and all tokens bound to it."""
    if not session_id:
        return
    conn = get_db()
    with conn.cursor() as cur:
        cur.execute(
            """
            UPDATE auth_sessions
               SET revoked_at = COALESCE(revoked_at, CURRENT_TIMESTAMP),
                   revoked_reason = COALESCE(revoked_reason, %s)
             WHERE session_id = %s;
            """,
            (reason, session_id),
        )
        cur.execute(
            """
            UPDATE auth_tokens
               SET revoked_at = COALESCE(revoked_at, CURRENT_TIMESTAMP)
             WHERE session_id = %s
               AND revoked_at IS NULL;
            """,
            (session_id,),
        )
    conn.commit()


def revoke_other_sessions_for_user(username: str, keep_session_id: str, reason: str | None = "logout_others") -> int:
    """Revoke all sessions for a user except keep_session_id. Returns number of sessions revoked."""
    if not username or not keep_session_id:
        return 0
    conn = get_db()
    with conn.cursor() as cur:
        cur.execute(
            """
            UPDATE auth_sessions
               SET revoked_at = COALESCE(revoked_at, CURRENT_TIMESTAMP),
                   revoked_reason = COALESCE(revoked_reason, %s)
             WHERE username = %s
               AND session_id <> %s
               AND revoked_at IS NULL;
            """,
            (reason, username, keep_session_id),
        )
        revoked_sessions = cur.rowcount

        cur.execute(
            """
            UPDATE auth_tokens
               SET revoked_at = COALESCE(revoked_at, CURRENT_TIMESTAMP)
             WHERE username = %s
               AND session_id <> %s
               AND revoked_at IS NULL;
            """,
            (username, keep_session_id),
        )
    conn.commit()
    return int(revoked_sessions or 0)


def revoke_all_sessions_for_user(username: str, reason: str | None = "logout_all") -> int:
    """Revoke all sessions + tokens for a user. Returns number of sessions revoked."""
    if not username:
        return 0
    conn = get_db()
    with conn.cursor() as cur:
        cur.execute(
            """
            UPDATE auth_sessions
               SET revoked_at = COALESCE(revoked_at, CURRENT_TIMESTAMP),
                   revoked_reason = COALESCE(revoked_reason, %s)
             WHERE username = %s
               AND revoked_at IS NULL;
            """,
            (reason, username),
        )
        revoked_sessions = cur.rowcount

        cur.execute(
            """
            UPDATE auth_tokens
               SET revoked_at = COALESCE(revoked_at, CURRENT_TIMESTAMP)
             WHERE username = %s
               AND revoked_at IS NULL;
            """,
            (username,),
        )
    conn.commit()
    return int(revoked_sessions or 0)


def list_auth_sessions(username: str) -> list[dict]:
    """List sessions for a user (most recent first)."""
    if not username:
        return []
    conn = get_db()
    with conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute(
            """
            SELECT session_id, created_at, last_seen_at, revoked_at, revoked_reason, user_agent, ip_address
              FROM auth_sessions
             WHERE username = %s
             ORDER BY COALESCE(last_seen_at, created_at) DESC;
            """,
            (username,),
        )
        rows = cur.fetchall() or []
    return [dict(r) for r in rows]




def revoke_all_tokens_global() -> None:
    """Revoke *all* tokens for *all* users (used only when explicitly enabled).

    This can be useful if you want "server restart forces re-login" behavior.
    """
    conn = get_db()
    with conn.cursor() as cur:
        cur.execute(
            """
            UPDATE auth_tokens
               SET revoked_at = COALESCE(revoked_at, CURRENT_TIMESTAMP)
             WHERE revoked_at IS NULL;
            """
        )
    conn.commit()


def is_refresh_token_active(username: str, jti: str) -> bool:
    """A refresh token is ACTIVE only if it exists and is not revoked/replaced.

    Additionally:
      - if the token is associated to a session_id, that session must be active
        (revoked_at IS NULL).
    """
    if not username or not jti:
        return False
    conn = get_db()
    now = datetime.now(timezone.utc)
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT revoked_at, replaced_by, expires_at, session_id
              FROM auth_tokens
             WHERE jti = %s
               AND username = %s
               AND token_type = 'refresh';
            """,
            (jti, username),
        )
        row = cur.fetchone()
    if not row:
        return False
    revoked_at, replaced_by, expires_at, session_id = row
    if revoked_at is not None:
        return False
    if replaced_by is not None:
        return False
    if expires_at is not None and expires_at <= now:
        return False

    if session_id:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT revoked_at FROM auth_sessions WHERE session_id = %s AND username = %s;",
                (session_id, username),
            )
            srow = cur.fetchone()
        # If we can't find the session row, fail closed (forces re-login).
        if not srow:
            return False
        if srow[0] is not None:
            return False

    return True


def get_refresh_token_meta(username: str, jti: str):
    """Return (revoked_at, replaced_by, expires_at, last_used_at, session_id) or None."""
    if not username or not jti:
        return None
    conn = get_db()
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT revoked_at, replaced_by, expires_at, last_used_at, session_id
              FROM auth_tokens
             WHERE jti = %s
               AND username = %s
               AND token_type = 'refresh';
            """,
            (jti, username),
        )
        row = cur.fetchone()
    return row


def is_refresh_token_usable(username: str, jti: str) -> bool:
    """Refresh token is *usable* if it exists, not explicitly revoked, and unexpired.

    NOTE:
      - This does **not** require replaced_by to be NULL. We intentionally allow
        rotated refresh tokens to reach /token/refresh so the endpoint can
        respond gracefully (race) or hard-kill (replay).
      - If the token is bound to a session_id, the session must be active.
    """
    meta = get_refresh_token_meta(username, jti)
    if not meta:
        return False
    revoked_at, _replaced_by, expires_at, _last_used_at, session_id = meta
    if revoked_at is not None:
        return False
    now = datetime.now(timezone.utc)
    if expires_at is not None and expires_at <= now:
        return False

    if session_id:
        conn = get_db()
        with conn.cursor() as cur:
            cur.execute(
                "SELECT revoked_at FROM auth_sessions WHERE session_id = %s AND username = %s;",
                (session_id, username),
            )
            srow = cur.fetchone()
        if not srow:
            return False
        if srow[0] is not None:
            return False

    return True


def rotate_refresh_token(
    username: str,
    old_jti: str,
    new_jti: str,
    new_expires_at: datetime | None,
    session_id: str | None = None,
    user_agent: str | None = None,
    ip_address: str | None = None,
) -> bool:
    """Single-use refresh rotation (session-aware).

    Returns True if rotation succeeded, False if the old token was not ACTIVE.

    If session_id is None, we will copy the old token's session_id (if present).
    """
    if not username or not old_jti or not new_jti:
        return False

    conn = get_db()
    with conn.cursor() as cur:
        # Copy session_id from old token unless explicitly provided.
        if session_id is None:
            cur.execute(
                """
                SELECT session_id
                  FROM auth_tokens
                 WHERE jti = %s
                   AND username = %s
                   AND token_type = 'refresh';
                """,
                (old_jti, username),
            )
            row = cur.fetchone()
            session_id = row[0] if row else None

        cur.execute(
            """
            UPDATE auth_tokens
               SET replaced_by = %s,
                   last_used_at = CURRENT_TIMESTAMP
             WHERE jti = %s
               AND username = %s
               AND token_type = 'refresh'
               AND revoked_at IS NULL
               AND replaced_by IS NULL;
            """,
            (new_jti, old_jti, username),
        )
        updated = cur.rowcount

        if updated != 1:
            conn.rollback()
            return False

        cur.execute(
            """
            INSERT INTO auth_tokens (jti, username, session_id, token_type, expires_at, user_agent, ip_address)
            VALUES (%s, %s, %s, 'refresh', %s, %s, %s)
            ON CONFLICT (jti) DO NOTHING;
            """,
            (new_jti, username, session_id, new_expires_at, user_agent, ip_address),
        )
    conn.commit()
    return True


def touch_auth_token(jti: str) -> None:
    """Update last_used_at for a token."""
    if not jti:
        return
    conn = get_db()
    with conn.cursor() as cur:
        cur.execute(
            """
            UPDATE auth_tokens
               SET last_used_at = CURRENT_TIMESTAMP
             WHERE jti = %s;
            """,
            (jti,),
        )
    conn.commit()


# ----------------------------------------------------------------------
# Public helper queries
# ----------------------------------------------------------------------
def get_friends_for_user(username: str) -> list[str]:
    """
    Return a list of accepted friends for the given username.
    """
    conn = get_db()
    friends: list[str] = []
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT DISTINCT
                CASE
                    WHEN from_user = %s THEN to_user
                    ELSE from_user
                END AS friend
              FROM friend_requests
             WHERE (from_user = %s OR to_user = %s)
               AND request_status = 'accepted';
            """,
            (username, username, username)
        )
        for row in cur.fetchall():
            friend_name = row[0]
            if friend_name and friend_name != username:
                friends.append(friend_name)
    return friends


def get_all_rooms():
    """Return a list of all chat rooms, ordered by name.

    Uses the global pool when available.
    """
    conn, from_pool = _acquire_conn()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT name, member_count FROM chat_rooms ORDER BY name;")
            rows = cur.fetchall()
        return [{"name": row[0], "member_count": int(row[1] or 0), "members": int(row[1] or 0)} for row in rows]
    except Exception as e:
        logging.error("get_all_rooms() failed: %s", str(e))
        return []
    finally:
        _release_conn(conn, from_pool)


def create_room_if_missing(room: str):
    """
    Insert a room with member_count=0 if it does not already exist.
    """
    # Use pooled connections; this can be called from Socket.IO contexts.
    conn, from_pool = _acquire_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO chat_rooms (name, member_count, created_by, last_active_at)
                VALUES (%s, 0, 'system', NOW())
                ON CONFLICT (name) DO NOTHING;
                """,
                (room,),
            )
        conn.commit()
    except Exception:
        try:
            conn.rollback()
        except Exception:
            pass
        logging.exception("create_room_if_missing failed (room=%s)", room)
    finally:
        _release_conn(conn, from_pool)


def create_autoscaled_room_if_missing(room: str, base_room: str):
    """Create an autoscaled room shard.

    Marks created_by='autoscaler' so janitor can safely delete it when idle.
    """
    conn, from_pool = _acquire_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO chat_rooms (name, member_count, created_by, last_active_at)
                VALUES (%s, 0, 'autoscaler', NOW())
                ON CONFLICT (name) DO NOTHING;
                """,
                (room,),
            )
        conn.commit()
    except Exception:
        try:
            conn.rollback()
        except Exception:
            pass
        logging.exception("create_autoscaled_room_if_missing failed (room=%s base=%s)", room, base_room)
    finally:
        _release_conn(conn, from_pool)


def increment_room_count(room: str, delta: int):
    """
    Add 'delta' (which may be negative) to member_count for a given room,
    ensuring the result does not go below 0.

    IMPORTANT:
      This helper is called from Socket.IO event handlers, disconnect handlers,
      and background-ish contexts where Flask's request/app context may not be
      present. Therefore it must NOT rely on flask.g / get_db().
    """
    conn, from_pool = _acquire_conn()
    try:
        with conn.cursor() as cur:
            if int(delta) > 0:
                cur.execute(
                    """
                    UPDATE chat_rooms
                       SET member_count = GREATEST(member_count + %s, 0),
                           last_active_at = NOW()
                     WHERE name = %s;
                    """,
                    (delta, room),
                )
            else:
                cur.execute(
                    """
                    UPDATE chat_rooms
                       SET member_count = GREATEST(member_count + %s, 0)
                     WHERE name = %s;
                    """,
                    (delta, room),
                )
        conn.commit()
    except Exception:
        try:
            conn.rollback()
        except Exception:
            pass
        logging.exception("increment_room_count failed (room=%s delta=%s)", room, delta)
    finally:
        _release_conn(conn, from_pool)


def cleanup_expired_autoscaled_rooms(idle_minutes: int = 30) -> int:
    """Delete empty autoscaled room shards that have been idle longer than idle_minutes."""
    try:
        idle_minutes = int(idle_minutes)
    except Exception:
        idle_minutes = 30
    idle_minutes = max(1, min(idle_minutes, 24 * 60 * 7))

    conn, from_pool = _acquire_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                DELETE FROM chat_rooms
                 WHERE created_by = 'autoscaler'
                   AND COALESCE(member_count, 0) = 0
                   AND COALESCE(last_active_at, created_at) < (NOW() - (%s || ' minutes')::interval)
                RETURNING name;
                """,
                (idle_minutes,),
            )
            rows = cur.fetchall() or []
        conn.commit()
        return len(rows)
    except Exception:
        try:
            conn.rollback()
        except Exception:
            pass
        logging.exception("cleanup_expired_autoscaled_rooms failed")
        return 0
    finally:
        _release_conn(conn, from_pool)



# ----------------------------------------------------------------------
# Flask app-factory helper
# ----------------------------------------------------------------------
def init_app(app):
    """
    Call in server_init.py after creating the Flask app:

        from database import init_app as init_db
        app = Flask(__name__)
        init_db(app)

    This runs init_database() once and registers teardown.
    """
    init_database()
    app.teardown_appcontext(close_db)


# ----------------------------------------------------------------------
# Optional debug helper
# ----------------------------------------------------------------------
def dump_tables():
    """
    Print quick row counts for sanity checks.
    """
    conn = get_db()
    with conn.cursor() as cur:
        for tbl in ("users", "chat_rooms", "messages"):
            cur.execute(f"SELECT COUNT(*) FROM {tbl};")
            count = cur.fetchone()[0]
            print(f"{tbl}: {count}")


# ----------------------------------------------------------------------
# Legacy helper for seeding rooms from a JSON file path (not usually used
# if load_rooms_from_json() is present). Retained here for compatibility.
# ----------------------------------------------------------------------
def seed_rooms_from_file(file_path="chat_rooms.json"):
    """
    Read a JSON file of rooms (each can be either a string or a dict
    containing 'name' and optional 'description'), then INSERT them
    into a legacy 'rooms' table if it exists. Prints status messages.
    """
    if not os.path.exists(file_path):
        print(f"⚠ Room file '{file_path}' not found.")
        return

    try:
        with open(file_path, "r", encoding="utf-8") as f:
            rooms = json.load(f)
    except Exception as e:
        print(f"❌ Failed to parse {file_path}: {e}")
        return

    conn, from_pool = _acquire_conn()
    try:
        with conn.cursor() as cur:
            count = 0
            for room in rooms:
                name = room.get("name") if isinstance(room, dict) else room
                description = room.get("description", "") if isinstance(room, dict) else ""
                cur.execute(
                    """
                    INSERT INTO rooms (name, description)
                    VALUES (%s, %s)
                    ON CONFLICT (name) DO NOTHING;
                    """,
                    (name, description)
                )
                count += 1
        conn.commit()
        print(f"✅ Seeded {count} room(s) from {file_path}")
    finally:
        _release_conn(conn, from_pool)
