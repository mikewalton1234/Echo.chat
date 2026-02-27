#!/usr/bin/env python3

from __future__ import annotations

import json
import os
import re
from pathlib import Path


# Application version (semantic-ish). Used for UI + packaging.
APP_VERSION = "0.10.14.11"

# Path to the JSON‐encrypted server configuration file
CONFIG_FILE = "server_config.json"

# Path to the file that holds your Fernet key for encrypting/decrypting CONFIG_FILE
KEY_FILE = "server_key.key"

# PostgreSQL connection string.
#   - Set DB_CONNECTION_STRING (preferred) or DATABASE_URL to override.
#   - Format: "postgresql://<username>:<password>@<host>:<port>/<dbname>"
#
# NOTE:
#   Avoid hardcoding real credentials in source control.
#   The fallback below is intentionally a placeholder.
DEFAULT_DB_CONNECTION_STRING = "postgresql://USER:PASSWORD@localhost:5432/echo_db"


def sanitize_postgres_dsn(dsn: str | None) -> str | None:
    """Best-effort sanitiser for Postgres DSNs.

    People sometimes paste placeholders like:
        postgresql://<user>:<pass>@<host>:5432/<db>
    which makes Postgres try to authenticate a role literally named
    "<user>" (angle brackets included).

    We defensively:
      - strip whitespace
      - remove any '<' and '>' characters
      - strip surrounding single/double quotes
    """
    if dsn is None:
        return None
    s = str(dsn).strip()
    if not s:
        return s
    # Remove common placeholder delimiters.
    if "<" in s or ">" in s:
        s = s.replace("<", "").replace(">", "")
    # Strip accidental surrounding quotes.
    if (s.startswith('"') and s.endswith('"')) or (s.startswith("'") and s.endswith("'")):
        s = s[1:-1].strip()
    return s

def get_db_connection_string(settings: dict | None = None) -> str:
    """Return the PostgreSQL DSN.

    Priority:
      1) settings['database_url'] (if provided)
      2) environment variables DB_CONNECTION_STRING / DATABASE_URL
      3) DEFAULT_DB_CONNECTION_STRING
    """
    # 1) Explicit settings dict (preferred in the running server)
    if settings and settings.get("database_url"):
        return str(sanitize_postgres_dsn(settings["database_url"]))

    # 2) Environment overrides
    env = os.getenv("DB_CONNECTION_STRING") or os.getenv("DATABASE_URL")
    if env:
        return str(sanitize_postgres_dsn(env))

    # 3) If a local server_config.json exists (common in EchoChat), read it.
    #    This avoids relying on DEFAULT_DB_CONNECTION_STRING which may contain
    #    a non-existent Postgres role (e.g. OS username).
    try:
        base_dir = Path(__file__).resolve().parent
        cfg_path = base_dir / CONFIG_FILE
        if cfg_path.exists():
            data = cfg_path.read_text(encoding="utf-8").strip()
            if data.startswith("{") and data.endswith("}"):
                cfg = json.loads(data)
                if isinstance(cfg, dict) and cfg.get("database_url"):
                    return str(sanitize_postgres_dsn(cfg["database_url"]))
    except Exception:
        # If config is encrypted or unreadable, fall through.
        pass

    # 4) Fallback
    return str(sanitize_postgres_dsn(DEFAULT_DB_CONNECTION_STRING))



from urllib.parse import urlparse, urlunparse


def redact_postgres_dsn(dsn: str | None) -> str | None:
    """Return a DSN safe to print (password redacted).

    Example:
        postgresql://user:***@localhost:5432/echo_db
    """
    if dsn is None:
        return None
    s = sanitize_postgres_dsn(dsn)
    if not s:
        return s
    try:
        p = urlparse(s)
        if p.scheme and "postgres" in p.scheme:
            netloc = p.netloc
            if "@" in netloc:
                creds, hostport = netloc.rsplit("@", 1)
                if ":" in creds:
                    user, _ = creds.split(":", 1)
                    creds = f"{user}:***"
                netloc = f"{creds}@{hostport}"
            p2 = p._replace(netloc=netloc)
            return urlunparse(p2)
    except Exception:
        pass
    # Fallback: best-effort redaction for common patterns.
    return re.sub(r":([^:@/]+)@", r":***@", str(s))


def postgres_dsn_parts(dsn: str | None) -> dict:
    """Extract user/host/port/dbname from a Postgres DSN (best-effort)."""
    out = {"scheme": None, "user": None, "host": None, "port": None, "db": None}
    if not dsn:
        return out
    s = sanitize_postgres_dsn(dsn)
    try:
        p = urlparse(s)
        out["scheme"] = p.scheme
        if p.username:
            out["user"] = p.username
        if p.hostname:
            out["host"] = p.hostname
        if p.port:
            out["port"] = p.port
        if p.path and len(p.path) > 1:
            out["db"] = p.path.lstrip("/")
        return out
    except Exception:
        return out


# Backward-compatible constant (reads env at import time).
# Prefer get_db_connection_string() for runtime evaluation.
DB_CONNECTION_STRING = get_db_connection_string()
