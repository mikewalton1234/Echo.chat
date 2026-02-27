#!/usr/bin/env python3
"""permissions.py

Role/permission guards for Echo Chat (PostgreSQL).

This module provides:
  - require_admin / require_super_admin: lightweight session/JWT guards
  - get_user_permissions: RBAC permission resolution
  - require_permission: declarative RBAC decorator

SQLite support has been removed.
"""

from __future__ import annotations

import functools
import logging
from typing import Callable, Iterable, Set

from flask import jsonify, session
from flask_jwt_extended import (
    get_jwt_identity,
    verify_jwt_in_request,
)

from database import get_db


def _safe_verify_jwt(optional: bool = False) -> str | None:
    """Return JWT identity if present/valid, else None.

    For privileged routes, prefer optional=False so a missing/expired access JWT
    produces a 401 (allowing the client to refresh).
    """
    try:
        verify_jwt_in_request(optional=optional)
        return get_jwt_identity()
    except Exception:
        return None


def get_user_permissions(username: str) -> Set[str]:
    """Resolve effective permissions for a username via RBAC tables."""
    if not username:
        return set()

    conn = get_db()
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT DISTINCT p.name
                  FROM users u
                  JOIN user_roles ur ON ur.user_id = u.id
                  JOIN role_permissions rp ON rp.role_id = ur.role_id
                  JOIN permissions p ON p.id = rp.permission_id
                 WHERE u.username = %s;
                """,
                (username,),
            )
            rows = cur.fetchall()
        return {r[0] for r in rows}
    except Exception as e:
        logging.error("RBAC lookup failed for %s: %s", username, e)
        return set()


def check_user_permission(username: str, permission: str) -> bool:
    """True if user has permission through RBAC."""
    return permission in get_user_permissions(username)


def require_permission(permission: str) -> Callable:
    """Decorator: require a specific RBAC permission.

    Notes:
      - Honors session super-admin flag (setup override) if present.
      - Otherwise uses JWT identity + RBAC tables.
    """

    def decorator(func: Callable) -> Callable:
        @functools.wraps(func)
        def wrapper(*args, **kwargs):
            # Session-based super-admin override (first-run admin)
            if session.get("is_super_admin"):
                # Populate JWT context if cookies are present (best-effort),
                # so handlers that call get_jwt_identity() won't crash.
                _safe_verify_jwt(optional=True)
                return func(*args, **kwargs)

            # For RBAC-enforced routes, require an access JWT.
            # We intentionally do NOT fall back to a session username.
            username = _safe_verify_jwt(optional=False)
            if not username:
                return jsonify({"error": "Unauthorized"}), 401

            perms = get_user_permissions(username)
            if permission not in perms:
                logging.warning("Permission denied: %s lacks '%s'", username, permission)
                return jsonify({"error": "Permission denied", "required": permission}), 403

            return func(*args, **kwargs)

        return wrapper

    return decorator


def require_admin(func: Callable) -> Callable:
    """Decorator for admin-only routes.

    Accepts either:
      - session.is_admin flag, or
      - RBAC permission admin:basic (or admin:super)
    """

    @functools.wraps(func)
    def wrapper(*args, **kwargs):
        if session.get("is_super_admin") or session.get("is_admin"):
            _safe_verify_jwt(optional=True)
            return func(*args, **kwargs)

        # Require access JWT for admin-only routes (no session fallback).
        username = _safe_verify_jwt(optional=False)
        if not username:
            return jsonify({"error": "Unauthorized"}), 401

        perms = get_user_permissions(username)
        if "admin:super" in perms or "admin:basic" in perms:
            return func(*args, **kwargs)

        return jsonify({"error": "Admin access required."}), 403

    return wrapper


def require_super_admin(func: Callable) -> Callable:
    """Decorator for super-admin routes.

    Accepts either:
      - session.is_super_admin flag, or
      - RBAC permission admin:super
    """

    @functools.wraps(func)
    def wrapper(*args, **kwargs):
        if session.get("is_super_admin"):
            _safe_verify_jwt(optional=True)
            return func(*args, **kwargs)

        # Privileged endpoints require an access JWT (not just a session cookie).
        username = _safe_verify_jwt(optional=False)
        if not username:
            return jsonify({"error": "Unauthorized"}), 401

        perms = get_user_permissions(username)
        if "admin:super" in perms:
            return func(*args, **kwargs)

        return jsonify({"error": "Super admin access required."}), 403

    return wrapper
