\set ON_ERROR_STOP on
-- Reverses value-pools-v1.sql only. Order (value-pools.md):
-- 1. revoke the reader grant and deploy code with value_pools_daily unpublished;
-- 2. value-pools-source-v1-rollback.sql on mainnet;
-- 3. ALTER SUBSCRIPTION ask_public_core_v1 REFRESH PUBLICATION WITH (copy_data=false);
--    on this store, so the subscription no longer lists the table;
-- 4. this file. It refuses while the subscription still lists the table.
BEGIN;
SET LOCAL lock_timeout='500ms';SET LOCAL statement_timeout='30s';
DO $$BEGIN IF current_database()<>'ask_analytics' OR pg_is_in_recovery() OR NOT EXISTS(SELECT FROM pg_roles WHERE rolname=current_user AND rolsuper)
 OR to_regclass('public.node_accounting_observations') IS NULL
 OR EXISTS(SELECT FROM pg_subscription_rel WHERE srrelid='public.node_accounting_observations'::regclass)
 THEN RAISE EXCEPTION 'Dedicated store with the value-pool dataset, removed from the subscription, required';END IF;END$$;
DROP VIEW analytics_public.value_pools_daily_query;
DELETE FROM analytics_meta.dataset_state WHERE dataset='value_pools_daily';
DROP TABLE public.node_accounting_observations;
COMMIT;
