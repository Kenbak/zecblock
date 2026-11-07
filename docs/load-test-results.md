# API load test results

The tool is `scripts/perf/load-test.mjs` (`npm run perf:load`), with unit tests in `server/tests/load-test.test.js`. Raw JSON artifacts go to `artifacts/perf/`, which is git-ignored. This page holds the published summaries.

## What the tool does

- Runs a weighted mix of real explorer reads in stages of increasing concurrency.
- Fills block heights and txids from the live tip, so every request targets data that exists. Historic blocks are drawn from the last 50,000 heights.
- Records the following per stage and per endpoint:
  - request count and achieved requests per second;
  - p50, p90, p95, p99 and maximum latency;
  - the HTTP status histogram, with timeouts counted separately;
  - 429s;
  - the application cache state (`X-ZecBlock-Cache` / `X-CipherScan-Cache`).
- Skips the remaining stages once a stage's failure rate passes `--abort-failed-pct` (5% by default).
- Takes a seed (`--seed`), so the same request sequence can be replayed.

| Endpoint | Path | Weight |
|---|---|---:|
| health | `/api/network/health` | 1 |
| info | `/api/info` | 1 |
| blocks-list | `/api/blocks?limit=10` | 4 |
| block-recent | `/api/block/{tip}` | 2 |
| block-historic | `/api/block/{random height in the last 50,000}` | 3 |
| tx-detail | `/api/tx/{recent txid}` | 3 |
| mempool | `/api/mempool` | 2 |
| accounting | `/api/network/accounting` | 1 |
| block-speed | `/api/network/block-speed` | 1 |
| v1-network-info | `/v1/network/info` | 1 |

### Safety rails

- Production API hosts are refused unless `--allow-production` is passed.
- A production run without a service key is capped at **6 req/s** (360 per minute). The public limit is 600 requests per 60 s per IP (`RATE_LIMIT_MAX_REQUESTS`), so a keyless run measures latency rather than the rate limiter, and doesn't crowd out other clients behind the same IP.
- `LOADTEST_SERVICE_KEY` lifts the cap by sending `X-Service-Key`. It is read only from the environment and is never printed or written to the artifact. Use it only against an isolated instance whose keys you control.
- **Capacity and saturation tests belong on an isolated instance**, such as a restored backup on a fenced host. The resilience work found that the production replica already serves API reads and must not be saturated as a test.

```bash
# Isolated instance: capacity sweep
LOADTEST_SERVICE_KEY=… npm run perf:load -- --base-url=http://127.0.0.1:3001 \
  --stages=1:60,8:60,32:60,64:60 --label=isolated-capacity --markdown

# Production: bounded latency check only
npm run perf:load -- --base-url=https://api.zecblock.com --allow-production \
  --stages=1:60,2:60,4:60 --label=public-latency --markdown
```

## 2026-11-07: mainnet public latency after NU7

- **Run:** 13:42:53–13:45:53 UTC, against `https://api.zecblock.com`.
- **Settings:** keyless, capped at 6 req/s, seed 1.
- **Chain:** tip 3,548,294, about 1.5 days after NU7 activated at 3,543,405.
- **Client:** one workstation over the public internet.

| Concurrency | Seconds | Requests | Req/s | p50 ms | p95 ms | p99 ms | Max ms | Failed | 429s |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | 60 | 347 | 5.8 | 112.6 | 128.8 | 136.2 | 1518.2 | 0% | 0 |
| 2 | 60 | 360 | 6 | 112.6 | 128.1 | 137 | 335.4 | 0% | 0 |
| 4 | 60 | 360 | 6 | 111.8 | 126.2 | 341.9 | 624.5 | 0% | 0 |

Per endpoint, across all three stages:

| Endpoint | Requests | p50 ms (c=1/2/4) | p95 ms (c=1/2/4) | Max ms |
|---|---:|---|---|---:|
| blocks-list | 222 | 112.5 / 112.4 / 111.3 | 117.1 / 115.9 / 116.1 | 170.6 |
| tx-detail | 179 | 112.6 / 112.2 / 111.7 | 115.2 / 116.5 / 341.9 | 624.5 |
| block-historic | 142 | 127.0 / 126.8 / 120.6 | 133.8 / 134.2 / 131.6 | 167.5 |
| mempool | 128 | 109.4 / 110.2 / 109.4 | 113.7 / 113.8 / 113.6 | 333.5 |
| block-recent | 126 | 116.9 / 116.5 / 115.9 | 120.6 / 120.2 / 119.6 | 123.4 |
| v1-network-info | 63 | 111.9 / 111.5 / 110.9 | 113.8 / 113.8 / 131.0 | 131.0 |
| health | 56 | 110.1 / 109.8 / 109.3 | 120.3 / 111.0 / 114.5 | 856.8 |
| info | 52 | 110.6 / 110.0 / 110.7 | 112.6 / 112.2 / 462.7 | 462.7 |
| block-speed | 51 | 110.5 / 111.4 / 109.8 | 113.6 / 335.4 / 113.7 | 335.4 |
| accounting | 48 | 113.7 / 113.9 / 111.4 | 1518.2 / 117.1 / 112.6 | 1518.2 |

### Reading these numbers

- **All 1,067 requests succeeded.** There were no 429s, no timeouts and no 5xx.
- **The ~110 ms floor is mostly network round trip** between the client and the server. Server time is a small part of it: earlier sampled `Server-Timing` app times were 0.1–6.5 ms.
- Historic block detail is the slowest route, about 15 ms above that floor at p50. It is also the most likely to miss caches, because heights are random across 50,000 blocks.
- **Mempool was the only route that returned a cache header:** 87 HIT and 41 STALE.
- The single slowest request was 1,518 ms, on `accounting` in the first stage. It was a single outlier; the same route's p50 stayed at 111–114 ms. One sample can't tell whether it was a cold cache or the network.
- **This is a latency baseline, not a capacity number.** Throughput was capped at 6 req/s, so p50 stayed flat across concurrency because the server was never pushed. Use the isolated-instance procedure above to find saturation points.
- The sample size is a few hundred requests per stage, enough for a rough p95. The p99 and maximum rest on only a handful of requests.

## Not yet measured

- Saturation throughput and latency under load on an isolated full-schema instance with a service key.
- Mixed load during cron peaks, where indexer freshness is checked while reads run.
- WebSocket fan-out and slow-reader behaviour. The tool covers HTTP reads only.
- Load during a failover. See the failover section in `DEPLOYMENT.md`.
