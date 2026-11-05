# Indexer heartbeat alerts

The five-minute native health monitor and ten-minute general ops monitor distinguish
successful tip polling from committed block ingestion. The default heartbeat budget
is 600 seconds; the lag budget remains three blocks. A quiet chain is healthy when
the writer keeps polling and its checkpoint matches the observed tip.

`indexer_state.last_tip_check_at` is the Unix-second time of successful writer polling.
`last_success_at` retains the actual last successful block ingest time. It must not
be refreshed merely because the writer is idle. `pending_work_since` records the
first outstanding block or failed canonical-chain/reorg check. Repeated polls and
retries preserve that clock; a successful canonical check clears it once caught up.
When work is pending, the progress budget starts at the later of `pending_work_since`
and `last_success_at`. This gives the first block after a long quiet period time to
ingest, while detecting a writer that keeps polling without committing progress.

Missing, malformed, or future clocks remain unhealthy. Stopped services, unavailable
RPC, excess lag, consecutive failures, and native ingest-latency checks remain in
force. Stale poll and stalled-progress alert signatures use stable failure categories,
so their changing ages honor the 30-minute cooldown. A new failure category alerts
immediately, and recovery sends once on the next scheduled successful check.

Deploy the matching Rust writer/health command before the updated ops monitor:
older writers do not publish `pending_work_since`. Deploy
`server/deploy/lib/indexer-progress-health.sh` with `check-ops-health.sh`; preserve
the existing unit, environment, timer schedule, and Telegram destination. The new
state key uses the existing table and needs no schema migration. Validate with
`node --test server/tests/ops-heartbeat.test.js` on Linux/Bash 4+, the Rust health
and PostgreSQL clock tests, native `health --json`, and API deep health. Fixture
monitor tests use fake commands and a temporary state directory; they do not send
Telegram messages or alter live writer state.
