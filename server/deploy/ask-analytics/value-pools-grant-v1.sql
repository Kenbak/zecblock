\set ON_ERROR_STOP on
-- Reader grant for value_pools_daily_query, applied only AFTER the worker build
-- that lists value_pools_daily_query in coreViews is running (value-pools.md).
-- The worker's guard refuses every query while the reader can select a view it
-- does not list, and analytics-availability.py alerts reader_view_drift.
-- Rollback: REVOKE ALL ON analytics_public.value_pools_daily_query FROM ask_public_reader;
BEGIN;
SET LOCAL lock_timeout='500ms';SET LOCAL statement_timeout='30s';
DO $$BEGIN IF current_database()<>'ask_analytics' OR pg_is_in_recovery() OR to_regclass('analytics_public.value_pools_daily_query') IS NULL
 THEN RAISE EXCEPTION 'value-pools-v1.sql required on the analytics store';END IF;END$$;
GRANT SELECT ON analytics_public.value_pools_daily_query TO ask_public_reader;
COMMIT;
