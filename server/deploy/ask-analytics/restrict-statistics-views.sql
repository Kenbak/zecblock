-- Manual preflight for the current mainnet deployment, where these extension
-- views have default PUBLIC SELECT. Review the role list before applying.
-- Preserve every existing login's access; never grant these views to Ask.
-- Run BEFORE provision.sql. PostgreSQL pg_catalog defaults are unchanged.
BEGIN;
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname LIKE 'ask_analytics_%')
    OR EXISTS (SELECT 1 FROM pg_roles WHERE rolcanlogin AND rolname NOT IN ('postgres','zcash_user','replicator')) THEN
    RAISE EXCEPTION 'Review existing roles before restricting statistics views';
  END IF;
END $$;
GRANT SELECT ON public.pg_stat_statements, public.pg_stat_statements_info
  TO postgres, zcash_user, replicator;
REVOKE SELECT ON public.pg_stat_statements, public.pg_stat_statements_info FROM PUBLIC;
COMMIT;
