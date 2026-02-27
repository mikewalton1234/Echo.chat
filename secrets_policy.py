"""secrets_policy.py

Central policy for whether EchoChat should persist *secrets* into server_config.json.

Why this exists:
- In production you typically want secrets in environment variables or a secret manager,
  not written back into a config file that may be copied, zipped, or committed.

Default behavior preserves backward compatibility:
- Secrets *may* be persisted unless you disable it via env.

Disable persistence:
  export ECHOCHAT_PERSIST_SECRETS=0
"""

from __future__ import annotations

import os
from typing import Any, Dict


def _env_bool(name: str, default: bool) -> bool:
    v = os.getenv(name)
    if v is None:
        return default
    s = str(v).strip().lower()
    if s in {"1", "true", "yes", "y", "on"}:
        return True
    if s in {"0", "false", "no", "n", "off"}:
        return False
    return default


def persist_secrets_enabled() -> bool:
    """Whether secret values should be written into server_config.json."""
    return _env_bool("ECHOCHAT_PERSIST_SECRETS", True)


# These are *top-level* keys in server_config.json that should be treated as secrets.
SECRET_SETTING_KEYS = {
    # Flask/JWT secrets
    "secret_key",
    "jwt_secret",
    "jwt_secret_key",
    # DB DSN often contains password
    "database_url",
    # Third-party API keys
    "giphy_api_key",
    "livekit_api_key",
    "livekit_api_secret",
    # SMTP
    "smtp_password",
    "smtp_pass",
}


def scrub_secrets_for_persist(settings: Dict[str, Any]) -> Dict[str, Any]:
    """Return a copy of settings with secret keys removed if persistence is disabled."""
    if persist_secrets_enabled():
        return dict(settings)

    out = dict(settings)
    for k in list(out.keys()):
        if k in SECRET_SETTING_KEYS:
            out.pop(k, None)
    return out


def scrub_patch_for_persist(patch: Dict[str, Any]) -> Dict[str, Any]:
    """Return a copy of a patch with secret keys removed if persistence is disabled."""
    if persist_secrets_enabled():
        return dict(patch)
    out = dict(patch)
    for k in list(out.keys()):
        if k in SECRET_SETTING_KEYS:
            out.pop(k, None)
    return out
