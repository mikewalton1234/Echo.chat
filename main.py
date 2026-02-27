#!/usr/bin/env python3
"""main.py

EchoChat server entrypoint.

This project currently treats ``server_config.json`` as a *plaintext* JSON settings
file. If you want to keep secrets out of the file, prefer environment variables
(``DATABASE_URL``, ``DB_CONNECTION_STRING``, ``SECRET_KEY``).

Why plaintext?
  The runtime needs to persist ``secret_key`` (only when missing) and other
  settings. Persisting into an encrypted blob is error‑prone unless the entire
  stack speaks that format. If you later want encrypted settings-at-rest, add a
  dedicated ``server_config.enc`` flow and keep ``server_config.json`` as a
  non-secret template.
"""

from __future__ import annotations

import argparse
from datetime import datetime
import json
import logging
import os
import sys
from pathlib import Path

from constants import CONFIG_FILE, sanitize_postgres_dsn
from interactive_setup import get_default_settings, interactive_setup
from server_init import run_web_server
from secrets_policy import scrub_secrets_for_persist


def configure_logging(settings: dict) -> None:
    """Configure file logging."""
    log_level_str = str(settings.get("log_level", "INFO")).upper()
    log_format = settings.get(
        "log_format",
        "%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    )
    log_file_path = settings.get("log_file_path", "logs/server.log")

    log_dir = os.path.dirname(log_file_path)
    if log_dir:
        os.makedirs(log_dir, exist_ok=True)

    log_level = getattr(logging, log_level_str, logging.INFO)
    logging.basicConfig(level=log_level, format=log_format, filename=log_file_path, filemode="a")
    logging.getLogger().addHandler(logging.StreamHandler(sys.stdout))
    logging.info("Logging configured (level=%s)", log_level_str)


def load_settings(path: Path) -> dict:
    """Load settings from JSON. Returns defaults if missing."""
    if not path.exists():
        return get_default_settings()

    try:
        with path.open("r", encoding="utf-8") as fp:
            return json.load(fp)
    except Exception as exc:
        print(f"⚠️  Could not parse {path} as JSON: {exc}")
        # If the settings file is corrupted, proactively back it up so the server
        # can safely persist generated secrets (secret_key / jwt_secret) into a
        # fresh JSON file.
        ts = datetime.now().strftime("%Y%m%d-%H%M%S")
        bad_path = path.with_suffix(path.suffix + f".bad-{ts}")
        try:
            path.rename(bad_path)
            print(f"⚠️  Backed up invalid settings file to: {bad_path}")
        except Exception as e2:
            print(f"⚠️  Could not back up invalid settings file: {e2}")
        print("⚠️  Falling back to defaults (run with --setup to rewrite config).")
        return get_default_settings()


def save_settings(path: Path, settings: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    # If ECHOCHAT_PERSIST_SECRETS=0, do not write secrets (DB DSN, API keys, SMTP pass, etc.)
    # into server_config.json. Keep them in env/.env instead.
    to_save = scrub_secrets_for_persist(settings)
    with path.open("w", encoding="utf-8") as fp:
        json.dump(to_save, fp, indent=2)


def apply_env_overrides(settings: dict) -> None:
    """Apply env overrides for secrets and runtime deployment."""

    def _bool_env(*names: str) -> bool | None:
        for n in names:
            v = os.getenv(n)
            if v is None:
                continue
            v = v.strip().lower()
            if v in ("1", "true", "yes", "y", "on"):
                return True
            if v in ("0", "false", "no", "n", "off"):
                return False
        return None

    def _str_env(*names: str) -> str | None:
        for n in names:
            v = os.getenv(n)
            if v is not None and v.strip() != "":
                return v.strip()
        return None

    def _int_env(*names: str) -> int | None:
        v = _str_env(*names)
        if v is None:
            return None
        try:
            return int(v)
        except ValueError:
            return None

    # Prefer DB env vars for safety.
    db = os.getenv("DB_CONNECTION_STRING") or os.getenv("DATABASE_URL")
    if db:
        settings["database_url"] = str(sanitize_postgres_dsn(db))

    secret = os.getenv("SECRET_KEY")
    if secret:
        settings["secret_key"] = secret

    jwt_secret = os.getenv("JWT_SECRET_KEY") or os.getenv("ECHOCHAT_JWT_SECRET")
    if jwt_secret:
        # Note: server_init.py will also read JWT_SECRET_KEY directly.
        # This assignment keeps behavior consistent across the codebase.
        settings["jwt_secret"] = jwt_secret

    # LiveKit (prefer env for production)
    lk_enabled = _bool_env("ECHOCHAT_LIVEKIT_ENABLED", "LIVEKIT_ENABLED")
    if lk_enabled is not None:
        settings["livekit_enabled"] = lk_enabled

    lk_api_url = _str_env("ECHOCHAT_LIVEKIT_API_URL", "LIVEKIT_API_URL", "LIVEKIT_URL")
    if lk_api_url:
        settings["livekit_api_url"] = lk_api_url

    lk_ws_url = _str_env("ECHOCHAT_LIVEKIT_WS_URL", "LIVEKIT_WS_URL")
    if lk_ws_url:
        settings["livekit_ws_url"] = lk_ws_url

    lk_key = _str_env("ECHOCHAT_LIVEKIT_API_KEY", "LIVEKIT_API_KEY")
    if lk_key:
        settings["livekit_api_key"] = lk_key

    lk_secret = _str_env("ECHOCHAT_LIVEKIT_API_SECRET", "LIVEKIT_API_SECRET")
    if lk_secret:
        settings["livekit_api_secret"] = lk_secret

    # GIPHY (prefer env for production)
    giphy_key = _str_env("ECHOCHAT_GIPHY_API_KEY", "GIPHY_API_KEY")
    if giphy_key:
        settings["giphy_api_key"] = giphy_key

    # SMTP (optional) — keep secrets out of server_config.json if desired.
    smtp_enabled = _bool_env("ECHOCHAT_SMTP_ENABLED", "SMTP_ENABLED")
    if smtp_enabled is not None:
        settings["smtp_enabled"] = smtp_enabled

    smtp_host = _str_env("ECHOCHAT_SMTP_HOST", "SMTP_HOST")
    if smtp_host:
        settings["smtp_host"] = smtp_host

    smtp_port = _int_env("ECHOCHAT_SMTP_PORT", "SMTP_PORT")
    if smtp_port:
        settings["smtp_port"] = smtp_port

    smtp_user = _str_env("ECHOCHAT_SMTP_USERNAME", "ECHOCHAT_SMTP_USER", "SMTP_USERNAME", "SMTP_USER")
    if smtp_user:
        settings["smtp_username"] = smtp_user

    smtp_pass = _str_env("ECHOCHAT_SMTP_PASSWORD", "ECHOCHAT_SMTP_PASS", "SMTP_PASSWORD", "SMTP_PASS")
    if smtp_pass:
        settings["smtp_password"] = smtp_pass

    smtp_from = _str_env("ECHOCHAT_SMTP_FROM", "SMTP_FROM")
    if smtp_from:
        settings["smtp_from"] = smtp_from

    smtp_starttls = _bool_env("ECHOCHAT_SMTP_STARTTLS", "SMTP_STARTTLS")
    if smtp_starttls is not None:
        settings["smtp_use_starttls"] = smtp_starttls

    smtp_ssl = _bool_env("ECHOCHAT_SMTP_SSL", "SMTP_SSL")
    if smtp_ssl is not None:
        settings["smtp_use_ssl"] = smtp_ssl


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="EchoChat server")
    p.add_argument("--setup", action="store_true", help="run the interactive setup wizard")
    p.add_argument("--config", default=CONFIG_FILE, help="path to server config JSON")
    return p.parse_args()


def main() -> None:
    args = parse_args()
    settings_path = Path(args.config)

    settings = load_settings(settings_path)
    apply_env_overrides(settings)

    if args.setup or not settings_path.exists():
        print("\n=== EchoChat Setup Wizard ===\n")
        settings = interactive_setup(settings)
        save_settings(settings_path, settings)
        print(f"✅ Saved settings to {settings_path}\n")

    if not settings.get("admin_pass"):
        print("⚠️  admin_pass is empty in settings. Superadmin login via /login will not work.")
        print("   Run with --setup to set an admin password (hashed).")

    configure_logging(settings)

    # Ensure document root exists (used by some templates/static expectations)
    www_folder = settings.get("document_root", "www")
    os.makedirs(www_folder, exist_ok=True)

    run_web_server(settings, limiter=None, settings_file=settings_path)


if __name__ == "__main__":
    main()
