\set ON_ERROR_STOP on
-- Additive dedicated-store migration: daily ZEC supply (replicated node archive)
-- and per-block consensus issuance (derived from canonical blocks, no table).
-- Apply BEFORE supply-issuance-source-v1.sql: a published table without this
-- destination table stops apply, and disable_on_error halts all research.
-- Reader grants change only by adding the two views. Rollback: see
-- supply-issuance.md (source first, then supply-issuance-v1-rollback.sql).
BEGIN;
SET LOCAL lock_timeout='500ms';SET LOCAL statement_timeout='30s';SET LOCAL timezone='UTC';
DO $$BEGIN
 IF current_database()<>'ask_analytics' OR pg_is_in_recovery()
 OR NOT EXISTS(SELECT FROM analytics_meta.identity WHERE store_kind='logical_public_core' AND schema_version=1)
 OR NOT EXISTS(SELECT FROM pg_roles WHERE rolname=current_user AND rolsuper)
 OR to_regclass('analytics_meta.dataset_state') IS NULL OR to_regclass('public.chain_supply_daily') IS NOT NULL
 OR to_regclass('analytics_public.issuance_query') IS NOT NULL OR EXISTS(SELECT FROM analytics_meta.dataset_state WHERE dataset='supply_daily')
 THEN RAISE EXCEPTION 'Existing extended catalogue without supply/issuance required';END IF;
END$$;
SET LOCAL ROLE analytics_owner;
-- Same names and types as the reviewed source columns of migration 032.
CREATE TABLE public.chain_supply_daily(date date PRIMARY KEY,block_height bigint,block_hash text,block_time bigint,chain_supply_zat bigint);
INSERT INTO analytics_meta.dataset_state(dataset) VALUES('supply_daily');
RESET ROLE;
GRANT SELECT ON public.chain_supply_daily TO ask_public_view_owner;
SET LOCAL ROLE ask_public_view_owner;
-- Consensus constants, checked against node getblocksubsidy at every boundary:
-- slow start (62500 zat/height, shift at 10000, full subsidy from 20000),
-- Blossom 653600 (halved spacing), halvings 1046400 and 2726400, founders 20%
-- below 1046400, ZIP 1014 streams 7+5+8% to 2726400, ZIP 2001 8% streams plus a
-- 12% lockbox from 2726400, and the one-time 78750 ZEC lockbox release at
-- NU6.1 (3146400). NU7 (3543405) applies ZIP 234: subsidy depends on chain
-- state, so every allocation is NULL from that height instead of guessed.
CREATE VIEW analytics_public.supply_daily_query WITH(security_barrier=true) AS
 SELECT s.date,s.block_height AS height,s.block_hash AS hash,s.block_time AS timestamp,s.chain_supply_zat AS chain_supply,l.lockbox,s.chain_supply_zat-l.lockbox AS circulating_supply,
 CASE WHEN lag(s.date) OVER w=s.date-1 THEN s.chain_supply_zat-lag(s.chain_supply_zat) OVER w END AS net_change
 FROM public.chain_supply_daily s
 JOIN public.blocks b ON b.height=s.block_height AND b.hash=s.block_hash
 CROSS JOIN LATERAL (SELECT CASE WHEN s.block_height>=3543405 THEN NULL WHEN s.block_height<2726400 THEN 0 ELSE 18750000*(s.block_height-2726399)-CASE WHEN s.block_height>=3146400 THEN 7875000000000 ELSE 0 END END::bigint AS lockbox) l
 CROSS JOIN analytics_public.dataset_coverage c CROSS JOIN analytics_public.coverage core
 WHERE c.dataset='supply_daily' AND c.ready AND core.ready AND s.date<CURRENT_DATE AND s.block_height BETWEEN core.covered_from AND core.covered_through
 WINDOW w AS (ORDER BY s.date);
CREATE VIEW analytics_public.issuance_query WITH(security_barrier=true) AS
 SELECT b.height,b.hash,b.timestamp,a.subsidy,a.subsidy-a.founders-a.funding_streams-a.lockbox AS miner_subsidy,a.founders,a.funding_streams,a.lockbox,
 CASE WHEN b.height>=3543405 THEN NULL WHEN b.height=3146400 THEN 7875000000000 ELSE 0 END::bigint AS lockbox_disbursed,b.total_fees AS fees
 FROM public.blocks b CROSS JOIN analytics_public.coverage c
 CROSS JOIN LATERAL (SELECT s.subsidy,
  CASE WHEN s.subsidy IS NULL THEN NULL WHEN b.height<1046400 THEN s.subsidy/5 ELSE 0 END AS founders,
  CASE WHEN s.subsidy IS NULL THEN NULL WHEN b.height<1046400 THEN 0 WHEN b.height<2726400 THEN s.subsidy*7/100+s.subsidy*5/100+s.subsidy*8/100 ELSE s.subsidy*8/100 END AS funding_streams,
  CASE WHEN s.subsidy IS NULL THEN NULL WHEN b.height<2726400 THEN 0 ELSE s.subsidy*12/100 END AS lockbox
  FROM (SELECT CASE WHEN b.height>=3543405 THEN NULL WHEN b.height<10000 THEN 62500*b.height WHEN b.height<20000 THEN 62500*(b.height+1) WHEN b.height<653600 THEN 1250000000
   ELSE 625000000::bigint>>((653600+(b.height-653600)/2-10000)/840000)::integer END::bigint AS subsidy) s) a
 WHERE c.ready AND b.height BETWEEN c.covered_from AND c.covered_through;
RESET ROLE;
REVOKE ALL ON public.chain_supply_daily FROM PUBLIC;
GRANT SELECT ON analytics_public.supply_daily_query,analytics_public.issuance_query TO ask_public_reader;
COMMIT;
