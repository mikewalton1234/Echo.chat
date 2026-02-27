# NEW FILE
# /home/drdrizzle/Downloads/echo_chat_server_project/server_join.py

import os
import time
import json
import base64
import hmac
import hashlib
from datetime import datetime, timedelta

from encryption import generate_encryption_key_separate
from config import load_config, save_config
from encryption import encrypt_config
from constants import KEY_FILE

PENDING_JOIN_REQUESTS = "pending_join_requests.json"
TOKEN_EXPIRY_MINUTES = 10


def generate_join_token(secret_key: bytes, server_name: str) -> str:
    timestamp = int(time.time())
    message = f"{server_name}:{timestamp}".encode()
    signature = hmac.new(secret_key, message, hashlib.sha256).digest()
    payload = base64.urlsafe_b64encode(message + b":" + signature).decode()
    return payload


def validate_join_token(secret_key: bytes, token: str) -> bool:
    """Validate a join token produced by :func:`generate_join_token`.

    Token encoding:
        base64url( b"<server_name>:<unix_timestamp>:<hmac_sha256_digest_bytes>" )

    Notes:
    - We use rsplit(b":", 2) so server_name may safely contain ':'.
    - We add missing base64 padding defensively.
    """
    try:
        token_b = token.strip().encode()

        # Add missing base64 padding (urlsafe tokens often omit '=')
        token_b += b"=" * (-len(token_b) % 4)

        decoded = base64.urlsafe_b64decode(token_b)

        # Expect exactly 3 parts: name, timestamp, signature
        parts = decoded.rsplit(b":", 2)
        if len(parts) != 3:
            return False

        server_name_b, ts_b, sig = parts
        if not server_name_b or not ts_b or not sig:
            return False

        # HMAC-SHA256 digest is 32 bytes
        if len(sig) != 32:
            return False

        try:
            timestamp = int(ts_b.decode("ascii"))
        except Exception:
            return False

        # Check expiration
        if int(time.time()) - timestamp > TOKEN_EXPIRY_MINUTES * 60:
            return False

        msg = server_name_b + b":" + str(timestamp).encode("ascii")
        expected_sig = hmac.new(secret_key, msg, hashlib.sha256).digest()
        return hmac.compare_digest(expected_sig, sig)

    except Exception:
        return False

def store_pending_request(server_name: str, token: str, meta: dict):
    reqs = []
    if os.path.exists(PENDING_JOIN_REQUESTS):
        with open(PENDING_JOIN_REQUESTS, "r") as f:
            reqs = json.load(f)

    reqs.append({
        "server_name": server_name,
        "token": token,
        "meta": meta,
        "timestamp": datetime.utcnow().isoformat(),
        "status": "pending"
    })

    with open(PENDING_JOIN_REQUESTS, "w") as f:
        json.dump(reqs, f, indent=2)


def approve_request(index: int, encryption_key: bytes) -> dict:
    if not os.path.exists(PENDING_JOIN_REQUESTS):
        raise FileNotFoundError("No join requests to approve.")

    with open(PENDING_JOIN_REQUESTS, "r") as f:
        requests = json.load(f)

    if index < 0 or index >= len(requests):
        raise IndexError("Invalid request index.")

    req = requests[index]
    if req["status"] != "pending":
        raise ValueError("Request already processed.")

    req["status"] = "approved"
    config = load_config(encryption_key)
    encrypted_config = encrypt_config(config, encryption_key)

    # Update file
    with open(PENDING_JOIN_REQUESTS, "w") as f:
        json.dump(requests, f, indent=2)

    return {
        "encrypted_config": base64.b64encode(encrypted_config).decode(),
        "shared_key": base64.b64encode(encryption_key).decode()
    }


def list_pending_requests():
    if not os.path.exists(PENDING_JOIN_REQUESTS):
        return []
    with open(PENDING_JOIN_REQUESTS, "r") as f:
        return json.load(f)
