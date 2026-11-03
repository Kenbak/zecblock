\set ON_ERROR_STOP on
-- Mainnet publisher: adds the daily transparent UTXO-set summaries to the
-- reviewed feed, reviewed columns only. Real production metadata change; owner
-- approval only. Apply utxo-daily-v1.sql on the analytics store FIRST. The job
-- bookkeeping column created_at stays private. No source rows, writers, jobs or
-- API change. Rollback: utxo-daily-source-v1-rollback.sql.
BEGIN;
SET LOCAL lock_timeout='500ms'; SET LOCAL statement_timeout='5s';
DO $$BEGIN
 IF current_database()<>'zcash_explorer_mainnet' OR pg_is_in_recovery()
 OR NOT EXISTS(SELECT FROM pg_publication WHERE pubname='ask_public_core_v1' AND NOT puballtables)
 OR NOT EXISTS(SELECT FROM pg_roles WHERE rolname='ask_core_replicator' AND rolreplication AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole)
 OR to_regclass('public.utxo_age_daily') IS NULL OR to_regclass('public.transparent_realized_cap_daily') IS NULL
 OR EXISTS(SELECT FROM pg_publication_tables WHERE pubname='ask_public_core_v1' AND schemaname='public' AND tablename IN('utxo_age_daily','transparent_realized_cap_daily'))
 THEN RAISE EXCEPTION 'Existing reviewed mainnet source feed with the UTXO summary tables required'; END IF;
END$$;
GRANT SELECT(date,lt_1m_zat,b_1_3m_zat,b_3_6m_zat,b_6_12m_zat,b_1_2y_zat,gt_2y_zat,total_unspent_zat,utxo_count,cdd,avg_dormancy_days,spent_count) ON public.utxo_age_daily TO ask_core_replicator;
GRANT SELECT(date,realized_cap_usd,unspent_count,avg_cost_basis_usd) ON public.transparent_realized_cap_daily TO ask_core_replicator;
ALTER PUBLICATION ask_public_core_v1 ADD TABLE public.utxo_age_daily(date,lt_1m_zat,b_1_3m_zat,b_3_6m_zat,b_6_12m_zat,b_1_2y_zat,gt_2y_zat,total_unspent_zat,utxo_count,cdd,avg_dormancy_days,spent_count),public.transparent_realized_cap_daily(date,realized_cap_usd,unspent_count,avg_cost_basis_usd);
COMMIT;
