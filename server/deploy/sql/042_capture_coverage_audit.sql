-- 042: Measurable competing-block capture coverage.
-- Additive and idempotent. Existing collectors keep working: every new observer
-- column is nullable and the collector only writes them once this table exists.
--
-- coverage_since: first delivery by a collector that times its gaps; streaming
--   fractions must use it, not collection_started_at (earlier gaps were not timed).
-- unobserved_ms / recent_gaps: time the collector was not streaming (process
--   down or disconnected). Retained replay may still recover blocks from these
--   intervals, so they bound unverified time, not missed blocks.
-- block_capture_audit_misses: node `getchaintips` valid-fork branch blocks the
--   collector had not captured on two consecutive audits. A later capture is
--   kept as captured_later_at, never deleted.
-- audit_canonical_*: recent canonical indexed blocks absent from captured_blocks,
--   a direct check that the block stream is not silently dropping blocks.
BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '120s';
ALTER TABLE public.block_capture_observers
    ADD COLUMN IF NOT EXISTS coverage_since timestamptz,
    ADD COLUMN IF NOT EXISTS unobserved_ms bigint CHECK (unobserved_ms >= 0),
    ADD COLUMN IF NOT EXISTS outage_since timestamptz,
    ADD COLUMN IF NOT EXISTS recent_gaps jsonb,
    ADD COLUMN IF NOT EXISTS pending_bytes bigint CHECK (pending_bytes >= 0),
    ADD COLUMN IF NOT EXISTS journal_max_bytes bigint CHECK (journal_max_bytes > 0),
    ADD COLUMN IF NOT EXISTS audit_checked_at timestamptz,
    ADD COLUMN IF NOT EXISTS audit_status text,
    ADD COLUMN IF NOT EXISTS audit_fork_tips integer CHECK (audit_fork_tips >= 0),
    ADD COLUMN IF NOT EXISTS audit_fork_blocks integer CHECK (audit_fork_blocks >= 0),
    ADD COLUMN IF NOT EXISTS audit_canonical_checked integer CHECK (audit_canonical_checked >= 0),
    ADD COLUMN IF NOT EXISTS audit_canonical_missing integer CHECK (audit_canonical_missing >= 0);
CREATE TABLE IF NOT EXISTS public.block_capture_audit_misses (
    observer text NOT NULL REFERENCES public.block_capture_observers(observer),
    hash text NOT NULL CHECK (hash ~ '^[0-9a-f]{64}$'),
    network text NOT NULL CHECK (network IN ('mainnet', 'testnet')),
    height bigint NOT NULL CHECK (height >= 0),
    branch_len integer NOT NULL CHECK (branch_len >= 1),
    detected_at timestamptz NOT NULL DEFAULT now(),
    captured_later_at timestamptz,
    PRIMARY KEY (observer, hash)
);
REVOKE ALL ON public.block_capture_audit_misses FROM PUBLIC;
DO $$
DECLARE r record;
BEGIN
  -- Same role mapping as 035: readers of blocks may read; writers may record.
  FOR r IN SELECT DISTINCT grantee FROM information_schema.role_table_grants
    WHERE table_schema='public' AND table_name='blocks' AND grantee <> 'PUBLIC'
  LOOP
    IF has_table_privilege(r.grantee,'public.blocks','SELECT') THEN
      EXECUTE format('GRANT SELECT ON public.block_capture_audit_misses TO %I', r.grantee);
    END IF;
    IF has_table_privilege(r.grantee,'public.blocks','INSERT') THEN
      EXECUTE format('GRANT INSERT, UPDATE ON public.block_capture_audit_misses TO %I', r.grantee);
    END IF;
  END LOOP;
  -- The restricted collector role already writes block_capture_observers.
  FOR r IN SELECT DISTINCT grantee FROM information_schema.role_table_grants
    WHERE table_schema='public' AND table_name='block_capture_observers'
      AND privilege_type='UPDATE' AND grantee <> 'PUBLIC'
  LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON public.block_capture_audit_misses TO %I', r.grantee);
  END LOOP;
END $$;
COMMIT;
