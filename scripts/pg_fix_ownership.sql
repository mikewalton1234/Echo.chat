-- EchoChat: Fix table ownership so migrations can run
--
-- Usage (example):
--   sudo -u postgres psql -d echo_db -v new_owner=drdrizzle -f scripts/pg_fix_ownership.sql
--
-- This will ALTER OWNER for all tables and sequences in schema public.
\set ON_ERROR_STOP on

DO $$
DECLARE
  r record;
BEGIN
  -- Tables
  FOR r IN
    SELECT schemaname, tablename
      FROM pg_tables
     WHERE schemaname = 'public'
  LOOP
    EXECUTE format('ALTER TABLE %I.%I OWNER TO %I', r.schemaname, r.tablename, :'new_owner');
  END LOOP;

  -- Sequences
  FOR r IN
    SELECT sequence_schema AS schemaname, sequence_name AS seqname
      FROM information_schema.sequences
     WHERE sequence_schema = 'public'
  LOOP
    EXECUTE format('ALTER SEQUENCE %I.%I OWNER TO %I', r.schemaname, r.seqname, :'new_owner');
  END LOOP;
END $$;

ALTER SCHEMA public OWNER TO :"new_owner";
