// utils/notifier.js
// ────────────────────────────────────────────────────────────
// Simple, dependency-free notification system.  Exports one
// function: notify(message, kind = "info", timeout = 3500).

/**
 * Show a transient banner at the top of #notifications.
 * ‘kind’ adds a CSS class so you can style .info / .warn / .error.
 */
export function notify(message, kind = "info", timeout = 3500) {
    const container = document.getElementById("notifications");
    if (!container) return;                          // no target div

    const div = document.createElement("div");
    div.className = `notify ${kind}`;                // style in CSS
    div.textContent = message;
    container.prepend(div);

    // Fade-out / remove after N ms
    setTimeout(() => div.remove(), timeout);
}
