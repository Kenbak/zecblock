\set ON_ERROR_STOP on
-- Reverses swaps-v1.sql only. Order (swaps.md):
-- 1. deploy code with swap_daily unpublished;
-- 2. swaps-source-v1-rollback.sql on mainnet (restores the original
--    cross_chain_swaps column list and drops the venue table);
-- 3. ALTER SUBSCRIPTION ask_public_core_v1 REFRESH PUBLICATION WITH (copy_data=false);
--    on this store, so the subscription no longer lists the venue table;
-- 4. this file. It refuses while the subscription still lists the venue table.
--    Dropping the amount columns while the publisher still sends them stops apply.
BEGIN;
SET LOCAL lock_timeout='500ms';SET LOCAL statement_timeout='30s';
DO $$BEGIN IF current_database()<>'ask_analytics' OR pg_is_in_recovery() OR NOT EXISTS(SELECT FROM pg_roles WHERE rolname=current_user AND rolsuper)
 OR to_regclass('public.crosschain_venue_actions') IS NULL
 OR EXISTS(SELECT FROM pg_subscription_rel WHERE srrelid='public.crosschain_venue_actions'::regclass)
 THEN RAISE EXCEPTION 'Dedicated store with swap detail, removed from the subscription, required';END IF;END$$;
DROP VIEW analytics_public.swap_daily_query;
DELETE FROM analytics_meta.dataset_state WHERE dataset='swap_daily';
DROP TABLE public.crosschain_venue_actions;
ALTER TABLE public.cross_chain_swaps DROP COLUMN source_amount,DROP COLUMN dest_amount;
COMMIT;
