// utils/cookies.js
// ────────────────────────────────────────────────────────────
// Minimal helpers for getting and setting browser cookies.

/**
 * Return the value of a cookie by name, or null if missing.
 */
export function getCookie(name) {
    const value = `; ${document.cookie}`;
    const parts = value.split(`; ${name}=`);
    if (parts.length === 2) {
        return parts.pop().split(";").shift();
    }
    return null;
}

/**
 * Set / overwrite a cookie.
 * @param {string} name   Cookie name
 * @param {string} value  Cookie value
 * @param {number} [days] Days until expiry (default 7)
 * @param {string} [path] Path attribute (default "/")
 */
export function setCookie(name, value, days = 7, path = "/") {
    const expires = new Date(Date.now() + days * 864e5).toUTCString();
    document.cookie = `${name}=${value}; expires=${expires}; path=${path}; SameSite=Lax`;
}
