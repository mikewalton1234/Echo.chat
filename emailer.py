#!/usr/bin/env python3
"""emailer.py

Minimal SMTP sender for transactional emails (password reset, verification later).

Design goals:
  - Production-safe: never print reset links or email bodies to logs.
  - If SMTP is not configured, we DO NOT fall back to console links.

Supported settings keys (any of these):
  smtp_enabled: bool
  smtp_host / smtp_server: str
  smtp_port: int
  smtp_username / smtp_user: str
  smtp_password / smtp_pass: str
  smtp_use_starttls / smtp_tls: bool (STARTTLS on port 587)
  smtp_use_ssl / smtp_ssl: bool (implicit TLS, typically port 465)
  smtp_from / from_email: str
"""

from __future__ import annotations

import logging
import smtplib
import os
from email.message import EmailMessage


def _get(settings: dict, *keys, default=None):
    for k in keys:
        if k in settings and settings[k] not in (None, ""):
            return settings[k]
    return default


def send_email(settings: dict, *, to_email: str, subject: str, body_text: str) -> tuple[bool, str]:
    """Send a plaintext email.

    Returns (ok, info). If SMTP isn't configured, returns (False, "not_configured").
    """

    if not to_email:
        return False, "missing_to"

    # Prefer env vars for production (keeps secrets out of server_config.json)
    env_enabled = os.getenv("ECHOCHAT_SMTP_ENABLED") or os.getenv("SMTP_ENABLED")
    if env_enabled is not None and str(env_enabled).strip() != "":
        enabled = str(env_enabled).strip().lower() in {"1", "true", "yes", "on"}
    else:
        enabled = bool(_get(settings, "smtp_enabled", default=False))

    host = os.getenv("ECHOCHAT_SMTP_HOST") or os.getenv("SMTP_HOST") or _get(settings, "smtp_host", "smtp_server")
    port = int(os.getenv("ECHOCHAT_SMTP_PORT") or os.getenv("SMTP_PORT") or _get(settings, "smtp_port", default=587) or 587)
    username = os.getenv("ECHOCHAT_SMTP_USERNAME") or os.getenv("ECHOCHAT_SMTP_USER") or os.getenv("SMTP_USERNAME") or os.getenv("SMTP_USER") or _get(settings, "smtp_username", "smtp_user")
    password = os.getenv("ECHOCHAT_SMTP_PASSWORD") or os.getenv("ECHOCHAT_SMTP_PASS") or os.getenv("SMTP_PASSWORD") or os.getenv("SMTP_PASS") or _get(settings, "smtp_password", "smtp_pass")
    env_starttls = os.getenv("ECHOCHAT_SMTP_STARTTLS") or os.getenv("SMTP_STARTTLS")
    if env_starttls is not None and str(env_starttls).strip() != "":
        starttls = str(env_starttls).strip().lower() in {"1", "true", "yes", "on"}
    else:
        starttls = bool(_get(settings, "smtp_use_starttls", "smtp_tls", default=True))

    env_ssl = os.getenv("ECHOCHAT_SMTP_SSL") or os.getenv("SMTP_SSL")
    if env_ssl is not None and str(env_ssl).strip() != "":
        use_ssl = str(env_ssl).strip().lower() in {"1", "true", "yes", "on"}
    else:
        use_ssl = bool(_get(settings, "smtp_use_ssl", "smtp_ssl", default=False))
    # Convenience: port 465 is typically implicit TLS (SMTP over SSL).
    if port == 465 and not starttls:
        use_ssl = True

    from_email = os.getenv("ECHOCHAT_SMTP_FROM") or os.getenv("SMTP_FROM") or _get(settings, "smtp_from", "from_email", default="EchoChat <no-reply@localhost>")

    # No dev fallback: if SMTP is not configured, refuse to "send".
    if not enabled or not host or not username or not password:
        logging.error(
            "SMTP not configured/enabled; cannot send email (to=%s subject=%s)",
            to_email,
            subject,
        )
        return False, "not_configured"

    msg = EmailMessage()
    msg["From"] = from_email
    msg["To"] = to_email
    msg["Subject"] = subject
    msg.set_content(body_text)

    try:
        smtp_cls = smtplib.SMTP_SSL if use_ssl else smtplib.SMTP
        with smtp_cls(host, port, timeout=15) as smtp:
            smtp.ehlo()
            if starttls and not use_ssl:
                smtp.starttls()
                smtp.ehlo()
            smtp.login(username, password)
            smtp.send_message(msg)
        return True, "sent"
    except Exception as e:
        # Do not log body_text (contains reset link).
        logging.warning(
            "SMTP send failed (%s:%s) to=%s subject=%s: %s",
            host,
            port,
            to_email,
            subject,
            e,
        )
        return False, f"smtp_error:{type(e).__name__}"
