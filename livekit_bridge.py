"""
LiveKit integration layer for EchoChat.

Responsibilities:
- Validate LiveKit config
- Choose a LiveKit "sub-room" for a given EchoChat room (Lobby -> Lobby(2) etc.)
- Mint LiveKit access tokens for browser clients

This module is sync-friendly even though the LiveKit server SDK uses asyncio under the hood.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import timedelta
import asyncio
import json
import re
import time
import os
from typing import Any, Dict, Optional, Tuple

try:
    from livekit import api  # type: ignore
except Exception:  # pragma: no cover
    api = None  # type: ignore


@dataclass(frozen=True)
class LiveKitConfig:
    enabled: bool
    api_url: str
    ws_url: str
    api_key: str
    api_secret: str
    token_ttl_seconds: int = 600
    room_prefix: str = "echo-"
    subrooms_enabled: bool = True
    subroom_capacity: int = 50  # 0 => unlimited
    max_subrooms: int = 25
    # cache room counts briefly to avoid hammering server API
    occupancy_cache_ttl_sec: float = 2.0


_LK_ROOM_COUNTS_CACHE: Dict[str, Tuple[float, Dict[str, int]]] = {}  # base_room -> (ts, {lk_room: count})


def _to_ws_url(url: str) -> str:
    url = (url or "").strip()
    if url.startswith("https://"):
        return "wss://" + url[len("https://") :]
    if url.startswith("http://"):
        return "ws://" + url[len("http://") :]
    return url


def get_livekit_config(settings: Dict[str, Any]) -> LiveKitConfig:
    enabled = bool(settings.get("livekit_enabled", False))
    # Prefer env vars for production (keeps secrets out of server_config.json)
    enabled = bool(
        settings.get("livekit_enabled", False)
        if os.getenv("ECHOCHAT_LIVEKIT_ENABLED") is None and os.getenv("LIVEKIT_ENABLED") is None
        else str(os.getenv("ECHOCHAT_LIVEKIT_ENABLED") or os.getenv("LIVEKIT_ENABLED") or "").strip().lower() in {"1", "true", "yes", "on"}
    )

    api_url = str(
        os.getenv("ECHOCHAT_LIVEKIT_API_URL")
        or os.getenv("LIVEKIT_API_URL")
        or os.getenv("LIVEKIT_URL")
        or settings.get("livekit_api_url")
        or settings.get("livekit_url")
        or ""
    ).strip()

    ws_url = str(
        os.getenv("ECHOCHAT_LIVEKIT_WS_URL")
        or os.getenv("LIVEKIT_WS_URL")
        or settings.get("livekit_ws_url")
        or ""
    ).strip()
    if not ws_url and api_url:
        ws_url = _to_ws_url(api_url)

    api_key = str(os.getenv("ECHOCHAT_LIVEKIT_API_KEY") or os.getenv("LIVEKIT_API_KEY") or settings.get("livekit_api_key") or "").strip()
    api_secret = str(os.getenv("ECHOCHAT_LIVEKIT_API_SECRET") or os.getenv("LIVEKIT_API_SECRET") or settings.get("livekit_api_secret") or "").strip()

    ttl = int(settings.get("livekit_token_ttl_seconds", 600) or 600)
    prefix = str(settings.get("livekit_room_prefix", "echo-") or "echo-")
    subrooms_enabled = bool(settings.get("livekit_subrooms_enabled", True))
    capacity = int(settings.get("livekit_subroom_capacity", 50) or 50)
    max_sub = int(settings.get("livekit_max_subrooms", 25) or 25)
    cache_ttl = float(settings.get("livekit_occupancy_cache_ttl_sec", 2.0) or 2.0)

    cfg = LiveKitConfig(
        enabled=enabled,
        api_url=api_url,
        ws_url=ws_url,
        api_key=api_key,
        api_secret=api_secret,
        token_ttl_seconds=max(60, ttl),
        room_prefix=prefix,
        subrooms_enabled=subrooms_enabled,
        subroom_capacity=max(0, capacity),
        max_subrooms=max(1, max_sub),
        occupancy_cache_ttl_sec=max(0.25, cache_ttl),
    )
    return cfg


def _require_livekit(cfg: LiveKitConfig) -> None:
    if not cfg.enabled:
        raise RuntimeError("LiveKit is disabled")
    if api is None:
        raise RuntimeError("Missing dependency: livekit-api (pip install livekit-api)")
    if not cfg.api_url or not cfg.ws_url:
        raise RuntimeError("LiveKit URLs not configured (livekit_api_url / livekit_ws_url)")
    if not cfg.api_key or not cfg.api_secret:
        raise RuntimeError("LiveKit API key/secret missing")


_ROOM_RE = re.compile(r"^[A-Za-z0-9 _\-\.\(\)\[\]\#]{1,80}$")
_SHARD_RE = re.compile(r"^(?P<base>.+?)\s*\((?P<n>\d+)\)\s*$")


def _sanitize_echo_room(room: str) -> str:
    room = (room or "").strip()
    room = re.sub(r"\s+", " ", room)
    if not room:
        raise ValueError("room required")
    if not _ROOM_RE.match(room):
        raise ValueError("room contains invalid characters")
    return room


def parse_room_shard(room: str) -> Tuple[str, Optional[int]]:
    """Return (base, shard_index) where shard_index is 2+ if name ends with '(N)'."""
    room = _sanitize_echo_room(room)
    m = _SHARD_RE.match(room)
    if not m:
        return room, None
    base = m.group("base").strip()
    try:
        n = int(m.group("n"))
    except Exception:
        n = None
    if n and n >= 2:
        return base, n
    return room, None


def livekit_room_name(cfg: LiveKitConfig, base_room: str, shard_index: int = 1) -> str:
    base_room = _sanitize_echo_room(base_room)
    if shard_index <= 1:
        return f"{cfg.room_prefix}{base_room}"
    return f"{cfg.room_prefix}{base_room}({shard_index})"


async def _fetch_room_counts(cfg: LiveKitConfig, lk_names: list[str]) -> Dict[str, int]:
    _require_livekit(cfg)
    lkapi = api.LiveKitAPI(url=cfg.api_url, api_key=cfg.api_key, api_secret=cfg.api_secret)
    try:
        resp = await lkapi.room.list_rooms(api.proto_room.ListRoomsRequest(names=lk_names))
        counts: Dict[str, int] = {n: 0 for n in lk_names}
        for r in getattr(resp, "rooms", []) or []:
            rn = getattr(r, "name", None) or getattr(r, "room", None) or ""
            if rn in counts:
                # Different SDK versions use num_participants; be defensive.
                c = getattr(r, "num_participants", None)
                if c is None:
                    c = getattr(r, "numParticipants", None)
                try:
                    counts[rn] = int(c or 0)
                except Exception:
                    counts[rn] = 0
        return counts
    finally:
        try:
            await lkapi.aclose()
        except Exception:
            pass


def _run_async(coro):
    # Always run in a fresh loop to avoid "already running" issues under eventlet/gevent.
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        try:
            loop.close()
        except Exception:
            pass


def choose_subroom(cfg: LiveKitConfig, echo_room: str) -> Tuple[str, int, Dict[str, int]]:
    """
    Pick an available LiveKit room for the given EchoChat room, based on participant counts.

    Returns (livekit_room_name, shard_index, counts_map).
    """
    _require_livekit(cfg)
    base, requested = parse_room_shard(echo_room)

    max_sub = max(1, int(cfg.max_subrooms))
    names = [livekit_room_name(cfg, base, i) for i in range(1, max_sub + 1)]

    # Cache per base room
    now = time.time()
    cache_key = base
    cached = _LK_ROOM_COUNTS_CACHE.get(cache_key)
    if cached and (now - cached[0]) <= cfg.occupancy_cache_ttl_sec:
        counts = cached[1]
    else:
        try:
            counts = _run_async(_fetch_room_counts(cfg, names))
        except Exception:
            # If API is temporarily unreachable, just use shard 1.
            counts = {n: 0 for n in names}
        _LK_ROOM_COUNTS_CACHE[cache_key] = (now, counts)

    cap = int(cfg.subroom_capacity or 0)
    # Helper: "has room?"
    def ok(n: str) -> bool:
        if cap <= 0:
            return True
        return int(counts.get(n, 0) or 0) < cap

    # If user explicitly requested a shard (Lobby(2)), try it first
    if requested and 1 <= requested <= max_sub:
        n = names[requested - 1]
        if ok(n):
            return n, requested, counts

    # Otherwise choose first available
    for i, n in enumerate(names, start=1):
        if ok(n):
            return n, i, counts

    # All full; fall back to last shard
    return names[-1], max_sub, counts


def mint_access_token(
    cfg: LiveKitConfig,
    *,
    identity: str,
    display_name: str,
    livekit_room: str,
    metadata: Optional[dict] = None,
    can_publish: bool = True,
    can_subscribe: bool = True,
    can_publish_data: bool = True,
) -> str:
    _require_livekit(cfg)
    ttl = timedelta(seconds=int(cfg.token_ttl_seconds))
    grants = api.VideoGrants(
        room_join=True,
        room=livekit_room,
        can_publish=bool(can_publish),
        can_subscribe=bool(can_subscribe),
        can_publish_data=bool(can_publish_data),
    )
    tok = (
        api.AccessToken(cfg.api_key, cfg.api_secret)
        .with_identity(str(identity))
        .with_name(str(display_name or identity))
        .with_ttl(ttl)
        .with_grants(grants)
    )
    if metadata is not None:
        try:
            tok = tok.with_metadata(json.dumps(metadata, separators=(",", ":")))
        except Exception:
            pass
    return tok.to_jwt()
