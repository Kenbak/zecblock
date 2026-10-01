-- 033: Crosslink legacy schema compatibility for current explorer reads.
-- Run only on the Crosslink feature-net database. No observations, roots or
-- unsupported Ironwood facts are invented: unavailable columns stay NULL.
BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';
DO $$ BEGIN
  IF current_database() NOT IN ('zcash_crosslink', 'zcash_explorer_crosslink')
     AND current_database() NOT LIKE 'crosslink_recovery_test_%' THEN
    RAISE EXCEPTION 'Migration 033 is restricted to Crosslink databases';
  END IF;
END $$;
ALTER TABLE public.blocks
  ADD COLUMN IF NOT EXISTS final_orchard_root text,
  ADD COLUMN IF NOT EXISTS final_ironwood_root text,
  ADD COLUMN IF NOT EXISTS coinbase_hex text;
ALTER TABLE public.transactions
  ADD COLUMN IF NOT EXISTS value_balance_ironwood bigint,
  ADD COLUMN IF NOT EXISTS has_ironwood boolean,
  ADD COLUMN IF NOT EXISTS ironwood_actions integer,
  ADD COLUMN IF NOT EXISTS orchard_anchor text,
  ADD COLUMN IF NOT EXISTS sapling_anchor text;
-- Empty until an authoritative collector records a real observation/orphan.
CREATE TABLE IF NOT EXISTS public.orphaned_blocks (
  id bigserial PRIMARY KEY, height bigint NOT NULL, hash text UNIQUE NOT NULL,
  canonical_hash text, timestamp bigint, transaction_count integer,
  size integer, difficulty text, miner_address text, previous_block_hash text,
  source text, detected_at timestamptz, first_indexed_at timestamptz,
  coinbase_hex text, final_sapling_root text, final_orchard_root text,
  final_ironwood_root text, block_metadata jsonb, raw_hex text
);
CREATE TABLE IF NOT EXISTS public.block_observations (
  hash text PRIMARY KEY CHECK (hash ~ '^[0-9a-f]{64}$'),
  height bigint NOT NULL CHECK (height >= 0),
  first_seen_at timestamptz NOT NULL,
  source text NOT NULL CHECK (source = 'local-node-rpc'),
  poll_interval_ms integer NOT NULL CHECK (poll_interval_ms > 0)
);
DO $$ DECLARE r record; BEGIN
  FOR r IN SELECT DISTINCT grantee FROM information_schema.role_table_grants
    WHERE table_schema='public' AND table_name='blocks' AND grantee <> 'PUBLIC'
  LOOP
    IF has_table_privilege(r.grantee,'public.blocks','SELECT') THEN
      EXECUTE format('GRANT SELECT ON public.orphaned_blocks, public.block_observations TO %I',r.grantee);
    END IF;
  END LOOP;
END $$;
COMMENT ON COLUMN public.blocks.final_orchard_root IS 'NULL until populated by an authoritative Crosslink parser; not an inferred root';
COMMENT ON COLUMN public.transactions.has_ironwood IS 'NULL means unavailable on the Crosslink parser, not false';
COMMIT;
