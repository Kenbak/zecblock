-- v14's native parser distinguishes Ironwood from Orchard. Legacy rows and
-- NULL (unavailable) compatibility fields remain untouched.
BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';
DO $$ BEGIN
  IF current_database() NOT IN ('zcash_crosslink', 'zcash_explorer_crosslink')
     AND current_database() NOT LIKE 'crosslink_recovery_test_%' THEN
    RAISE EXCEPTION 'Migration 034 is restricted to Crosslink databases';
  END IF;
END $$;
ALTER TABLE public.shielded_flows DROP CONSTRAINT IF EXISTS shielded_flows_pool_check;
ALTER TABLE public.shielded_flows ADD CONSTRAINT shielded_flows_pool_check
  CHECK (pool IN ('sapling', 'orchard', 'ironwood', 'sprout', 'mixed'));
COMMENT ON COLUMN public.transactions.has_ironwood IS
  'Native v14 parser: false means no Ironwood bundle; NULL in legacy rows means unavailable';
COMMIT;
