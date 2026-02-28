#!/usr/bin/env python3
"""Smoke test: PM relay + offline queue.

What it checks
- Can register/login two users (via CSRF-protected HTML forms).
- Can connect to Socket.IO with JWT cookie auth.
- Online PM relay works (A -> B delivers immediately).
- Offline PM queue works (B offline, A sends, B reconnects and receives).

This does NOT test E2EE correctness (encryption is client-side in the browser).
It only tests the ciphertext relay/queue path on the backend.

Usage:
  python tools/smoke_test_pm_relay.py --base http://127.0.0.1:5000

Tip:
  Run the server first in another terminal.
"""

from __future__ import annotations

import argparse
import os
import random
import re
import string
import sys
import threading
import time
from dataclasses import dataclass

import requests
import socketio


CSRF_RE = re.compile(r'name="csrf_token"\s+value="([^"]+)"')


def _rand_suffix(n: int = 6) -> str:
    return "".join(random.choice(string.ascii_lowercase + string.digits) for _ in range(n))


def get_csrf(session: requests.Session, url: str) -> str:
    r = session.get(url, timeout=10)
    r.raise_for_status()
    m = CSRF_RE.search(r.text)
    if not m:
        raise RuntimeError(f"Could not find csrf_token in {url}")
    return m.group(1)


def register_user(session: requests.Session, base: str, username: str, password: str, email: str, age: int) -> None:
    csrf = get_csrf(session, f"{base}/register")
    r = session.post(
        f"{base}/register",
        data={
            "csrf_token": csrf,
            "username": username,
            "email": email,
            "password": password,
            "confirm": password,
            "age": str(age),
        },
        allow_redirects=False,
        timeout=10,
    )

    # 302 -> redirect to /login (success)
    if r.status_code in (301, 302, 303, 307, 308):
        return

    # 409 -> already exists (fine for smoke tests)
    if r.status_code == 409:
        return

    if r.status_code >= 400:
        raise RuntimeError(f"register failed: {r.status_code} {r.text[:200]}")


def login_user(session: requests.Session, base: str, username: str, password: str) -> None:
    csrf = get_csrf(session, f"{base}/login")
    r = session.post(
        f"{base}/login",
        data={
            "csrf_token": csrf,
            "username": username,
            "password": password,
        },
        allow_redirects=False,
        timeout=10,
    )

    if r.status_code in (301, 302, 303, 307, 308):
        return

    raise RuntimeError(f"login failed: {r.status_code} {r.text[:200]}")


def cookie_header_from_session(session: requests.Session) -> str:
    parts = []
    for c in session.cookies:
        parts.append(f"{c.name}={c.value}")
    return "; ".join(parts)


@dataclass
class SioWrap:
    sio: socketio.Client
    received: list
    event: threading.Event


def make_client(base: str, cookie_header: str) -> SioWrap:
    sio = socketio.Client(logger=False, engineio_logger=False)
    received = []
    event = threading.Event()

    @sio.on("private_message")
    def _on_pm(data):
        received.append(data)
        event.set()

    # Add cookie header for JWT cookie auth
    sio.connect(
        base,
        headers={
            "Cookie": cookie_header,
        },
        transports=["websocket"],
        wait_timeout=10,
    )

    return SioWrap(sio=sio, received=received, event=event)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default=os.environ.get("ECHOCHAT_BASE", "http://127.0.0.1:5000"))
    ap.add_argument("--user-a", default=f"smokea_{_rand_suffix()}")
    ap.add_argument("--user-b", default=f"smokeb_{_rand_suffix()}")
    ap.add_argument("--password", default="TestPassw0rd!123")
    args = ap.parse_args()

    base = args.base.rstrip("/")

    # 1) Register + login both users
    sa = requests.Session()
    sb = requests.Session()

    register_user(sa, base, args.user_a, args.password, f"{args.user_a}@example.com", 30)
    register_user(sb, base, args.user_b, args.password, f"{args.user_b}@example.com", 31)

    login_user(sa, base, args.user_a, args.password)
    login_user(sb, base, args.user_b, args.password)

    ca = cookie_header_from_session(sa)
    cb = cookie_header_from_session(sb)

    # 2) Socket.IO connect
    A = make_client(base, ca)
    B = make_client(base, cb)

    try:
        # 3) Online PM
        B.event.clear()
        cipher1 = "EC1:" + "T05MSU5F"  # base64('ONLINE')
        res = A.sio.call("send_direct_message", {"to": args.user_b, "cipher": cipher1}, timeout=10)
        if not (isinstance(res, dict) and res.get("success")):
            print(f"❌ send_direct_message ack failed: {res}")
            return 2

        if not B.event.wait(10):
            print("❌ Online PM not received")
            return 3

        print("✅ Online PM relay OK")

        # 4) Offline PM (disconnect B, send, reconnect)
        B.sio.disconnect()

        cipher2 = "EC1:" + "T0ZGTElORQ=="  # base64('OFFLINE')
        res2 = A.sio.call("send_direct_message", {"to": args.user_b, "cipher": cipher2}, timeout=10)
        if not (isinstance(res2, dict) and res2.get("success")):
            print(f"❌ send_direct_message ack failed (offline): {res2}")
            return 4

        # reconnect B
        B2 = make_client(base, cb)
        try:
            B2.event.clear()
            # offline delivery happens on connect; give it a moment
            if not B2.event.wait(10):
                print("❌ Offline PM not delivered on reconnect")
                return 5
            print("✅ Offline PM queue OK")
        finally:
            try:
                B2.sio.disconnect()
            except Exception:
                pass

        print("\n🎉 Smoke test PASSED")
        return 0

    finally:
        try:
            A.sio.disconnect()
        except Exception:
            pass
        try:
            if B.sio.connected:
                B.sio.disconnect()
        except Exception:
            pass


if __name__ == "__main__":
    raise SystemExit(main())
