# Chain-qualified crawler observations (census v3)

This release repairs the Flux contamination found on 2026-10-19. A protocol
handshake, software name, destination port, or shared network magic does not
establish the remote chain. Version-2 counts/history must not be presented as
comparable Zcash growth baselines.

## Population and proof

The mainnet `NODE_SOURCE=crawl` population remains the IP-deduplicated union of:

- Local consensus-node connections observed through `getpeerinfo` within 900
  seconds. This is the existing local-peer admission boundary; these IPs have
  not necessarily answered the crawler's independent header challenge.
- Crawler endpoints with a version/verack handshake and matching mainnet
  checkpoint response in the same session, both within 3,600 seconds.

The stats response separately reports `chainQualifiedCrawlerNodes`,
`localPeerNodes`, `localPeerOnlyNodes`, and `overlapNodes`. Its active count is
`chainQualifiedCrawlerNodes + localPeerOnlyNodes`. IPs collapse across ports;
IPv4 and IPv6 remain separate identities. This is neither a complete global
census nor an independent-operator count.

The pinned checkpoint is mainnet height **3,520,000**:

- Header hash: `00000000001cfe8c0d46d5f8a7f107546d56168fb5ab1cd66c8033390de10418`.
- Parent: `00000000004cdd2c00f60266d185a2e0992ae8ab0a23d1896982bcf35bb720d6`.
- Proof marker: `zcash-mainnet-checkpoint-v1`.

The collector sends `getheaders` with the parent locator and checkpoint stop
hash, then requires exactly that header and parent before requesting/accepting
address gossip. It checks framing, message checksums, payload bounds, and proof
session/timeout state. No port or client-name allowlist is used. The checkpoint
was retrieved from the trusted serving node on 2026-10-19 at 00:48:10.141 UTC
with 2,682 confirmations, and the serialized header hash/parent were verified
independently. The accompanying collector patch contains its raw fixture and
source metadata.

This proves service of the pinned chain header, not current synchronization,
validation of every block, or honest/independent operation. Nodes below the
checkpoint, not serving headers, or timing out remain unverified candidates.
A future fork sharing the checkpoint is outside this proof's scope: update the
collector and consumer pin together through a reviewed release when needed.

## Storage, expiry, and presentation

Migration **038** adds nullable `last_chain_verified_at`, `chain_block_hash`,
and `chain_proof` to `nodes` and `nodes_crawl`, and safely adds a missing
`last_peer_seen_at` for installations that did not receive migration 031.
There is no timestamp backfill. The identical SQL mirror is in the Rust repo;
applying SQL does not require restarting the indexer.

`last_verified_at` remains the actual handshake timestamp. Proof time must be
at/after the handshake and no later than observation/query time. The proof
tuple advances atomically and independently of the peer observation clock;
replayed/older data cannot refresh it. Query-time eligibility rejects all
legacy handshake-only crawler rows, even before another writer run. Old
collector output supplies no qualified crawler observations; local peers can
still advance independently. All-source failure does not refresh observations.

The single five-minute ingester retains advisory lock 839272 and its bounded
transaction deadlines. The first qualified proof resets legacy crawl counters.
Unqualified/stale proof rows cannot provide current latency/reliability values.
`totalNodes` explicitly means all historical candidate IPs, including old
foreign/discovery records; it is not a verified all-time Zcash total.

Version-3 snapshots and cache keys are isolated from versions 0/1/2. Missing
24h/7d/30d baselines return null until a compatible sample exists near the
requested age. Historical observations remain stored without rewriting them.

The old full gossip graph lacks chain-qualified advertiser provenance and stays
quarantined. Without fresh qualified receipts, topology returns active isolated
vertices with `topologyAvailable=false`. The additive
[qualified gossip release](QUALIFIED-GOSSIP-TOPOLOGY.md) restores directed address
advertisements through a separate receipt/proof contract and migration 039;
advertised-only targets do not enter the active census. Centrality and overall
connectivity scores remain unavailable because advertisements do not establish
remote peer connections. Geography and the node directory remain available.
Do not substitute zero edges for a measured connectivity claim.

Country clusters preserve country boundaries. Unlocated IPs are omitted from
map cells; independently cached map/stats samples may differ slightly. Tor
classification identifies known exit IPs/hidden-service destinations, not all
Tor users or connections routed through SOCKS.

Tor classification availability is separate from the observed-IP count. A valid,
nonempty exit-list response reclassifies the active population. Provider errors,
malformed or empty lists preserve last-known per-row flags and publish an
unavailable status only after the census transaction commits. The Redis status
`zcash:tor-classification:census-v3` expires after 600 seconds and binds the
classification result to the exact committed snapshot and source clock. The API
checks that binding on every request, including aggregate cache hits, against
the latest committed v3 database snapshot. Missing, failed, expired or mismatched
status returns `torNodes: null`, `torClassificationAvailable: false` and an ISO
`torClassificationCheckedAt` or null. A matching successful lookup may return a
measured zero. The UI requires explicit availability for v3 and shows an em dash
with “Tor classification unavailable” otherwise.

Crawl stats and history send `Cache-Control: no-store`; the internal five-minute
aggregate cache and independent five-minute network-page ISR remain in place.
History returns a Tor count only for an exact sample with fresh matching status;
older samples are null because availability was not persisted in the snapshot
schema. No migration or historical classification backfill is required.


## Release sequence and acceptance gates

This is a prepared local repair, not a deployment record.

1. Reconcile the target main commit, network, frontend/API releases, collector
   source and binary hashes, serving Zakura, Rust parser pin, and running
   indexer artifact before release. Preserve passive standby writer inactivity.
2. Apply migration 038 with its lock/statement limits on mainnet primary,
   verify replication, and check actual API-role reads of all added columns.
   Keep the additive columns on rollback. Peer/testnet API mode does not need
   them; the crawler ingester, including shadow mode, does.
3. Prepare the collector from base `b595b07dd450cfa02ad40a05a6a2fdd2fd1689dd`
   using `crawler-chain-proof.patch` (tested source `d3f5c14cd54d1e83d1308af20ec452062c86d97c`). The patch SHA-256 is
   `e8f33c720e254a085056e4efb61ce63d91b0b4bcd3cb1d29baab957a8e0ed416`. Build/test/checksum the exact Linux
   artifact before installing it. Run an isolated canary against current
   Zebra/Zakura and an actual shared-magic Flux peer; record qualification,
   rejection/unverified behavior, bounded runtime, and no unqualified gossip.
   Check a reachable legacy zcashd responder separately: unmodified zcashd
   6.20.0 halted at height 3,417,100, below this checkpoint, and does not support
   NU6.3 ([official deprecation record](https://z.cash/support/zcashd-deprecation/)).
   It must remain an unverified candidate. A historical-header protocol probe
   can establish that interoperability separately; it is not a current-chain
   qualification pass. Do not lower the checkpoint to manufacture one.
   Mock-P2P fixtures do not replace these live acceptance checks.
4. Coordinate API/ingester and both collector cutovers. During an API-first
   cutover, legacy collectors contribute zero qualified crawler observations.
   Prevent the new proof-aware watchdog from repeatedly restarting an old
   incompatible collector: pause its timer only for the bounded cutover and
   reenable it after both updated collectors are verified. Record the interval.
   No consensus-node or indexer restart is required; collector restarts are.
5. Verify both RPCs publish current generation times and actual proof fields;
   allow discovery to rebuild. Verify a natural cron run and independently
   reconcile active/client/country/list/topology/source-breakdown counts.
   Confirm old Flux rows stay inactive without deleting history. Check latency
   availability, null incompatible trends, and no raw endpoint disclosure.
6. Expire only applicable census caches/ISR entries or wait out their bounded
   five-minute windows; check the served `censusVersion=3`. Verify every
   affected Vercel project at the exact commit, latest GitHub Actions attempts,
   raw HTML metadata/H1/indexation, hydrated UI, API/deep health and replica lag.
   Do not infer a deployment from a successful local build or push.

Rollback must preserve the v3 eligibility gate. Returning to unmodified v2
code would immediately re-admit old contaminated handshakes. A safe fallback
keeps v3 API predicates and temporarily counts only available local-peer
observations while qualified crawlers are unavailable. Keep old history and
additive migration 038. Restore graph output only after its own acceptance.

## Local verification

Focused Node tests include real PostgreSQL session-local temporary tables,
all nine census routes, legacy/foreign/stale/future proof rejection, legitimate
nondefault ports, clock replay/order, client metadata clearing, peer-only
source separation, graph quarantine, and history isolation. They do not touch
persistent tables or production sequences. Collector tests exchange the real
checkpoint fixture over mock P2P and reject an actual testnet header under
mainnet framing and genuine early Zcash history. Further decoder tests cover
checksum/magic, truncation/size limits, ignored extensions, and payload counts.
Keep live endpoint canaries and deployment acceptance separate from these tests.
