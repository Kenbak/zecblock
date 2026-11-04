# Fresh chain-qualified address advertisements

Prepared 2026-10-23. This document defines the release contract and gates; it
is not a record that production has been updated.

The October 19 census repair correctly quarantined legacy undirected adjacency.
Restoring the graph requires new directed receipts, not re-enabling that table.
Migration 039 and `node-topology*` keep this path separate from census v3 and
from the legacy cruncher graph. Active counts and their comparable-history
baseline remain unchanged. Connectivity, overall health and centrality remain
unavailable: address advertisements do not measure remote peer connections.

## Collector contract

Apply `crawler-qualified-gossip.patch` on the deployed chain-proof source tree
`39c9fcd67fb0741f62c2e43e486119d18cbf98ab` (deployed commit
`d3f5c14cd54d1e83d1308af20ec452062c86d97c`). The resulting producer is commit
`cbab96b8edf1baa8298be4dcdfde84f384f44761`, tree
`a919348640c49ba1221ab14dc4d799993382b30a`. Patch SHA-256:
`d74fd47ae093796fd04970bc1f0b9b62fcc6d649caba9a84acfbcd3ee4bba098`.

`getmetrics` adds:

- `gossip_provenance: "zcash-mainnet-qualified-addr-v1"`.
- `gossip_truncated`: boolean, including false for an initial/empty snapshot.
- `gossip_edges`: objects with exact `source`, `target` endpoints and actual
  `observed_at_ms` receipt time. Proof stays in the same snapshot's `node_info`.

A source must have a fresh version/verack handshake and pinned checkpoint proof
in the same connection session before its address messages qualify. Reconnect
and invalidated proof clear receipts. Each source retains at most 1,000 targets;
repeated advertisements update their actual receipt time. Receipts expire after
ten minutes. Export includes at most 40,000 edges, newest first with stable
endpoint ties; dropping eligible output sets `gossip_truncated=true`.
Neither this checkpoint proof nor an advertisement proves the target's chain,
current liveness, honest operation, or a remote peer connection.

## Admission, storage and public output

The ingester validates direct and Tor collector snapshots independently before
merging or collapsing endpoints by IP. It requires a snapshot no older than
three minutes, exact source endpoint membership with fresh same-snapshot proof,
and `handshake <= proof <= receipt <= generation <= ingestion`. Handshake and
proof must each be within one hour and receipt within ten minutes. Public
literal global-unicast IP endpoints with explicit valid ports are admitted;
private, documentation, multicast, DNS, onion and malformed endpoints are not.
Nondefault ports and public IPv6 are allowed. Missing/malformed/oversized
contracts fail closed. Collection via SOCKS does not classify an address as Tor.

Migration **039** creates private `topology_gossip_snapshots` and
`topology_gossip_edges`, owned by `zcash_user` with no PUBLIC privileges. The
identical SQL mirror belongs in the Rust schema repository; this additive
migration does not require an indexer restart. Ingestion replaces metadata and
receipts atomically inside the existing advisory-locked census transaction.
Every timestamp is the original evidence time, never database insertion time.

Mainnet crawl topology bypasses Redis and sends `Cache-Control: no-store`.
SQL rechecks the proof marker/hash, clock order, source qualification and all
expiry bounds using the database clock. Active census IPs remain vertices even
without links; a fresh eligible advertised target is added with
`reachable=false` and unknown software/geography until independently observed.
IP pairs deduplicate across ports/collectors while preserving direction.
Public JSON uses synthetic IDs and never includes endpoint/IP or proof fields.

- `topologyAvailable=false`: missing schema/capability or expired snapshot.
- `topologyAvailable=true` with no links: a fresh supported empty observation.
- `edgeKind="advertised-address"`, `directed=true`: link meaning.
- `observedAt`: collector snapshot time, ISO 8601.
- `expiresAt`: earliest admitted evidence expiry; consumers must hide expired
  observations and refresh rather than continue showing old links.
- `truncated=true`: producer or public edge bound made output partial.
- `counts.reachable`: observed active IPs; legacy `counts.off`: advertised-only
  IPs. `degree` counts incident directed advertisements, not connection count.
- `betweenness` and `closeness`: null. Health/connectivity are not restored.

The browser defaults to geography, polls topology only while active, expires
its graph using `expiresAt`, and bounds force layout separately with explicit
displayed-subset counts. No new public route, URL variant or indexation policy
is introduced. The network routes retain their existing SSR/SEO policy.

## Release gates and rollback

1. Reconcile exact main/explorer commit, serving API and source configuration,
   collector source and executable hashes, Zakura executable, Rust parser pin
   and each running indexer artifact. Keep passive standby writers inactive.
2. Pass focused validator/store tests, actual PostgreSQL migration/route tests,
   UI tests, API contract generation checks, lint, typecheck and build. Build
   the exact Linux producer with locked dependencies and run a bounded isolated
   canary without gossip fanout. Record fresh source proof and receipt clocks,
   directed output and rejection behavior before replacing services.
3. Apply 039 with its two-second lock / thirty-second statement limits to the
   primary, verify API-role permissions and replica replay. Retain additive
   tables on rollback. Coordinate exact collector binary and API/ingester
   cutover; old collectors safely leave topology unavailable. No consensus
   node or indexer restart is required. Record any watchdog pause interval.
4. Verify both private RPC contracts and a natural five-minute ingester run.
   Reconcile private eligible receipts against public synthetic graph counts;
   confirm no target promotion, no endpoint leakage, expiry and unchanged
   census-v3 history/null incompatible trends. Check API/deep health and replica
   lag, and passive standby inactivity.
5. Verify latest GitHub Actions attempts and every affected Vercel project at
   the exact pushed commit until terminal; distinguish previews from production.
   Verify raw HTML metadata/H1 and hydrated Globe/Map/topology behavior. Record
   deployment facts in the canonical wiki and release log.

Rollback retains census-v3 proof gates and legacy graph quarantine. The prior
API/ingester ignores additive tables; restoring the prior collector makes the
new graph unavailable after expiry. Never restore old Flux-contaminated graph
rows, old count baselines or a fabricated connectivity score.

## Local and isolated Linux verification receipt

At 2026-10-23 01:04:32 UTC the exact producer above passed a locked Linux build,
18 crawler tests and 17 codec regressions. Candidate ELF SHA-256:
`54263b5e366533aeea98769f3e2c276071fc2721f54585b22ab1155a65bffeb1`.
A bounded seed-only direct canary observed one independently qualified source
and 319 advertised targets. Two snapshots one minute apart advanced generation
time without advancing the actual handshake, checkpoint proof or receipt time.
A separate native-SOCKS canary observed one qualified source and 386 advertised
targets. Both reported the exact marker and `gossip_truncated=false`, performed
one scheduler sweep with no discovery fanout, and exited successfully.

The isolated processes and private test listeners were removed. The running
production collector source, executable and processes remained unchanged.
These receipts validate the candidate, not a production rollout or a complete
network measurement. Fresh production ingestion, public graph/UI verification,
CI and exact-commit deployment checks remain release gates.
