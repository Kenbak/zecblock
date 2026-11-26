-- networks: mainnet, testnet
-- Shielded pool sources and destinations v1: where value entering each
-- shielded pool comes from and where value leaving it goes, per UTC day.
-- Additive: new tables only. Written by server/jobs/refresh-pool-sources.js;
-- classifier and reader in server/lib/pool-sources.js. Reads stay unavailable
-- until `refresh-pool-sources.js --rebuild` completes (state.ready).
--
-- Every zatoshi of a pool's value balance is assigned to exactly one row, so
-- for each pool and day sum(in) - sum(out) equals the pool's exact net change
-- from canonical transactions. Amounts are exact zatoshi integers. A covered
-- day with no row is zero; a day outside coverage is unknown, never zero.
BEGIN;
SET LOCAL lock_timeout = '2s';

CREATE TABLE IF NOT EXISTS public.shielded_pool_source_daily (
  day date NOT NULL,
  pool text NOT NULL CHECK (pool IN ('sprout','sapling','orchard','ironwood')),
  direction text NOT NULL CHECK (direction IN ('in','out')),
  -- in:  migration | coinbase | mining | funding | other_coinbase | exchange | transparent | unknown
  -- out: migration | fee | exchange | transparent | unknown
  category text NOT NULL,
  -- migration: the other pool; mining/funding/other_coinbase: the reward
  -- recipient address; exchange: the exchange entity id; otherwise ''.
  detail text NOT NULL DEFAULT '',
  amount_zat bigint NOT NULL CHECK (amount_zat > 0),
  tx_count integer NOT NULL CHECK (tx_count > 0),
  PRIMARY KEY (day, pool, direction, category, detail)
);
CREATE INDEX IF NOT EXISTS idx_shielded_pool_source_daily_pool_day
  ON public.shielded_pool_source_daily (pool, day);

-- Single-row job state. `version` is the classifier version plus the
-- exchange-label and funding-stream fingerprints every stored row was
-- classified with; readers compare it with the live value to detect staleness.
-- rebuild_* track an in-progress, resumable full rebuild.
CREATE TABLE IF NOT EXISTS public.shielded_pool_source_state (
  id smallint PRIMARY KEY CHECK (id = 1),
  ready boolean NOT NULL DEFAULT false,
  version text,
  coverage_from_day date,
  through_height integer,
  through_hash text,
  through_time bigint,
  rebuild_version text,
  rebuild_next_day date,
  last_run_at timestamptz,
  last_skipped jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.shielded_pool_source_state(id) VALUES (1) ON CONFLICT DO NOTHING;

-- Readers of blocks may read the new tables; writers of blocks may maintain
-- them. Never copy PUBLIC grants.
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT DISTINCT grantee FROM information_schema.role_table_grants
    WHERE table_schema = 'public' AND table_name = 'blocks' AND grantee <> 'PUBLIC'
  LOOP
    IF has_table_privilege(r.grantee, 'public.blocks', 'SELECT') THEN
      EXECUTE format('GRANT SELECT ON public.shielded_pool_source_daily, public.shielded_pool_source_state TO %I', r.grantee);
    END IF;
    IF has_table_privilege(r.grantee, 'public.blocks', 'INSERT') OR has_table_privilege(r.grantee, 'public.blocks', 'UPDATE') THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.shielded_pool_source_daily, public.shielded_pool_source_state TO %I', r.grantee);
    END IF;
  END LOOP;
END $$;
COMMIT;
