#!/usr/bin/env python3
"""security.py

Utility functions for password hashing and audit logging.

2026-02-15 hardening:
  - New hashes: Argon2id (argon2-cffi)
  - Back-compat: verify legacy PBKDF2 hashes (salt_hex:hash_b64)
  - Upgrade path: verify_password_and_upgrade() returns a new Argon2id hash

We reuse these helpers for:
  - user passwords (users.password)
  - recovery PIN hashes (users.recovery_pin_hash)
  - super-admin password hash stored in server_config.json (admin_pass)
"""

from __future__ import annotations

import os
import base64
import hmac
import getpass
import logging
from typing import Optional, Tuple

from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.backends import default_backend

from database import get_db

# ────────────────────────────────────────────────────────────
# Audit logging
# ────────────────────────────────────────────────────────────

def log_audit_event(actor: str, action: str, target: str | None = None, details: str | None = None) -> None:
    """Insert an audit log entry into the audit_log table."""
    try:
        conn = get_db()
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO audit_log (actor, action, target, details)
                VALUES (%s, %s, %s, %s);
                """,
                (actor, action, target, details),
            )
        conn.commit()
    except Exception as e:
        logging.error("Failed to write audit log (%s, %s, %s, %s): %s", actor, action, target, details, e)


# ────────────────────────────────────────────────────────────
# Password hashing utilities
# ────────────────────────────────────────────────────────────

# Legacy PBKDF2 parameters (kept only for verifying old hashes)
_LEGACY_PBKDF2_ITERS = 100_000
_LEGACY_PBKDF2_LEN = 32


def _pbkdf2_legacy(password: str, salt: bytes) -> bytes:
    """Derive a 32-byte key from password+salt using legacy PBKDF2-SHA256."""
    kdf = PBKDF2HMAC(
        algorithm=hashes.SHA256(),
        length=_LEGACY_PBKDF2_LEN,
        salt=salt,
        iterations=_LEGACY_PBKDF2_ITERS,
        backend=default_backend(),
    )
    return kdf.derive(password.encode("utf-8"))


def _is_legacy_pbkdf2_hash(stored_hash: str) -> bool:
    # Expected: <32 hex chars>:<base64...>
    if not stored_hash or ":" not in stored_hash:
        return False
    left, right = stored_hash.split(":", 1)
    if len(left) != 32:
        return False
    try:
        bytes.fromhex(left)
    except Exception:
        return False
    return bool(right)


def _verify_legacy_pbkdf2(password: str, stored_hash: str) -> bool:
    try:
        salt_hex, hashed_b64 = stored_hash.split(":", 1)
        salt = bytes.fromhex(salt_hex)
        new_hash = base64.urlsafe_b64encode(_pbkdf2_legacy(password, salt)).decode("utf-8")
        return hmac.compare_digest(new_hash, hashed_b64)
    except Exception:
        return False


# Argon2id (preferred)
try:
    from argon2 import PasswordHasher
    from argon2.exceptions import VerifyMismatchError, VerificationError, InvalidHash

    _PWH = PasswordHasher(
        time_cost=3,
        memory_cost=65536,  # KiB (64 MiB)
        parallelism=1,
        hash_len=32,
        salt_len=16,
    )
except Exception:
    PasswordHasher = None  # type: ignore
    _PWH = None


def _is_argon2_hash(stored_hash: str) -> bool:
    return bool(stored_hash) and stored_hash.startswith("$argon2")


def hash_password(password: str) -> str:
    """Hash plaintext password using Argon2id (preferred).

    Falls back to PBKDF2 if argon2-cffi isn't installed.
    """
    if _PWH is None:
        # Fallback (dev only): keep legacy format
        salt = os.urandom(16)
        hashed = base64.urlsafe_b64encode(_pbkdf2_legacy(password, salt)).decode("utf-8")
        return f"{salt.hex()}:{hashed}"
    return _PWH.hash(password)


def verify_password(password: str, stored_hash: str) -> bool:
    """Verify password against stored hash (Argon2id or legacy PBKDF2)."""
    ok, _ = verify_password_and_upgrade(password, stored_hash)
    return ok


def verify_password_and_upgrade(password: str, stored_hash: str) -> Tuple[bool, Optional[str]]:
    """Verify password, and if the stored hash is legacy (or needs rehash),
    return a new Argon2id hash for upgrade.

    Returns: (ok, upgraded_hash_or_None)
    """
    if not stored_hash:
        return False, None

    # Argon2 path
    if _is_argon2_hash(stored_hash) and _PWH is not None:
        try:
            _PWH.verify(stored_hash, password)
            if _PWH.check_needs_rehash(stored_hash):
                return True, _PWH.hash(password)
            return True, None
        except (VerifyMismatchError, VerificationError, InvalidHash):
            return False, None
        except Exception:
            return False, None

    # Legacy PBKDF2 path
    if _is_legacy_pbkdf2_hash(stored_hash):
        ok = _verify_legacy_pbkdf2(password, stored_hash)
        if ok and _PWH is not None:
            return True, _PWH.hash(password)
        return ok, None

    # Unknown format
    return False, None


def get_admin_password(prompt_text: str = "Enter password: ") -> str:
    """Secure prompt for passwords (CLI tools/setup)."""
    return getpass.getpass(prompt_text)


# ────────────────────────────────────────────────────────────
# Small in-process rate limiter (dev-safe; use Redis-backed limiter in prod)
# ────────────────────────────────────────────────────────────
#
# We use this as a centralized guardrail for broad path prefixes (e.g. /admin/*)
# to avoid missing new endpoints accidentally. It is NOT a replacement for
# Flask-Limiter with a shared storage backend in production.

import time
import threading
from collections import deque

_SRL_BUCKETS: dict[str, deque] = {}
_SRL_LOCK = threading.Lock()

def simple_rate_limit(key: str, limit: int, window_sec: int) -> tuple[bool, float]:
    """Sliding-window limiter.

    Returns (ok, retry_after_seconds).
    """
    try:
        limit = int(limit)
    except Exception:
        limit = 0
    try:
        window_sec = int(window_sec)
    except Exception:
        window_sec = 0

    if limit <= 0 or window_sec <= 0:
        return True, 0.0

    now = time.time()
    with _SRL_LOCK:
        dq = _SRL_BUCKETS.get(key)
        if dq is None:
            dq = deque()
            _SRL_BUCKETS[key] = dq
        cutoff = now - window_sec
        while dq and dq[0] < cutoff:
            dq.popleft()
        if len(dq) >= limit:
            retry = (dq[0] + window_sec) - now
            return False, max(0.0, float(retry))
        dq.append(now)
        return True, 0.0
