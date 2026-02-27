#!/usr/bin/env python3
"""routes_main.py

General (non-auth) routes.

Changes in this update:
  - Removed duplicate /chat and /api/rooms routes (single /chat lives in routes_auth.py;
    rooms API lives in routes_chat.py).
  - Removed JSON-backed room endpoints (PostgreSQL is the single source of truth).
"""

from __future__ import annotations

import logging
import os
import secrets
import time
import ipaddress
import urllib.parse
import urllib.request
import requests
from datetime import datetime, timezone
from pathlib import Path

from flask import jsonify, request, send_file
from flask_jwt_extended import get_jwt_identity, jwt_required
from werkzeug.utils import secure_filename

from database import get_db
from security import log_audit_event
from moderation import is_user_sanctioned


def register_main_routes(app, settings, socketio):
    upload_folder = os.path.join(app.static_folder or "www", "uploads")
    os.makedirs(upload_folder, exist_ok=True)

    # Encrypted DM file storage (NOT publicly served)
    dm_upload_root = settings.get("dm_upload_root") or os.path.join(os.getcwd(), "uploads", "dm_files")
    os.makedirs(dm_upload_root, exist_ok=True)
    max_dm_file_bytes = int(settings.get("max_dm_file_bytes", 10 * 1024 * 1024))
    # Encrypted Group file storage (NOT publicly served)
    group_upload_root = settings.get("group_upload_root") or os.path.join(os.getcwd(), "uploads", "group_files")
    os.makedirs(group_upload_root, exist_ok=True)
    max_group_file_bytes = int(settings.get("max_group_file_bytes", max_dm_file_bytes))
    disable_group_files_globally = bool(
        settings.get("disable_group_files_globally", False)
        or settings.get("disable_file_transfer_globally", False)
    )

    # ------------------------------------------------------------------
    # Local helper: Flask-Limiter decorator (no-op if Limiter is not active)
    # ------------------------------------------------------------------
    _limiter = (app.extensions.get("limiter")
               or app.extensions.get("flask_limiter")
               or app.extensions.get("flask-limiter"))

    def _limit(rule: str):
        """Decorate a route with a rate limit if Limiter is initialized."""
        if _limiter is not None:
            try:
                return _limiter.limit(rule)
            except Exception:
                # If Limiter is misconfigured, fail open rather than breaking boot.
                pass
        def _decorator(fn):
            return fn
        return _decorator


    # ------------------------------------------------------------------
    # Torrent scrape (swarm stats) tuning
    #
    # Tracker scrapes can be slow/unreliable; we keep the endpoint fast and
    # cache results briefly to avoid repeated outbound requests.
    # ------------------------------------------------------------------
    _TORRENT_SCRAPE_CACHE: dict[str, tuple[float, int | None, int | None, int | None]] = {}
    _TORRENT_SCRAPE_CACHE_TTL = float(settings.get("torrent_scrape_cache_ttl_sec", 120))
    _TORRENT_SCRAPE_MAX_TRIES = int(settings.get("torrent_scrape_max_tries", 4))
    _TORRENT_SCRAPE_HTTP_TIMEOUT = float(settings.get("torrent_scrape_http_timeout_sec", 1.5))
    _TORRENT_SCRAPE_UDP_TIMEOUT = float(settings.get("torrent_scrape_udp_timeout_sec", 1.5))

    def _either_blocked(a: str, b: str) -> bool:
        conn = get_db()
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT 1
                  FROM blocks
                 WHERE (blocker = %s AND blocked = %s)
                    OR (blocker = %s AND blocked = %s)
                 LIMIT 1;
                """,
                (a, b, b, a),
            )
            return cur.fetchone() is not None

    @app.route("/")
    @jwt_required(optional=True)
    def index():
        user = get_jwt_identity()
        if user:
            greeting = f"Welcome, {user}!"
            links = "<a href='/chat'>Chat</a> | <a href='/logout'>Logout</a>"
        else:
            greeting = "Welcome, Guest!"
            links = "<a href='/login'>Login</a> | <a href='/register'>Register</a>"

        return f"""
        <h1>{settings.get('server_name')}</h1>
        <p>{greeting}</p>
        <p>{links}</p>
        """

    # Health check is optional and should be safe for unauthenticated probes.
    if settings.get("enable_health_check_endpoint", False):
        endpoint = settings.get("health_check_endpoint") or "/health"

        @app.route(endpoint, methods=["GET"])
        def health_check():
            # Minimal health payload. Avoid leaking config.
            db_ok = True
            try:
                conn = get_db()
                with conn.cursor() as cur:
                    cur.execute("SELECT 1;")
                    cur.fetchone()
            except Exception:
                db_ok = False

            return (
                jsonify(
                    {
                        "status": "ok" if db_ok else "degraded",
                        "db": "ok" if db_ok else "down",
                        "time": datetime.now(timezone.utc).isoformat(),
                    }
                ),
                200 if db_ok else 503,
            )

    
    # ------------------------------------------------------------------
    # GIPHY GIF search (server-side proxy; keeps API key off the client)
    # ------------------------------------------------------------------
    _GIPHY_CACHE: dict[tuple[str, int, str, str], tuple[float, list[dict]]] = {}
    _GIPHY_CACHE_TTL = float(settings.get("giphy_cache_ttl_sec", 45))

    def _read_giphy_key_file() -> str | None:
        """Best-effort read of a local key file for GIPHY.

        Allows keeping the API key out of server_config.json by placing it in:
          - .giphy_api_key
          - giphy_api_key.txt
        (either in the project root / CWD, or next to this module).
        """
        try:
            base_dir = Path(__file__).resolve().parent
            candidates = [
                Path.cwd() / ".giphy_api_key",
                Path.cwd() / "giphy_api_key.txt",
                base_dir / ".giphy_api_key",
                base_dir / "giphy_api_key.txt",
            ]
            for p in candidates:
                try:
                    if p.exists():
                        v = p.read_text(encoding="utf-8").strip()
                        if v:
                            return v
                except Exception:
                    continue
        except Exception:
            pass
        return None

    def _get_giphy_key() -> str | None:
        # Prefer env var; optionally allow config file value or a local key file.
        return (
            os.getenv("ECHOCHAT_GIPHY_API_KEY")
            or os.getenv("GIPHY_API_KEY")
            or settings.get("giphy_api_key")
            or _read_giphy_key_file()
            or ""
        ).strip() or None

    @app.route("/api/gifs/search", methods=["GET"])
    @_limit(settings.get("rate_limit_gif_search") or "120 per minute")
    @jwt_required()
    def api_gifs_search():
        if not bool(settings.get("giphy_enabled", True)):
            return jsonify({"success": False, "error": "GIF search disabled"}), 403

        api_key = _get_giphy_key()
        if not api_key:
            return jsonify({"success": False, "error": "GIPHY_API_KEY not set"}), 500

        q = (request.args.get("q") or "").strip()
        if not q:
            return jsonify({"success": True, "data": []})

        # Hard bounds to avoid abuse
        q = q[:120]
        try:
            limit = int(request.args.get("limit") or settings.get("giphy_default_limit", 24))
        except Exception:
            limit = int(settings.get("giphy_default_limit", 24))
        limit = max(1, min(limit, 48))

        rating = str(settings.get("giphy_rating", "pg-13") or "pg-13")
        lang = str(settings.get("giphy_lang", "en") or "en")

        cache_key = (q.lower(), limit, rating, lang)
        now = time.time()
        hit = _GIPHY_CACHE.get(cache_key)
        if hit and (now - hit[0]) < _GIPHY_CACHE_TTL:
            return jsonify({"success": True, "data": hit[1]})

        try:
            resp = requests.get(
                "https://api.giphy.com/v1/gifs/search",
                params={
                    "api_key": api_key,
                    "q": q,
                    "limit": limit,
                    "rating": rating,
                    "lang": lang,
                },
                timeout=6,
            )
            resp.raise_for_status()
            payload = resp.json() or {}
        except Exception as e:
            logging.warning("GIPHY search failed: %s", e)
            return jsonify({"success": False, "error": "GIF search failed"}), 502

        out: list[dict] = []
        for item in (payload.get("data") or []):
            try:
                images = (item.get("images") or {})
                fixed = (images.get("fixed_width") or {})
                preview = (images.get("fixed_width_small") or fixed)
                url = (fixed.get("url") or "").strip()
                pv = (preview.get("url") or "").strip()
                if not url:
                    continue
                out.append(
                    {
                        "id": item.get("id"),
                        "title": item.get("title") or "",
                        "url": url,
                        "preview": pv or url,
                    }
                )
            except Exception:
                continue

        # Cache briefly
        _GIPHY_CACHE[cache_key] = (now, out)
        return jsonify({"success": True, "data": out})
    @app.route("/upload", methods=["POST"])
    @_limit(settings.get("rate_limit_upload") or "20 per minute")
    @jwt_required()
    def upload_file():
        user = get_jwt_identity()
        if "file" not in request.files or "to" not in request.form:
            return jsonify({"error": "Missing file or recipient"}), 400

        file = request.files["file"]
        if file.filename == "":
            return jsonify({"error": "No selected file"}), 400

        filename = secure_filename(file.filename)
        filepath = os.path.join(upload_folder, filename)
        file.save(filepath)

        receiver = request.form["to"]
        try:
            conn = get_db()
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO messages (sender, receiver, message, is_encrypted)
                    VALUES (%s, %s, %s, FALSE)
                    RETURNING id;
                    """,
                    (user, receiver, f"[file] {filename}"),
                )
                message_id = cur.fetchone()[0]

                cur.execute(
                    """
                    INSERT INTO file_attachments (message_id, file_path, file_type, file_size)
                    VALUES (%s, %s, %s, %s);
                    """,
                    (
                        message_id,
                        f"/static/uploads/{filename}",
                        file.content_type,
                        os.path.getsize(filepath),
                    ),
                )
            conn.commit()
        except Exception as e:
            logging.error("[DB ERROR] Failed to save uploaded file record: %s", e)
            return jsonify({"error": "Database failure"}), 500

        log_audit_event(user, "file_upload", receiver, filename)
        return jsonify({"status": "uploaded", "file": filename})


    # ------------------------------------------------------------------
    # Encrypted DM file transfers (ciphertext-only)
    # ------------------------------------------------------------------
    @app.route("/api/dm_files/upload", methods=["POST"])
    @_limit(settings.get("rate_limit_dm_file_upload") or "10 per minute")
    @jwt_required()
    def upload_dm_file_ciphertext():
        """Upload an encrypted DM file blob.

        Client sends multipart/form-data:
          - to (recipient username)
          - file (ciphertext blob)
          - iv_b64
          - ek_to_b64
          - ek_from_b64
          - sha256 (optional; plaintext hash, client-provided)
          - original_name (optional; fallback to file.filename)
          - mime_type (optional; fallback to file.content_type)
        """
        user = get_jwt_identity()

        # Basic multipart validation
        if "file" not in request.files:
            return jsonify({"success": False, "error": "Missing file"}), 400

        to_user = (request.form.get("to") or "").strip()
        if not to_user:
            return jsonify({"success": False, "error": "Missing recipient"}), 400
        if to_user == user:
            return jsonify({"success": False, "error": "Cannot send file to yourself"}), 400

        # Match Socket.IO DM policy: banned users can't do anything; muted users
        # cannot send.
        if is_user_sanctioned(user, "ban"):
            return jsonify({"success": False, "error": "You are banned."}), 403
        if is_user_sanctioned(user, "mute"):
            return jsonify({"success": False, "error": "You are muted."}), 403

        # Block policy: either direction blocks file sends.
        if _either_blocked(user, to_user):
            return jsonify({"success": False, "error": "You cannot send files to this user."}), 403

        # Ensure recipient exists.
        try:
            conn = get_db()
            with conn.cursor() as cur:
                cur.execute("SELECT 1 FROM users WHERE username = %s LIMIT 1;", (to_user,))
                if cur.fetchone() is None:
                    return jsonify({"success": False, "error": "Recipient not found"}), 404
        except Exception as e:
            logging.error("[DB ERROR] recipient lookup failed: %s", e)
            return jsonify({"success": False, "error": "Database failure"}), 500

        iv_b64 = (request.form.get("iv_b64") or "").strip()
        ek_to_b64 = (request.form.get("ek_to_b64") or "").strip()
        ek_from_b64 = (request.form.get("ek_from_b64") or "").strip()
        if not iv_b64 or not ek_to_b64 or not ek_from_b64:
            return jsonify({"success": False, "error": "Missing encryption envelope fields"}), 400

        # Lightweight upload size guard. request.content_length includes form overhead,
        # so allow a small cushion.
        try:
            if request.content_length and request.content_length > (max_dm_file_bytes + 256_000):
                return jsonify({"success": False, "error": f"File too large (max {max_dm_file_bytes} bytes)"}), 413
        except Exception:
            pass

        f = request.files["file"]
        if not f or f.filename == "":
            return jsonify({"success": False, "error": "Empty filename"}), 400

        original_name = (request.form.get("original_name") or "").strip() or f.filename
        original_name = secure_filename(original_name) or "file.bin"
        mime_type = (request.form.get("mime_type") or "").strip() or (f.content_type or "application/octet-stream")
        sha256 = (request.form.get("sha256") or "").strip() or None

        # Store ciphertext to disk
        file_id = os.urandom(16).hex()
        storage_path = os.path.join(dm_upload_root, f"{file_id}.bin")
        try:
            f.save(storage_path)
            size = int(os.path.getsize(storage_path))
        except Exception as e:
            logging.error("[UPLOAD ERROR] dm_files save failed: %s", e)
            try:
                if os.path.exists(storage_path):
                    os.remove(storage_path)
            except Exception:
                pass
            return jsonify({"success": False, "error": "Upload failed"}), 500

        if size > max_dm_file_bytes:
            try:
                os.remove(storage_path)
            except Exception:
                pass
            return jsonify({"success": False, "error": f"File too large (max {max_dm_file_bytes} bytes)"}), 413

        # Persist metadata
        try:
            conn = get_db()
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO dm_files (
                        file_id, sender, receiver, original_name, mime_type,
                        file_size, sha256, storage_path, iv_b64, ek_to_b64, ek_from_b64
                    ) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s);
                    """,
                    (
                        file_id,
                        user,
                        to_user,
                        original_name,
                        mime_type,
                        size,
                        sha256,
                        storage_path,
                        iv_b64,
                        ek_to_b64,
                        ek_from_b64,
                    ),
                )
            conn.commit()
        except Exception as e:
            logging.error("[DB ERROR] dm_files insert failed: %s", e)
            try:
                os.remove(storage_path)
            except Exception:
                pass
            return jsonify({"success": False, "error": "Database failure"}), 500

        log_audit_event(user, "dm_file_upload", to_user, original_name)
        return jsonify({
            "success": True,
            "file_id": file_id,
            "name": original_name,
            "mime": mime_type,
            "size": size,
        })


    def _get_dm_file_row(file_id: str):
        conn = get_db()
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT sender, receiver, original_name, mime_type, file_size, sha256,
                       storage_path, iv_b64, ek_to_b64, ek_from_b64, revoked
                  FROM dm_files
                 WHERE file_id = %s;
                """,
                (file_id,),
            )
            row = cur.fetchone()
        return row


    @app.route("/api/dm_files/<file_id>/meta", methods=["GET"])
    @_limit(settings.get("rate_limit_dm_file_meta") or "240 per minute")
    @jwt_required()
    def dm_file_meta(file_id: str):
        user = get_jwt_identity()
        row = _get_dm_file_row(file_id)
        if not row:
            return jsonify({"success": False, "error": "Not found"}), 404

        sender, receiver, original_name, mime_type, file_size, sha256, storage_path, iv_b64, ek_to_b64, ek_from_b64, revoked = row
        if revoked:
            return jsonify({"success": False, "error": "Not found"}), 404

        if user != sender and user != receiver:
            return jsonify({"success": False, "error": "Forbidden"}), 403

        ek_b64 = ek_to_b64 if user == receiver else ek_from_b64
        return jsonify({
            "success": True,
            "file_id": file_id,
            "name": original_name,
            "mime": mime_type,
            "size": int(file_size),
            "sha256": sha256,
            "iv_b64": iv_b64,
            "ek_b64": ek_b64,
        })


    @app.route("/api/dm_files/<file_id>/blob", methods=["GET"])
    @_limit(settings.get("rate_limit_dm_file_blob") or "240 per minute")
    @jwt_required()
    def dm_file_blob(file_id: str):
        user = get_jwt_identity()
        row = _get_dm_file_row(file_id)
        if not row:
            return jsonify({"success": False, "error": "Not found"}), 404

        sender, receiver, original_name, mime_type, file_size, sha256, storage_path, iv_b64, ek_to_b64, ek_from_b64, revoked = row
        if revoked:
            return jsonify({"success": False, "error": "Not found"}), 404

        if user != sender and user != receiver:
            return jsonify({"success": False, "error": "Forbidden"}), 403

        if not storage_path or not os.path.exists(storage_path):
            return jsonify({"success": False, "error": "Not found"}), 404

        # Send ciphertext blob. Client will decrypt locally.
        return send_file(
            storage_path,
            mimetype="application/octet-stream",
            as_attachment=False,
            download_name=f"{file_id}.bin",
            conditional=True,
        )

    

    
    # ------------------------------------------------------------------
    # Encrypted Group file routes (ciphertext-only; server cannot decrypt)
    # ------------------------------------------------------------------
    def _is_group_member_username(group_id: int, username: str) -> bool:
        try:
            conn = get_db()
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT 1
                      FROM group_members gm
                      JOIN users u ON u.id = gm.user_id
                     WHERE gm.group_id = %s AND u.username = %s
                     LIMIT 1;
                    """,
                    (group_id, username),
                )
                return cur.fetchone() is not None
        except Exception:
            return False

    def _get_group_member_usernames(group_id: int) -> list[str]:
        conn = get_db()
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT u.username
                  FROM group_members gm
                  JOIN users u ON u.id = gm.user_id
                 WHERE gm.group_id = %s
                 ORDER BY u.username;
                """,
                (group_id,),
            )
            return [r[0] for r in cur.fetchall()]

    def _is_group_muted(group_id: int, username: str) -> bool:
        try:
            conn = get_db()
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT 1 FROM group_mutes WHERE group_id=%s AND username=%s LIMIT 1;",
                    (group_id, username),
                )
                return cur.fetchone() is not None
        except Exception:
            return False

    def _get_group_file_row(file_id: str):
        conn = get_db()
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT group_id, sender, original_name, mime_type, file_size, sha256,
                       storage_path, iv_b64, ek_map_json, revoked
                  FROM group_files
                 WHERE file_id = %s;
                """,
                (file_id,),
            )
            return cur.fetchone()

    @app.route("/api/group_files/upload", methods=["POST"])
    @_limit(settings.get("rate_limit_group_file_upload") or "10 per minute")
    @jwt_required()
    def upload_group_file_ciphertext():
        """Upload an encrypted Group file blob.

        Client sends multipart/form-data:
          - group_id (int)
          - file (ciphertext blob)
          - iv_b64
          - ek_map_json (JSON map: username -> wrapped AES key b64)
          - sha256 (optional; plaintext hash, client-provided)
          - original_name (optional; fallback to file.filename)
          - mime_type (optional; fallback to file.content_type)
        """
        user = get_jwt_identity()

        if disable_group_files_globally:
            return jsonify({"success": False, "error": "File sharing is disabled"}), 403

        if "file" not in request.files:
            return jsonify({"success": False, "error": "Missing file"}), 400

        try:
            group_id = int((request.form.get("group_id") or "").strip())
        except Exception:
            return jsonify({"success": False, "error": "Missing group_id"}), 400

        # Sanctions: banned users can't do anything; muted users cannot send.
        if is_user_sanctioned(user, "ban"):
            return jsonify({"success": False, "error": "You are banned."}), 403
        if is_user_sanctioned(user, "mute"):
            return jsonify({"success": False, "error": "You are muted."}), 403
        if _is_group_muted(group_id, user):
            return jsonify({"success": False, "error": "You are muted in this group."}), 403

        if not _is_group_member_username(group_id, user):
            # No group existence leak
            return jsonify({"success": False}), 403

        iv_b64 = (request.form.get("iv_b64") or "").strip()
        ek_map_json = (request.form.get("ek_map_json") or "").strip()
        if not iv_b64 or not ek_map_json:
            return jsonify({"success": False, "error": "Missing encryption envelope fields"}), 400

        # Parse key map
        try:
            ek_map = json.loads(ek_map_json)
            if not isinstance(ek_map, dict) or not ek_map:
                raise ValueError("bad map")
        except Exception:
            return jsonify({"success": False, "error": "Bad ek_map_json"}), 400

        # Enforce: must include keys for all current members (ciphertext-only guarantee)
        try:
            members = _get_group_member_usernames(group_id)
        except Exception:
            members = []
        if not members:
            return jsonify({"success": False, "error": "Group not found"}), 404
        missing = [u for u in members if u not in ek_map]
        if missing:
            return jsonify({"success": False, "error": "Missing keys for some group members"}), 400
        if user not in ek_map:
            return jsonify({"success": False, "error": "Missing sender key"}), 400

        # Size guard (includes multipart overhead, allow cushion)
        try:
            if request.content_length and request.content_length > (max_group_file_bytes + 256_000):
                return jsonify({"success": False, "error": f"File too large (max {max_group_file_bytes} bytes)"}), 413
        except Exception:
            pass

        f = request.files["file"]
        if not f or f.filename == "":
            return jsonify({"success": False, "error": "Empty filename"}), 400

        original_name = (request.form.get("original_name") or "").strip() or f.filename
        original_name = secure_filename(original_name) or "file.bin"
        mime_type = (request.form.get("mime_type") or "").strip() or (f.content_type or "application/octet-stream")
        sha256 = (request.form.get("sha256") or "").strip() or None

        file_id = os.urandom(16).hex()
        storage_path = os.path.join(group_upload_root, f"{file_id}.bin")
        try:
            f.save(storage_path)
            size = int(os.path.getsize(storage_path))
        except Exception as e:
            logging.error("[UPLOAD ERROR] group_files save failed: %s", e)
            try:
                if os.path.exists(storage_path):
                    os.remove(storage_path)
            except Exception:
                pass
            return jsonify({"success": False, "error": "Upload failed"}), 500

        if size > max_group_file_bytes:
            try:
                os.remove(storage_path)
            except Exception:
                pass
            return jsonify({"success": False, "error": f"File too large (max {max_group_file_bytes} bytes)"}), 413

        # Persist metadata
        try:
            conn = get_db()
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO group_files (
                        file_id, group_id, sender, original_name, mime_type,
                        file_size, sha256, storage_path, iv_b64, ek_map_json
                    ) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s);
                    """,
                    (
                        file_id,
                        group_id,
                        user,
                        original_name,
                        mime_type,
                        size,
                        sha256,
                        storage_path,
                        iv_b64,
                        json.dumps(ek_map),
                    ),
                )
            conn.commit()
        except Exception as e:
            logging.error("[DB ERROR] group_files insert failed: %s", e)
            try:
                os.remove(storage_path)
            except Exception:
                pass
            return jsonify({"success": False, "error": "Database failure"}), 500

        log_audit_event(user, "group_file_upload", str(group_id), original_name)
        return jsonify({
            "success": True,
            "group_id": group_id,
            "file_id": file_id,
            "name": original_name,
            "mime": mime_type,
            "size": size,
            "sha256": sha256,
        })

    @app.route("/api/group_files/<file_id>/meta", methods=["GET"])
    @_limit(settings.get("rate_limit_group_file_meta") or "240 per minute")
    @jwt_required()
    def group_file_meta(file_id: str):
        user = get_jwt_identity()
        row = _get_group_file_row(file_id)
        if not row:
            return jsonify({"success": False, "error": "Not found"}), 404

        group_id, sender, original_name, mime_type, file_size, sha256, storage_path, iv_b64, ek_map_json, revoked = row
        if revoked:
            return jsonify({"success": False, "error": "Not found"}), 404

        if not _is_group_member_username(int(group_id), user):
            return jsonify({"success": False, "error": "Forbidden"}), 403

        try:
            ek_map = json.loads(ek_map_json or "{}")
        except Exception:
            ek_map = {}
        ek_b64 = ek_map.get(user)
        if not ek_b64:
            return jsonify({"success": False, "error": "Forbidden"}), 403

        return jsonify({
            "success": True,
            "file_id": file_id,
            "group_id": int(group_id),
            "sender": sender,
            "name": original_name,
            "mime": mime_type,
            "size": int(file_size),
            "sha256": sha256,
            "iv_b64": iv_b64,
            "ek_b64": ek_b64,
        })

    @app.route("/api/group_files/<file_id>/blob", methods=["GET"])
    @_limit(settings.get("rate_limit_group_file_blob") or "240 per minute")
    @jwt_required()
    def group_file_blob(file_id: str):
        user = get_jwt_identity()
        row = _get_group_file_row(file_id)
        if not row:
            return jsonify({"success": False, "error": "Not found"}), 404

        group_id, sender, original_name, mime_type, file_size, sha256, storage_path, iv_b64, ek_map_json, revoked = row
        if revoked:
            return jsonify({"success": False, "error": "Not found"}), 404

        if not _is_group_member_username(int(group_id), user):
            return jsonify({"success": False, "error": "Forbidden"}), 403

        if not storage_path or not os.path.exists(storage_path):
            return jsonify({"success": False, "error": "Not found"}), 404

        # Send ciphertext blob. Client will decrypt locally.
        return send_file(
            storage_path,
            mimetype="application/octet-stream",
            as_attachment=False,
            download_name=f"{file_id}.bin",
            conditional=True,
        )

# ───────────────────────────────────────────────────────────────────────────
    # Torrent helpers (room sharing + tracker scrape)
    # ───────────────────────────────────────────────────────────────────────────
    torrents_root = settings.get("torrents_root") or os.path.join(os.getcwd(), "uploads", "torrents")
    os.makedirs(torrents_root, exist_ok=True)

    def _bdecode(data: bytes, idx: int = 0):
        """Minimal bencode decoder for tracker scrape responses."""
        if idx >= len(data):
            raise ValueError("bencode: out of range")

        c = data[idx:idx+1]
        if c == b"i":
            end = data.index(b"e", idx)
            num = int(data[idx+1:end])
            return num, end + 1

        if c == b"l":
            idx += 1
            out = []
            while data[idx:idx+1] != b"e":
                v, idx = _bdecode(data, idx)
                out.append(v)
            return out, idx + 1

        if c == b"d":
            idx += 1
            out = {}
            while data[idx:idx+1] != b"e":
                k, idx = _bdecode(data, idx)
                v, idx = _bdecode(data, idx)
                out[k] = v
            return out, idx + 1

        # bytes: <len>:<payload>
        colon = data.index(b":", idx)
        ln = int(data[idx:colon])
        start = colon + 1
        end = start + ln
        return data[start:end], end


    def _is_local_host(host: str) -> bool:
        host = (host or "").strip().lower()
        if not host:
            return True
        if host in ("localhost",) or host.endswith(".local"):
            return True
        try:
            ip = ipaddress.ip_address(host)
            return bool(ip.is_private or ip.is_loopback or ip.is_link_local)
        except ValueError:
            # Non-IP host; allow (can't resolve safely here).
            return False

    def _safe_http_tracker_candidates(url: str) -> list[str]:
        """Return 0..N safe HTTP(S) tracker endpoints to try for scrape.

        Trackers are often provided as *announce* URLs. For HTTP(S) trackers,
        scrape is usually at a sibling endpoint (announce -> scrape).
        We try a few best-effort candidates rather than hard-forcing /scrape.
        """
        out: list[str] = []
        try:
            p = urllib.parse.urlparse(url)
            if p.scheme not in ("http", "https"):
                return []
            host = (p.hostname or "").strip().lower()
            if _is_local_host(host):
                return []

            # Baseline: keep original path, drop query/fragment
            base = urllib.parse.urlunparse((p.scheme, p.netloc, p.path or "/", "", "", ""))
            if base:
                out.append(base)

            path = p.path or "/"
            scrape_path = None
            if path.endswith("/announce"):
                scrape_path = path[:-len("/announce")] + "/scrape"
            elif path.endswith("/announce/"):
                scrape_path = path[:-len("/announce/")] + "/scrape/"
            elif path.endswith("announce.php"):
                scrape_path = path[:-len("announce.php")] + "scrape.php"
            elif "/announce" in path:
                # last segment replacement
                left, _ = path.rsplit("/announce", 1)
                scrape_path = left + "/scrape"

            if scrape_path:
                cand = urllib.parse.urlunparse((p.scheme, p.netloc, scrape_path, "", "", ""))
                if cand and cand not in out:
                    out.append(cand)

        except Exception:
            return []
        return out

    def _safe_udp_tracker(url: str) -> tuple[str, int] | None:
        try:
            p = urllib.parse.urlparse(url)
            if p.scheme != "udp":
                return None
            host = (p.hostname or "").strip().lower()
            if _is_local_host(host):
                return None
            port = int(p.port or 0)
            if port <= 0 or port > 65535:
                return None
            return host, port
        except Exception:
            return None

    def _udp_tracker_scrape(host: str, port: int, infohash: bytes) -> tuple[int | None, int | None, int | None]:
        """BEP 15: UDP tracker connect + scrape. Returns (seeders, leechers, completed)."""
        import os
        import socket
        import struct

        # connect request
        conn_id = 0x41727101980
        trans_id = int.from_bytes(os.urandom(4), "big")
        pkt = struct.pack(">QLL", conn_id, 0, trans_id)

        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.settimeout(_TORRENT_SCRAPE_UDP_TIMEOUT)
        try:
            s.sendto(pkt, (host, port))
            resp, _ = s.recvfrom(2048)
            if len(resp) < 16:
                return None, None, None
            action, r_trans, r_conn = struct.unpack(">LLQ", resp[:16])
            if action != 0 or r_trans != trans_id:
                return None, None, None

            # scrape request (action=2)
            trans_id2 = int.from_bytes(os.urandom(4), "big")
            pkt2 = struct.pack(">QLL", r_conn, 2, trans_id2) + infohash
            s.sendto(pkt2, (host, port))
            resp2, _ = s.recvfrom(2048)
            if len(resp2) < 20:
                return None, None, None
            action2, r_trans2 = struct.unpack(">LL", resp2[:8])
            if action2 != 2 or r_trans2 != trans_id2:
                return None, None, None
            seeders, completed, leechers = struct.unpack(">LLL", resp2[8:20])
            return int(seeders), int(leechers), int(completed)
        finally:
            try:
                s.close()
            except Exception:
                pass


    @app.route("/api/torrents/upload", methods=["POST"])
    @_limit(settings.get("rate_limit_torrent_upload") or "5 per minute")
    @jwt_required()
    def torrents_upload():
        user = get_jwt_identity()
        if is_user_sanctioned(user, "upload"):
            return jsonify({"success": False, "error": "Your account is restricted."}), 403

        f = request.files.get("file")
        if not f or not getattr(f, "filename", ""):
            return jsonify({"success": False, "error": "No file"}), 400

        orig = secure_filename(f.filename)
        if not orig.lower().endswith(".torrent"):
            return jsonify({"success": False, "error": "Only .torrent files are allowed"}), 400

        f.seek(0, os.SEEK_END)
        size = f.tell()
        f.seek(0)
        if size <= 0 or size > 1_000_000:
            return jsonify({"success": False, "error": "Torrent too large"}), 400

        tid = secrets.token_urlsafe(12)
        stored = f"{tid}__{orig}"
        path = os.path.join(torrents_root, stored)
        f.save(path)

        log_audit_event(user, "torrent_upload", {"torrent_id": tid, "name": orig, "size": size})
        return jsonify({"success": True, "torrent_id": tid, "name": orig, "size": size})


    @app.route("/api/torrents/<torrent_id>/download", methods=["GET"])
    @_limit(settings.get("rate_limit_torrent_download") or "120 per minute")
    @jwt_required()
    def torrents_download(torrent_id: str):
        user = get_jwt_identity()

        # Find file on disk
        prefix = f"{torrent_id}__"
        found = None
        for name in os.listdir(torrents_root):
            if name.startswith(prefix):
                found = name
                break
        if not found:
            return jsonify({"success": False, "error": "Not found"}), 404

        path = os.path.join(torrents_root, found)
        dl_name = found.split("__", 1)[1] if "__" in found else f"{torrent_id}.torrent"

        log_audit_event(user, "torrent_download", {"torrent_id": torrent_id, "name": dl_name})
        return send_file(path, mimetype="application/x-bittorrent", as_attachment=True, download_name=dl_name, conditional=True)


    @app.route("/api/torrent/scrape", methods=["POST"])
    @_limit(settings.get("rate_limit_torrent_scrape") or "30 per minute")
    @jwt_required()
    def torrent_scrape():
        data = request.get_json(silent=True) or {}
        infohex = str(data.get("infohash_hex") or "").strip().lower()
        trackers = data.get("trackers") or []
        if len(infohex) != 40:
            return jsonify({"success": False, "error": "Invalid infohash"}), 400
        try:
            infohash = bytes.fromhex(infohex)
        except ValueError:
            return jsonify({"success": False, "error": "Invalid infohash"}), 400

        # Fast path: cache hit
        now = time.time()
        cached = _TORRENT_SCRAPE_CACHE.get(infohex)
        if cached and (now - cached[0]) <= _TORRENT_SCRAPE_CACHE_TTL:
            _, seeds, leechers, completed = cached
            return jsonify({"success": True, "seeds": seeds, "leechers": leechers, "completed": completed, "cached": True})

        seeds = leechers = completed = None
        tried = 0

        # Try a handful of trackers. Prefer UDP if present; many public trackers are UDP-only.
        for tr in (trackers[:18] if isinstance(trackers, list) else []):
            if not isinstance(tr, str):
                continue
            if tried >= _TORRENT_SCRAPE_MAX_TRIES:
                break

            tr = tr.strip()
            if not tr:
                continue

            # UDP scrape (BEP 15)
            udp = _safe_udp_tracker(tr)
            if udp:
                tried += 1
                try:
                    s, l, d = _udp_tracker_scrape(udp[0], udp[1], infohash)
                    if isinstance(s, int):
                        seeds = max(seeds or 0, s)
                    if isinstance(l, int):
                        leechers = max(leechers or 0, l)
                    if isinstance(d, int):
                        completed = max(completed or 0, d)
                except Exception:
                    pass
                continue

            # HTTP(S) scrape
            cands = _safe_http_tracker_candidates(tr)
            if not cands:
                continue

            for safe in cands[:2]:
                if tried >= _TORRENT_SCRAPE_MAX_TRIES:
                    break
                tried += 1
                try:
                    q = "info_hash=" + urllib.parse.quote_from_bytes(infohash, safe="")
                    url = safe + ("?" + q)
                    req = urllib.request.Request(url, headers={"User-Agent": "EchoChat/1.0"})
                    with urllib.request.urlopen(req, timeout=_TORRENT_SCRAPE_HTTP_TIMEOUT) as resp:
                        raw = resp.read(200_000)
                    decoded, _ = _bdecode(raw, 0)
                    files = decoded.get(b"files") if isinstance(decoded, dict) else None
                    stats = files.get(infohash) if isinstance(files, dict) else None
                    if isinstance(stats, dict):
                        c = stats.get(b"complete")
                        ic = stats.get(b"incomplete")
                        dl = stats.get(b"downloaded")
                        if isinstance(c, int):
                            seeds = max(seeds or 0, c)
                        if isinstance(ic, int):
                            leechers = max(leechers or 0, ic)
                        if isinstance(dl, int):
                            completed = max(completed or 0, dl)
                except Exception:
                    continue

        # Cache results (including "all unknown") for a short TTL to reduce outbound spam.
        _TORRENT_SCRAPE_CACHE[infohex] = (now, seeds, leechers, completed)
        return jsonify({"success": True, "seeds": seeds, "leechers": leechers, "completed": completed, "cached": False})


    @app.route("/api/friends")
    @jwt_required()
    def api_friends():
        user = get_jwt_identity()
        try:
            conn = get_db()
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT u.username, u.online, u.presence_status, u.custom_status, u.last_seen
                      FROM users u
                      JOIN friends f
                        ON (f.user_id = u.id OR f.friend_id = u.id)
                     WHERE (f.user_id = (
                                SELECT id FROM users WHERE username = %s
                            ) AND u.id = f.friend_id)
                        OR (f.friend_id = (
                                SELECT id FROM users WHERE username = %s
                            ) AND u.id = f.user_id);
                    """,
                    (user, user),
                )
                rows = cur.fetchall()

            results = []
            for uname, online, presence_status, custom_status, last_seen in rows:
                pres = str(presence_status or "online").strip().lower()
                if pres == "available":
                    pres = "online"
                visible_online = bool(online) and pres != "invisible"
                visible_presence = "offline" if not visible_online else pres
                results.append(
                    {
                        "username": uname,
                        "online": visible_online,
                        "presence": visible_presence,
                        "custom_status": custom_status if visible_online else None,
                        "last_seen": last_seen.isoformat() if last_seen else None,
                    }
                )
        except Exception as e:
            logging.error("[DB ERROR] Failed to fetch friends: %s", e)
            results = []

        return jsonify({"friends": results})
