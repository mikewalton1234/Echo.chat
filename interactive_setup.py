#!/usr/bin/env python3
"""interactive_setup.py

EchoChat setup wizard.

This project uses a small set of settings at runtime (database DSN, bind host/port,
JWT secret, cookie security, etc.). Earlier versions of the wizard ballooned into
hundreds of unrelated prompts and produced massive config files.

This module now keeps the wizard *EchoChat-only*:

  • Quick setup (default): the handful of settings you actually need.
  • Advanced setup (optional): token lifetimes, logging, pool sizing, ICE servers.

It also *compacts* the saved JSON to only known EchoChat keys, so your
server_config.json stays readable.
"""

from __future__ import annotations

import getpass
import json
import os
from typing import Any, Dict, List, Optional

import psycopg2

from constants import DEFAULT_DB_CONNECTION_STRING, sanitize_postgres_dsn
from security import hash_password, verify_password
from database import create_user_with_keys, ensure_user_has_keys


# ──────────────────────────────────────────────────────────────────────────────
# Defaults (compact)
# ──────────────────────────────────────────────────────────────────────────────

DEFAULT_ICE_SERVERS: list[dict] = [
    {"urls": "stun:stun.l.google.com:19302"},
    {"urls": "stun:stun1.l.google.com:19302"},
]


def get_default_settings() -> Dict[str, Any]:
    """Return a compact set of defaults for EchoChat.

    Notes:
      - Keep secrets out of JSON when possible; prefer env vars.
      - server_init.py will generate/persist secret_key + jwt_secret if missing.
    """

    dsn = sanitize_postgres_dsn(
        os.getenv("DATABASE_URL")
        or os.getenv("DB_CONNECTION_STRING")
        or DEFAULT_DB_CONNECTION_STRING
    )

    return {
        # ── Core server ──────────────────────────────────────────────────
        "server_name": "EchoChat",
        "server_host": "0.0.0.0",
        "server_port": 5000,
        # Backwards-compat keys (some code paths still check these first)
        "host": "0.0.0.0",
        "port": 5000,
        "server_debug": False,
        "debug": False,
        "https": False,
        "domain_name": "",
        "document_root": "www",

        # Secrets (server_init.py will generate/persist if missing)
        "secret_key": "",
        "jwt_secret": "",
        "jwt_secret_key": "",  # legacy alias

        # ── Database ─────────────────────────────────────────────────────
        "database_url": dsn,
        "db_pool_min": 1,
        "db_pool_max": 10,

        # ── Auth / cookies ───────────────────────────────────────────────
        "admin_user": os.getenv("ADMIN_USER") or "admin",
        "admin_pass": "",  # PBKDF2 hash (salt:hash)
        "admin_notification_email": "",
        "cookie_secure": False,
        "cookie_samesite": "Lax",
        "access_token_minutes": 30,
        "refresh_token_days": 7,
        # Idle logout (hours of no activity before auto-logout). Set 0 to disable.
        "idle_logout_hours": 8,

        # ── Autoscaled public rooms (Lobby -> Lobby (2) -> ...) ─────────
        "autoscale_rooms_enabled": True,
        "autoscale_room_capacity": 30,
        "autoscale_room_idle_minutes": 30,
        "public_base_url": "",
        "password_reset_token_minutes": 15,
        "recovery_pin_max_attempts": 5,
        "recovery_pin_lock_minutes": 15,
        # If true, every server restart revokes *all* sessions (forces re-login).
        # Off by default.
        "revoke_all_tokens_on_start": False,
        "refresh_rotation_grace_seconds": 10,

        # ── Email (SMTP relay; password reset) ───────────────────────────
        "smtp_enabled": False,
        "smtp_provider": "",
        "smtp_host": "",
        "smtp_port": 587,
        "smtp_username": "",
        "smtp_password": "",
        "smtp_use_starttls": True,
        "smtp_use_ssl": False,
        "smtp_from": "EchoChat <no-reply@localhost>",



        # ── GIFs (GIPHY) ────────────────────────────────────────────────
        # Prefer env var GIPHY_API_KEY; you may also store it encrypted in
        # server_config.json as giphy_api_key.
        "giphy_enabled": True,
        "giphy_api_key": "",
        "giphy_rating": "pg-13",
        "giphy_lang": "en",
        "giphy_default_limit": 24,
        "giphy_cache_ttl_sec": 45,

        # ── CORS / rate limiting ─────────────────────────────────────────
        "cors_allowed_origins": "*",  # can also be a list
        "allowed_origins": "*",       # legacy alias
        "rate_limit_storage_uri": "memory://",
        "rate_limit_storage": "memory://",
        # Group chat flood control (messages per window)
        # The server accepts either an int (treated as per-minute) or strings like "60 per minute".
        # Prefer ints in generated config.
        "group_msg_rate_limit": 60,
        "group_msg_rate_window_sec": 60,

        # Room/DM flood control (messages per window)
        # Accept either an int (treated as per-minute) or strings like "20@10" (20 per 10 seconds).
        "room_msg_rate_limit": "20@10",
        "room_msg_rate_window_sec": 10,
        "dm_msg_rate_limit": "15@10",
        "dm_msg_rate_window_sec": 10,
        # File transfer signaling flood control (offers per window)
        "file_offer_rate_limit": "5@60",
        "file_offer_rate_window_sec": 60,

        # Slowmode per room (seconds between messages per user). 0 disables.
        "room_slowmode_default_sec": 0,
        # Room history (DB-backed). 0 disables history being sent on join.
        "room_history_limit": 60,
        "room_history_page_size": 60,

        # Background cleanup
        "janitor_interval_seconds": 60,
        # Custom rooms are removed if empty/inactive beyond this threshold (hours)
        "custom_room_idle_hours": 168,
        # Private custom rooms are often ephemeral; default is shorter.
        "custom_private_room_idle_hours": 24,


        # Anti-abuse: auto-mute if the user repeatedly hits limits.
        "antiabuse_strikes_before_mute": 6,
        "antiabuse_strike_window_sec": 30,
        "antiabuse_auto_mute_minutes": 2,

        # Anti-abuse: join / room creation / friend request flood control
        "room_join_rate_limit": "15@30",
        "room_join_rate_window_sec": 30,
        "room_create_rate_limit": "5@300",
        "room_create_rate_window_sec": 300,
        "friend_req_rate_limit": "5@60",
        "friend_req_rate_window_sec": 60,
        "friend_req_unique_targets_max": 20,
        "friend_req_unique_targets_window_sec": 600,

        # Room creation policy
        "allow_user_create_rooms": True,
        "max_room_name_length": 48,

        # Anti-spam content heuristics (plaintext rooms only)
        "max_links_per_message": 8,
        "max_magnets_per_message": 2,
        "max_mentions_per_message": 12,
        "dup_msg_window_sec": 20,
        "dup_msg_max": 3,
        "dup_msg_min_length": 6,
        "dup_msg_normalize": True,


        # ── Logging ──────────────────────────────────────────────────────
        "log_level": "INFO",
        "log_format": "%(asctime)s - %(name)s - %(levelname)s - %(message)s",
        "log_file_path": "logs/server.log",

        # ── Health ───────────────────────────────────────────────────────
        "enable_health_check_endpoint": False,
        "health_check_endpoint": "/health",

        # ── Chat limits ──────────────────────────────────────────────────
        "max_message_length": 1000,
        "max_attachment_size": 10 * 1024 * 1024,
        "max_group_message_chars": 4000,
        "max_group_upload_bytes": 25 * 1024 * 1024,

        # Upload roots
        "dm_upload_root": "",
        "torrents_root": "",

        # ── DM file transfers (ciphertext-only) ──────────────────────────
        "max_dm_file_bytes": 10 * 1024 * 1024,
        "allow_plaintext_dm_fallback": True,
        "require_dm_e2ee": False,
        "p2p_file_enabled": True,
        "p2p_file_chunk_bytes": 64 * 1024,
        "p2p_file_handshake_timeout_ms": 7_000,
        "p2p_file_transfer_timeout_ms": 60_000,
        "p2p_file_session_ttl_seconds": 300,
        "p2p_ice_servers": DEFAULT_ICE_SERVERS,
        "p2p_ice": DEFAULT_ICE_SERVERS,            # legacy alias
        "webrtc_ice_servers": DEFAULT_ICE_SERVERS, # legacy alias
        "ice_servers": DEFAULT_ICE_SERVERS,        # legacy alias

        # ── Voice chat ───────────────────────────────────────────────────
        "voice_enabled": True,
        # 0 (or any <=0 value) means unlimited.
        "voice_max_room_peers": 0,
        "voice_ice_servers": [],  # empty => client falls back to p2p_ice_servers
        "voice_invite_cooldown_seconds": 8,
        "voice_dm_invite_ttl_seconds": 30,
        "voice_dm_active_ttl_seconds": 120,

        # ── Optional: torrent helpers (routes_main.py) ────────────────────
        "torrent_scrape_cache_ttl_sec": 120,
        "torrent_scrape_max_tries": 4,
        "torrent_scrape_http_timeout_sec": 1.5,
        "torrent_scrape_udp_timeout_sec": 1.5,

        # ── Legacy config-encryption flows (unused by main.py) ───────────
        "key_management_option": "separate_file",

        # ── Dynamic DNS (optional) ───────────────────────────────────────
        "dynamic_dns_enabled": False,
        "dynamic_dns_provider": "No-IP",
        "dynamic_dns_username": os.getenv("DDNS_USERNAME", ""),
        "dynamic_dns_password": "",
        "dynamic_dns_domain": "",
        "dynamic_dns_update_url": "https://dynupdate.no-ip.com/nic/update",

        # ── SSL block placeholder (some older tooling reads this) ─────────
        "ssl_tls_settings": {
            "enabled": False,
            "certificate_path": "cert.pem",
            "key_path": "key.pem"
        },
    }


def _compact_settings(settings: Dict[str, Any]) -> Dict[str, Any]:
    """Drop unknown keys so server_config.json stays small."""
    template = get_default_settings()
    compact: Dict[str, Any] = {}
    for k in template.keys():
        compact[k] = settings.get(k, template[k])
    return compact


# ──────────────────────────────────────────────────────────────────────────────
# Prompt helpers
# ──────────────────────────────────────────────────────────────────────────────


def _yn(prompt: str, default: bool = True) -> bool:
    suffix = "[Y/n]" if default else "[y/N]"
    while True:
        raw = (input(f"{prompt} {suffix}: ") or "").strip().lower()
        if not raw:
            return default
        if raw in ("y", "yes"):
            return True
        if raw in ("n", "no"):
            return False
        print("❌ Please answer yes or no.")


def _prompt_str(prompt: str, default: str) -> str:
    raw = input(f"{prompt} [{default}]: ")
    return raw.strip() if raw.strip() else default


def _prompt_int(prompt: str, default: int, min_val: int | None = None, max_val: int | None = None) -> int:
    while True:
        raw = input(f"{prompt} [{default}]: ").strip()
        if not raw:
            val = default
        else:
            try:
                val = int(raw)
            except ValueError:
                print("❌ Please enter a valid integer.")
                continue

        if min_val is not None and val < min_val:
            print(f"❌ Must be ≥ {min_val}.")
            continue
        if max_val is not None and val > max_val:
            print(f"❌ Must be ≤ {max_val}.")
            continue
        return val



def _prompt_choice(prompt: str, default: str, choices: list[str]) -> str:
    ch = {c.lower(): c for c in choices}
    choices_str = "/".join(choices)
    while True:
        raw = (input(f"{prompt} ({choices_str}) [{default}]: ") or "").strip()
        val = (raw or default).strip().lower()
        if val in ch:
            return val
        print(f"❌ Please choose one of: {choices_str}")


def _prompt_secret(prompt: str, allow_blank: bool = False) -> str:
    while True:
        val = getpass.getpass(f"{prompt}: ").strip()
        if not val and allow_blank:
            return ""
        if not val:
            print("❌ Value cannot be empty.")
            continue
        return val


def _prompt_password(prompt: str = "Password") -> str:
    while True:
        p1 = getpass.getpass(f"{prompt}: ").strip()
        p2 = getpass.getpass("Confirm: ").strip()
        if not p1:
            print("❌ Password cannot be empty.")
            continue
        if p1 != p2:
            print("❌ Passwords do not match.")
            continue
        return p1


def _parse_csv_urls(raw: str) -> list[dict]:
    """Parse comma-separated STUN/TURN urls into WebRTC iceServers format."""
    urls = [s.strip() for s in raw.split(",") if s.strip()]
    if not urls:
        return []
    return [{"urls": u} for u in urls]


# ──────────────────────────────────────────────────────────────────────────────
# DB helpers for setup (no Flask app context needed)
# ──────────────────────────────────────────────────────────────────────────────


def _ensure_users_table(conn) -> None:
    """Ensure the users table exists and has the columns required for E2EE keys."""
    with conn.cursor() as cur:
        # Create table if missing (minimal subset used by EchoChat)
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS users (
                id                    SERIAL PRIMARY KEY,
                username              TEXT UNIQUE NOT NULL,
                password              TEXT NOT NULL,
                email                 TEXT,
                phone                 TEXT,
                address               TEXT,
                age                   INTEGER,
                is_admin              BOOLEAN NOT NULL DEFAULT FALSE,
                public_key            TEXT,
                encrypted_private_key TEXT,
                presence_status       TEXT NOT NULL DEFAULT 'online',
                custom_status         TEXT,
                online                BOOLEAN DEFAULT FALSE,
                created_at            TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
            );
            """
        )

        # Patch common legacy columns
        cur.execute(
            """
            SELECT column_name FROM information_schema.columns
             WHERE table_name='users' AND column_name='password_hash';
            """
        )
        if cur.fetchone() is not None:
            cur.execute(
                """
                SELECT column_name FROM information_schema.columns
                 WHERE table_name='users' AND column_name='password';
                """
            )
            if cur.fetchone() is None:
                cur.execute("ALTER TABLE users RENAME COLUMN password_hash TO password;")

        for col, ddl in (
            ("public_key", "ALTER TABLE users ADD COLUMN public_key TEXT;"),
            ("encrypted_private_key", "ALTER TABLE users ADD COLUMN encrypted_private_key TEXT;"),
            ("is_admin", "ALTER TABLE users ADD COLUMN is_admin BOOLEAN NOT NULL DEFAULT FALSE;"),
            ("presence_status", "ALTER TABLE users ADD COLUMN presence_status TEXT NOT NULL DEFAULT 'online';"),
            ("custom_status", "ALTER TABLE users ADD COLUMN custom_status TEXT;"),
            ("online", "ALTER TABLE users ADD COLUMN online BOOLEAN DEFAULT FALSE;"),
        ):
            cur.execute(
                """
                SELECT column_name FROM information_schema.columns
                 WHERE table_name='users' AND column_name=%s;
                """,
                (col,),
            )
            if cur.fetchone() is None:
                cur.execute(ddl)

    conn.commit()


def _sync_superadmin_in_db(
    conn,
    username: str,
    raw_password: str,
    password_hash: str,
    email: str | None,
    age: int | None,
) -> str:
    """Create/update the superadmin row so E2EE keys match the login password.

    Returns the *password hash that should be stored in config* for the
    superadmin override.
    """
    _ensure_users_table(conn)

    with conn.cursor() as cur:
        cur.execute(
            "SELECT password, public_key, encrypted_private_key, is_admin FROM users WHERE username=%s;",
            (username,),
        )
        row = cur.fetchone()

    if row is None:
        create_user_with_keys(
            conn,
            username=username,
            raw_password=raw_password,
            password_hash=password_hash,
            email=email,
            age=age,
            is_admin=True,
        )
        return password_hash

    stored_hash = row[0]
    if stored_hash and verify_password(raw_password, stored_hash):
        # Ensure keys exist and mark as admin.
        ensure_user_has_keys(conn, username, raw_password)
        with conn.cursor() as cur:
            cur.execute("UPDATE users SET is_admin = TRUE WHERE username=%s;", (username,))
        conn.commit()
        # It's OK if config stores a different PBKDF2 hash for the same password.
        return password_hash

    # Password mismatch: avoid silently breaking decryption of existing messages.
    print(
        "\n⚠️  The user already exists in the DB, but the password you entered does not match.\n"
        "    If you continue without fixing this, the superadmin can log in (config override),\n"
        "    but existing E2EE keys in the DB may not decrypt with the new password.\n"
    )

    if _yn("Reset DB password + regenerate E2EE keys for this user?", default=False):
        # Regenerating keys breaks old encrypted history for this user. That's intentional.
        public_pem, encrypted_priv_blob = _generate_new_keypair_blob(raw_password)
        with conn.cursor() as cur:
            cur.execute(
                """
                UPDATE users
                   SET password=%s,
                       email=COALESCE(%s, email),
                       age=COALESCE(%s, age),
                       is_admin=TRUE,
                       public_key=%s,
                       encrypted_private_key=%s
                 WHERE username=%s;
                """,
                (password_hash, email, age, public_pem, encrypted_priv_blob, username),
            )
        conn.commit()
        return password_hash
    else:
        print(
            "✅ Leaving the DB user unchanged.\n"
            "   → Setup will keep the existing DB password for superadmin login.\n"
            "   → Use the DB password at /login (not the password you just typed).\n"
        )
        return stored_hash or password_hash


def _generate_new_keypair_blob(raw_password: str) -> tuple[str, str]:
    """Generate a fresh keypair using the same helper as create_user_with_keys()."""
    # Reuse database's internal helper (kept local to avoid import cycles).
    from database import _generate_and_encrypt_rsa_keypair  # type: ignore

    public_pem, encrypted_priv_b64 = _generate_and_encrypt_rsa_keypair(raw_password)
    return public_pem, encrypted_priv_b64


# ──────────────────────────────────────────────────────────────────────────────
# Main wizard
# ──────────────────────────────────────────────────────────────────────────────


def interactive_setup(settings: Dict[str, Any]) -> Dict[str, Any]:
    """Run the EchoChat setup wizard and return an updated (compacted) settings dict."""

    # Start from compact defaults, but allow existing values to carry forward.
    base = get_default_settings()
    merged = {**base, **(settings or {})}

    print("\n=== EchoChat Setup Wizard ===\n")

    advanced = _yn("Advanced mode? (more prompts)", default=False)

    # ── Core server ───────────────────────────────────────────────────────────
    merged["server_name"] = _prompt_str("Server name", str(merged.get("server_name") or base["server_name"]))
    merged["server_host"] = _prompt_str("Bind host", str(merged.get("server_host") or base["server_host"]))
    merged["server_port"] = _prompt_int("Bind port", int(merged.get("server_port") or base["server_port"]), 1, 65535)
    # Keep legacy keys in sync so older code paths don't bind the wrong address.
    merged["host"] = merged["server_host"]
    merged["port"] = merged["server_port"]

    # ── Database ──────────────────────────────────────────────────────────────
    while True:
        raw_dsn = _prompt_str(
            "PostgreSQL DSN",
            str(merged.get("database_url") or base["database_url"]),
        )
        merged["database_url"] = str(sanitize_postgres_dsn(raw_dsn))
        if merged["database_url"] != raw_dsn:
            print("⚠️  DSN sanitised (removed placeholder angle brackets / quotes).")
        try:
            test = psycopg2.connect(str(merged["database_url"]))
            test.close()
            print("✅ PostgreSQL connection OK")
            break
        except Exception as e:
            print(f"❌ PostgreSQL connection failed: {e}")
            if not _yn("Try again?", default=True):
                raise SystemExit(1)

    # ── Cookies / HTTPS ───────────────────────────────────────────────────────
    merged["cookie_secure"] = _yn(
        "Are you serving the site over HTTPS (or behind an HTTPS reverse proxy)?",
        default=bool(merged.get("cookie_secure", False)),
    )
    merged["cookie_samesite"] = _prompt_str("Cookie SameSite (Lax/Strict/None)", str(merged.get("cookie_samesite") or "Lax"))

    # ── Email (SMTP relay) ───────────────────────────────────────────────────
    print("\n— Email (SMTP relay; password reset) —")
    merged["smtp_enabled"] = _yn(
        "Enable SMTP for password reset emails?",
        default=bool(merged.get("smtp_enabled", False)),
    )

    if merged["smtp_enabled"]:
        providers = ["brevo", "mailjet", "smtp2go", "mailersend", "custom"]
        merged["smtp_provider"] = _prompt_choice(
            "SMTP provider",
            str((merged.get("smtp_provider") or "brevo")).lower(),
            providers,
        )

        presets = {
            "brevo": {"host": "smtp-relay.brevo.com", "port": 587, "starttls": True, "ssl": False},
            "mailjet": {"host": "in-v3.mailjet.com", "port": 587, "starttls": True, "ssl": False},
            "smtp2go": {"host": "mail.smtp2go.com", "port": 587, "starttls": True, "ssl": False},
            "mailersend": {"host": "smtp.mailersend.net", "port": 587, "starttls": True, "ssl": False},
            "custom": {},
        }

        preset = presets.get(str(merged["smtp_provider"]).lower(), {})

        merged["smtp_host"] = _prompt_str("SMTP host", str(merged.get("smtp_host") or preset.get("host") or ""))
        merged["smtp_port"] = _prompt_int(
            "SMTP port",
            int(merged.get("smtp_port") or preset.get("port") or 587),
            1,
            65535,
        )

        # STARTTLS is typical for 587/2525. Port 465 is typically implicit TLS.
        merged["smtp_use_starttls"] = _yn(
            "Use STARTTLS?",
            default=bool(merged.get("smtp_use_starttls", preset.get("starttls", True))),
        )
        merged["smtp_use_ssl"] = _yn(
            "Use implicit TLS (SMTP SSL)?",
            default=bool(merged.get("smtp_use_ssl", preset.get("ssl", False))) or (int(merged["smtp_port"]) == 465),
        )

        merged["smtp_username"] = _prompt_str("SMTP username/login", str(merged.get("smtp_username") or ""))

        store_pw = _yn("Store SMTP password in server_config.json? (not recommended)", default=False)
        if store_pw:
            merged["smtp_password"] = _prompt_secret("SMTP password / key")
        else:
            merged["smtp_password"] = ""
            print("ℹ️  SMTP password will be read from env var ECHOCHAT_SMTP_PASSWORD (or SMTP_PASSWORD).")

        default_from = str(merged.get("smtp_from") or f"{merged['server_name']} <no-reply@localhost>")
        merged["smtp_from"] = _prompt_str("From address", default_from)




    # ── GIFs (GIPHY) ──────────────────────────────────────────────────────────
    print("\n— GIFs (GIPHY) —")
    merged["giphy_enabled"] = _yn(
        "Enable GIF search (GIPHY)?",
        default=bool(merged.get("giphy_enabled", True)),
    )
    if merged["giphy_enabled"]:
        store_key = _yn("Store GIPHY API key in server_config.json? (or No = env/.giphy_api_key)", default=bool(str(merged.get("giphy_api_key") or "").strip()))
        if store_key:
            merged["giphy_api_key"] = _prompt_secret("GIPHY API key", allow_blank=False)
        else:
            merged["giphy_api_key"] = ""
            print("ℹ️  Set env var GIPHY_API_KEY (or create .giphy_api_key file) to enable GIF search.")
    else:
        merged["giphy_api_key"] = ""

    # ── CORS ──────────────────────────────────────────────────────────────────
    if advanced:
        cors_default = merged.get("cors_allowed_origins") or "*"
        raw = input(f"CORS allowed origins (comma-separated or * for all) [{cors_default}]: ").strip()
        if raw:
            if raw == "*":
                merged["cors_allowed_origins"] = "*"
            else:
                merged["cors_allowed_origins"] = [s.strip() for s in raw.split(",") if s.strip()]

    # ── Tokens / pool / logging ───────────────────────────────────────────────
    if advanced:
        merged["access_token_minutes"] = _prompt_int(
            "Access token minutes",
            int(merged.get("access_token_minutes") or base["access_token_minutes"]),
            1,
            24 * 60,
        )
        merged["refresh_token_days"] = _prompt_int(
            "Refresh token days",
            int(merged.get("refresh_token_days") or base["refresh_token_days"]),
            1,
            365,
        )
        merged["db_pool_min"] = _prompt_int("DB pool min", int(merged.get("db_pool_min") or base["db_pool_min"]), 1, 100)
        merged["db_pool_max"] = _prompt_int("DB pool max", int(merged.get("db_pool_max") or base["db_pool_max"]), 1, 500)
        merged["log_level"] = _prompt_str("Log level (DEBUG/INFO/WARNING/ERROR)", str(merged.get("log_level") or base["log_level"]))
        merged["log_file_path"] = _prompt_str("Log file path", str(merged.get("log_file_path") or base["log_file_path"]))

        merged["enable_health_check_endpoint"] = _yn(
            "Enable /health endpoint?",
            default=bool(merged.get("enable_health_check_endpoint", False)),
        )
        if merged["enable_health_check_endpoint"]:
            merged["health_check_endpoint"] = _prompt_str(
                "Health endpoint path",
                str(merged.get("health_check_endpoint") or base["health_check_endpoint"]),
            )

    # ── File transfers / Voice / ICE ─────────────────────────────────────────
    if advanced:
        merged["max_dm_file_bytes"] = _prompt_int(
            "Max DM file bytes",
            int(merged.get("max_dm_file_bytes") or base["max_dm_file_bytes"]),
            1 * 1024,
            500 * 1024 * 1024,
        )
        merged["p2p_file_enabled"] = _yn("Enable P2P-first DM file transfer?", default=bool(merged.get("p2p_file_enabled", True)))
        merged["voice_enabled"] = _yn("Enable voice chat?", default=bool(merged.get("voice_enabled", True)))

        p2p_default_urls = ", ".join([d.get("urls", "") for d in (merged.get("p2p_ice_servers") or DEFAULT_ICE_SERVERS)])
        raw_p2p = input(f"P2P ICE server URLs (comma-separated) [{p2p_default_urls}]: ").strip()
        if raw_p2p:
            merged["p2p_ice_servers"] = _parse_csv_urls(raw_p2p)

        voice_default_urls = ", ".join([d.get("urls", "") for d in (merged.get("voice_ice_servers") or [])])
        raw_voice = input(
            f"Voice ICE server URLs (comma-separated; blank = use P2P ICE list) [{voice_default_urls or 'blank'}]: "
        ).strip()
        if raw_voice:
            merged["voice_ice_servers"] = _parse_csv_urls(raw_voice)
        else:
            merged["voice_ice_servers"] = merged.get("voice_ice_servers") or []

    # ── JWT secret (stable) ───────────────────────────────────────────────────
    # server_init.py will ensure/persist this if missing, but we can do it now.
    if not merged.get("jwt_secret"):
        if _yn("Generate & save a stable jwt_secret now?", default=True):
            import secrets

            merged["jwt_secret"] = secrets.token_hex(32)
            print("✅ jwt_secret generated")

    # ── Superadmin ───────────────────────────────────────────────────────────
    print("\n— Superadmin (required) —")
    merged["admin_user"] = _prompt_str("Superadmin username", str(merged.get("admin_user") or base["admin_user"]))
    raw_password = _prompt_password("Superadmin password")
    desired_hash = hash_password(raw_password)
    merged["admin_pass"] = desired_hash

    if advanced:
        merged["admin_notification_email"] = _prompt_str(
            "Admin notification email (optional)",
            str(merged.get("admin_notification_email") or ""),
        )

    # Create/sync the DB row so E2EE keys match the login password.
    try:
        conn = psycopg2.connect(str(merged["database_url"]))
        try:
            email: Optional[str] = None
            age: Optional[int] = None
            if advanced:
                e = input("Email for superadmin (optional): ").strip()
                email = e or None
                a = input("Age for superadmin (optional): ").strip()
                age = int(a) if a else None
            merged["admin_pass"] = _sync_superadmin_in_db(
                conn,
                merged["admin_user"],
                raw_password,
                desired_hash,
                email,
                age,
            )
            print(f"✅ Superadmin '{merged['admin_user']}' is ready")
        finally:
            conn.close()
    except Exception as e:
        print(f"⚠️  Could not create/sync superadmin in DB: {e}")
        print("    You can still start the server; the superadmin row can be created on first login.")

    print("\n✅ Setup complete.\n")
    return _compact_settings(merged)