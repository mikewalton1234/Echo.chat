-- Dedupe emails by keeping the lowest user id per case-insensitive email
--
-- ⚠️ Review before running. This deletes user rows.
--
-- Usage:
--   sudo -u postgres psql -d echo_db -f scripts/pg_find_duplicate_emails.sql
--   sudo -u postgres psql -d echo_db -f scripts/pg_dedupe_emails_keep_lowest_id.sql
\set ON_ERROR_STOP on

WITH ranked AS (
  SELECT id,
         lower(email) AS email_ci,
         ROW_NUMBER() OVER (PARTITION BY lower(email) ORDER BY id ASC) AS rn
    FROM users
   WHERE email IS NOT NULL AND btrim(email) <> ''
)
DELETE FROM users u
 USING ranked r
 WHERE u.id = r.id
   AND r.rn > 1;
