#!/usr/bin/env python3
"""moderation_routes.py

Admin moderation panel + audit log viewer.
Updated to PostgreSQL (get_db). SQLite support removed.
"""

from __future__ import annotations

from flask import request, session, render_template_string

from database import get_db
from moderation import ban_user, mute_user, kick_user, list_active_sanctions
from permissions import require_admin
from security import log_audit_event


def register_moderation_routes(app, settings, limiter=None):
    def _limit(rule, **kwargs):
        if limiter is None:
            return lambda f: f
        try:
            return limiter.limit(rule, **kwargs)
        except Exception:
            return lambda f: f

    @app.route("/moderation", methods=["GET", "POST"])
    @_limit(settings.get("rate_limit_moderation") or "60 per minute", methods=["POST"])
    @require_admin
    def moderation_panel():
        msg = ""
        if request.method == "POST":
            username = (request.form.get("username") or "").strip()
            action = (request.form.get("action") or "").strip().lower()
            duration = int(request.form.get("duration") or 60)
            reason = (request.form.get("reason") or "No reason provided").strip()
            actor = session.get("username", "unknown")

            if not username:
                msg = "❌ Missing username"
            elif action == "ban":
                ban_user(username, reason, duration, actor=actor)
                msg = f"✅ Banned {username} for {duration} min"
            elif action == "mute":
                mute_user(username, reason, duration, actor=actor)
                msg = f"🔇 Muted {username} for {duration} min"
            elif action == "kick":
                kick_user(username, reason, duration, actor=actor)
                msg = f"⚠️ Kicked {username} for {duration} min"
            else:
                msg = "❌ Unknown action"

            log_audit_event(actor, action, username, f"Reason: {reason}, Duration: {duration}")

        sanctions = list_active_sanctions("*")
        return render_template_string(
            """
            <h2>Moderation Panel</h2>
            <form method="post">
                <input name="username" placeholder="Username" required>
                <select name="action">
                    <option value="ban">Ban</option>
                    <option value="mute">Mute</option>
                    <option value="kick">Kick</option>
                </select>
                <input type="hidden" name="csrf_token" value="{{ csrf_token() }}">
                <input name="duration" type="number" value="60" placeholder="Minutes">
                <input name="reason" placeholder="Reason">
                <button type="submit">Apply</button>
            </form>
            <p>{{ msg }}</p>
            <h3>Active Sanctions</h3>
            <table border="1">
                <tr><th>User</th><th>Type</th><th>Reason</th><th>Expires</th></tr>
                {% for u, t, r, e in sanctions %}
                    <tr>
                        <td>{{ u }}</td>
                        <td>{{ t }}</td>
                        <td>{{ r }}</td>
                        <td>{{ e }}</td>
                    </tr>
                {% endfor %}
            </table>
            """,
            sanctions=sanctions,
            msg=msg,
        )

    @app.route("/audit-log")
    @require_admin
    def view_audit_log():
        conn = get_db()
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT actor, action, target, timestamp, details
                  FROM audit_log
                 ORDER BY timestamp DESC
                 LIMIT 100;
                """
            )
            rows = cur.fetchall()

        return render_template_string(
            """
            <h2>Audit Log</h2>
            <table border="1">
              <tr>
                <th>Actor</th><th>Action</th><th>Target</th><th>Time</th><th>Details</th>
              </tr>
              {% for actor, action, target, ts, details in logs %}
                <tr>
                  <td>{{ actor }}</td>
                  <td>{{ action }}</td>
                  <td>{{ target }}</td>
                  <td>{{ ts }}</td>
                  <td>{{ details }}</td>
                </tr>
              {% endfor %}
            </table>
            """,
            logs=rows,
        )
