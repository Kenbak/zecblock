\set ON_ERROR_STOP on
-- One bounded batch of the swaps.md amount backfill on the analytics store.
-- Usage: psql -d ask_analytics -v lo=1 -v hi=500000 -f swaps-backfill-v1.sql
-- Copies source_amount/dest_amount from the staged mainnet export into rows that
-- still miss both (rows replicated after the source step already carry them).
-- Each run is its own short transaction; rerunning a range changes nothing.
BEGIN;
SET LOCAL lock_timeout='500ms';SET LOCAL statement_timeout='20s';
DO $$BEGIN
 IF current_database()<>'ask_analytics' OR pg_is_in_recovery()
 OR to_regclass('analytics_meta.swap_amount_backfill') IS NULL OR to_regclass('analytics_public.swap_daily_query') IS NULL
 THEN RAISE EXCEPTION 'Staged swap amount export and swap detail migration required';END IF;
END$$;
UPDATE public.cross_chain_swaps s SET source_amount=b.source_amount,dest_amount=b.dest_amount
 FROM analytics_meta.swap_amount_backfill b
 WHERE s.id=b.id AND s.id BETWEEN :lo AND :hi AND s.source_amount IS NULL AND s.dest_amount IS NULL;
COMMIT;
