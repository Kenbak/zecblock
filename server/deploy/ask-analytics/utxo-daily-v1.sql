\set ON_ERROR_STOP on
-- Additive dedicated-store migration: daily transparent UTXO-set summaries (two
-- small replicated tables, reviewed columns only). Apply BEFORE
-- utxo-daily-source-v1.sql: a published table without its destination table
-- stops apply, and disable_on_error halts all research. No reader grant here:
-- utxo-daily-grant-v1.sql runs only after the worker build that lists the view.
-- Rollback: see utxo-daily.md (source first, then utxo-daily-v1-rollback.sql).
BEGIN;
SET LOCAL lock_timeout='500ms';SET LOCAL statement_timeout='30s';SET LOCAL timezone='UTC';
DO $$BEGIN
 IF current_database()<>'ask_analytics' OR pg_is_in_recovery()
 OR NOT EXISTS(SELECT FROM analytics_meta.identity WHERE store_kind='logical_public_core' AND schema_version=1)
 OR NOT EXISTS(SELECT FROM pg_roles WHERE rolname=current_user AND rolsuper)
 OR to_regclass('analytics_public.value_pools_daily_query') IS NULL
 OR to_regclass('public.utxo_age_daily') IS NOT NULL OR to_regclass('public.transparent_realized_cap_daily') IS NOT NULL
 OR EXISTS(SELECT FROM analytics_meta.dataset_state WHERE dataset='utxo_daily')
 THEN RAISE EXCEPTION 'Existing value-pool catalogue without UTXO dataset required';END IF;
END$$;
SET LOCAL ROLE analytics_owner;
-- Same names and types as the reviewed source columns. The explorer's jobs upsert
-- one row per completed UTC date and repair the last seven dates each morning.
CREATE TABLE public.utxo_age_daily(date date PRIMARY KEY,lt_1m_zat bigint,b_1_3m_zat bigint,b_3_6m_zat bigint,b_6_12m_zat bigint,b_1_2y_zat bigint,gt_2y_zat bigint,total_unspent_zat bigint,utxo_count integer,cdd double precision,avg_dormancy_days double precision,spent_count integer);
CREATE TABLE public.transparent_realized_cap_daily(date date PRIMARY KEY,realized_cap_usd numeric,unspent_count bigint,avg_cost_basis_usd numeric);
INSERT INTO analytics_meta.dataset_state(dataset) VALUES('utxo_daily');
RESET ROLE;
GRANT SELECT ON public.utxo_age_daily,public.transparent_realized_cap_daily TO ask_public_view_owner;
SET LOCAL ROLE ask_public_view_owner;
-- One row per completed UTC date: the transparent UTXO set (outputs with value
-- above zero) at 23:59:59 UTC, by age since the creating block, plus that date's
-- spends. cdd is coin-days destroyed (ZEC x days held, over outputs spent that
-- date). realized_cap_usd values each unspent output at the daily USD price of
-- its creation date. Both tables have 3,657 narrow rows, so no temp spill.
CREATE VIEW analytics_public.utxo_daily_query WITH(security_barrier=true) AS
 SELECT u.date,u.utxo_count::bigint AS utxos,u.total_unspent_zat AS unspent,
  u.lt_1m_zat AS age_lt_1m,u.b_1_3m_zat AS age_1_3m,u.b_3_6m_zat AS age_3_6m,u.b_6_12m_zat AS age_6_12m,u.b_1_2y_zat AS age_1_2y,u.gt_2y_zat AS age_gt_2y,
  u.spent_count::bigint AS spent_outputs,round(u.cdd::numeric,4) AS cdd,round(u.avg_dormancy_days::numeric,4) AS avg_dormancy_days,
  round(r.realized_cap_usd,2) AS realized_cap_usd,round(r.avg_cost_basis_usd,4) AS avg_cost_basis_usd
 FROM public.utxo_age_daily u LEFT JOIN public.transparent_realized_cap_daily r ON r.date=u.date AND r.unspent_count=u.utxo_count
 CROSS JOIN analytics_public.dataset_coverage c CROSS JOIN analytics_public.coverage core
 WHERE u.date<CURRENT_DATE AND c.dataset='utxo_daily' AND c.ready AND core.ready;
RESET ROLE;
REVOKE ALL ON public.utxo_age_daily,public.transparent_realized_cap_daily FROM PUBLIC;
COMMIT;
