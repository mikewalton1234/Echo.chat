#!/usr/bin/env python3
"""EchoChat DB utility: dedupe duplicate emails (case-insensitive).

Problem this fixes
------------------
Postgres can't create the project's case-insensitive unique index if you have
two or more users whose emails match ignoring case:

    CREATE UNIQUE INDEX users_email_unique_ci ON users (lower(email));

This script:
  1) Finds duplicates by lower(email)
  2) Picks ONE canonical user per email (oldest created_at, then lowest id)
  3) Migrates integer user-id references from duplicate ids -> canonical id
     using safe "insert ... on conflict do nothing" patterns where needed.
  4) Deletes the duplicate user rows
  5) Rebuilds users_email_unique_ci

⚠️ Notes
--------
* Some tables in EchoChat store usernames (TEXT) rather than user_id. Those
  historical rows will remain with the old username string; this is normally
  fine in dev/test.
* This is primarily for local/dev databases. For production, you'd usually
  want a manual review/merge strategy.

Usage
-----
  # dry run (prints what it would do)
  python tools/dedupe_duplicate_emails.py --dry-run

  # perform changes
  python tools/dedupe_duplicate_emails.py

  # explicit DSN
  python tools/dedupe_duplicate_emails.py --dsn "postgresql://user:pass@localhost:5432/echo_db"

Exit codes:
  0 success
  2 db connect error
  3 unexpected error
"""

from __future__ import annotations

import argparse
import sys
from typing import Any

import psycopg2
from psycopg2 import errors

from constants import get_db_connection_string


def _fetchall(cur, q: str, params: tuple[Any, ...] = ()):
    cur.execute(q, params)
    return cur.fetchall()


def _print_group(email_ci: str, rows: list[tuple[int, str, str, str]]):
    # rows: (id, username, email, created_at)
    print(f"\n📧 Duplicate email group: {email_ci}")
    for (uid, username, email, created_at) in rows:
        print(f"  - id={uid:<6} username={username:<24} email={email:<32} created_at={created_at}")


def _print_priv_help(db_user: str, db_name: str, missing_tables: list[str] | None = None) -> None:
    mt = ", ".join(missing_tables or [])
    if mt:
        print(f"Missing privileges on: {mt}")
    print("\nFix options:")
    print("  A) Run this script as the DB owner/superuser (peer auth):")
    print(f"     sudo -u postgres -E bash -lc 'cd /home/drdrizzle/Projects/Echo-Chat-main && \\")
    print("       source .venv/bin/activate && \\")
    print(f"       python tools/dedupe_duplicate_emails.py --dsn \"dbname={db_name} user=postgres\"'")
    print("\n  B) Or grant your app DB role broad privileges (dev-friendly):")
    print(f"     sudo -u postgres psql -d {db_name} -c \"GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO \\\"{db_user}\\\";\"")
    print(f"     sudo -u postgres psql -d {db_name} -c \"GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO \\\"{db_user}\\\";\"")
    print("\nThen rerun the script.")


def _migrate_user_refs(cur, canonical_id: int, dupe_id: int, dry_run: bool) -> None:
    """Move integer user-id references from dupe_id -> canonical_id.

    We deliberately use insert+delete patterns for tables with unique
    constraints so we don't violate them during a direct UPDATE.
    """

    def do(sql: str, params: tuple[Any, ...] = ()):
        if dry_run:
            return
        cur.execute(sql, params)

    # user_roles (PK: user_id, role_id)
    do(
        """
        INSERT INTO user_roles (user_id, role_id)
        SELECT %s, role_id FROM user_roles WHERE user_id = %s
        ON CONFLICT DO NOTHING;
        """,
        (canonical_id, dupe_id),
    )
    do("DELETE FROM user_roles WHERE user_id = %s;", (dupe_id,))

    # group_members (unique: group_id, user_id)
    do(
        """
        INSERT INTO group_members (group_id, user_id, role, joined_at)
        SELECT group_id, %s, role, joined_at
        FROM group_members
        WHERE user_id = %s
        ON CONFLICT DO NOTHING;
        """,
        (canonical_id, dupe_id),
    )
    do("DELETE FROM group_members WHERE user_id = %s;", (dupe_id,))

    # chat_settings (unique: user_id, setting_name)
    do(
        """
        INSERT INTO chat_settings (user_id, setting_name, setting_value)
        SELECT %s, setting_name, setting_value
        FROM chat_settings
        WHERE user_id = %s
        ON CONFLICT DO NOTHING;
        """,
        (canonical_id, dupe_id),
    )
    do("DELETE FROM chat_settings WHERE user_id = %s;", (dupe_id,))

    # notifications (no unique constraint)
    do("UPDATE notifications SET user_id = %s WHERE user_id = %s;", (canonical_id, dupe_id))

    # groups.created_by (no FK constraint declared, but keep integrity)
    do("UPDATE groups SET created_by = %s WHERE created_by = %s;", (canonical_id, dupe_id))

    # friends (unique: user_id, friend_id)
    # dupe as user_id
    do(
        """
        INSERT INTO friends (user_id, friend_id, created_at)
        SELECT %s, friend_id, created_at
        FROM friends
        WHERE user_id = %s
        ON CONFLICT DO NOTHING;
        """,
        (canonical_id, dupe_id),
    )
    do("DELETE FROM friends WHERE user_id = %s;", (dupe_id,))

    # dupe as friend_id
    do(
        """
        INSERT INTO friends (user_id, friend_id, created_at)
        SELECT user_id, %s, created_at
        FROM friends
        WHERE friend_id = %s
        ON CONFLICT DO NOTHING;
        """,
        (canonical_id, dupe_id),
    )
    do("DELETE FROM friends WHERE friend_id = %s;", (dupe_id,))

    # blocked_users (unique: user_id, blocked_id)
    do(
        """
        INSERT INTO blocked_users (user_id, blocked_id)
        SELECT %s, blocked_id
        FROM blocked_users
        WHERE user_id = %s
        ON CONFLICT DO NOTHING;
        """,
        (canonical_id, dupe_id),
    )
    do("DELETE FROM blocked_users WHERE user_id = %s;", (dupe_id,))

    do(
        """
        INSERT INTO blocked_users (user_id, blocked_id)
        SELECT user_id, %s
        FROM blocked_users
        WHERE blocked_id = %s
        ON CONFLICT DO NOTHING;
        """,
        (canonical_id, dupe_id),
    )
    do("DELETE FROM blocked_users WHERE blocked_id = %s;", (dupe_id,))

    # auth_tokens store uses username (TEXT) not user_id; nothing to migrate.
    # other tables largely use username TEXT; nothing to migrate.


def main() -> int:
    ap = argparse.ArgumentParser(description="Deduplicate users by case-insensitive email")
    ap.add_argument(
        "--dsn",
        default=None,
        help="Override Postgres DSN (otherwise uses server_config.json / env / constants.py fallback)",
    )
    ap.add_argument("--dry-run", action="store_true", help="Print changes but do not write")
    ap.add_argument(
        "--keep",
        choices=["oldest", "newest", "lowest_id", "highest_id"],
        default="oldest",
        help="Which account to keep per duplicate email group (default: oldest)",
    )
    args = ap.parse_args()

    dsn = args.dsn or get_db_connection_string()
    try:
        conn = psycopg2.connect(dsn)
    except Exception as e:
        print("❌ Could not connect to Postgres.")
        print(f"DSN used: {dsn}")
        print(f"Details: {e}")
        return 2

    dry_run = bool(args.dry_run)
    keep = args.keep

    try:
        with conn.cursor() as cur:
            # Identify effective DB user / db for troubleshooting.
            cur.execute("SELECT current_user, current_database();")
            db_user, db_name = cur.fetchone()

            # Ensure we can actually read/write the key tables this tool touches.
            needed_tables = [
                "users",
                "user_roles",
                "group_members",
                "chat_settings",
                "notifications",
                "groups",
                "friends",
                "blocked_users",
            ]
            missing: list[str] = []
            for t in needed_tables:
                cur.execute(
                    "SELECT has_table_privilege(current_user, %s, 'SELECT,INSERT,UPDATE,DELETE');",
                    (f"public.{t}",),
                )
                ok = bool(cur.fetchone()[0])
                if not ok:
                    missing.append(t)

            if missing:
                print(
                    f"❌ Permission denied: database user '{db_user}' lacks required privileges in database '{db_name}'."
                )
                _print_priv_help(db_user=db_user, db_name=db_name, missing_tables=missing)
                conn.rollback()
                return 3

            # Normalize blank emails to NULL so they don't act like duplicates.
            if not dry_run:
                cur.execute("UPDATE users SET email = NULL WHERE email IS NOT NULL AND btrim(email) = '';")

            # Find duplicate groups.
            groups = _fetchall(
                cur,
                """
                SELECT lower(email) AS email_ci
                FROM users
                WHERE email IS NOT NULL
                GROUP BY 1
                HAVING COUNT(*) > 1
                ORDER BY 1;
                """,
            )

            if not groups:
                print("✅ No duplicate emails found (case-insensitive).")
                if not dry_run:
                    cur.execute("DROP INDEX IF EXISTS users_email_unique_ci;")
                    cur.execute(
                        """
                        CREATE UNIQUE INDEX users_email_unique_ci
                        ON users (lower(email))
                        WHERE email IS NOT NULL AND btrim(email) <> '';
                        """
                    )
                    conn.commit()
                    print("✅ Rebuilt users_email_unique_ci.")
                else:
                    print("(dry-run) Would rebuild users_email_unique_ci.")
                return 0

            print(f"⚠️ Found {len(groups)} duplicate email group(s).")

            total_deleted = 0
            for (email_ci,) in groups:
                rows = _fetchall(
                    cur,
                    """
                    SELECT id, username, email, created_at
                    FROM users
                    WHERE email IS NOT NULL AND lower(email) = %s
                    ORDER BY created_at ASC, id ASC;
                    """,
                    (email_ci,),
                )
                if len(rows) < 2:
                    continue

                _print_group(email_ci, rows)

                # Choose canonical.
                if keep == "oldest":
                    canonical = rows[0]
                elif keep == "newest":
                    canonical = rows[-1]
                elif keep == "lowest_id":
                    canonical = sorted(rows, key=lambda r: r[0])[0]
                else:  # highest_id
                    canonical = sorted(rows, key=lambda r: r[0])[-1]

                canonical_id = canonical[0]
                canonical_username = canonical[1]
                print(f"✅ Keeping: id={canonical_id} username={canonical_username}")

                dupes = [r for r in rows if r[0] != canonical_id]

                for (dupe_id, dupe_username, dupe_email, dupe_created) in dupes:
                    print(f"🧹 Removing duplicate user: id={dupe_id} username={dupe_username}")

                    # Migrate integer references first.
                    _migrate_user_refs(cur, canonical_id=canonical_id, dupe_id=dupe_id, dry_run=dry_run)

                    # Finally delete the user record.
                    if not dry_run:
                        cur.execute("DELETE FROM users WHERE id = %s;", (dupe_id,))
                    total_deleted += 1

            # Rebuild unique index now that duplicates are removed.
            if dry_run:
                print("\n(dry-run) Would drop/recreate users_email_unique_ci.")
                print(f"(dry-run) Would delete {total_deleted} duplicate user(s).")
                conn.rollback()
                return 0

            cur.execute("DROP INDEX IF EXISTS users_email_unique_ci;")
            cur.execute(
                """
                CREATE UNIQUE INDEX users_email_unique_ci
                ON users (lower(email))
                WHERE email IS NOT NULL AND btrim(email) <> '';
                """
            )
            conn.commit()

            print(f"\n✅ Deleted {total_deleted} duplicate user(s).")
            print("✅ Rebuilt users_email_unique_ci.")
            return 0

    except Exception as e:
        conn.rollback()
        # Provide a more actionable message for the most common failure:
        # insufficient privileges (SQLSTATE 42501).
        if isinstance(e, errors.InsufficientPrivilege) or getattr(e, "pgcode", None) == "42501":
            try:
                with conn.cursor() as cur2:
                    cur2.execute("SELECT current_user, current_database();")
                    db_user, db_name = cur2.fetchone()
            except Exception:
                db_user, db_name = "<unknown>", "<unknown>"
            print("❌ Dedupe failed due to insufficient database privileges.")
            print(f"Details: {e}")
            _print_priv_help(db_user=db_user, db_name=db_name)
            return 3

        print("❌ Dedupe failed; rolled back transaction.")
        print(f"Details: {e}")
        return 3
    finally:
        conn.close()


if __name__ == "__main__":
    raise SystemExit(main())
