# EchoChat Email via Brevo (SMTP relay)

## 1) Verify a sender in Brevo
In Brevo dashboard:
- Settings → Senders, domains, IPs → Senders
- Add a sender (e.g., your Gmail address) and complete the verification email.

Your `smtp_from` in EchoChat **must** use a verified sender address.

## 2) Get SMTP credentials
- Settings → SMTP & API → SMTP
- Copy:
  - SMTP Server: `smtp-relay.brevo.com`
  - Port: `587`
  - Login: (shown on the page)
  - SMTP Key: generate/copy an SMTP key

## 3) Configure EchoChat
Edit `server_config.json`:

```json
{
  "public_base_url": "http://127.0.0.1:5000",
  "smtp_enabled": true,
  "smtp_host": "smtp-relay.brevo.com",
  "smtp_port": 587,
  "smtp_username": "YOUR_BREVO_LOGIN",
  "smtp_password": "YOUR_BREVO_SMTP_KEY",
  "smtp_use_starttls": true,
  "smtp_from": "EchoChat <YOUR_VERIFIED_SENDER_EMAIL>"
}
```

Restart the server.

## 4) Smoke test
```bash
python tools/smtp_test.py --config server_config.json --to you@example.com
```

## Security notes
- Never commit SMTP keys into git.
- If a key is ever pasted into chat/logs/screenshots, revoke and rotate it immediately.
