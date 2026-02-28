#!/usr/bin/env bash
set -euo pipefail

# EchoChat: wipe & recreate the configured PostgreSQL database.
#
# ⚠️  DESTRUCTIVE: deletes ALL data (users, rooms, messages, keys, etc.)
# Creates a backup first (if pg_dump exists).

trap 'echo "❌ Reset failed. Ensure EchoChat is stopped and your Postgres role can DROP/CREATE the DB. If needed, re-run with a superuser (e.g. psql -U postgres) or adjust DSN." >&2' ERR

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG_FILE="$ROOT_DIR/server_config.json"

# DSN resolution priority:
#   1) DB_CONNECTION_STRING
#   2) DATABASE_URL
#   3) server_config.json -> database_url
DSN="${DB_CONNECTION_STRING:-${DATABASE_URL:-}}"
if [[ -z "${DSN}" && -f "${CONFIG_FILE}" ]]; then
  DSN="$(python - <<PY
import json
try:
    with open("${CONFIG_FILE}", "r", encoding="utf-8") as f:
        s = json.load(f)
    print(s.get("database_url", "") or "")
except Exception:
    print("")
PY
)"
fi

if [[ -z "${DSN}" ]]; then
  echo "❌ Could not determine database DSN." >&2
  echo "Set DB_CONNECTION_STRING or DATABASE_URL, or ensure server_config.json has database_url." >&2
  exit 1
fi

# Parse DSN safely using Python and emit shell vars.
eval "$(python - "${DSN}" <<'PY'
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
PY
)"

# Basic safety: only allow simple identifiers for drop/create.
if [[ ! "${DBNAME}" =~ ^[A-Za-z0-9_]+$ ]]; then
  echo "❌ Unsafe DBNAME '${DBNAME}'. Use a simple name (letters/numbers/underscore only)." >&2
  exit 1
fi
if [[ -z "${DBUSER}" || ! "${DBUSER}" =~ ^[A-Za-z0-9_]+$ ]]; then
  echo "❌ Unsafe DBUSER '${DBUSER}'. Use a simple Postgres role name." >&2
  exit 1
fi

# Build base psql invocation.
PSQL_BASE=(psql -h "${DBHOST}" -p "${DBPORT}" -U "${DBUSER}" -v ON_ERROR_STOP=1)

# Set password only if present (peer/trust auth may not need it).
if [[ -n "${DBPASS}" ]]; then
  export PGPASSWORD="${DBPASS}"
fi

# Backup (best-effort).
mkdir -p "${ROOT_DIR}/backups"
if command -v pg_dump >/dev/null 2>&1; then
  TS="$(date +'%Y%m%d_%H%M%S')"
  OUT="${ROOT_DIR}/backups/${DBNAME}_${TS}.dump"
  echo "🗄️  Creating backup: ${OUT}"
  set +e
  pg_dump -Fc -h "${DBHOST}" -p "${DBPORT}" -U "${DBUSER}" -f "${OUT}" "${DBNAME}" >/dev/null 2>&1
  RC=$?
  set -e
  if [[ $RC -ne 0 ]]; then
    echo "⚠️  Backup failed (continuing). If you need a backup, run pg_dump manually." >&2
  fi
else
  echo "⚠️  pg_dump not found; skipping backup." >&2
fi

echo "🧹 Terminating connections to '${DBNAME}' (best-effort)…"
set +e
"${PSQL_BASE[@]}" -d postgres -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${DBNAME}' AND pid <> pg_backend_pid();" >/dev/null 2>&1
set -e

echo "🗑️  Dropping database '${DBNAME}'…"
"${PSQL_BASE[@]}" -d postgres -c "DROP DATABASE IF EXISTS \"${DBNAME}\";"

echo "🆕 Creating database '${DBNAME}' (owner: ${DBUSER})…"
"${PSQL_BASE[@]}" -d postgres -c "CREATE DATABASE \"${DBNAME}\" OWNER \"${DBUSER}\";"

echo "✅ Fresh database ready: ${DBNAME}"
echo "➡️  Next: start the server (python main.py). It will recreate schema automatically."
