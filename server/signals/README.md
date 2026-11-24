# server/signals

What remains here is public explorer code:

| File | Role |
|------|------|
| `api.js` | `/api/signals/*` (v1 `/v1/signals/*`): reads the `trading_signals` table behind a service key or an x402 payment. |
| `compute-mvrv.js` | Daily MVRV and realized-cap analytics (`mvrv_daily`), run by `cipherscan-prices.service` and reused by `server/jobs/backfill-analytics-history.js`. |
| `build-pool-realized-cap.js` | Shielded pool realized caps, a wrapper over `server/jobs/refresh-pool-realized-cap.js`. |

The trading-signal engine that writes `trading_signals` is not part of this
repository; it runs from a separate private checkout on the API host.
