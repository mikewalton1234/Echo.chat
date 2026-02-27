#!/usr/bin/env python3
"""janitor_runner.py

Run the EchoChat background cleanup loop as a dedicated process.

Why?
- If you run EchoChat under Gunicorn with N workers, starting the janitor thread
  inside each worker creates N janitors.
- Running this as a single service keeps cleanup predictable and light.

Usage:
  python janitor_runner.py --config server_config.json

Or via env:
  ECHOCHAT_CONFIG=/path/to/server_config.json python janitor_runner.py
"""

from __future__ import annotations

import argparse
import os
import time
from pathlib import Path

from constants import CONFIG_FILE
from main import load_settings, apply_env_overrides, configure_logging
from janitor import start_janitor


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="EchoChat janitor runner")
    p.add_argument(
        "--config",
        default=os.environ.get("ECHOCHAT_CONFIG") or CONFIG_FILE,
        help="path to server config JSON",
    )
    return p.parse_args()


def main() -> None:
    args = parse_args()
    settings_path = Path(args.config)

    settings = load_settings(settings_path)
    apply_env_overrides(settings)

    # Use the same logging configuration as the server.
    configure_logging(settings)

    start_janitor(settings)
    # Keep the process alive forever.
    while True:
        time.sleep(3600)


if __name__ == "__main__":
    main()
