\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout='500ms';SET LOCAL statement_timeout='5s';
DO $$BEGIN IF current_database()<>'ask_analytics' OR pg_is_in_recovery() OR NOT EXISTS(SELECT FROM pg_roles WHERE rolname=current_user AND rolsuper) OR to_regclass('analytics_public.address_activity_query') IS NULL THEN RAISE EXCEPTION 'Dedicated existing public address catalogue required';END IF;END$$;
SET LOCAL ROLE ask_public_view_owner;
-- OFFSET 0 retains an indexed per-incidence canonical lookup instead of a
-- planner-driven full transaction-history hash/sort. No reader grant changes.
CREATE OR REPLACE VIEW analytics_public.address_activity_query WITH(security_barrier=true) AS SELECT a.address,a.txid,a.block_height AS height,a.block_time AS timestamp,a.tx_index,a.is_input,a.is_output,a.value_out AS received,a.value_in AS sent FROM public.address_transactions a CROSS JOIN LATERAL (SELECT 1 FROM public.transactions t JOIN public.blocks b ON b.height=t.block_height AND b.hash=t.block_hash WHERE t.txid=a.txid AND t.block_height=a.block_height AND t.block_time=a.block_time OFFSET 0) canonical CROSS JOIN analytics_public.dataset_coverage c CROSS JOIN analytics_public.coverage core WHERE c.dataset='address_activity' AND c.ready AND core.ready AND a.block_height BETWEEN core.covered_from AND core.covered_through;
RESET ROLE;
COMMIT;
