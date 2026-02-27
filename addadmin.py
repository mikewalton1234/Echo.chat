#!/usr/bin/env python3
"""addadmin.py

Assign the built-in RBAC 'admin' role to an existing user in PostgreSQL.

Usage:
  python addadmin.py <username>

Notes:
  - This does NOT create the user; it only assigns the role.
  - It also sets users.is_admin = true for UI convenience.
"""

from __future__ import annotations

import argparse
import psycopg2

from constants import get_db_connection_string


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("username")
    parser.add_argument("--role", default="admin", help="Role name to assign")
    parser.add_argument(
        "--dsn",
        default=None,
        help="Override Postgres DSN (otherwise uses server_config.json, env, or constants.py fallback)",
    )
    args = parser.parse_args()

    username = args.username.strip()
    role = args.role.strip().lower()
    if not username:
        print("Username required")
        return 2

    dsn = args.dsn or get_db_connection_string()
    try:
        conn = psycopg2.connect(dsn)
    except Exception as e:
        print("❌ Could not connect to Postgres.")
        print(f"DSN used: {dsn}")
        print("Tip: set DB_CONNECTION_STRING to your real DSN, or pass --dsn <dsn>.")
        print(f"Details: {e}")
        return 3
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT id FROM users WHERE username = %s;", (username,))
            row = cur.fetchone()
            if not row:
                print(f"User not found: {username}")
                return 1
            user_id = row[0]

            cur.execute("SELECT id FROM roles WHERE name = %s;", (role,))
            r = cur.fetchone()
            if not r:
                print(f"Role not found: {role}. Did you run init_database?")
                return 1
            role_id = r[0]

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
        print(f"Assigned role '{role}' to {username} ✅")
        return 0
    finally:
        conn.close()


if __name__ == "__main__":
    raise SystemExit(main())
