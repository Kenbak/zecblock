-- Census v3: require independently pinned Zcash mainnet checkpoint evidence.
-- Additive and idempotent. Never infer proof from old handshake/ingest clocks.
BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';
-- Some schema-only installations did not receive the explorer's migration 031.
ALTER TABLE nodes ADD COLUMN IF NOT EXISTS last_peer_seen_at timestamptz;
ALTER TABLE nodes_crawl ADD COLUMN IF NOT EXISTS last_peer_seen_at timestamptz;
ALTER TABLE nodes ADD COLUMN IF NOT EXISTS last_chain_verified_at timestamptz;
ALTER TABLE nodes ADD COLUMN IF NOT EXISTS chain_block_hash text;
ALTER TABLE nodes ADD COLUMN IF NOT EXISTS chain_proof text;
ALTER TABLE nodes_crawl ADD COLUMN IF NOT EXISTS last_chain_verified_at timestamptz;
ALTER TABLE nodes_crawl ADD COLUMN IF NOT EXISTS chain_block_hash text;
ALTER TABLE nodes_crawl ADD COLUMN IF NOT EXISTS chain_proof text;
COMMENT ON COLUMN nodes.last_verified_at IS 'Actual version/verack handshake time; does not establish Zcash chain identity.';
COMMENT ON COLUMN nodes.last_chain_verified_at IS 'Actual same-session Zcash mainnet checkpoint header proof completion time, at or after the handshake; null means no qualified crawler evidence.';
COMMENT ON COLUMN nodes.chain_block_hash IS 'Conventional display-order hex of the header matched to an independently pinned block; stored atomically with its proof timestamp.';
COMMENT ON COLUMN nodes.chain_proof IS 'Chain proof protocol identifier; census v3 requires zcash-mainnet-checkpoint-v1 at pinned height 3520000. Evidence of a known mainnet checkpoint, not current-tip synchronization or operator identity.';
COMMENT ON COLUMN nodes_crawl.last_chain_verified_at IS 'Actual same-session Zcash mainnet checkpoint header proof completion time; null legacy rows remain unqualified.';
COMMENT ON COLUMN nodes_crawl.chain_block_hash IS 'Pinned header hash in conventional display-order hex, stored atomically with proof timestamp.';
COMMENT ON COLUMN nodes_crawl.chain_proof IS 'Chain proof protocol identifier; census v3 requires zcash-mainnet-checkpoint-v1.';
COMMENT ON COLUMN node_snapshots.census_version IS '0 = mixed discovery; 1 = crawler handshakes; 2 = handshakes plus live peers; 3 = pinned Zcash mainnet checkpoint proofs within one hour plus established live peers observed within fifteen minutes, unique IPs. Versions are not comparable.';
COMMIT;
