\set ON_ERROR_STOP on
-- Reverses reorgs-source-v1.sql only. Run before the destination rollback.
BEGIN;
SET LOCAL lock_timeout='500ms'; SET LOCAL statement_timeout='5s';
DO $$BEGIN
 IF current_database()<>'zcash_explorer_mainnet' OR pg_is_in_recovery()
 OR (SELECT count(*) FROM pg_publication_tables WHERE pubname='ask_public_core_v1' AND schemaname='public' AND tablename IN('fork_events','orphaned_blocks'))<>2
 THEN RAISE EXCEPTION 'Published reorg tables required'; END IF;
END$$;
ALTER PUBLICATION ask_public_core_v1 DROP TABLE public.fork_events,public.orphaned_blocks;
REVOKE SELECT(id,fork_height,depth,orphaned_count,detected_at) ON public.fork_events FROM ask_core_replicator;
REVOKE SELECT(id,height,hash,canonical_hash,timestamp,transaction_count,size,miner_address,fork_event_id,detected_at) ON public.orphaned_blocks FROM ask_core_replicator;
COMMIT;
