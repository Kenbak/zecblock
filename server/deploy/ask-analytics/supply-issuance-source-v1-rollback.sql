\set ON_ERROR_STOP on
-- Reverses supply-issuance-source-v1.sql only. Run before the destination rollback.
BEGIN;
SET LOCAL lock_timeout='500ms'; SET LOCAL statement_timeout='5s';
DO $$BEGIN
 IF current_database()<>'zcash_explorer_mainnet' OR pg_is_in_recovery()
 OR NOT EXISTS(SELECT FROM pg_publication_tables WHERE pubname='ask_public_core_v1' AND schemaname='public' AND tablename='chain_supply_daily')
 THEN RAISE EXCEPTION 'Published supply archive required'; END IF;
END$$;
ALTER PUBLICATION ask_public_core_v1 DROP TABLE public.chain_supply_daily;
REVOKE SELECT(date,block_height,block_hash,block_time,chain_supply_zat) ON public.chain_supply_daily FROM ask_core_replicator;
COMMIT;
