"""Shared in-memory state for EchoChat Socket.IO handlers.

This module centralizes mutable runtime state so handler modules can be split
without creating circular imports.
"""

import threading

# Shared in-memory state
_SEND_HISTORY = {}
CONNECTED_USERS: dict[str, dict] = {}
TYPING_STATUS: dict[str, float] = {}
TYPING_EXPIRY_SECONDS = 5

CONNECTED_USERS_LOCK = threading.Lock()
TYPING_STATUS_LOCK = threading.Lock()

# WebRTC P2P file transfer sessions
P2P_FILE_SESSIONS: dict[str, dict] = {}
P2P_FILE_SESSIONS_LOCK = threading.Lock()

# 1:1 voice call sessions (DM-like)
VOICE_DM_SESSIONS: dict[str, dict] = {}
VOICE_DM_SESSIONS_LOCK = threading.Lock()

# Message reactions (pre-alpha) — in-memory only
MESSAGE_REACTIONS: dict[str, dict] = {}
MESSAGE_REACTIONS_LOCK = threading.Lock()

# Voice chat room roster — in-memory
VOICE_ROOMS: dict[str, set[str]] = {}
VOICE_ROOMS_LOCK = threading.Lock()

# Simple anti-spam for voice call invites (per-socket)
VOICE_INVITE_LAST: dict[str, float] = {}  # sid -> epoch

# Default allowed reactions
ALLOWED_REACTION_EMOJIS = {"👍", "👎", "😂", "❤️", "😮", "😢", "😡"}
