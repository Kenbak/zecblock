-- Operator-reviewed provisioning, NOT an automatically applied migration.
-- Run once on primary, then verify replay and permissions on standby before
-- enabling Ask. Do not put a password in this file or its command-line arguments.
-- Existing names abort rather than silently repurposing a privileged login.
BEGIN;
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';
CREATE ROLE ask_analytics_owner NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE ask_analytics_reader LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 2;
ALTER ROLE ask_analytics_reader SET default_transaction_read_only = on;
ALTER ROLE ask_analytics_reader SET statement_timeout = '3s';
ALTER ROLE ask_analytics_reader SET lock_timeout = '500ms';
ALTER ROLE ask_analytics_reader SET idle_in_transaction_session_timeout = '5s';
ALTER ROLE ask_analytics_reader SET work_mem = '1MB';
ALTER ROLE ask_analytics_reader SET temp_file_limit = '16MB';
ALTER ROLE ask_analytics_reader SET search_path = pg_catalog;
CREATE SCHEMA ask_public AUTHORIZATION ask_analytics_owner;
REVOKE ALL ON SCHEMA ask_public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO ask_analytics_owner;
GRANT SELECT (date, shielded_count, transparent_count, orchard_pool_size, ironwood_pool_size, sapling_pool_size, sprout_pool_size)
  ON public.privacy_trends_daily TO ask_analytics_owner;
SET LOCAL ROLE ask_analytics_owner;
CREATE VIEW ask_public.daily_v1 WITH (security_barrier=true) AS
  SELECT date, shielded_count, transparent_count, orchard_pool_size, ironwood_pool_size, sapling_pool_size, sprout_pool_size
  FROM public.privacy_trends_daily;
RESET ROLE;
REVOKE ALL ON ask_public.daily_v1 FROM PUBLIC;
GRANT USAGE ON SCHEMA ask_public TO ask_analytics_reader;
GRANT SELECT ON ask_public.daily_v1 TO ask_analytics_reader;
COMMIT;
-- Provision the login password through a secure administrator session/secrets
-- manager. Never grant zcash_user, owner roles, pg_read_all_data, file, program,
-- replication or monitoring roles to this reader. No global PUBLIC grants are
-- modified: runtime audit refuses pre-existing PUBLIC leaks instead.
