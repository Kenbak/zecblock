-- Crosslink legacy deployment reconciliation. Mainnet/testnet do not have
-- this optional feature-net registry. Preserve registrations and TTLs.
DO $$ BEGIN
  IF to_regclass('public.fork_monitor_nodes') IS NOT NULL THEN
    ALTER TABLE public.fork_monitor_nodes ADD COLUMN IF NOT EXISTS owner_token_hash text;
    COMMENT ON COLUMN public.fork_monitor_nodes.owner_token_hash IS
      'SHA-256 of the node ownership token; NULL legacy rows require operator credentials to claim.';
  END IF;
END $$;
