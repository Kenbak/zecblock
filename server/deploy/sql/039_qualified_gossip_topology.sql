-- Fresh directed advertisements, separate from unqualified legacy adjacency.
-- Endpoint/IP identity columns are private and must never enter public JSON.
BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE IF NOT EXISTS topology_gossip_snapshots (
  collector_source text PRIMARY KEY CHECK (collector_source IN ('direct', 'tor')),
  generated_at timestamptz NOT NULL,
  provenance text NOT NULL CHECK (provenance = 'zcash-mainnet-qualified-addr-v1'),
  edge_count integer NOT NULL CHECK (edge_count >= 0 AND edge_count <= 40000),
  truncated boolean NOT NULL DEFAULT false,
  UNIQUE (collector_source, generated_at)
);

CREATE TABLE IF NOT EXISTS topology_gossip_edges (
  collector_source text NOT NULL,
  source_generated_at timestamptz NOT NULL,
  advertiser text NOT NULL,
  advertised text NOT NULL,
  advertiser_ip text NOT NULL,
  advertised_ip text NOT NULL,
  observed_at timestamptz NOT NULL,
  advertiser_handshake_at timestamptz NOT NULL,
  advertiser_chain_verified_at timestamptz NOT NULL,
  chain_block_hash text NOT NULL,
  chain_proof text NOT NULL,
  PRIMARY KEY (collector_source, advertiser, advertised),
  FOREIGN KEY (collector_source, source_generated_at)
    REFERENCES topology_gossip_snapshots(collector_source, generated_at) ON DELETE CASCADE,
  CHECK (advertiser_handshake_at <= advertiser_chain_verified_at
    AND advertiser_chain_verified_at <= observed_at AND observed_at <= source_generated_at)
);

CREATE INDEX IF NOT EXISTS topology_gossip_edges_observed_at ON topology_gossip_edges(observed_at);
CREATE INDEX IF NOT EXISTS topology_gossip_edges_advertiser_ip ON topology_gossip_edges(advertiser_ip);

ALTER TABLE topology_gossip_snapshots OWNER TO zcash_user;
ALTER TABLE topology_gossip_edges OWNER TO zcash_user;
REVOKE ALL ON topology_gossip_snapshots, topology_gossip_edges FROM PUBLIC;
COMMENT ON TABLE topology_gossip_snapshots IS 'Supported private crawler snapshots. A fresh supported snapshot with zero receipts is an available empty observation; old/absent capability is unavailable.';
COMMENT ON TABLE topology_gossip_edges IS 'Directed advertiser-to-advertised-address receipts bound to fresh same-session mainnet checkpoint proof. Not a measurement of remote peer connections. Never promotes an advertised target into the active IP census.';
COMMENT ON COLUMN topology_gossip_edges.observed_at IS 'Crawler receipt time, never database insertion time. Public eligibility expires after ten minutes even if ingestion stops.';
COMMIT;
