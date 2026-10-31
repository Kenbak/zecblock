\set ON_ERROR_STOP on
-- Mainnet publisher: adds the reorg event log and orphaned-block summaries to the
-- reviewed feed, reviewed columns only. Real production metadata change; owner
-- approval only. Apply reorgs-v1.sql on the analytics store FIRST. The free-text
-- description, source and reporter fields, raw/header/coinbase hex, block
-- metadata, roots, difficulty and consensus flags stay private. No source rows,
-- writers, indexer or API change. Rollback: reorgs-source-v1-rollback.sql.
BEGIN;
SET LOCAL lock_timeout='500ms'; SET LOCAL statement_timeout='5s';
DO $$BEGIN
 IF current_database()<>'zcash_explorer_mainnet' OR pg_is_in_recovery()
 OR NOT EXISTS(SELECT FROM pg_publication WHERE pubname='ask_public_core_v1' AND NOT puballtables)
 OR NOT EXISTS(SELECT FROM pg_roles WHERE rolname='ask_core_replicator' AND rolreplication AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole)
 OR to_regclass('public.fork_events') IS NULL OR to_regclass('public.orphaned_blocks') IS NULL
 OR current_setting('TimeZone')<>'Europe/Berlin'
 OR EXISTS(SELECT FROM pg_publication_tables WHERE pubname='ask_public_core_v1' AND schemaname='public' AND tablename IN('fork_events','orphaned_blocks'))
 THEN RAISE EXCEPTION 'Existing reviewed mainnet source feed with reorg tables (Europe/Berlin detected_at) required'; END IF;
END$$;
GRANT SELECT(id,fork_height,depth,orphaned_count,detected_at) ON public.fork_events TO ask_core_replicator;
GRANT SELECT(id,height,hash,canonical_hash,timestamp,transaction_count,size,miner_address,fork_event_id,detected_at) ON public.orphaned_blocks TO ask_core_replicator;
ALTER PUBLICATION ask_public_core_v1 ADD TABLE public.fork_events(id,fork_height,depth,orphaned_count,detected_at),public.orphaned_blocks(id,height,hash,canonical_hash,timestamp,transaction_count,size,miner_address,fork_event_id,detected_at);
COMMIT;
