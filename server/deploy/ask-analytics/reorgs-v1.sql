\set ON_ERROR_STOP on
-- Additive dedicated-store migration: reorg events and orphaned blocks (two small
-- replicated tables, reviewed columns only). Apply BEFORE reorgs-source-v1.sql:
-- a published table without its destination table stops apply, and
-- disable_on_error halts all research. Reader grants change only by adding the
-- two views. Rollback: see reorgs.md (source first, then reorgs-v1-rollback.sql).
BEGIN;
SET LOCAL lock_timeout='500ms';SET LOCAL statement_timeout='30s';SET LOCAL timezone='UTC';
DO $$BEGIN
 IF current_database()<>'ask_analytics' OR pg_is_in_recovery()
 OR NOT EXISTS(SELECT FROM analytics_meta.identity WHERE store_kind='logical_public_core' AND schema_version=1)
 OR NOT EXISTS(SELECT FROM pg_roles WHERE rolname=current_user AND rolsuper)
 OR to_regclass('analytics_public.block_timing_query') IS NULL
 OR to_regclass('public.fork_events') IS NOT NULL OR to_regclass('public.orphaned_blocks') IS NOT NULL
 OR EXISTS(SELECT FROM analytics_meta.dataset_state WHERE dataset IN('reorgs','orphaned_blocks'))
 THEN RAISE EXCEPTION 'Existing mining catalogue without reorg datasets required';END IF;
END$$;
SET LOCAL ROLE analytics_owner;
-- Same names and types as the reviewed source columns of the explorer's reorg tables.
CREATE TABLE public.fork_events(id integer PRIMARY KEY,fork_height bigint,depth integer,orphaned_count integer,detected_at timestamp);
CREATE TABLE public.orphaned_blocks(id integer PRIMARY KEY,height bigint,hash text,canonical_hash text,timestamp bigint,transaction_count integer,size integer,miner_address text,fork_event_id integer,detected_at timestamp);
CREATE INDEX orphaned_blocks_fork_event_idx ON public.orphaned_blocks(fork_event_id);
INSERT INTO analytics_meta.dataset_state(dataset) VALUES('reorgs'),('orphaned_blocks');
RESET ROLE;
GRANT SELECT ON public.fork_events,public.orphaned_blocks TO ask_public_view_owner;
SET LOCAL ROLE ask_public_view_owner;
-- detected_at is written by the mainnet indexer with now() into a timestamp
-- without time zone under the server zone Europe/Berlin; convert it once here.
-- orphans counts the stored orphaned_blocks rows of the event; reported_orphans is the
-- count the indexer recorded when it rolled back (they differ for 24 early events).
CREATE VIEW analytics_public.reorgs_query WITH(security_barrier=true) AS
 SELECT f.id AS reorg_id,f.fork_height,f.depth,f.orphaned_count AS reported_orphans,
  (SELECT count(*) FROM public.orphaned_blocks o WHERE o.fork_event_id=f.id) AS orphans,
  extract(epoch FROM f.detected_at AT TIME ZONE 'Europe/Berlin')::bigint AS detected_at
 FROM public.fork_events f
 CROSS JOIN analytics_public.dataset_coverage c CROSS JOIN analytics_public.coverage core
 WHERE c.dataset='reorgs' AND c.ready AND core.ready AND f.fork_height BETWEEN core.covered_from AND core.covered_through;
-- One row per block the indexer replaced during a reorg. hash is the orphaned
-- block; canonical_hash is the block that replaced it when it was detected.
-- canonical_now is true when a later reorg restored this hash to the canonical chain.
CREATE VIEW analytics_public.orphaned_blocks_query WITH(security_barrier=true) AS
 SELECT o.height,o.hash,o.canonical_hash,o.timestamp,o.miner_address AS miner,o.transaction_count AS transactions,o.size AS bytes,o.fork_event_id AS reorg_id,
  extract(epoch FROM o.detected_at AT TIME ZONE 'Europe/Berlin')::bigint AS detected_at,
  EXISTS(SELECT FROM public.blocks b WHERE b.height=o.height AND b.hash=o.hash) AS canonical_now
 FROM public.orphaned_blocks o
 CROSS JOIN analytics_public.dataset_coverage c CROSS JOIN analytics_public.coverage core
 WHERE c.dataset='orphaned_blocks' AND c.ready AND core.ready AND o.height BETWEEN core.covered_from AND core.covered_through;
RESET ROLE;
REVOKE ALL ON public.fork_events,public.orphaned_blocks FROM PUBLIC;
GRANT SELECT ON analytics_public.reorgs_query,analytics_public.orphaned_blocks_query TO ask_public_reader;
COMMIT;
