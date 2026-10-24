# CipherScan Deployment Guide

Operational documentation for running CipherScan locally and in production.

**Architecture:** Frontend (Next.js on Vercel) → API (Express + WebSocket, Hetzner) → PostgreSQL ← cipherscan-rust indexer (Hetzner) → Zebra/Zakura node

See also: [server infrastructure wiki](https://github.com/Kenbak/cipherscan) and `zcg/milestone-3/VERIFICATION.md` for M3 acceptance checks.

---

## Prerequisites

| Component | Version / Notes |
|-----------|----------------|
| **Node.js frontend** | 24.22.1 or newer within Node 24 (development/CI pin in `.node-version`) |
| **Node.js API / indexer** | 22.23.4 or newer within Node 22 (server CI pin in `.node-version.server`) |
| **npm** | 9+ |
| **PostgreSQL** | 16+ with `zcash_explorer_mainnet` or `zcash_explorer_testnet` database |
| **Redis** | 6+ (pub/sub for multi-worker WebSocket; API response caching) |
| **Zebra** (mainnet) / **Zakura** (testnet) | Full node with gRPC indexer support |
| **cipherscan-rust** | Rust indexer writing to the same PostgreSQL database (separate repo, `github.com/Kenbak/cipherscan-rust`) |
| **lightwalletd** | Optional — gRPC light client interface backed by Zebra (mainnet only) |
| **Caddy** (mainnet) / **nginx** (testnet) | Reverse proxy with TLS |

The frontend targets patched Node 24.22.1 or newer. The root engine range also
supports patched Node 22.23.4 so existing self-managed API/bot installations can
continue installing shared root dependencies. Vercel selects the newest supported
major matching that range (24); the repository engine range overrides the dashboard.
The previous Node 22 restriction came from development/CI standardization, with
no documented application incompatibility that required excluding Node 24.

Vercel manages the actual serving patch separately from `.node-version`. Verify
`[node-runtime]` / `process.version` on each exact deployment: a Node 24 selection
or patched builder does not establish a patched serving process. Node 24.22.0 is
vulnerable to the October 2026 Brotli issue; 24.22.1 contains its fix.

Self-managed servers retain Node 22.23.4 or newer within 22. Updating those
processes requires installing the runtime and restarting each API, bot or job.
Docker deployments require rebuilt images and recreated containers. The web image
defaults to Node 24.22.1 (`WEB_NODE_IMAGE` override); the API image retains its
Node 22.23.4 default (`NODE_IMAGE` override). An engine-only
root manifest/lock change skips the API rollout only when no other API-relevant
content differs from the previously deployed commit; dependency, server and shared
library changes still trigger normal deployment.

---

## Service Architecture

```
┌─────────────┐     HTTPS      ┌──────────────┐
│   Browser   │ ──────────────▶│  Vercel CDN  │  (frontend — Next.js)
└─────────────┘                └──────┬───────┘
                                       │ REST / WS
                                       ▼
                        ┌──────────────────────────┐
                        │ Caddy/nginx :443 (Hetzner)│
                        └──────────────┬────────────┘
                                       ▼
                              ┌───────────────┐
                              │ Express :3001 │  (API + WebSocket)
                              └───────┬───────┘
                         ┌────────────┼────────────┐
                         ▼            ▼            ▼
                   ┌──────────┐ ┌──────────┐ ┌──────────┐
                   │PostgreSQL│ │  Redis   │ │  Zebra   │
                   │  :5432   │ │  :6379   │ │RPC :8232 │
                   └────▲─────┘ └──────────┘ │gRPC:8230 │
                        │                     └────▲─────┘
                        │                          │
                   ┌────┴─────┐              ┌─────┴────┐
                   │cipherscan│              │lightwalletd│
                   │  -rust   │              │  :9067    │
                   └──────────┘              └──────────┘
```

**Data flow:** Zebra/Zakura indexes blocks → cipherscan-rust writes to PostgreSQL → Node API reads PostgreSQL + node RPC/gRPC → Vercel-hosted frontend fetches API → WebSocket pushes real-time events.

**Cross-repo impact:** Schema changes in cipherscan-rust migrations affect the API. Materialized views and cron jobs in this repo must be compatible with indexer table ownership (`zcash_user`).

### API ownership and route boundaries

Blockchain data has one runtime owner: the Express service on port 3001. The
frontend calls that service directly; do not add duplicate Next.js handlers
that query PostgreSQL, proxy an Express route, or reshape the same blockchain
payload. The stable `/v1` contract is mounted by Express and is the intended
public API after its preview/cutover period. The legacy `/api/*` Express routes
remain while clients migrate.

The only Next.js route handlers retained are frontend-runtime concerns:

- `/api/revalidate` performs authenticated Next cache invalidation.
- `/api/name/*` hosts the Zcash Name Service resolver until that integration is
  migrated to Express.

These are not a second blockchain API. New public data endpoints belong in the
Express v1 contract, with source height, freshness, network, and explicit units.

---

## Environment Variables

Never commit secrets. Reference `.env.example` (frontend) and `server/api/.env` (API server, not in repo).

### Frontend (`.env.local`)

| Variable | Required | Description |
|----------|----------|-------------|
| `NEXT_PUBLIC_NETWORK` | **Yes for builds** | Deployment identity: `mainnet`, `testnet`, or `crosslink-testnet`. Controls APIs, currency labels, canonical hosts, and indexation. |
| `NEXT_PUBLIC_API_URL` | No | Browser-visible API origin override. Normally omit it so the network-specific public origin is selected. |
| `CIPHERSCAN_API_URL` | Recommended for self-hosting | Server-only API origin override used by Server Components/metadata. In Docker this should be the private service URL (for example `http://api:3001`). |
| `SITEMAP_BLOCK_MIN_HEIGHT` | No | Mainnet-only lower bound for advertised block sitemap shards. Must be divisible by 50,000. |
| `SITEMAP_BLOCK_MAX_HEIGHT` | No | Mainnet-only inclusive upper bound. Must end a complete 50,000-height bucket. |
| `NEXT_PUBLIC_LIGHTWALLETD_HOST` / `_PORT` | No | Lightwalletd hostname/port for client-side gRPC (default port 9067) |
| `NEAR_INTENTS_API_KEY` | No | NEAR Intents Explorer API (historical swap data) |
| `NEXT_TELEMETRY_DISABLED` | Recommended | Set to `1` — disable Next.js telemetry |
| `ZEBRA_GRPC_URL` | No | Zebra gRPC indexer address (e.g. `127.0.0.1:8230`) |

### API Server (`server/api/.env`)

| Variable | Required | Description |
|----------|----------|-------------|
| `DB_HOST` / `DB_PORT` / `DB_NAME` / `DB_USER` / `DB_PASSWORD` | Yes | PostgreSQL connection |
| `REPLICA_DATABASE_URL` | No | Read-only PostgreSQL standby URL. Set only on an active API host, point it at a server that is actually in recovery, and keep all writes on the primary connection. |
| `REDIS_HOST` / `REDIS_PORT` | Recommended | Default `127.0.0.1:6379` |
| `ZEBRA_RPC_URL` | Yes | JSON-RPC URL (e.g. `http://127.0.0.1:8232`) |
| `ZEBRA_RPC_COOKIE_FILE` | Yes | Path to node's `.cookie` file for RPC auth (mainnet; testnet Zakura runs without cookie auth) |
| `ZEBRA_GRPC_URL` | Recommended | gRPC indexer for real-time mempool/blocks |
| `ZEBRA_HEALTH_URL` | No | Default `http://127.0.0.1:8080` |
| `PORT` | No | Default `3001` |
| `NODE_ENV` | Recommended | `production` in prod |
| `SERVICE_API_KEYS` | Recommended | Comma-separated keys; requests with a matching `X-Service-Key` header bypass rate limiting (used by the Vercel frontend's SSR, CipherPay, Telegram bot) |
| `CORS_ORIGINS` | No | Comma-separated allowed origins |
| `NEAR_INTENTS_API_KEY` | For crosschain | NEAR Intents API key for swap sync |
| `API_V1_ENABLED` / `API_V1_LAUNCHED` | No | v1 rollout gates. Keep disabled by default; preview requires `API_V1_PREVIEW_KEY`. See `server/api/v1/README.md`. |

### Cron Jobs (`server/jobs/.env`)

Same `DB_*` and `ZEBRA_*` variables as the API server.

### cipherscan-rust (separate repo)

Its own `.env` with `ZEBRA_RPC_URL`, `DATABASE_URL`, gRPC settings, and `ZEBRA_STATE_PATH`. Must point to the same PostgreSQL database as the API.

---

## Local Development

### Frontend only (uses public API)

```bash
git clone https://github.com/Kenbak/cipherscan.git
cd cipherscan
npm ci
npm run dev
# Open http://localhost:3000
```

### Full stack (local API + database)

1. Start PostgreSQL and Redis locally or via Docker.
2. Run cipherscan-rust (separate repo) against a synced Zebra/Zakura node.
3. Start the API server:

```bash
cd server/api
cp .env.example .env  # set DB_*, ZEBRA_*
npm ci
node server.js
# API listens on http://127.0.0.1:3001
```

4. Start the frontend:

```bash
cd ../..
npm run dev
# Frontend on http://localhost:3000, API on http://localhost:3001
```

5. Verify:

```bash
curl http://localhost:3001/api/network/health
node zcg/milestone-3/verify.js http://localhost:3000
```

---

## Production Deployment

**Deploy workflow is git-only: push → pull on the server → rebuild → restart the systemd unit. Never `scp` build artifacts or hand-edit files directly on a server** — if a live file differs from what's in git, treat that as a bug to fix (commit the real state), not a pattern to repeat.

### Frontend — Vercel

The frontend deploys to Vercel (migrated from Netlify, August 2026). A push to `main` triggers an automatic production build/deploy; pull requests get preview deployments. Set `NEXT_PUBLIC_NETWORK` per Vercel project/environment — production builds fail when it is absent or invalid, so a deployment cannot silently fall back to the wrong network. `NEXT_PUBLIC_*` values are compiled into the browser bundle at build time, so the environment variable must be set before the build runs, not just at runtime.

A Tor hidden-service mirror of the frontend also runs on the mainnet server as `cipherscan-frontend.service` (systemd, not Vercel) and must be restarted manually after a deploy:

```bash
ssh <mainnet-host>
cd /root/cipherscan && git pull origin main && npm run build
systemctl restart cipherscan-frontend.service
```

### Sitemap rollout

The mainnet `/sitemap.xml` endpoint is a sitemap index. Its core, content, and tools children are independent of chain APIs; dynamic children fail with a retryable `503` instead of publishing an empty successful sitemap. Testnet retains a homepage-only sitemap; Crosslink does not advertise one.

Deploy the split sitemap with `SITEMAP_BLOCK_MIN_HEIGHT`/`MAX_HEIGHT` unset. Submit `/sitemap.xml`, `/sitemap-core.xml`, `/sitemap-content.xml`, and `/sitemap-tools.xml` separately in Google Search Console. After seven days of clean processing, choose the two fixed pilot buckets from the authoritative mainnet tip:

```text
bucketStart = floor(tip / 50000) * 50000
SITEMAP_BLOCK_MIN_HEIGHT = bucketStart - 50000
SITEMAP_BLOCK_MAX_HEIGHT = bucketStart + 49999
```

Observe the pilot for 28 days before extending. Expand only when core indexing stays ≥90%, core coverage hasn't dropped more than 5 points, sitemap fetch errors stay at zero, Googlebot-facing 5xx stays below 0.1%, page p95 hasn't regressed more than 20%, and at least 20% of the block pilot is indexed with an upward trend. If a gate fails, keep existing shards and pause expansion.

### API + Indexer — Hetzner (systemd)

Production runs on dedicated/cloud Hetzner servers (migrated from DigitalOcean, completed 2026-07-12) with systemd units. Server IPs and exact specs are documented in the internal ops wiki, not here — both `cipherscan` and `cipherscan-rust` are public GitHub repos.

**Mainnet units:** `zebrad-mainnet.service`, `cipherscan-rust.service` (indexer, separate repo — fenced against dual-writer starts via `flock`), `zcash-api-mainnet.service`, `cipherscan-frontend.service` (Tor mirror), `lightwalletd.service`, `caddy.service`, `tor@default.service`.

**Testnet units:** `zakurad.service` (node), `cipherscan-rust-testnet.service` (indexer), `zcash-api.service`, `nginx.service`, `postgresql@18-main.service`. Definitions for all of these are committed in `server/deploy/*-testnet.service` and `cipherscan-rust/deploy/testnet/` (added 2026-08-15 — previously live-only).

**Start order:** PostgreSQL → node (Zebra/Zakura) → indexer → lightwalletd (mainnet only) → API → Caddy/nginx.

The standby host is not an active application server during normal operation:
keep the API, indexer, cron jobs, and public reverse proxy disabled there until
a documented failover promotes it. On the active host,
`REPLICA_DATABASE_URL` must target the standby—not the primary and not the
active host itself. Verify `SELECT pg_is_in_recovery()` returns `true` through
that URL before enabling read offload.

Apply database migrations before deploying API code that reads new columns.
In particular, deploy cipherscan-rust migrations `018` (rich-list balance
index) and `019` (fork-monitor ownership hash) before restarting this API
release. Both are additive; migration `018` builds its index concurrently.

**Deploy the API:**

```bash
ssh <mainnet-host>
cd /root/cipherscan && git pull origin main
cd server/api && npm ci --omit=dev
systemctl restart zcash-api-mainnet.service
curl -s http://localhost:3001/health
```

**Deploy the indexer** (separate repo):

```bash
ssh <mainnet-host>
cd /root/cipherscan-rust && git pull origin main
cargo build --release
systemctl restart cipherscan-rust.service
journalctl -u cipherscan-rust -f  # verify indexing resumes, watch for slow-statement warnings
```

Caddy (mainnet) terminates TLS on 443/80 and reverse-proxies to the API and lightwalletd; nginx (testnet) does the same for the testnet API. Privacy hardening: access logs disabled on Caddy; no `X-Forwarded-For`/`X-Real-IP` sent upstream; TLS 1.2+ only.

### After a node restart

Update the `.cookie` password in `zcash.conf` (mainnet Zebra only — Zakura testnet runs without cookie auth) and restart lightwalletd so RPC authentication stays aligned.

### CI

Both repositories have GitHub Actions CI. This repository exposes the same frontend verification contract locally as `npm run verify:frontend` (or `make verify-full` for every language/subproject). `cipherscan-rust` runs formatting, clippy, schema migrations, and tests against PostgreSQL 16 on every push/PR to `main`.

---

## Cron Jobs

All cron jobs run from `/root/cipherscan/server/jobs/` on production hosts.

| Schedule | Job | Purpose |
|----------|-----|---------|
| `*/5 * * * *` | `sync-crosschain-swaps.js` | NEAR Intents swap sync + MV refresh |
| `*/5 * * * *` | `refresh-turnstile.js` | Incremental turnstile daily aggregates |
| `0 4 * * *` | `refresh-turnstile.js --sweep` | Full held-output sweep |
| `0 * * * *` | `update-privacy-stats.js` | Pool sizes, privacy trends, `flow_daily` MV |
| `0 * * * *` | `update-chain-snapshots.js` | Chain supply snapshots |
| `*/10 * * * *` | `sync-nodes.js` | Network node geo data / fork monitor |
| `*/30 * * * *` | `run-pattern-scanners.sh` | Privacy linkage edges + batch clusters |
| `0 3 * * *` | `snapshot-mining-behavior.js`, `snapshot-miner-destinations.js` | Mining analytics |
| `0 4 * * *` | `backfill-zec-prices.js` | Historical price backfill |
| `*/5 * * * *` | `monitor-lightwalletd.sh` | Lightwalletd health |
| `0 2 * * *` | `backup-postgres.sh` | Streams a custom-format dump to Hetzner Storage Box |
| `0 * * * *` | `signals/compute.js` | Trading signals |
| `0 6 * * *` | `signals/notify.js` | Telegram daily signal |

**Note (2026-08-15):** `server/signals/compute-mvrv.js` (daily via `daily-v3.sh` at 21:00) and `server/jobs/compute-utxo-age.js` (daily at 05:00) both scan `transaction_outputs` by `spent` status; a missing index made the base filter a 16.6s full-table scan until `idx_tx_outputs_spent` was recreated and confirmed via real usage stats — see `cipherscan-rust/deploy/recreate-redundant-backfill-indexes.sql` for the full evidence trail, including three *other* indexes that were built on an unverified assumption about address-page queries and had to be dropped again the same day once real production job runs proved they weren't used. If a fresh database rebuild ever drops indexes again, verify each one against a real call site and a real `pg_stat_user_indexes` delta before recreating — don't assume from a hand-crafted stand-in query.

---

## Monitoring & Health Checks

### API health endpoints

```bash
curl -s https://api.mainnet.cipherscan.app/api/network/health | jq .
curl -s https://api.mainnet.cipherscan.app/api/grpc-status | jq .
curl -s https://api.mainnet.cipherscan.app/api/crosschain/db-stats | jq '.totalSwapsAllTime'
curl -s "https://api.mainnet.cipherscan.app/api/network/pool-history?period=1y" | jq '.points | length'
```

### systemd status

```bash
systemctl status zebrad-mainnet cipherscan-rust zcash-api-mainnet lightwalletd
journalctl -u zcash-api-mainnet -f
```

### Frontend maintenance banner

`MaintenanceBanner.tsx` auto-detects stale block data (>15 min since last indexed block) and displays a banner to users.

### M3 verification script

```bash
node zcg/milestone-3/verify.js https://cipherscan.app
```

### Alerts to watch

- Root disk > 90% full
- PostgreSQL pool exhaustion
- Zebra/Zakura RPC `ECONNREFUSED` on localhost
- Indexer lag: compare `indexer_state.last_seen_rpc_tip` vs `last_indexed_height`
- `cipherscan-rust` slow-statement warnings in the journal (>1s address-summary writes indicate a query-plan regression)
- Redis down: WebSocket rate limiting falls back to the bounded in-memory fail-closed limiter

---

## Tor Hidden Services

Live on mainnet (migrated from the prior DigitalOcean host, same `.onion` addresses):
- Frontend: served by `cipherscan-frontend.service` (Tor mirror of the Vercel-hosted site)
- API: served by `zcash-api-mainnet.service` via the same Tor config

Config lives in `/etc/tor/torrc` on the mainnet host; keys are host-local and never checked into git.

---

## See Also

- [API Documentation](https://cipherscan.app/docs) — public endpoints
- [M1 Verification](zcg/milestone-1/VERIFICATION.md)
- [M2 Verification](zcg/milestone-2/VERIFICATION.md)
- [M3 Verification](zcg/milestone-3/VERIFICATION.md)
- [Feature Parity Audit](zcg/milestone-3/FEATURE_PARITY_AUDIT.md)
- `cipherscan-rust` repo — indexer schema migrations, `deploy/` for systemd units and CI
