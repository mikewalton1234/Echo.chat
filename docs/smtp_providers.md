# SMTP providers (free tiers) for EchoChat

EchoChat uses SMTP for transactional mail (password reset today; verification/alerts later).

## Recommended: Brevo (formerly Sendinblue)

- Free tier: **300 emails/day**
- SMTP server: `smtp-relay.brevo.com`
- Ports: `587` (STARTTLS recommended), `465` (SSL), `2525` (alt)

### What you need from Brevo
1. Create a Brevo account (free).
2. In **SMTP & API** settings, generate an **SMTP key** (use this as the SMTP password).
3. Use your **SMTP login email** as the SMTP username.
4. Verify your sender domain/address so messages land in inboxes.

## Alternative: Mailjet

- Free tier: **6,000 emails/month** (max **200/day**)
- SMTP server: `in-v3.mailjet.com`
- Ports: `587` (STARTTLS), `465` (SSL)
- Username/Password: API key + Secret key (SMTP credentials)

## EchoChat config keys

These keys live in `server_config.json` (or can be injected via your own env override logic):

```json
{
  "smtp_enabled": true,
  "smtp_provider": "brevo",
  "smtp_host": "smtp-relay.brevo.com",
  "smtp_port": 587,
  "smtp_use_starttls": true,
  "smtp_use_ssl": false,
  "smtp_username": "you@example.com",
  "smtp_password": "YOUR_SMTP_KEY",
  "smtp_from": "EchoChat <no-reply@yourdomain.com>"
}
```

## Quick test

Run setup again:

```bash
python main.py --setup
```

Then use the web UI → **Forgot password** to trigger an email.
