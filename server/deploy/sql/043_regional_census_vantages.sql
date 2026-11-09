-- Regional census vantage points: additive and widening only.
-- Allows `direct-<region>` crawler sources (for example `direct-nyc3`) beside
-- the primary's `direct` and `tor` collectors, and adds a private per-source
-- status table. Existing rows, readers and the migration-039 proof gates are
-- unchanged; an older ingester ignores the status table and only writes
-- `direct`/`tor`. No consensus node, indexer or API restart is required.
BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';

-- Replace the inline migration-039 check (PostgreSQL default name) with a
-- named one. Both statements are idempotent; the table holds one row per source.
ALTER TABLE topology_gossip_snapshots
  DROP CONSTRAINT IF EXISTS topology_gossip_snapshots_collector_source_check;
ALTER TABLE topology_gossip_snapshots
  DROP CONSTRAINT IF EXISTS topology_gossip_snapshots_collector_source_vantage;
ALTER TABLE topology_gossip_snapshots
  ADD CONSTRAINT topology_gossip_snapshots_collector_source_vantage
  CHECK (collector_source IN ('direct', 'tor')
    OR collector_source ~ '^direct-[a-z][a-z0-9]{1,15}$');

CREATE TABLE IF NOT EXISTS census_vantage_status (
  collector_source text PRIMARY KEY CHECK (collector_source IN ('direct', 'tor')
    OR collector_source ~ '^direct-[a-z][a-z0-9]{1,15}$'),
  attempted_at timestamptz NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('admitted', 'unreachable', 'rejected')),
  admitted_at timestamptz,
  generated_at timestamptz,
  verified_endpoints integer CHECK (verified_endpoints >= 0),
  gossip_supported boolean,
  gossip_receipts integer CHECK (gossip_receipts >= 0),
  CHECK (outcome <> 'admitted' OR (admitted_at IS NOT NULL AND generated_at IS NOT NULL
    AND verified_endpoints IS NOT NULL AND gossip_supported IS NOT NULL))
);

ALTER TABLE census_vantage_status OWNER TO zcash_user;
REVOKE ALL ON census_vantage_status FROM PUBLIC;
COMMENT ON TABLE census_vantage_status IS 'Private per-collector census admission status. attempted_at is the ingester poll time; generated_at is the crawler snapshot clock. Operational only: never a public count and never a liveness proof for any node.';
COMMENT ON COLUMN census_vantage_status.admitted_at IS 'Last ingester time this source passed snapshot admission. Retained when later polls fail, so staleness is attempted_at minus admitted_at.';
COMMENT ON COLUMN census_vantage_status.verified_endpoints IS 'Chain-qualified endpoints in the last admitted snapshot before IP deduplication across vantages.';
COMMIT;
