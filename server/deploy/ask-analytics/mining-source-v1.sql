\set ON_ERROR_STOP on
-- Mainnet publisher: adds the daily pool attribution column of the analytics
-- history (migration 028) and the canonical software-marker day counts
-- (migration 023), plus the hash/height/first-seen columns of the two block
-- receipt tables, to the reviewed feed. Real production metadata change; owner
-- approval only. Apply mining-v1.sql on the analytics store FIRST. Only the four
-- listed analytics_history_daily columns are published: cohorts, USD cost
-- basis, SOPR and fees stay private, and so do the
-- receipts' raw block bytes, coinbase, payout and poll metadata. No source rows, writers, indexer or API
-- change. Rollback: mining-source-v1-rollback.sql.
BEGIN;
SET LOCAL lock_timeout='500ms'; SET LOCAL statement_timeout='5s';
DO $$BEGIN
 IF current_database()<>'zcash_explorer_mainnet' OR pg_is_in_recovery()
 OR NOT EXISTS(SELECT FROM pg_publication WHERE pubname='ask_public_core_v1' AND NOT puballtables)
 OR NOT EXISTS(SELECT FROM pg_roles WHERE rolname='ask_core_replicator' AND rolreplication AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole)
 OR to_regclass('public.analytics_history_daily') IS NULL OR to_regclass('public.block_software_daily') IS NULL
 OR to_regclass('public.block_observations') IS NULL OR to_regclass('public.captured_blocks') IS NULL
 OR NOT EXISTS(SELECT FROM public.block_software_state WHERE version=1 AND ready)
 OR EXISTS(SELECT FROM pg_publication_tables WHERE pubname='ask_public_core_v1' AND schemaname='public' AND tablename IN('analytics_history_daily','block_software_daily','block_observations','captured_blocks'))
 THEN RAISE EXCEPTION 'Existing reviewed mainnet source feed with migrations 023 and 028 (classifier ready) required'; END IF;
END$$;
GRANT SELECT(date,anchor_height,anchor_hash,mining_pool_blocks) ON public.analytics_history_daily TO ask_core_replicator;
GRANT SELECT(day,software,blocks) ON public.block_software_daily TO ask_core_replicator;
GRANT SELECT(hash,height,first_seen_at) ON public.block_observations TO ask_core_replicator;
GRANT SELECT(hash,height,first_seen_at) ON public.captured_blocks TO ask_core_replicator;
ALTER PUBLICATION ask_public_core_v1 ADD TABLE public.analytics_history_daily(date,anchor_height,anchor_hash,mining_pool_blocks),public.block_software_daily(day,software,blocks),public.block_observations(hash,height,first_seen_at),public.captured_blocks(hash,height,first_seen_at);
COMMIT;
