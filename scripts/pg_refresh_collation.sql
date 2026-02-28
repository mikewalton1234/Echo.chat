-- EchoChat: Refresh collation version + reindex (fixes glibc collation mismatch warnings)
--
-- Usage:
--   sudo -u postgres psql -d echo_db -f scripts/pg_refresh_collation.sql
\set ON_ERROR_STOP on

DO $$
DECLARE
  db text;
BEGIN
  SELECT current_database() INTO db;
  EXECUTE format('ALTER DATABASE %I REFRESH COLLATION VERSION', db);
  EXECUTE format('REINDEX DATABASE %I', db);
END $$;

\echo ✅ Collation version refreshed and database reindexed.
