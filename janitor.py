import threading
import time

from database import cleanup_expired_custom_rooms, cleanup_expired_room_messages, cleanup_expired_autoscaled_rooms


def start_janitor(settings: dict):
    """Start a lightweight background cleanup loop.

    - Removes inactive/empty custom rooms (based on `custom_room_idle_hours`)
    - Purges messages for rooms with configured expiry

    This keeps the UX Yahoo-like (ephemeral custom rooms) without requiring UI polling.
    """

    def _loop():
        while True:
            # Re-read settings each cycle so admin changes take effect live.
            try:
                interval = int(settings.get("janitor_interval_seconds", 60))
            except Exception:
                interval = 60
            interval = max(10, min(interval, 3600))

            try:
                idle_hours = int(settings.get("custom_room_idle_hours", 168))  # public
            except Exception:
                idle_hours = 168
            idle_hours = max(1, min(idle_hours, 24 * 365))

            try:
                private_idle_hours = int(settings.get("custom_private_room_idle_hours", idle_hours))
            except Exception:
                private_idle_hours = idle_hours
            private_idle_hours = max(1, min(private_idle_hours, 24 * 365))

            try:
                autoscale_idle_min = int(settings.get("autoscale_room_idle_minutes", 30))
            except Exception:
                autoscale_idle_min = 30
            autoscale_idle_min = max(1, min(autoscale_idle_min, 24 * 60 * 7))

            try:
                n = cleanup_expired_custom_rooms(idle_hours=idle_hours, private_idle_hours=private_idle_hours)
                if n:
                    print(f"[JANITOR] deleted {n} idle custom rooms")
            except Exception as e:
                print(f"[JANITOR] custom room cleanup error: {e}")

            # Cleanup empty autoscaled room shards (e.g., Lobby (2))
            try:
                if bool(settings.get("autoscale_rooms_enabled", True)):
                    n = cleanup_expired_autoscaled_rooms(idle_minutes=autoscale_idle_min)
                    if n:
                        print(f"[JANITOR] deleted {n} idle autoscaled rooms")
            except Exception as e:
                print(f"[JANITOR] autoscaled room cleanup error: {e}")

            try:
                deleted = cleanup_expired_room_messages()
                if deleted:
                    print(f"[JANITOR] deleted {deleted} expired messages")
            except Exception as e:
                print(f"[JANITOR] message expiry cleanup error: {e}")

            time.sleep(interval)

    t = threading.Thread(target=_loop, name="echochat_janitor", daemon=True)
    t.start()
    return t
