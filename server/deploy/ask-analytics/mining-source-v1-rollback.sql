\set ON_ERROR_STOP on
-- Reverses mining-source-v1.sql only. Run before the destination rollback.
BEGIN;
SET LOCAL lock_timeout='500ms'; SET LOCAL statement_timeout='5s';
DO $$BEGIN
 IF current_database()<>'zcash_explorer_mainnet' OR pg_is_in_recovery()
 OR (SELECT count(*) FROM pg_publication_tables WHERE pubname='ask_public_core_v1' AND schemaname='public' AND tablename IN('analytics_history_daily','block_software_daily','block_observations','captured_blocks'))<>4
 THEN RAISE EXCEPTION 'Published mining tables required'; END IF;
END$$;
ALTER PUBLICATION ask_public_core_v1 DROP TABLE public.analytics_history_daily,public.block_software_daily,public.block_observations,public.captured_blocks;
REVOKE SELECT(date,anchor_height,anchor_hash,mining_pool_blocks) ON public.analytics_history_daily FROM ask_core_replicator;
REVOKE SELECT(day,software,blocks) ON public.block_software_daily FROM ask_core_replicator;
REVOKE SELECT(hash,height,first_seen_at) ON public.block_observations FROM ask_core_replicator;
REVOKE SELECT(hash,height,first_seen_at) ON public.captured_blocks FROM ask_core_replicator;
COMMIT;
