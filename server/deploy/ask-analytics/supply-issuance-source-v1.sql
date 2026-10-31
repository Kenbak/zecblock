\set ON_ERROR_STOP on
-- Mainnet publisher: adds the permanent canonical supply archive (migration 032)
-- to the reviewed feed. Real production metadata change; owner approval only.
-- Apply supply-issuance-v1.sql on the analytics store FIRST. No source rows,
-- writers, indexer or API change. Rollback: supply-issuance-source-v1-rollback.sql.
BEGIN;
SET LOCAL lock_timeout='500ms'; SET LOCAL statement_timeout='5s';
DO $$BEGIN
 IF current_database()<>'zcash_explorer_mainnet' OR pg_is_in_recovery()
 OR NOT EXISTS(SELECT FROM pg_publication WHERE pubname='ask_public_core_v1' AND NOT puballtables)
 OR NOT EXISTS(SELECT FROM pg_roles WHERE rolname='ask_core_replicator' AND rolreplication AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole)
 OR to_regclass('public.chain_supply_daily') IS NULL
 OR EXISTS(SELECT FROM pg_publication_tables WHERE pubname='ask_public_core_v1' AND schemaname='public' AND tablename='chain_supply_daily')
 THEN RAISE EXCEPTION 'Existing reviewed mainnet source feed with migration 032 required'; END IF;
END$$;
GRANT SELECT(date,block_height,block_hash,block_time,chain_supply_zat) ON public.chain_supply_daily TO ask_core_replicator;
ALTER PUBLICATION ask_public_core_v1 ADD TABLE public.chain_supply_daily(date,block_height,block_hash,block_time,chain_supply_zat);
COMMIT;
