# Email / SMTP setup (password reset)

EchoChat sends password-reset emails using a third-party **SMTP relay** (a.k.a. “smart host”).

✅ Recommended: **use a free SMTP relay provider**. You do **not** want to run your own mail server unless you’re ready to manage SPF/DKIM/DMARC, reverse DNS, IP reputation, etc.

---

## EchoChat config keys

Edit `server_config.json`:

```json
{
  "public_base_url": "http://127.0.0.1:5000",

  "smtp_enabled": true,
  "smtp_host": "smtp.example.com",
  "smtp_port": 587,
  "smtp_username": "...",
  "smtp_password": "...",
  "smtp_use_starttls": true,
  "smtp_from": "EchoChat <no-reply@yourdomain.com>"
}
```

Notes:
- Port **587 + STARTTLS** is the common default.
- Some providers also offer port **465 (implicit TLS)**.

---

## Dev helper when SMTP is not configured

If `smtp_enabled` is false (or SMTP credentials are missing), EchoChat will **not** send the email.
For **local development** only, EchoChat will additionally **spool the generated password reset link** to:

- `logs/reset_links.log`

Spooling is **restricted to localhost/LAN** by default (to avoid leaking reset links on a public deployment).

Optional config keys (in `server_config.json`):

```json
{
  "password_reset_spool_file": "logs/reset_links.log",
  "password_reset_spool_allow_remote": false
}
```

When the request originates from `127.0.0.1` / `::1`, EchoChat will also print the reset link to the console
with a `[DEV]` prefix.

---

## Provider options (free tiers)

### Option A (recommended): Brevo SMTP relay (free plan)

Brevo advertises a free SMTP server allowing **300 emails/day**. After signup, you obtain an **SMTP login** + **SMTP key** (password) for relay. If you don’t authenticate a domain, you typically must verify each sender email address first. 

Steps:
1. Create a Brevo account.
2. In Brevo: **Transactional → Settings → Configuration → SMTP relay**.
3. Create a sender (From address) and **verify it** (Brevo sends a code) if your domain isn’t authenticated.
4. Copy SMTP host/port/username and generate/copy your SMTP key.
5. Paste those values into `server_config.json`.

References:
- Brevo free SMTP: 300 emails/day.
- Sender verification requirement when domain isn’t authenticated.

---

### Option B: Mailjet SMTP relay (free plan)

Mailjet’s free plan includes **6,000 emails/month** with a **200/day cap** and supports SMTP relay.

Steps:
1. Create a Mailjet account.
2. Add and validate a sender email or domain.
3. Get SMTP credentials (from your API key / SMTP settings).
4. Paste into `server_config.json`.

---

### Option C: SMTP2GO (forever-free plan)

SMTP2GO describes a forever-free plan with **1,000 emails/month** and a **200/day cap**. Sender verification is mandatory (either verify your domain or a single sender email).

Steps:
1. Create SMTP2GO account.
2. Verify a sender domain or a single sender email.
3. Create an SMTP user / credentials.
4. Paste into `server_config.json`.

---

### Option D: MailerSend (free plan)

MailerSend’s free plan allows **500 emails/month** with a **100/day** limit, and supports SMTP relay (with low concurrent-connection limits on free tier).

---

## Testing SMTP from the command line

EchoChat includes a helper script:

```bash
source .venv/bin/activate
python tools/smtp_test.py --to your@email.com
```

If this succeeds, your password-reset emails should work.

---

## Local dev-only: MailHog / smtp4dev

If you want *zero* external dependencies for dev, you can run a local SMTP capture tool.
It will **not** deliver to real inboxes; it just shows emails in a web UI.

In that setup:
- `smtp_host` is your local container/host (e.g., `127.0.0.1`)
- `smtp_port` is the local tool’s SMTP port
- no username/password required (or dummy)

Use this only for testing.

---

## Keeping secrets out of server_config.json

If you don't want your SMTP key in `server_config.json`, set `smtp_password` to an empty string and export it as an env var before running the server:

```bash
export ECHOCHAT_SMTP_ENABLED=1
export ECHOCHAT_SMTP_HOST=smtp-relay.brevo.com
export ECHOCHAT_SMTP_PORT=587
export ECHOCHAT_SMTP_USERNAME='YOUR_LOGIN_HERE'
export ECHOCHAT_SMTP_PASSWORD='YOUR_SMTP_KEY_HERE'
export ECHOCHAT_SMTP_STARTTLS=1
export ECHOCHAT_SMTP_FROM='EchoChat <no-reply@yourdomain.com>'
python main.py
```

EchoChat also accepts the shorter `SMTP_HOST/SMTP_PORT/...` env var names.
