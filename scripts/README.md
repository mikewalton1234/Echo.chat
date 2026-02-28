# EchoChat Postgres repair scripts

These scripts are for local development.

## Why you are seeing `must be owner of table users`

Postgres only lets the **table owner** run `ALTER TABLE`.
If you created your DB/tables earlier under one role (e.g. `echochat`) but later
changed your DSN to another role (e.g. `drdrizzle`), migrations will crash.

## Fix table ownership

Run:

```bash
sudo -u postgres psql -d echo_db -v new_owner=drdrizzle -f scripts/pg_fix_ownership.sql
```

Notes:
- Replace `echo_db` with your database name.
- Replace `drdrizzle` with the user in your DSN (`postgresql://USER:PASS@host:port/DB`).
- If you don't know the owner, run:

```bash
sudo -u postgres psql -d echo_db -c "\\dt+ users"
```

## Fix glibc collation mismatch warnings

If Postgres warns about a collation version mismatch after a system update, you can refresh and reindex:

```bash
sudo -u postgres psql -d echo_db -f scripts/pg_refresh_collation.sql
```

## Fix duplicate emails (case-insensitive unique index failure)

If init prints something like:

```
could not create unique index "users_email_unique_ci" ... Key (lower(email))=(...) is duplicated
```

Find duplicates:

```bash
sudo -u postgres psql -d echo_db -f scripts/pg_find_duplicate_emails.sql
```

Resolve duplicates (safer option: sets `email = NULL` on all but one row):

```bash
sudo -u postgres psql -d echo_db -f scripts/pg_dedupe_emails_set_null.sql
```

