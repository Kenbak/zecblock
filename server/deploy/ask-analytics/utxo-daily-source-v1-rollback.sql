\set ON_ERROR_STOP on
-- Reverses utxo-daily-source-v1.sql only. Run before the destination rollback.
BEGIN;
SET LOCAL lock_timeout='500ms'; SET LOCAL statement_timeout='5s';
DO $$BEGIN
 IF current_database()<>'zcash_explorer_mainnet' OR pg_is_in_recovery()
 OR (SELECT count(*) FROM pg_publication_tables WHERE pubname='ask_public_core_v1' AND schemaname='public' AND tablename IN('utxo_age_daily','transparent_realized_cap_daily'))<>2
 THEN RAISE EXCEPTION 'Published UTXO summary tables required'; END IF;
END$$;
ALTER PUBLICATION ask_public_core_v1 DROP TABLE public.utxo_age_daily,public.transparent_realized_cap_daily;
REVOKE SELECT(date,lt_1m_zat,b_1_3m_zat,b_3_6m_zat,b_6_12m_zat,b_1_2y_zat,gt_2y_zat,total_unspent_zat,utxo_count,cdd,avg_dormancy_days,spent_count) ON public.utxo_age_daily FROM ask_core_replicator;
REVOKE SELECT(date,realized_cap_usd,unspent_count,avg_cost_basis_usd) ON public.transparent_realized_cap_daily FROM ask_core_replicator;
COMMIT;
