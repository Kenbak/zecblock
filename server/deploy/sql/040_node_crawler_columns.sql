-- networks: testnet
-- Crawler/graph columns that the node-intelligence routes read from `nodes`
-- (list, reliability, concentration, health-score, upgrade-readiness).
-- Mainnet received them from its crawler outside these migrations; testnet's
-- schema-only rebuild (2026-10-29) did not, so those routes return 500 there.
-- Additive, nullable and idempotent. Values stay NULL until a crawler writes
-- them, which the routes already report as unavailable rather than zero.
-- `nodes` is owned by postgres: apply with `sudo -u postgres psql -v ON_ERROR_STOP=1 -f`
-- and record version 040 in schema_migrations in the same session.
BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';
ALTER TABLE nodes ADD COLUMN IF NOT EXISTS onion_address text;
ALTER TABLE nodes ADD COLUMN IF NOT EXISTS tor_type text;
ALTER TABLE nodes ADD COLUMN IF NOT EXISTS betweenness double precision;
ALTER TABLE nodes ADD COLUMN IF NOT EXISTS closeness double precision;
ALTER TABLE nodes ADD COLUMN IF NOT EXISTS degree integer;
ALTER TABLE nodes ADD COLUMN IF NOT EXISTS network_type text;
ALTER TABLE nodes ADD COLUMN IF NOT EXISTS start_height bigint;
ALTER TABLE nodes ADD COLUMN IF NOT EXISTS services bigint;
ALTER TABLE nodes ADD COLUMN IF NOT EXISTS crawl_seen_count integer DEFAULT 0;
ALTER TABLE nodes ADD COLUMN IF NOT EXISTS crawl_miss_count integer DEFAULT 0;
COMMIT;
