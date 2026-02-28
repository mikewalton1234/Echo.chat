# routes_dm.py

from flask import request, redirect, render_template_string
from flask_jwt_extended import jwt_required, get_jwt_identity
from flask_wtf.csrf import generate_csrf
from database import get_db
from encryption import load_or_generate_key
from cryptography.fernet import Fernet
import logging


def register_dm_routes(app, settings):
    @app.route("/chat/<friend>")
    @jwt_required()
    def direct_chat(friend):
        user = get_jwt_identity()
        key = load_or_generate_key(settings)
        fernet = Fernet(key)

        conn = get_db()
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT sender, message, timestamp, is_encrypted
                  FROM messages
                 WHERE (sender = %s AND receiver = %s)
                    OR (sender = %s AND receiver = %s)
                 ORDER BY timestamp ASC;
                """,
                (user, friend, friend, user),
            )
            rows = cur.fetchall()

        chat_history = []
        for sender, msg, ts, encrypted in rows:
            try:
                if encrypted:
                    msg = fernet.decrypt(msg.encode()).decode()
            except Exception:
                msg = "[Error decrypting]"
            chat_history.append((sender, msg, ts))

        return render_template_string(
            """
            <h2>Chat with {{ friend }}</h2>
            <a href="/chat">⬅ Back</a><br><br>
            <div style="max-height:400px; overflow-y:auto; border:1px solid #ccc; padding:10px;">
              {% for m in chat_history %}
                <p><strong>{{ m[0] }}</strong>: {{ m[1] }} <small>{{ m[2] }}</small></p>
              {% endfor %}
            </div>
            <form method="post" action="/chat/{{ friend }}/send">
                <input type="hidden" name="csrf_token" value="{{ csrf_token }}">
                <input name="message" placeholder="Type your message..." style="width:80%;">
                <button type="submit">Send</button>
            </form>
            """,
            friend=friend,
            chat_history=chat_history,
            csrf_token=generate_csrf(),
        )

    @app.route("/chat/<friend>/send", methods=["POST"])
    @jwt_required()
    def send_direct_message(friend):
        user = get_jwt_identity()
        message = request.form.get("message", "").strip()
        if not message:
            return redirect(f"/chat/{friend}")

        key = load_or_generate_key(settings)
        fernet = Fernet(key)
        try:
            encrypted = fernet.encrypt(message.encode()).decode()
        except Exception:
            logging.error("Encryption failed for message from %s to %s", user, friend)
            encrypted = message

        conn = get_db()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO messages (sender, receiver, message, is_encrypted)
                    VALUES (%s, %s, %s, TRUE);
                    """,
                    (user, friend, encrypted),
                )
            conn.commit()
        except Exception as e:
            logging.error("[DB ERROR] Failed to save direct message: %s", e)

        return redirect(f"/chat/{friend}")

    @app.route("/chat/<friend>/history")
    @jwt_required()
    def dm_history(friend):
        user = get_jwt_identity()
        try:
            page = int(request.args.get("page", 1))
        except ValueError:
            page = 1
        per_page = 50
        offset = (page - 1) * per_page

        key = load_or_generate_key(settings)
        fernet = Fernet(key)

        conn = get_db()
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT sender, message, timestamp, is_encrypted
                  FROM messages
                 WHERE (sender = %s AND receiver = %s)
                    OR (sender = %s AND receiver = %s)
                 ORDER BY timestamp DESC
                 LIMIT %s OFFSET %s;
                """,
                (user, friend, friend, user, per_page, offset),
            )
            rows = cur.fetchall()

        messages = []
        for sender, msg, ts, encrypted in rows:
            try:
                msg = fernet.decrypt(msg.encode()).decode() if encrypted else msg
            except Exception:
                msg = "[Error decrypting]"
            messages.append((sender, msg, ts))

        return render_template_string(
            """
            <h2>DM History with {{ friend }}</h2>
            <a href="/chat/{{ friend }}">⬅ Back</a><br><br>
            <div style="max-height:500px; overflow-y:auto; border:1px solid #ccc; padding:10px;">
              {% for m in messages %}
                <p><strong>{{ m[0] }}</strong>: {{ m[1] }} <small>{{ m[2] }}</small></p>
              {% endfor %}
            </div>
            {% if page > 1 %}
              <a href="/chat/{{ friend }}/history?page={{ page - 1 }}">⬅ Previous</a>
            {% endif %}
            <a href="/chat/{{ friend }}/history?page={{ page + 1 }}">Next ➡</a>
            """,
            friend=friend,
            messages=messages,
            page=page,
        )
