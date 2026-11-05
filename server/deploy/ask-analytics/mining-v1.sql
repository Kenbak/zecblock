\set ON_ERROR_STOP on
-- Additive dedicated-store migration: daily mining pool attribution and node
-- software markers (two small replicated daily tables), block first-seen timing
-- (two replicated receipt tables, hash/height/time columns only) and daily
-- issuance (closed-form consensus sums over supply_daily heights, no table).
-- Apply BEFORE mining-source-v1.sql: a published table without its destination
-- table stops apply, and disable_on_error halts all research.
-- Reader grants change only by adding the four views. Rollback: see
-- mining.md (source first, then mining-v1-rollback.sql).
BEGIN;
SET LOCAL lock_timeout='500ms';SET LOCAL statement_timeout='30s';SET LOCAL timezone='UTC';
DO $$BEGIN
 IF current_database()<>'ask_analytics' OR pg_is_in_recovery()
 OR NOT EXISTS(SELECT FROM analytics_meta.identity WHERE store_kind='logical_public_core' AND schema_version=1)
 OR NOT EXISTS(SELECT FROM pg_roles WHERE rolname=current_user AND rolsuper)
 OR to_regclass('analytics_public.supply_daily_query') IS NULL
 OR to_regclass('public.analytics_history_daily') IS NOT NULL OR to_regclass('public.block_software_daily') IS NOT NULL
 OR to_regclass('public.block_observations') IS NOT NULL OR to_regclass('public.captured_blocks') IS NOT NULL
 OR to_regclass('analytics_public.issuance_daily_query') IS NOT NULL
 OR EXISTS(SELECT FROM analytics_meta.dataset_state WHERE dataset IN('mining_daily','software_daily','issuance_daily','block_timing'))
 THEN RAISE EXCEPTION 'Existing supply/issuance catalogue without mining datasets required';END IF;
END$$;
SET LOCAL ROLE analytics_owner;
-- Same names and types as the reviewed source columns (migrations 028 and 023,
-- and the explorer's block receipt tables).
CREATE TABLE public.analytics_history_daily(date date PRIMARY KEY,anchor_height bigint,anchor_hash text,mining_pool_blocks jsonb);
CREATE TABLE public.block_software_daily(day integer,software text,blocks bigint,PRIMARY KEY(day,software));
CREATE TABLE public.block_observations(hash text PRIMARY KEY,height bigint,first_seen_at timestamptz);
CREATE TABLE public.captured_blocks(hash text PRIMARY KEY,height bigint,first_seen_at timestamptz);
-- Subscriber-only indexes: bound the timing view to the collection range.
CREATE INDEX block_observations_height_idx ON public.block_observations(height);
CREATE INDEX captured_blocks_height_idx ON public.captured_blocks(height);
INSERT INTO analytics_meta.dataset_state(dataset) VALUES('mining_daily'),('software_daily'),('issuance_daily'),('block_timing');
RESET ROLE;
GRANT SELECT ON public.analytics_history_daily,public.block_software_daily,public.block_observations,public.captured_blocks TO ask_public_view_owner;
SET LOCAL ROLE ask_public_view_owner;
-- Pool attribution per completed UTC date, written by the mainnet analytics
-- history job from the shared pool registry (coinbase tags and payout
-- addresses). A row whose anchor is not a canonical replicated block is hidden.
CREATE VIEW analytics_public.mining_daily_query WITH(security_barrier=true) AS
 SELECT h.date,p.key AS pool,p.value::bigint AS blocks,sum(p.value::bigint) OVER(PARTITION BY h.date) AS day_blocks
 FROM public.analytics_history_daily h
 JOIN public.blocks b ON b.height=h.anchor_height AND b.hash=h.anchor_hash
 CROSS JOIN LATERAL jsonb_each_text(h.mining_pool_blocks) p
 CROSS JOIN analytics_public.dataset_coverage c CROSS JOIN analytics_public.coverage core
 WHERE c.dataset='mining_daily' AND c.ready AND core.ready AND h.date<CURRENT_DATE AND h.anchor_height BETWEEN core.covered_from AND core.covered_through;
-- Trigger-maintained canonical counts per UTC day (day = days since 1970-01-01).
-- A day is shown only once the replicated canonical tip has passed its end.
CREATE VIEW analytics_public.software_daily_query WITH(security_barrier=true) AS
 SELECT DATE '1970-01-01'+s.day AS date,s.software,s.blocks,sum(s.blocks) OVER(PARTITION BY s.day) AS day_blocks
 FROM public.block_software_daily s
 CROSS JOIN analytics_public.dataset_coverage c CROSS JOIN analytics_public.coverage core
 JOIN public.blocks tip ON tip.height=core.covered_through
 WHERE c.dataset='software_daily' AND c.ready AND core.ready AND s.day<LEAST(CURRENT_DATE-DATE '1970-01-01',(tip.timestamp/86400)::integer);
-- Earliest ZecBlock receipt of each canonical block (1 s local-node tip poll or
-- the node block stream), against the miner-written header time. Blocks neither
-- collector saw are absent; collection starts at the earliest receipt.
CREATE VIEW analytics_public.block_timing_query WITH(security_barrier=true) AS
 SELECT b.height,b.hash,b.timestamp,b.miner_address AS miner,r.first_seen,r.first_seen-b.timestamp AS lag_seconds,r.observed_by
 FROM public.blocks b
 CROSS JOIN analytics_public.dataset_coverage c CROSS JOIN analytics_public.coverage core
 CROSS JOIN LATERAL(SELECT round(extract(epoch FROM x.first_seen_at),3) AS first_seen,x.observed_by FROM(
  SELECT o.first_seen_at,'local-node-rpc'::text AS observed_by FROM public.block_observations o WHERE o.hash=b.hash
  UNION ALL SELECT k.first_seen_at,'node-block-stream' FROM public.captured_blocks k WHERE k.hash=b.hash) x ORDER BY x.first_seen_at LIMIT 1) r
 WHERE c.dataset='block_timing' AND c.ready AND core.ready AND b.height BETWEEN core.covered_from AND core.covered_through
 AND b.height>=(SELECT LEAST((SELECT min(height) FROM public.block_observations),(SELECT min(height) FROM public.captured_blocks)));
-- Daily sums of the per-block schedule in issuance_query, in closed form over the
-- heights each supply_daily date covers (previous date's height + 1 through
-- this date's height). Constant-subsidy eras multiply; the slow start sums an
-- arithmetic series. The first archived date starts at genesis; a date whose
-- previous date is missing, or that reaches NU7 (3543405, ZIP 234), is NULL.
CREATE VIEW analytics_public.issuance_daily_query WITH(security_barrier=true) AS
 WITH days AS(
  SELECT s.date,s.height AS last_height,
   CASE WHEN lag(s.date) OVER w=s.date-1 THEN lag(s.height) OVER w+1 WHEN lag(s.date) OVER w IS NULL AND s.date=DATE '2016-10-28' THEN 0 END AS first_height
  FROM analytics_public.supply_daily_query s WINDOW w AS(ORDER BY s.date)),
 eras(lo,hi,ramp,subsidy,founders,streams,lockbox) AS(VALUES
  (1::bigint,9999::bigint,0::bigint,NULL::bigint,NULL::bigint,0::bigint,0::bigint),
  (10000,19999,1,NULL,NULL,0,0),
  (20000,653599,NULL,1250000000,250000000,0,0),
  (653600,1046399,NULL,625000000,125000000,0,0),
  (1046400,2726399,NULL,312500000,0,62500000,0),
  (2726400,3543404,NULL,156250000,0,12500000,18750000))
 SELECT d.date,d.first_height,d.last_height,d.last_height-d.first_height+1 AS blocks,
  a.subsidy,a.subsidy-a.founders-a.streams-a.lockbox AS miner_subsidy,a.founders,a.streams AS funding_streams,a.lockbox,
  CASE WHEN d.first_height IS NULL OR d.last_height>=3543405 THEN NULL WHEN 3146400 BETWEEN d.first_height AND d.last_height THEN 7875000000000 ELSE 0 END::bigint AS lockbox_disbursed
 FROM days d
 CROSS JOIN analytics_public.dataset_coverage c
 CROSS JOIN LATERAL(
  SELECT CASE WHEN ok THEN coalesce(sum(CASE WHEN e.ramp IS NULL THEN r.n*e.subsidy ELSE 62500*((r.x+r.y)*r.n/2+e.ramp*r.n) END),0) END::bigint AS subsidy,
   CASE WHEN ok THEN coalesce(sum(CASE WHEN e.ramp IS NULL THEN r.n*e.founders ELSE 62500*((r.x+r.y)*r.n/2+e.ramp*r.n)/5 END),0) END::bigint AS founders,
   CASE WHEN ok THEN coalesce(sum(r.n*e.streams),0) END::bigint AS streams,
   CASE WHEN ok THEN coalesce(sum(r.n*e.lockbox),0) END::bigint AS lockbox
  FROM (SELECT d.first_height IS NOT NULL AND d.last_height<3543405 AS ok) k
  LEFT JOIN eras e ON k.ok AND e.lo<=d.last_height AND e.hi>=d.first_height
  LEFT JOIN LATERAL(SELECT GREATEST(e.lo,d.first_height) AS x,LEAST(e.hi,d.last_height) AS y,LEAST(e.hi,d.last_height)-GREATEST(e.lo,d.first_height)+1 AS n) r ON true
  GROUP BY k.ok) a
 WHERE c.dataset='issuance_daily' AND c.ready;
RESET ROLE;
REVOKE ALL ON public.analytics_history_daily,public.block_software_daily,public.block_observations,public.captured_blocks FROM PUBLIC;
GRANT SELECT ON analytics_public.mining_daily_query,analytics_public.software_daily_query,analytics_public.block_timing_query,analytics_public.issuance_daily_query TO ask_public_reader;
COMMIT;
