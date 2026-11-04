# Queued research v1 (private preview)

The dedicated worker, not the AI or browser, owns execution budgets. Enable
`ASK_RESEARCH_JOBS_ENABLED=true` on both API and worker only after testing the
existing admitted logical store. `ASK_RESEARCH_CACHE_ENABLED=true` is a worker
optimization; neither flag expands datasets or PostgreSQL grants.

- Interactive statements: 3 seconds. Background SQL statements: 30 seconds,
  35-second outer deadline, one background job across worker processes.
- Existing database connection limit remains two, `work_mem=1MB`, parallel
  workers disabled and role `temp_file_limit=16MB`. No budget overrides in SQL
  request schemas; the browser cannot raise time, rows, disk or privileges.
- Six pending jobs; 24 retained jobs globally, one-hour expiration. These are
  deliberately conservative preview limits, not a public capacity claim.
- Redis atomic transitions and a 90-second fenced owner lease serialize jobs.
  Lease loss aborts work. After lease expiry, a replacement marks interrupted
  running jobs failed and resumes queued work, without retrying expensive SQL.
  Redis must be persistent for jobs to survive a Redis/server restart; worker
  restart alone preserves Redis jobs. Do not claim durable storage if the
  instance has AOF/RDB disabled. Snapshot loss loses jobs, not chain data.
- Every job has a random ID and 256-bit bearer capability, hashed at rest in
  Redis. Only its holder can poll/cancel/read its result. Capabilities are POST
  bodies, never URLs, provider prompts, logs or saved research files. The API
  authenticates to the loopback worker using its separate existing service key.
- Submit uses the existing CAPTCHA and 5/minute, 20/day IP admission; model
  calls retain existing daily/monthly/active cost reservations. Polling has a
  separate 90/minute limiter. One paid explanation attempt per completed job;
  repeated successful reads reuse it. Manual SQL makes no provider calls.
- Cancel sends a PostgreSQL protocol CancelRequest to the specific backend and
  discards its connection. Statement timeouts remain an independent fallback.
- Cache retains at most 24 results, each <=256KiB, for 30 seconds. Admission and
  current canonical coverage are checked before lookup. Keys include canonical
  tip hash, coverage range and verification timestamp as well as SQL/row limit.
  Time-dependent SQL is not cached. Cached results retain original retrievedAt.
- APIs are mainnet-only, no-store and noindex. Error categories distinguish
  query validation, statement timeout, resource limits, source availability,
  quotas, job expiry and interrupted work; PostgreSQL diagnostics stay private.

The existing daily snapshot/chart datasets are unchanged. A broad reusable
historical aggregate store is a separate trusted ingestion/reorg design: do
not let the query login create materialized views or write aggregate tables.
Keep exact zatoshis, null semantics and independent flow-completeness caveats.
This step supplies a bounded result cache; it is not a new daily aggregate feed.

Before enabling publicly: load-test representative full-year joins, budget
PostgreSQL backend CPU/memory separately from the Node worker, add observability
without questions/tokens/SQL in logs, and size queues/retention for real traffic.
No claim of universal jailbreak safety or unlimited arbitrary SQL is made.

Refresh destination planner statistics with `research-statistics.sql` when
EXPLAIN finds poor estimates. Existing height/time/txid indexes should be
measured first. This script refuses the source/standby and requires the admitted
dedicated identity. It does not change indexes, data, replication or privileges.
