\set ON_ERROR_STOP on
-- Reverses value-pools-source-v1.sql only. Run before the destination rollback.
BEGIN;
SET LOCAL lock_timeout='500ms'; SET LOCAL statement_timeout='5s';
DO $$BEGIN
 IF current_database()<>'zcash_explorer_mainnet' OR pg_is_in_recovery()
 OR NOT EXISTS(SELECT FROM pg_publication_tables WHERE pubname='ask_public_core_v1' AND schemaname='public' AND tablename='node_accounting_observations')
 THEN RAISE EXCEPTION 'Published node accounting observations required'; END IF;
END$$;
ALTER PUBLICATION ask_public_core_v1 DROP TABLE public.node_accounting_observations;
REVOKE SELECT(hash,height,observed_at,chain,nsm_balance_zat,circulating_supply_zat,pool_balances_zat) ON public.node_accounting_observations FROM ask_core_replicator;
COMMIT;
