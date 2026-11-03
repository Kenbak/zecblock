\set ON_ERROR_STOP on
-- Reverses utxo-daily-v1.sql only. Order (utxo-daily.md):
-- 1. revoke the reader grant and deploy code with utxo_daily unpublished;
-- 2. utxo-daily-source-v1-rollback.sql on mainnet;
-- 3. ALTER SUBSCRIPTION ask_public_core_v1 REFRESH PUBLICATION WITH (copy_data=false);
--    on this store, so the subscription no longer lists either table;
-- 4. this file. It refuses while the subscription still lists either table.
BEGIN;
SET LOCAL lock_timeout='500ms';SET LOCAL statement_timeout='30s';
DO $$BEGIN IF current_database()<>'ask_analytics' OR pg_is_in_recovery() OR NOT EXISTS(SELECT FROM pg_roles WHERE rolname=current_user AND rolsuper)
 OR to_regclass('public.utxo_age_daily') IS NULL OR to_regclass('public.transparent_realized_cap_daily') IS NULL
 OR EXISTS(SELECT FROM pg_subscription_rel WHERE srrelid IN('public.utxo_age_daily'::regclass,'public.transparent_realized_cap_daily'::regclass))
 THEN RAISE EXCEPTION 'Dedicated store with the UTXO dataset, removed from the subscription, required';END IF;END$$;
DROP VIEW analytics_public.utxo_daily_query;
DELETE FROM analytics_meta.dataset_state WHERE dataset='utxo_daily';
DROP TABLE public.utxo_age_daily,public.transparent_realized_cap_daily;
COMMIT;
