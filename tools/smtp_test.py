#!/usr/bin/env python3
"""tools/smtp_test.py

Quick SMTP smoke test for EchoChat config.

Usage:
  source .venv/bin/activate
  python tools/smtp_test.py --config server_config.json --to you@example.com

This script ONLY sends a simple plaintext email (no reset tokens).
"""

from __future__ import annotations

import argparse
import json
import sys

from emailer import send_email


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default="server_config.json", help="Path to server_config.json")
    ap.add_argument("--to", required=True, help="Recipient email address")
    ap.add_argument("--subject", default="EchoChat SMTP test", help="Email subject")
    args = ap.parse_args()

    try:
        with open(args.config, "r", encoding="utf-8") as f:
            settings = json.load(f)
    except Exception as e:
        print(f"❌ Could not read config {args.config}: {e}")
        return 2

    ok, info = send_email(
        settings,
        to_email=args.to,
        subject=args.subject,
        body_text="EchoChat SMTP test: if you received this, SMTP is working.",
    )

    if ok:
        print("✅ SMTP test email sent")
        return 0

    print(f"❌ SMTP test failed: {info}")
    # Common hints
    if info == "not_configured":
        print("Hint: set smtp_enabled=true and provide smtp_host/smtp_username/smtp_password in server_config.json")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
