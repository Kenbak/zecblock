\set ON_ERROR_STOP on
-- Additive dedicated-store migration: daily node-reported value-pool balances
-- (one small replicated table, reviewed columns only). Apply BEFORE
-- value-pools-source-v1.sql: a published table without its destination table
-- stops apply, and disable_on_error halts all research. No reader grant here:
-- value-pools-grant-v1.sql runs only after the worker build that lists the view
-- (its guard refuses every query while the reader can read an unlisted view).
-- Rollback: see value-pools.md (source first, then value-pools-v1-rollback.sql).
BEGIN;
SET LOCAL lock_timeout='500ms';SET LOCAL statement_timeout='30s';SET LOCAL timezone='UTC';
DO $$BEGIN
 IF current_database()<>'ask_analytics' OR pg_is_in_recovery()
 OR NOT EXISTS(SELECT FROM analytics_meta.identity WHERE store_kind='logical_public_core' AND schema_version=1)
 OR NOT EXISTS(SELECT FROM pg_roles WHERE rolname=current_user AND rolsuper)
 OR to_regclass('analytics_public.swap_daily_query') IS NULL
 OR to_regclass('public.node_accounting_observations') IS NOT NULL
 OR EXISTS(SELECT FROM analytics_meta.dataset_state WHERE dataset='value_pools_daily')
 THEN RAISE EXCEPTION 'Existing swap catalogue without value-pool dataset required';END IF;
END$$;
SET LOCAL ROLE analytics_owner;
-- Same names and types as the reviewed source columns. The indexer only inserts
-- (ON CONFLICT DO NOTHING); subsidy, upgrades, source and poll interval stay private.
CREATE TABLE public.node_accounting_observations(hash text PRIMARY KEY,height bigint NOT NULL,observed_at timestamptz NOT NULL,chain text,nsm_balance_zat bigint,circulating_supply_zat bigint,pool_balances_zat jsonb NOT NULL);
CREATE INDEX node_accounting_observations_height_idx ON public.node_accounting_observations(height);
INSERT INTO analytics_meta.dataset_state(dataset) VALUES('value_pools_daily');
RESET ROLE;
GRANT SELECT ON public.node_accounting_observations TO ask_public_view_owner;
SET LOCAL ROLE ask_public_view_owner;
-- One row per completed UTC date (block header time) with at least one observed
-- canonical block: the node's getblockchaininfo snapshot at the highest observed
-- canonical block of that date. Observations of orphaned blocks never match a
-- canonical (height, hash). A pool the node did not monitor stays NULL. The node's
-- circulating_supply_zat is the sum of every pool INCLUDING the lockbox (equal to
-- supply_daily.chain_supply at day ends), so it is published as chain_supply.
CREATE VIEW analytics_public.value_pools_daily_query WITH(security_barrier=true) AS
 WITH obs AS(
  SELECT (pg_catalog.to_timestamp(b.timestamp) AT TIME ZONE 'UTC')::date AS date,b.height,b.hash,o.nsm_balance_zat,o.circulating_supply_zat,o.pool_balances_zat p
  FROM public.node_accounting_observations o JOIN public.blocks b ON b.height=o.height AND b.hash=o.hash
  WHERE o.chain='main'),
 last AS(SELECT DISTINCT ON(date) * FROM obs ORDER BY date,height DESC),
 observed AS(SELECT date,count(*) AS observed_blocks FROM obs GROUP BY date),
 days AS(
  SELECT (pg_catalog.to_timestamp(b.timestamp) AT TIME ZONE 'UTC')::date AS date,count(*) AS day_blocks
  FROM public.blocks b WHERE b.height>=(SELECT min(height) FROM obs) GROUP BY 1)
 SELECT l.date,l.height,l.hash,o.observed_blocks,d.day_blocks,
  (l.p->>'transparent')::bigint AS transparent,(l.p->>'sprout')::bigint AS sprout,(l.p->>'sapling')::bigint AS sapling,
  (l.p->>'orchard')::bigint AS orchard,(l.p->>'ironwood')::bigint AS ironwood,(l.p->>'lockbox')::bigint AS lockbox,
  l.nsm_balance_zat AS nsm,l.circulating_supply_zat AS chain_supply
 FROM last l JOIN observed o USING(date) JOIN days d USING(date)
 CROSS JOIN analytics_public.dataset_coverage c CROSS JOIN analytics_public.coverage core
 WHERE l.date<CURRENT_DATE AND c.dataset='value_pools_daily' AND c.ready AND core.ready AND l.height BETWEEN core.covered_from AND core.covered_through;
RESET ROLE;
REVOKE ALL ON public.node_accounting_observations FROM PUBLIC;
COMMIT;
