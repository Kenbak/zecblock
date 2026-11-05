\set ON_ERROR_STOP on
-- Reverses supply-issuance-v1.sql only. Order (supply-issuance.md):
-- 1. deploy code with supply_daily/issuance unpublished;
-- 2. supply-issuance-source-v1-rollback.sql on mainnet;
-- 3. ALTER SUBSCRIPTION ask_public_core_v1 REFRESH PUBLICATION WITH (copy_data=false);
--    on this store, so the subscription no longer lists chain_supply_daily;
-- 4. this file. It refuses while the subscription still lists the table.
BEGIN;
SET LOCAL lock_timeout='500ms';SET LOCAL statement_timeout='30s';
DO $$BEGIN IF current_database()<>'ask_analytics' OR pg_is_in_recovery() OR NOT EXISTS(SELECT FROM pg_roles WHERE rolname=current_user AND rolsuper) OR to_regclass('public.chain_supply_daily') IS NULL
 OR EXISTS(SELECT FROM pg_subscription_rel WHERE srrelid='public.chain_supply_daily'::regclass) THEN RAISE EXCEPTION 'Dedicated store with supply/issuance, removed from the subscription, required';END IF;END$$;
DROP VIEW analytics_public.supply_daily_query,analytics_public.issuance_query;
DELETE FROM analytics_meta.dataset_state WHERE dataset='supply_daily';
DROP TABLE public.chain_supply_daily;
COMMIT;
