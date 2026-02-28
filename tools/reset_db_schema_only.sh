#!/usr/bin/env bash
set -euo pipefail

# EchoChat: wipe ALL tables without dropping the database.
# Useful when you don't have permission to DROP/CREATE DATABASE.

trap 'echo "❌ Schema reset failed. Ensure EchoChat is stopped and your Postgres role can DROP/CREATE SCHEMA public." >&2' ERR

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG_FILE="$ROOT_DIR/server_config.json"

# DSN resolution priority:
#   1) DB_CONNECTION_STRING
#   2) DATABASE_URL
#   3) server_config.json -> database_url
DSN="${DB_CONNECTION_STRING:-${DATABASE_URL:-}}"
if [[ -z "${DSN}" && -f "${CONFIG_FILE}" ]]; then
  DSN="$(python - <<PY2
import json
try:
    with open("${CONFIG_FILE}", "r", encoding="utf-8") as f:
        s = json.load(f)
    print(s.get("database_url", "") or "")
except Exception:
    print("")
PY2
)"
fi

if [[ -z "${DSN}" ]]; then
  echo "❌ Could not determine database DSN." >&2
  echo "Set DB_CONNECTION_STRING or DATABASE_URL, or ensure server_config.json has database_url." >&2
  exit 1
fi

eval "$(python - "${DSN}" <<'PY2'
import sys, urllib.parse as up

dsn = sys.argv[1]
u = up.urlparse(dsn)
if u.scheme not in ("postgresql", "postgres"):
    raise SystemExit(f"Unsupported DSN scheme: {u.scheme}")

dbname = (u.path or "").lstrip("/") or "postgres"
user = up.unquote(u.username or "")
password = up.unquote(u.password or "")
host = u.hostname or "localhost"
port = str(u.port or 5432)

print(f"DBNAME={dbname}")
print(f"DBUSER={user}")
print(f"DBPASS={password}")
print(f"DBHOST={host}")
print(f"DBPORT={port}")
PY2
)"

if [[ -z "${DBUSER}" || ! "${DBUSER}" =~ ^[A-Za-z0-9_]+$ ]]; then
  echo "❌ Unsafe DBUSER '${DBUSER}'. Use a simple Postgres role name." >&2
  exit 1
fi

PSQL_BASE=(psql -h "${DBHOST}" -p "${DBPORT}" -U "${DBUSER}" -v ON_ERROR_STOP=1)

if [[ -n "${DBPASS}" ]]; then
  export PGPASSWORD="${DBPASS}"
fi

echo "🧨 Wiping schema in '${DBNAME}'…"
"${PSQL_BASE[@]}" -d "${DBNAME}" -c "DROP SCHEMA IF EXISTS public CASCADE;"
"${PSQL_BASE[@]}" -d "${DBNAME}" -c "CREATE SCHEMA public AUTHORIZATION \"${DBUSER}\";"
"${PSQL_BASE[@]}" -d "${DBNAME}" -c "GRANT ALL ON SCHEMA public TO \"${DBUSER}\";"

echo "✅ Schema wiped. Next: start the server (python main.py) to recreate tables."
