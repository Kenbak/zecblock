\set ON_ERROR_STOP on
-- Reverses mining-v1.sql only. Order (mining.md):
-- 1. deploy code with mining_daily/software_daily/block_timing/issuance_daily unpublished;
-- 2. mining-source-v1-rollback.sql on mainnet;
-- 3. ALTER SUBSCRIPTION ask_public_core_v1 REFRESH PUBLICATION WITH (copy_data=false);
--    on this store, so the subscription no longer lists the four tables;
-- 4. this file. It refuses while the subscription still lists any of them.
BEGIN;
SET LOCAL lock_timeout='500ms';SET LOCAL statement_timeout='30s';
DO $$BEGIN IF current_database()<>'ask_analytics' OR pg_is_in_recovery() OR NOT EXISTS(SELECT FROM pg_roles WHERE rolname=current_user AND rolsuper)
 OR to_regclass('public.analytics_history_daily') IS NULL OR to_regclass('public.block_software_daily') IS NULL
 OR to_regclass('public.block_observations') IS NULL OR to_regclass('public.captured_blocks') IS NULL
 OR EXISTS(SELECT FROM pg_subscription_rel WHERE srrelid IN('public.analytics_history_daily'::regclass,'public.block_software_daily'::regclass,'public.block_observations'::regclass,'public.captured_blocks'::regclass))
 THEN RAISE EXCEPTION 'Dedicated store with mining datasets, removed from the subscription, required';END IF;END$$;
DROP VIEW analytics_public.mining_daily_query,analytics_public.software_daily_query,analytics_public.block_timing_query,analytics_public.issuance_daily_query;
DELETE FROM analytics_meta.dataset_state WHERE dataset IN('mining_daily','software_daily','issuance_daily','block_timing');
DROP TABLE public.analytics_history_daily,public.block_software_daily,public.block_observations,public.captured_blocks;
COMMIT;
