\set ON_ERROR_STOP on
-- Reverses reorgs-v1.sql only. Order (reorgs.md):
-- 1. deploy code with reorgs/orphaned_blocks unpublished;
-- 2. reorgs-source-v1-rollback.sql on mainnet;
-- 3. ALTER SUBSCRIPTION ask_public_core_v1 REFRESH PUBLICATION WITH (copy_data=false);
--    on this store, so the subscription no longer lists either table;
-- 4. this file. It refuses while the subscription still lists either table.
BEGIN;
SET LOCAL lock_timeout='500ms';SET LOCAL statement_timeout='30s';
DO $$BEGIN IF current_database()<>'ask_analytics' OR pg_is_in_recovery() OR NOT EXISTS(SELECT FROM pg_roles WHERE rolname=current_user AND rolsuper)
 OR to_regclass('public.fork_events') IS NULL OR to_regclass('public.orphaned_blocks') IS NULL
 OR EXISTS(SELECT FROM pg_subscription_rel WHERE srrelid IN('public.fork_events'::regclass,'public.orphaned_blocks'::regclass))
 THEN RAISE EXCEPTION 'Dedicated store with reorg datasets, removed from the subscription, required';END IF;END$$;
DROP VIEW analytics_public.reorgs_query,analytics_public.orphaned_blocks_query;
DELETE FROM analytics_meta.dataset_state WHERE dataset IN('reorgs','orphaned_blocks');
DROP TABLE public.fork_events,public.orphaned_blocks;
COMMIT;
