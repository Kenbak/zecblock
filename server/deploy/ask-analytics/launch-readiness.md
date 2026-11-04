# Ask private research: launch acceptance

This branch is a private research implementation. Successful fixture/runtime
checks do not authorize paid public activation or imply a full-history audit.
Canonical current rollout/evidence: the private wiki's `ask-research-workspace`,
`ask-source-feed-operations` and `ask-logical-sync` topics.

## Feed outage and guarded recovery (October 12, 2026 JST)

The October 9 publisher restart closed a logical replication stream. PostgreSQL
16 recorded one apply error and disabled the subscription because
`disable_on_error=true`. The WAL slot remained available; the source identity
and timeline were unchanged. A reviewed enable operation resumed from the saved
origin; no origin advance, slot recreation, history skip or chain-row mutation.
The original error counter and log event must be retained as incident evidence
when acknowledging the reviewed event; do not reset cumulative statistics.
Existing admission remains closed until applied source checkpoint, canonical
consistency, freshness and dirty-history reconciliation pass again.

For a future disabled subscription:

1. Capture its error counters, origin/checkpoint, coverage and selected error log.
2. Verify publisher database/system identity/timeline and the existing slot's WAL
   status and retained interval through a separate trusted operator connection.
3. Diagnose the actual error. A transport termination is not a schema conflict,
   lost slot, failover, inconsistent copy or permission failure.
4. Resume only the existing named subscription after those facts match. Retain
   `disable_on_error`, publication filters and read-only worker privileges.
   Never advance an origin or reset statistics merely to turn a monitor green.
5. Wait for dirty canonical heights and completed-day summaries to reconcile.
   Check every dataset gate, then run the reviewed workload through the worker.

The source `zecblock-ask-availability.timer` and analytics
`zecblock-ask-analytics-alerts.timer` check each minute, using the owner's existing
private ops Telegram destination. Source checks subscriber connection/progress,
slot availability and retained WAL pressure, even if analytics cannot send.
Analytics checks host isolation/capacity, admission, all six extended dataset
gates and query-worker availability. Failures persist for two minutes before
notification; unchanged failures have a thirty-minute reminder cooldown; one
recovery notice follows a notified failure. Delivery failures retry without
recording success. No automatic resnapshot, promotion, grant expansion or reset.
The source monitor is not an independent probe of the source host's own outage;
existing infrastructure monitoring remains necessary.

Bot credentials stay in protected operator environment files, outside the query
worker. Messages contain fixed check codes, never questions, SQL, job capabilities,
DSNs, credentials or arbitrary exceptions. Verify actual API `ok=true`, rather
than treating an HTTP 200 as acknowledged delivery.

## Automatic recovery implementation

The [feed-recovery runbook](feed-recovery.md) describes the guarded target-only
service and [disabled config template](feed-recovery.json.example). It preserves
raw errors in an append-only acknowledgement ledger and re-enables only an
existing subscription after classified native evidence and source/target pins
match. Normal admission still reconciles data before reopening coverage.
Installation, current retry/checkpoint behavior and isolated test outcomes
must be reconciled with the actual release; this link does not claim deployment.

## Repeatable fixed workload

Run `server/api/scripts/check-ask-research-readiness.js` through the existing
private loopback worker, with its service key loaded outside logs. It accepts
only registered benchmark IDs, concurrency1–6 and rounds1–2 (maximum22 requests).
Default runs eleven reviewed cases once. For a bounded burst:

```
node server/api/scripts/check-ask-research-readiness.js --concurrency=6 --rounds=2 annual_activity flow_months address_incidence
```

The worker keeps one queued runner, six pending jobs, two DB connections and
3s interactive/30s queued statement limits. The retained result registry remains
capped at24; under pressure only its oldest terminal result expires, never queued
or running work. Capabilities can therefore expire before the one-hour TTL under
load; clients must handle `expired` and retain their displayed/saved result.
Spending and admission quotas are not reset by testing or registry eviction.

Reports contain case ID, outcome, safe HTTP/transport code, rows and timing only.
Percentiles describe that small fixed sample, including queue/transport; they do
not establish capacity, arbitrary-query accuracy or performance for all users.
Cancelled work must remain terminal; Redis loss, stale datasets and failed
privilege checks must never produce success. Mutation/file/catalogue-access
probes belong in isolated fixtures or the rejecting compiler, not live chain SQL.

## Gates still requiring explicit evidence

- Repeated live-model routing, SQL/result equality and explanations on reviewed
  questions, ambiguous requests, unavailable/private measures and follow-ups.
  A SQL execution pass does not prove the model interpreted the question.
- Bounded independent numerical audits of public flows and address incidences;
  certify only tested scope/authority. Missing observations remain unavailable.
  Decoded-record comparisons are not an independent raw-node historical replay.
- Safe recovery/delivery tests and maintained external operational monitoring.
- Owner-selected off-server backup access, encrypted backup/restore verification
  and documented rebuild/RPO/RTO. RAID and a retained source copy are not backups.
  Do not mount production backup credentials in Ask or its query worker.
- Reconcile the feature branch with current main, complete CI/build/SEO checks,
  verify private previews and all exact deployment targets before public release.
  Public provider credentials, bot verification and spend limits must be validated
  in their actual environment; development dummy verification is not a pass.
