\set ON_ERROR_STOP on
-- Replaces value_pools_daily_query with an equivalent plan that stays inside the
-- reader's temp_file_limit (16MB at work_mem 1MB). v1 materialized every
-- observation's pool_balances_zat jsonb in a CTE read three times; any query
-- reading a balance spilled past the limit (2026-11-02: "temporary file size
-- exceeds temp_file_limit", count(*) unaffected). v2 aggregates one row per date
-- first and reads the jsonb for those rows only. Same columns and types, so the
-- reader grant is kept. Rollback: re-run the CREATE VIEW of value-pools-v1.sql
-- as CREATE OR REPLACE VIEW (same columns).
BEGIN;
SET LOCAL lock_timeout='500ms';SET LOCAL statement_timeout='30s';SET LOCAL timezone='UTC';
DO $$BEGIN
 IF current_database()<>'ask_analytics' OR pg_is_in_recovery()
 OR NOT EXISTS(SELECT FROM pg_roles WHERE rolname=current_user AND rolsuper)
 OR to_regclass('analytics_public.value_pools_daily_query') IS NULL OR to_regclass('public.node_accounting_observations') IS NULL
 THEN RAISE EXCEPTION 'value-pools-v1.sql required on the analytics store';END IF;
END$$;
SET LOCAL ROLE ask_public_view_owner;
CREATE OR REPLACE VIEW analytics_public.value_pools_daily_query WITH(security_barrier=true) AS
 WITH per AS(
  SELECT (pg_catalog.to_timestamp(b.timestamp) AT TIME ZONE 'UTC')::date AS date,max(b.height) AS height,min(b.height) AS first_height,count(*) AS observed_blocks
  FROM public.node_accounting_observations o JOIN public.blocks b ON b.height=o.height AND b.hash=o.hash
  WHERE o.chain='main' GROUP BY 1),
 days AS(
  SELECT (pg_catalog.to_timestamp(b.timestamp) AT TIME ZONE 'UTC')::date AS date,count(*) AS day_blocks
  FROM public.blocks b WHERE b.height>=(SELECT min(first_height) FROM per) GROUP BY 1)
 SELECT p.date,p.height,b.hash,p.observed_blocks,d.day_blocks,
  (o.pool_balances_zat->>'transparent')::bigint AS transparent,(o.pool_balances_zat->>'sprout')::bigint AS sprout,(o.pool_balances_zat->>'sapling')::bigint AS sapling,
  (o.pool_balances_zat->>'orchard')::bigint AS orchard,(o.pool_balances_zat->>'ironwood')::bigint AS ironwood,(o.pool_balances_zat->>'lockbox')::bigint AS lockbox,
  o.nsm_balance_zat AS nsm,o.circulating_supply_zat AS chain_supply
 FROM per p JOIN days d USING(date) JOIN public.blocks b ON b.height=p.height
 JOIN public.node_accounting_observations o ON o.height=b.height AND o.hash=b.hash AND o.chain='main'
 CROSS JOIN analytics_public.dataset_coverage c CROSS JOIN analytics_public.coverage core
 WHERE p.date<CURRENT_DATE AND c.dataset='value_pools_daily' AND c.ready AND core.ready AND p.height BETWEEN core.covered_from AND core.covered_through;
RESET ROLE;
COMMIT;
