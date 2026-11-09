\set ON_ERROR_STOP on
-- Mainnet publisher: adds node-reported accounting observations to the reviewed
-- feed, reviewed columns only. Real production metadata change; owner approval
-- only. Apply value-pools-v1.sql on the analytics store FIRST. subsidy (funding
-- stream addresses), upgrades, source and poll_interval_ms stay private. No
-- source rows, writers, indexer or API change. Rollback:
-- value-pools-source-v1-rollback.sql.
BEGIN;
SET LOCAL lock_timeout='500ms'; SET LOCAL statement_timeout='5s';
DO $$BEGIN
 IF current_database()<>'zcash_explorer_mainnet' OR pg_is_in_recovery()
 OR NOT EXISTS(SELECT FROM pg_publication WHERE pubname='ask_public_core_v1' AND NOT puballtables)
 OR NOT EXISTS(SELECT FROM pg_roles WHERE rolname='ask_core_replicator' AND rolreplication AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole)
 OR to_regclass('public.node_accounting_observations') IS NULL
 OR EXISTS(SELECT FROM pg_publication_tables WHERE pubname='ask_public_core_v1' AND schemaname='public' AND tablename='node_accounting_observations')
 THEN RAISE EXCEPTION 'Existing reviewed mainnet source feed with node accounting observations required'; END IF;
END$$;
GRANT SELECT(hash,height,observed_at,chain,nsm_balance_zat,circulating_supply_zat,pool_balances_zat) ON public.node_accounting_observations TO ask_core_replicator;
ALTER PUBLICATION ask_public_core_v1 ADD TABLE public.node_accounting_observations(hash,height,observed_at,chain,nsm_balance_zat,circulating_supply_zat,pool_balances_zat);
COMMIT;
