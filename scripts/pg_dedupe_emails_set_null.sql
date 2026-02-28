-- Resolve duplicate emails by setting email = NULL on all but the lowest-id row.
--
-- After running this, you can retry creating the case-insensitive unique index.
--
-- Usage:
--   sudo -u postgres psql -d echo_db -f scripts/pg_dedupe_emails_set_null.sql
\set ON_ERROR_STOP on

WITH ranked AS (
  SELECT id,
         lower(email) AS email_ci,
         ROW_NUMBER() OVER (PARTITION BY lower(email) ORDER BY id) AS rn
    FROM users
   WHERE email IS NOT NULL AND btrim(email) <> ''
)
UPDATE users u
   SET email = NULL
  FROM ranked r
 WHERE u.id = r.id
   AND r.rn > 1;
