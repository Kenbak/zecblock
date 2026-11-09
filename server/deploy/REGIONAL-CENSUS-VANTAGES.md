# Regional census vantage points

Prepared 2026-11-05. This document defines the contract and rollout gates for
running the Ziggurat crawler on the Phase 0 regional observers. It is **not** a
record of a deployment: no observer exists yet, migration 043 has not been
applied anywhere, and nothing here may be applied to production without owner
approval.

## What changes

The primary (Hetzner HEL1) runs two loopback crawlers, `direct` (54321) and
`tor` (54322). A regional observer adds one direct crawler whose `getmetrics`
RPC listens on its WireGuard address. The primary's existing five-minute
ingester polls each configured vantage over WireGuard as source
`direct-<region>`, for example `direct-nyc3`, `direct-sgp1`, `direct-syd1`.

| Concern | Rule |
|---|---|
| Source names | `direct`, `tor`, or `direct-` + `[a-z][a-z0-9]{1,15}`. Code (`server/lib/census-vantages.js`) and migration 043 CHECKs use the same pattern. A name is never reused for a different host. |
| Configuration | `CRAWLER_VANTAGES=nyc3=10.77.0.2:54321,sgp1=10.77.0.3:54321,syd1=10.77.0.4:54321` in the ingester environment. Empty (default) means primary-only, the current behavior. |
| Network | Each RPC must be a literal IPv4 inside `CRAWLER_VANTAGE_NETWORK` (default `10.77.0.0/24`). DNS names, public, IPv6 and out-of-range addresses are skipped and logged; one bad entry never disables the census. At most eight vantages. |
| Poll | Concurrent with the primary collectors; 15 s timeout per vantage (primary keeps 30 s); responses over 64 MiB are dropped. |
| Census admission | Per source, unchanged rules: snapshot generated within 3 minutes (30 s future skew), and per node a pinned checkpoint proof plus handshake within one hour. An unreachable or stale vantage is skipped; others still count. |
| Census identity | One IP is one node across every vantage and port. The freshest chain proof from any vantage wins, exactly like `direct` + `tor` today. Public counts, countries, clients and map vertices therefore stay deduplicated. |
| Latency | `ping_ms` remains a primary (`direct`/`tor`) handshake measurement. Handshake time from Sydney is not comparable with Helsinki, so an IP seen only regionally has no latency and is excluded from `avg_ping`. |
| Gossip admission | Each vantage snapshot is validated on its own: an advertiser needs fresh proof in **that vantage's** same snapshot. One vantage cannot certify another's receipts. |
| Gossip storage | Private rows keep the vantage (`collector_source`). Each source is replaced independently. A source missing from a run keeps its last snapshot until the database clock expires it (10 minutes, the same bound readers already enforce); an older generation can never replace a newer one; a source removed from configuration is deleted on the next run. |
| Public graph | Unchanged reader: directed IP pairs deduplicate across vantages and ports, `observedAt` is the newest and `expiresAt` the earliest admitted evidence. No vantage name, endpoint or IP is public. |
| Status | Private `census_vantage_status` (migration 043): `attempted_at`, `outcome` (`admitted`/`unreachable`/`rejected`), and the last admitted `generated_at`, `verified_endpoints` (before IP dedup) and gossip receipt count. Staleness is `attempted_at - admitted_at`. Operational only; not a public count. |

The Tor collector stays primary-only. Regional Tor (`tor-<region>`) is not
allowed by migration 043 and would need its own decision.

### Semantic change for `direct`/`tor`

Before this change every ingestion deleted all gossip snapshots and rewrote
only the sources that answered, so a failed `direct` poll removed its links
immediately. Now an absent source keeps its last snapshot until its own
10-minute expiry. This is the same evidence lifetime as when ingestion stops
entirely, and the public reader already enforces it with the database clock.

### What multi-vantage does and does not mean

More vantages can observe more listening nodes (latency- or region-dependent
reachability, per-source connection limits) and more gossip. They do not prove
complete coverage, and they do not change the active-population definition:
`census_v3` is still established local peers within 900 s union chain-qualified
crawler handshakes within one hour. History is **not** re-baselined. A jump in
active IPs when the first vantage goes live is a measurement change, not
network growth; record its timestamp in the wiki and release log before
interpreting trends across it. No census-version bump is proposed here; that is
an owner decision if the jump is material.

## Migration 043

`server/deploy/sql/043_regional_census_vantages.sql`, mirrored byte for byte
in `cipherscan-rust/schema/migrations/`. Additive and widening only:

- replaces 039's inline `topology_gossip_snapshots_collector_source_check`
  with the named `topology_gossip_snapshots_collector_source_vantage` CHECK;
- creates private `census_vantage_status`, owned by `zcash_user`, no PUBLIC
  privileges;
- `lock_timeout 2s`, `statement_timeout 30s`, idempotent, single transaction.

Old code ignores the new table and writes only `direct`/`tor`. New code before
043 still updates the IP census from regional vantages but skips regional
gossip rows (the 039 CHECK would abort the census transaction) and logs that the
status table is missing. No consensus node, indexer or API restart is required.
Rollback: unset `CRAWLER_VANTAGES`; regional snapshots are pruned on the next
run and their status rows removed. Keep the additive schema.

Lint receipt (2026-11-05, local PostgreSQL 14.18): applied twice on top of 039
inside the fixture transaction; prior `direct` receipts survived; regional
sources accepted and `tor-nyc3`, `direct-`, `direct-NYC3`, `nyc3` rejected with
`23514` on both tables; owner/PUBLIC privileges checked. No SQL linter is
configured in this repository; squawk was not available locally.

## Running the crawler on an observer

Per observer, after the observer kit's own acceptance (WireGuard up, Zakura
synced, chrony < 10 ms):

1. Install the **same** crawler artifact as the primary (record SHA-256; the
   primary's producer is documented in `QUALIFIED-GOSSIP-TOPOLOGY.md`). Do not
   build on the observer.
2. Write `/etc/zcash-crawler/observer.env` with
   `CRAWLER_RPC_ADDR=<wg-ip>:54321` and install
   `zcash-crawler-observer.service`. The RPC has no authentication: bind only
   the WireGuard address and allow 54321/tcp from `10.77.0.1` on `wg0` only
   (UFW: `ufw allow in on wg0 from 10.77.0.1 to <wg-ip> port 54321 proto tcp`).
   Confirm from a public vantage that 54321 is closed.
3. Watchdog: run `check-crawler-health.js` on the observer every five minutes
   with `CRAWLER_HEALTH_TARGETS=<wg-ip>:54321=zcash-crawler-observer.service`.
4. Qualify resources before enabling the next observer (see below).
5. On the primary, with owner approval: apply 043, then add the vantage to
   `CRAWLER_VANTAGES`. Watch one natural cron run: `census_vantage_status` row
   `admitted`, `generated_at` within 3 minutes, `verified_endpoints > 0`; the
   public stats count is a deduplicated union; `/api/network/topology` remains
   available with no identity leakage.

The crawler's outbound P2P connections share the observer's uplink with the
pruned Zakura node. `--node-listening-port 8233` is the default *remote* port it
dials, not a local listener. Whether its synthetic node opens any local listener
has not been verified here: check `ss -ltnp` after start, and keep UFW's public
allow-list unchanged (8233 belongs to Zakura).

### Resource budget: unmeasured

Crawler memory, CPU and bandwidth on a 4 vCPU / 8 GB DigitalOcean droplet have
**not been measured**. No measurement of the primary crawler's actual RSS or
traffic is recorded in the wiki either; the unit's `MemoryMax=2G`,
`MemoryHigh=1536M` and `CPUQuota=50%` are caps, and decision 007's "~50 MB" was
a pre-deployment estimate. On the first observer, record over at least 24 h:

- crawler RSS (`systemctl show -p MemoryCurrent`, peak), CPU and restarts;
- crawler and Zakura bytes in/out separately (e.g. nftables counters by uid or
  cgroup) against the droplet's included transfer;
- `getmetrics` response size and poll duration over WireGuard;
- Zakura peer count, sync lag and orphan-collector heartbeat unchanged.

Stop if Zakura or the orphan collector degrades: they are the observer's
primary job.

## Release gates

1. Focused unit and real PostgreSQL tests (`census-vantages*.test.js`,
   `node-topology*.test.js`, `node-census*.test.js`), lint, and the Rust mirror
   byte-identity test.
2. Owner approval for 043 on the primary; verify API-role access and replica
   replay. Testnet/Crosslink have no regional crawler; 043 is harmless there.
3. One observer first, resource receipt recorded, then the others.
4. Record the first-vantage timestamp, before/after active IPs and per-vantage
   `verified_endpoints` in the wiki (`ziggurat-network-intelligence`) and log.
