-- Additive, explicitly applied provider index. Never modifies the NEAR tables.
BEGIN;
SET LOCAL lock_timeout = '2s';
CREATE TABLE IF NOT EXISTS crosschain_venue_actions (
  venue text NOT NULL CHECK (venue IN ('maya','thorchain')),
  id text NOT NULL,
  action_type text NOT NULL CHECK (action_type IN ('swap','refund')),
  status text NOT NULL CHECK (status IN ('SUCCESS','PROCESSING','FAILED','REFUNDED')),
  swap_created_at timestamptz NOT NULL,
  created_at_ns numeric(30,0) NOT NULL CHECK (created_at_ns >= 0),
  source_chain text, source_token text, source_asset text,
  dest_chain text, dest_token text, dest_asset text,
  source_amount numeric, dest_amount numeric,
  zec_amount_zat numeric(40,0) CHECK (zec_amount_zat >= 0),
  source_amount_usd numeric, dest_amount_usd numeric,
  source_tx_hashes text[] NOT NULL DEFAULT '{}',
  dest_tx_hashes text[] NOT NULL DEFAULT '{}',
  canonical_identity text,
  payload jsonb NOT NULL,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  status_observed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (venue,id)
);
CREATE INDEX IF NOT EXISTS crosschain_venue_created ON crosschain_venue_actions
  (venue,swap_created_at DESC,id);
CREATE INDEX IF NOT EXISTS crosschain_venue_unsettled ON crosschain_venue_actions
  (venue,last_seen_at,id) WHERE status='PROCESSING';
CREATE TABLE IF NOT EXISTS crosschain_venue_sync (
  venue text NOT NULL CHECK (venue IN ('maya','thorchain')),
  mode text NOT NULL CHECK (mode IN ('backfill','sync')),
  cursor text,
  snapshot_at timestamptz,
  head_created_at_ns numeric(30,0),
  earliest_seen_at timestamptz,
  latest_seen_at timestamptz,
  pages bigint NOT NULL DEFAULT 0 CHECK (pages >= 0),
  actions bigint NOT NULL DEFAULT 0 CHECK (actions >= 0),
  excluded_actions bigint NOT NULL DEFAULT 0 CHECK (excluded_actions >= 0),
  completed_at timestamptz,
  as_of timestamptz,
  last_advanced_at timestamptz NOT NULL DEFAULT now(),
  last_checked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (venue,mode)
);
COMMIT;
-- Transaction-page lookups match one Zcash txid inside the leg hash arrays.
-- CONCURRENTLY keeps writes flowing; it must run outside a transaction block.
CREATE INDEX CONCURRENTLY IF NOT EXISTS crosschain_venue_source_hashes ON crosschain_venue_actions
  USING gin (source_tx_hashes);
CREATE INDEX CONCURRENTLY IF NOT EXISTS crosschain_venue_dest_hashes ON crosschain_venue_actions
  USING gin (dest_tx_hashes);
