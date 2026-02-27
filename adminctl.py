#!/usr/bin/env python3
"""adminctl.py

Grant/revoke admin rights for a specific user (by username or email).

This script does TWO things when granting admin:
  1) Sets users.is_admin = TRUE (used by UI/admin-injection logic)
  2) Assigns the RBAC 'admin' role in user_roles (used by permission checks)

Usage:
  # Grant admin to a user (username or email)
  python adminctl.py grant <identifier>

  # Revoke admin from a user (username or email)
  python adminctl.py revoke <identifier>

  # Show admin status + roles for a user
  python adminctl.py status <identifier>

  # List all current admins
  python adminctl.py list

Options:
  --role admin        Role name to grant/revoke (default: admin)
  --create-role       If the role does not exist, create it automatically (safe for dev)
"""

from __future__ import annotations

import argparse
import sys
import json
import os
from pathlib import Path

import psycopg2

from constants import CONFIG_FILE, get_db_connection_string, sanitize_postgres_dsn



def _dsn_from_server_config() -> str | None:
    """Best-effort DSN discovery from server_config.json.

    This avoids a common footgun: adminctl defaults to constants.py fallback DSN,
    which may not match the database_url you actually run the server with.
    """
    try:
        path = Path(CONFIG_FILE)
        if not path.exists():
            return None
        raw = path.read_text(encoding="utf-8")
        data = json.loads(raw)
        dsn = (data.get("database_url") or data.get("db_connection_string") or data.get("DATABASE_URL") or data.get("DB_CONNECTION_STRING"))
        if not dsn:
            return None
        return str(sanitize_postgres_dsn(str(dsn)))
    except Exception:
        return None



def _find_user(cur, ident: str):
    # Prefer exact username match; fall back to email; then id if numeric.
    ident = ident.strip()
    if not ident:
        return None
    # numeric id?
    if ident.isdigit():
        cur.execute("SELECT id, username, email, is_admin FROM users WHERE id = %s;", (int(ident),))
        return cur.fetchone()

    cur.execute("SELECT id, username, email, is_admin FROM users WHERE username = %s;", (ident,))
    row = cur.fetchone()
    if row:
        return row

    cur.execute("SELECT id, username, email, is_admin FROM users WHERE email = %s;", (ident,))
    return cur.fetchone()


def _get_role_id(cur, role: str, create_role: bool):
    cur.execute("SELECT id FROM roles WHERE name = %s;", (role,))
    r = cur.fetchone()
    if r:
        return r[0]

    if not create_role:
        return None

    # Minimal role creation. Permissions should already exist for a seeded schema,
    # but in case this runs before seeding, we still create a placeholder role.
    cur.execute("INSERT INTO roles (name, description) VALUES (%s, %s) RETURNING id;", (role, f"{role} role"))
    return cur.fetchone()[0]


def cmd_grant(conn, ident: str, role: str, create_role: bool) -> int:
    with conn.cursor() as cur:
        user = _find_user(cur, ident)
        if not user:
            print(f"❌ User not found: {ident}")
            return 1
        user_id, username, email, is_admin = user

        role_id = _get_role_id(cur, role, create_role)
        if role_id is None:
            print(f"❌ Role not found: {role} (run init_database / seeding, or pass --create-role)")
            return 1

        cur.execute("UPDATE users SET is_admin = TRUE WHERE id = %s;", (user_id,))
        cur.execute(
            """
            INSERT INTO user_roles (user_id, role_id)
            VALUES (%s, %s)
            ON CONFLICT (user_id, role_id) DO NOTHING;
            """,
            (user_id, role_id),
        )
    conn.commit()
    print(f"✅ Granted '{role}' to {username}{' <'+email+'>' if email else ''}")
    return 0


def cmd_revoke(conn, ident: str, role: str) -> int:
    with conn.cursor() as cur:
        user = _find_user(cur, ident)
        if not user:
            print(f"❌ User not found: {ident}")
            return 1
        user_id, username, email, is_admin = user

        cur.execute("SELECT id FROM roles WHERE name = %s;", (role,))
        r = cur.fetchone()
        if not r:
            print(f"❌ Role not found: {role}")
            return 1
        role_id = r[0]

        cur.execute("DELETE FROM user_roles WHERE user_id = %s AND role_id = %s;", (user_id, role_id))

        # Only flip is_admin off if the user has no remaining admin role assignment(s).
        # If you use multiple admin-like roles, adjust this logic.
        if role == "admin":
            cur.execute(
                """
                SELECT 1
                FROM user_roles ur
                JOIN roles r ON r.id = ur.role_id
                WHERE ur.user_id = %s AND r.name = 'admin'
                LIMIT 1;
                """,
                (user_id,),
            )
            still_admin = cur.fetchone() is not None
            if not still_admin:
                cur.execute("UPDATE users SET is_admin = FALSE WHERE id = %s;", (user_id,))
    conn.commit()
    print(f"✅ Revoked '{role}' from {username}{' <'+email+'>' if email else ''}")
    return 0


def cmd_status(conn, ident: str) -> int:
    with conn.cursor() as cur:
        user = _find_user(cur, ident)
        if not user:
            print(f"❌ User not found: {ident}")
            return 1
        user_id, username, email, is_admin = user

        cur.execute(
            """
            SELECT r.name
            FROM user_roles ur
            JOIN roles r ON r.id = ur.role_id
            WHERE ur.user_id = %s
            ORDER BY r.name;
            """,
            (user_id,),
        )
        roles = [r[0] for r in cur.fetchall()]

    print(f"User: {username}{' <'+email+'>' if email else ''} (id={user_id})")
    print(f"is_admin column: {'TRUE' if is_admin else 'FALSE'}")
    print(f"roles: {', '.join(roles) if roles else '(none)'}")
    return 0


def cmd_list(conn) -> int:
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT u.id, u.username, u.email, u.is_admin
            FROM users u
            WHERE u.is_admin = TRUE
            ORDER BY u.username;
            """
        )
        rows = cur.fetchall()

    if not rows:
        print("(no admins found)")
        return 0

    for (uid, username, email, is_admin) in rows:
        print(f"- {username}{' <'+email+'>' if email else ''} (id={uid})")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Grant/revoke admin rights for a specific user.")
    parser.add_argument(
        "--dsn",
        default=None,
        help="Override Postgres DSN (otherwise uses server_config.json, env, or constants.py fallback)",
    )
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_grant = sub.add_parser("grant", aliases=["gr"], help="Grant admin role to a user")
    p_grant.add_argument("identifier", help="username OR email OR numeric id")
    p_grant.add_argument("--role", default="admin")
    p_grant.add_argument("--create-role", action="store_true")

    p_revoke = sub.add_parser("revoke", aliases=["rv"], help="Revoke admin role from a user")
    p_revoke.add_argument("identifier", help="username OR email OR numeric id")
    p_revoke.add_argument("--role", default="admin")

    p_status = sub.add_parser("status", aliases=["st"], help="Show admin status for a user")
    p_status.add_argument("identifier", help="username OR email OR numeric id")

    sub.add_parser("list", aliases=["ls"], help="List current admins")

    args = parser.parse_args()
    dsn = (
        args.dsn
        or os.getenv("DB_CONNECTION_STRING")
        or os.getenv("DATABASE_URL")
        or _dsn_from_server_config()
        or get_db_connection_string()
    )

    try:
        conn = psycopg2.connect(dsn)
    except Exception as e:
        print("❌ Could not connect to Postgres.")
        print(f"DSN used: {dsn}")
        print("Tip: set DB_CONNECTION_STRING to your real DSN, or pass --dsn <dsn>.")
        print(f"Details: {e}")
        return 3
    try:
        if args.cmd == "grant":
            return cmd_grant(conn, args.identifier, args.role.strip().lower(), bool(args.create_role))
        if args.cmd == "revoke":
            return cmd_revoke(conn, args.identifier, args.role.strip().lower())
        if args.cmd == "status":
            return cmd_status(conn, args.identifier)
        if args.cmd == "list":
            return cmd_list(conn)
        parser.error("Unknown command")
        return 2
    finally:
        conn.close()


if __name__ == "__main__":
    raise SystemExit(main())
