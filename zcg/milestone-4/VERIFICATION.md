# Milestone 4 — Verification Guide

**Grant:** ZecBlock (formerly CipherScan) Zcash Block Explorer
**Milestone:** 4 — NU7, Shielded Rate Tracking & Infrastructure ($14,700)
**Scope changes:** ZSA support → NU7 network upgrade support (NU7 shipped without ZSAs); Rust indexer research → Zakura node migration (the Rust indexer was already in production)
**Live:** [zecblock.com](https://zecblock.com)

---

## Deliverable Checklist

| # | Deliverable | Status | Live URL |
|---|-------------|--------|----------|
| 1 | NU7 network upgrade support *(replaces ZSA support)* | ✅ | [zecblock.com/network/block-speed](https://zecblock.com/network/block-speed), [zecblock.com/network/upgrades](https://zecblock.com/network/upgrades) |
| 2 | Shielded Rate Tracking — bridged ZEC that gets shielded | ✅ | [zecblock.com/crosschain](https://zecblock.com/crosschain) |
| 3 | Infrastructure scaling — load testing, benchmarks, monitoring | ✅ | [status.zecblock.com](https://status.zecblock.com), [load test results](../../docs/load-test-results.md) |
| 4 | Zakura node migration *(replaces Rust indexer research)* | ✅ | Serving node reports `/Zakura:1.8.0/` |
| 5 | Annual retrospective with metrics | ✅ | Forum and GitHub issue #179 |
| 6 | 2027 roadmap | ✅ | Forum and GitHub issue #179 |
| 7 | Final report on forum | ✅ | Forum and GitHub issue #179 |

---

## Independent Verification

All commands below can be run by anyone with `curl` and `jq`. No ZecBlock code required. Expected outputs were captured on 2026-11-14; counts and balances grow over time.

---

### 1. NU7 Network Upgrade Support

NU7 activated on testnet at block 4,465,026 (October 4, 2026) and on mainnet at block 3,543,405 (November 6, 2026, 02:34 UTC). Activation heights and block-time eras come from the serving node's upgrade schedule.

**Block speed before and after NU7:**

```bash
curl -s "https://api.zecblock.com/api/network/block-speed" | jq '{activation: .activation.height, target: .schedule.eras[-1].seconds, beforeNu7: .windows.beforeUpgrade.averageSeconds, sinceNu7: .windows.latest.averageSeconds}'
```

```json
{
  "activation": 3543405,
  "target": 25,
  "beforeNu7": 75.4,
  "sinceNu7": 25
}
```

**NU7 accounting (NSM balance and fee rule):**

```bash
curl -s "https://api.zecblock.com/v1/network/accounting" | jq '.data | {nu7Height: .schedule.nu7Height, nsmBalanceZat, feeRule: .block.feeRule}'
```

```json
{
  "nu7Height": 3543405,
  "nsmBalanceZat": "37913921059",
  "feeRule": "floor(aggregate-block-fees * 3 / 5)"
}
```

**Per-block fee split.** Fees to NSM = floor(fees × 3/5); the miner receives the rest; miner receipts = subsidy + miner fee share:

```bash
curl -s "https://api.zecblock.com/api/network/accounting/history" | jq '[.points[] | select(.feesPaidZat != null and (.feesPaidZat|tonumber) > 0)][0] | {height, feesPaidZat, feesToNsmZat, minerFeeAllocationZat, minerSubsidyZat, minerReceiptsZat}'
```

```json
{
  "height": 3573460,
  "feesPaidZat": "24100",
  "feesToNsmZat": "14460",
  "minerFeeAllocationZat": "9640",
  "minerSubsidyZat": "41666668",
  "minerReceiptsZat": "41676308"
}
```

`24100 × 3/5 = 14460` to NSM, `24100 − 14460 = 9640` to the miner, `41666668 + 9640 = 41676308` miner receipts. `verify.js` checks this for each of the most recent blocks the history endpoint returns (currently 120).

**Node upgrade readiness:**

```bash
curl -s "https://api.zecblock.com/api/network/nodes/upgrade-readiness" | jq '{referenceUpgrade, readinessPct, latestCount, totalActive}'
```

```json
{
  "referenceUpgrade": "NU7",
  "readinessPct": 100,
  "latestCount": 411,
  "totalActive": 411
}
```

Testnet: replace `api.zecblock.com` with `api.testnet.zecblock.com`. The activation height there is 4,465,026.

---

### 2. Shielded Rate Tracking

The share of ZEC delivered by NEAR Intents (1Click) swaps that ends up shielded, either delivered directly into a shielded pool or shielded on its first spend. Only swaps whose Zcash delivery transaction is reported, canonical and tied to the recipient are counted. Coverage is published with every rate.

```bash
curl -s "https://api.zecblock.com/v1/crosschain/shielding?period=all" | jq '.data.summary | {swaps, coveredSwaps, swapCoverage, shieldedRate, shieldedOnArrivalZat: .breakdownZat.shieldedOnArrival, shieldedAfterZat: .breakdownZat.shieldedAfter, coveredZat}'
```

```json
{
  "swaps": 93138,
  "coveredSwaps": 92038,
  "swapCoverage": 0.9882,
  "shieldedRate": 0.8207,
  "shieldedOnArrivalZat": "71290498104550",
  "shieldedAfterZat": "36343783081530",
  "coveredZat": "131147016584731"
}
```

82.1% of 1,311,470 covered ZEC ends up shielded: 54.4% on arrival and 27.7% on the first spend. Swap coverage is 98.8%.

**Time to shield (transparent arrivals):**

```bash
curl -s "https://api.zecblock.com/v1/crosschain/shielding?period=all" | jq '.data.timeToShield | {samples, medianMinutes: (.medianMinutes|floor)}'
```

```json
{
  "samples": 18178,
  "medianMinutes": 15
}
```

Other periods: `?period=30d`, `90d`, `1y`. The full response also includes `daily`, `byChain`, `coverage` and the `definition` (methodology). Also available to AI clients as the public MCP tool `crosschain_shielding` at `https://api.zecblock.com/v1/mcp`.

---

### 3. Infrastructure Scaling

**Health, primary and streaming-replication standby:**

```bash
curl -s "https://api.zecblock.com/health/deep" | jq '{status, database: .checks.database.status, replica: .checks.replica | {status, role, lag_blocks, circuit}}'
```

```json
{
  "status": "healthy",
  "database": "up",
  "replica": {
    "status": "up",
    "role": "standby",
    "lag_blocks": 0,
    "circuit": "CLOSED"
  }
}
```

**Public status page:** [status.zecblock.com](https://status.zecblock.com) covers the explorer and API on mainnet and testnet.

**Load testing and benchmarks:**

- Tool: [`scripts/perf/load-test.mjs`](../../scripts/perf/load-test.mjs) (`npm run perf:load`). It runs a staged, weighted mix of real explorer reads and reports p50/p90/p95/p99/max latency plus status and cache breakdowns per endpoint.
- Published results: [`docs/load-test-results.md`](../../docs/load-test-results.md). First production run: 1,067 requests, 0 failures, 0 rate-limit responses, p50 ≈ 112 ms, p95 ≈ 128 ms.

**Failover runbook:** the [Failover section of DEPLOYMENT.md](../../DEPLOYMENT.md#failover) covers primary and standby roles, the read-offload circuit breaker, manual promotion with fencing, total-loss restore, and the exercise log.

---

### 4. Zakura Node Migration

```bash
curl -s "https://api.zecblock.com/api/blockchain-info" | jq '{build, chain, blocks}'
```

```json
{
  "build": "/Zakura:1.8.0/",
  "chain": "main",
  "blocks": 3573579
}
```

```bash
curl -s "https://api.testnet.zecblock.com/api/blockchain-info" | jq '{build, chain}'
```

```json
{
  "build": "/Zakura:1.8.0/",
  "chain": "test"
}
```

Mainnet and testnet moved from Zebra to Zakura in September 2026 with zero downtime. They are now on Zakura 1.8.0, and rollback was tested on the standby before each promotion.

---

## Automated Verification (Optional)

```bash
git clone https://github.com/Kenbak/zecblock
cd zecblock

# Mainnet (all deliverables)
node zcg/milestone-4/verify.js https://zecblock.com

# Testnet (NU7, infrastructure and Zakura; cross-chain swaps settle on mainnet)
node zcg/milestone-4/verify.js https://testnet.zecblock.com
```

Requires Node 18 or later, with no dependencies. Run from a clone so the repository checks (load test, results, failover runbook) are included. Result on 2026-11-14: **mainnet 59 passed, 0 failed**.

---

## Context

- **ZSA support → NU7 network upgrade support.** NU7 activated on mainnet on November 6, 2026 without ZSAs, and no 2026 network upgrade brings ZSAs to testnet or mainnet. NU7 was the upgrade that shipped this quarter, so it was supported testnet first and then mainnet, as the original item intended.
- **Rust indexer research → Zakura node migration.** The Rust indexer had already replaced the Node.js indexer in production, so the research item was obsolete. The quarter's infrastructure work was moving the nodes from Zebra to Zakura.
- **Rebrand.** CipherScan is now ZecBlock. Same project and repositories; old `cipherscan.app` URLs redirect.

---

## Source Code

- **Explorer / API:** [github.com/Kenbak/zecblock](https://github.com/Kenbak/zecblock)
- **Rust indexer:** [github.com/Kenbak/zecblock-rust](https://github.com/Kenbak/zecblock-rust)
- **This milestone:** [`zcg/milestone-4/verify.js`](verify.js)
