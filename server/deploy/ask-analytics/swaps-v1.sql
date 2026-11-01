\set ON_ERROR_STOP on
-- Additive dedicated-store migration: daily cross-chain swap detail. Adds the two
-- ZEC-side amount columns to the replicated cross_chain_swaps (NEAR Intents) and a
-- replicated Maya/THORChain venue action table (reviewed columns only). Apply
-- BEFORE swaps-source-v1.sql: a published column or table without its
-- destination stops apply, and disable_on_error halts all research.
-- Reader grants change only by adding one view. The view never exposes a single
-- swap's ZEC amount or time: flows already exposes exact shield/deshield amounts
-- with timestamps, so per-swap amounts would let SQL rebuild linkage edges.
-- Rollback: see swaps.md (source first, then swaps-v1-rollback.sql).
BEGIN;
SET LOCAL lock_timeout='500ms';SET LOCAL statement_timeout='30s';SET LOCAL timezone='UTC';
DO $$BEGIN
 IF current_database()<>'ask_analytics' OR pg_is_in_recovery()
 OR NOT EXISTS(SELECT FROM analytics_meta.identity WHERE store_kind='logical_public_core' AND schema_version=1)
 OR NOT EXISTS(SELECT FROM pg_roles WHERE rolname=current_user AND rolsuper)
 OR to_regclass('analytics_public.reorgs_query') IS NULL OR to_regclass('public.cross_chain_swaps') IS NULL
 OR EXISTS(SELECT FROM pg_attribute WHERE attrelid='public.cross_chain_swaps'::regclass AND attname IN('source_amount','dest_amount') AND NOT attisdropped)
 OR to_regclass('public.crosschain_venue_actions') IS NOT NULL
 OR EXISTS(SELECT FROM analytics_meta.dataset_state WHERE dataset='swap_daily')
 THEN RAISE EXCEPTION 'Existing reorg catalogue without swap detail required';END IF;
END$$;
SET LOCAL ROLE analytics_owner;
-- Same names and types as the reviewed source columns. Rows copied before the
-- source step keep NULL amounts until the bounded backfill in swaps.md; the view
-- counts them in missing_zec, and swap_daily stays unpublished until it is 0.
ALTER TABLE public.cross_chain_swaps ADD COLUMN source_amount numeric,ADD COLUMN dest_amount numeric;
CREATE TABLE public.crosschain_venue_actions(venue text,id text,action_type text,status text,swap_created_at timestamptz,source_chain text,source_token text,dest_chain text,dest_token text,zec_amount_zat numeric,source_amount_usd numeric,dest_amount_usd numeric,PRIMARY KEY(venue,id));
INSERT INTO analytics_meta.dataset_state(dataset) VALUES('swap_daily');
RESET ROLE;
GRANT SELECT ON public.crosschain_venue_actions TO ask_public_view_owner;
GRANT SELECT(source_amount,dest_amount) ON public.cross_chain_swaps TO ask_public_view_owner;
SET LOCAL ROLE ask_public_view_owner;
-- Successful swaps per completed UTC date, venue, direction and counterparty
-- chain/token. NEAR Intents rows keep the swaps dataset's filter and direction;
-- venue direction follows the chains (equal to the provider's own direction for
-- every stored success). Cells with fewer than 5 swaps fold into chain/token
-- 'other' for that date, venue and direction; zec and usd are whole units,
-- rounded, and NULL where fewer than 5 swaps with that value contribute.
CREATE VIEW analytics_public.swap_daily_query WITH(security_barrier=true) AS
 WITH s AS(
  SELECT (x.swap_created_at AT TIME ZONE 'UTC')::date AS date,'near-intents'::text AS venue,
   CASE WHEN lower(x.dest_chain)='zec' THEN 'inflow' ELSE 'outflow' END AS direction,
   CASE WHEN lower(x.dest_chain)='zec' THEN x.source_chain ELSE x.dest_chain END AS chain,
   CASE WHEN lower(x.dest_chain)='zec' THEN x.source_token ELSE x.dest_token END AS token,
   CASE WHEN lower(x.dest_chain)='zec' THEN x.dest_amount ELSE x.source_amount END AS zec,
   NULLIF(CASE WHEN lower(x.dest_chain)='zec' THEN x.source_amount_usd ELSE x.dest_amount_usd END,0) AS usd
  FROM public.cross_chain_swaps x WHERE x.status='SUCCESS' AND (lower(x.source_chain)='zec')<>(lower(x.dest_chain)='zec')
  UNION ALL
  SELECT (v.swap_created_at AT TIME ZONE 'UTC')::date,v.venue,
   CASE WHEN v.dest_chain='zec' AND v.source_chain<>'zec' THEN 'inflow' WHEN v.source_chain='zec' AND v.dest_chain<>'zec' THEN 'outflow' ELSE 'internal' END,
   CASE WHEN v.dest_chain='zec' THEN v.source_chain ELSE v.dest_chain END,
   CASE WHEN v.dest_chain='zec' THEN v.source_token ELSE v.dest_token END,
   v.zec_amount_zat/100000000.0,
   NULLIF(CASE WHEN v.dest_chain='zec' THEN v.source_amount_usd ELSE v.dest_amount_usd END,0)
  FROM public.crosschain_venue_actions v WHERE v.action_type='swap' AND v.status='SUCCESS'),
 cells AS(
  SELECT date,venue,direction,chain,token,count(*) AS n,sum(zec) AS zec,count(zec) AS amounts,sum(usd) AS usd,count(usd) AS valued
  FROM s WHERE date<CURRENT_DATE GROUP BY 1,2,3,4,5),
 folded AS(
  SELECT date,venue,direction,CASE WHEN n<5 THEN 'other' ELSE chain END AS chain,CASE WHEN n<5 THEN 'other' ELSE token END AS token,
   sum(n) AS swaps,sum(zec) AS zec,sum(amounts) AS amounts,sum(usd) AS usd,sum(valued) AS valued
  FROM cells GROUP BY 1,2,3,4,5)
 SELECT f.date,f.venue,f.direction,f.chain,f.token,f.swaps::bigint AS swaps,
  CASE WHEN f.amounts>=5 THEN round(f.zec)::bigint END AS zec,
  CASE WHEN f.valued>=5 THEN round(f.usd)::bigint END AS usd,
  (f.swaps-f.amounts)::bigint AS missing_zec,(f.swaps-f.valued)::bigint AS missing_usd
 FROM folded f CROSS JOIN analytics_public.dataset_coverage c
 WHERE c.dataset='swap_daily' AND c.ready;
RESET ROLE;
REVOKE ALL ON public.crosschain_venue_actions FROM PUBLIC;
GRANT SELECT ON analytics_public.swap_daily_query TO ask_public_reader;
COMMIT;
