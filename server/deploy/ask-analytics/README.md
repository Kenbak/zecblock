# Ask replica analytics — operator gate

## Current private feed and acceptance authority — October 12, 2026 JST

The nine-dataset private analytics store is provisioned. Today's outage/recovery,
alert delivery, fixed workload and remaining public-launch gates are tracked in
[launch-readiness.md](launch-readiness.md) and the canonical private wiki. Earlier
copy/dormant-reader statements below are dated provisioning history, not the
current state. No public paid activation is implied.

The [guarded feed-recovery runbook](feed-recovery.md) documents classified
transport recovery, protected configuration, operator pauses, error evidence
and isolated acceptance. Deployment status still requires a verified release
record; the runbook itself is not evidence of an enabled timer.

## Public catalogue audit (operator tooling)

[`catalogue-audit.md`](catalogue-audit.md) describes the draft nine-source
catalogue, bounded standby inventory, selected-row storage samples and canonical
join proof. Generate the fixed profiling script with
`node server/api/scripts/profile-ask-catalogue.js`; benchmarks and samples are
explicit opt-ins. This catalogue is not connected to model routing or public
SQL execution and grants no additional permissions. The v2 contract below
remains the deployed-private query surface.

## Implemented contract

`POST /v1/ask/chat` can select version-two relational plans when paid Ask and
`ASK_ANALYTICS_ENABLED=true` are configured. Five reviewed datasets expose daily
observations, canonical blocks, confirmed non-coinbase transactions, public
shielding/deshielding boundary flows and tracked successful cross-chain swaps.
`upgrade-v2.sql` adds security-barrier views; v1 `daily_v1` remains compatible.

Plans accept inclusive completed UTC dates (at most 366 days), day/week/month
buckets, up to two dimensions, four bound filters, four measures, two same-unit
ratios/differences and 1–25 ranked rows. No SQL text or arbitrary joins. Stocks
cannot be summed; `last` preserves a null reading on the last dated snapshot.
Per-measure missing counts remain visible. Sparse event dates do not imply zero
activity or missing database days. Canonical joins exclude orphan transactions.
Exact monetary values remain decimal strings; SQL averages/ratios round to six
storage decimal places. Prose uses verified rounded facts with ≈; tables retain
exact returned values. Follow-ups carry the last validated plan as untrusted context.

Cross-chain authority is `public.cross_chain_swaps` (`legacy-success-index`),
matching the public cross-chain reader verified October 3. Direction derives from
the source/destination ZEC chains; internal ZEC-to-ZEC routes are excluded and
legacy zero USD sentinels become NULL. Already installed v2 views use the
reviewed `refresh-swaps-v2.sql` correction. Inflow USD uses the
source valuation; outflow USD uses the destination valuation. This **counterparty**
valuation differs from the cross-chain page's source-side-only USD definition.
Do not compare them as identical metrics. No upstream completeness is certified.
Historical flow backfill coverage is also unverified.

The worker enforces a 3s statement timeout, serial query execution, 1MB work_mem,
two database connections, daily query quota, 32KiB raw results and 64KiB transport
responses. Worker CPU limits do not limit PostgreSQL backend CPU; scan/concurrency
limits and statement timeouts are separate controls. Runtime audit accepts exactly
six reviewed views and rejects unexpected reader privileges. Numeric claims must
use server placeholders; provider decoding rejects all Unicode numeric categories.

The AI receives a public metric catalogue, validated results and fact placeholders;
it never receives the database password, SQL, private tables, filesystem or shell
tools. SQL is compiled exclusively from server constants and bound parameters.
No expressions, arbitrary identifiers, joins, functions, URLs or SQL text can be
submitted. Existing fixed charts and block/transaction tools remain available;
they are not replaced by this initial dataset.

## Relational query engine (version two)

`upgrade-v2.sql` adds five reviewed views after v1 provisioning. The reader can
SELECT these views and `daily_v1`, with no underlying-table access. Public datasets:

- `daily`: maintained non-coinbase activity and pool-stock observations.
- `blocks`: current canonical blocks, transaction counts, size and fees.
- `transactions`: non-coinbase confirmed transactions joined by hash and height
  to canonical blocks, including component flags, fees, sizes, actions and miner.
- `flows`: indexed public boundary amounts joined to canonical transactions and
  blocks; direction and pool filters, individual or aggregated rankings.
- `swaps`: successful tracked swaps, counterparty chain/token and reported USD.

A plan chooses an inclusive completed UTC window of at most 366 days, optional
calendar bucket, up to two category/identifier dimensions, four AND filters,
four measures with up to two per-measure filters, and two ratio/difference
calculations. Sort by any returned column and return up to 25 groups. Numeric
ZEC filters use storage zatoshis; results format these as exact decimal ZEC.
The compiler controls every identifier/operator/function and binds filter values.
Prejoined canonical datasets provide reviewed relationships without arbitrary
joins or fanout. This is a flexible public-data query language, not an SQL editor.
It does not yet expose every explorer table, arbitrary joins, address history,
saved queries/dashboards or unrestricted all-history scans.

Examples: weekly deshielding counts and volume; largest public boundary transfers
in a selected month; average transaction fees by shielded-component status;
Orchard versus Ironwood stock ratios; highest tracked inflow chains by USD.
Follow-ups carry the prior bounded plan as untrusted context, never DB rows or SQL.
Missing measures are reported per result cell. A sum/average ignores null inputs;
last uses the last dated row even if null. Ratios with zero denominators stay null.
Dates are clipped at window boundaries. Event datasets do not certify historical
backfill completeness; absent events are not automatically zero or missing days.
The latest canonical block timestamp is shown separately from retrieval time.

## Independent boundaries

- Dedicated `ask_analytics_reader`, no memberships or elevated role attributes.
  Only SELECT on the explicitly reviewed public views; a non-login view owner has only explicitly
  granted source columns. Do not reuse `zcash_user` or `REPLICA_DATABASE_URL`.
- Every request checks standby recovery, replay age (maximum 120 seconds),
  role identity/permissions, PUBLIC and column grants, schemas, sequences and
  callable non-system SECURITY DEFINER functions. Any failed check rejects the
  query. Promotion and replica failure never fall back to primary.
- Read-only repeatable-read transaction, server 3-second statement deadline,
  500ms lock deadline, 1MB work_mem, role 16MB temp-file bound, 2 login connections.
  Overall execution deadline 10 seconds, 25 rows; v1 raw cap 16KiB, v2 32KiB and authenticated wire cap 64KiB. Query parallel workers and JIT are disabled. Failed or
  cancelled sessions are discarded. PostgreSQL timeouts also bound remaining
  server work after disconnect.
- Redis atomic admission: maximum 2 analytics executions across instances and
  explicit daily query allowance (1–10,000). Leases expire after 30 seconds; no
  refunds for failed queries. Redis unavailable means no query. Existing Ask
  bot/IP admission and per-provider-call money reservations still apply.
- Separate loopback worker holds the reader DSN and has no provider, primary DB,
  RPC or SSH credentials. The public API can submit only validated plans using
  a private service token. No raw-SQL endpoint is exposed. The worker refuses
  root startup; the supplied systemd unit adds a dynamic user, a read-only
  filesystem, hidden home directories and CPU/RAM limits. These host controls
  require actual operator installation and verification.
- Native table renderer uses React text escaping, not generated HTML or JS.
  Narratives use exact server fact placeholders; no model-supplied numbers or links.

These controls constrain model behavior; they do not establish immunity to all
vulnerabilities. Read-only alone does not prevent every server effect or resource
attack. PostgreSQL's built-in metadata/function defaults are not globally revoked:
the no-raw-SQL compiler is essential. Do not expose the reader DSN or a generic SQL
endpoint. A physical replica still contains operational data.

## Before enabling production

Private preview rollout, October 2: the reader/view have been provisioned and
the standalone worker is running on standby, serving only authenticated
loopback requests. Public Ask remains guided; the public API is not connected
to this worker. The local preview reaches it through SSH forwarding.

1. Review `provision.sql` and primary/standby source at the intended release SHA.
   Apply the additive script on primary only, verify WAL replay. It aborts if
   roles/schema already exist; do not silently reuse them. It changes no shared
   PUBLIC grants. Audit any existing PUBLIC grants separately rather than
   automatically revoking permissions needed by other services.
   On the current deployment, the two pg_stat_statements extension views had
   PUBLIC SELECT. `restrict-statistics-views.sql` records the separately
   reviewed cleanup: explicit SELECT for all three existing login roles before
   revoking PUBLIC SELECT. The new reader must not inherit those views. Run this
   preflight before provisioning, and review again if the role list changes.
2. Set the reader password privately, with SCRAM and credential rotation. Restrict
   its login in pg_hba/network rules to the analytics service and standby only;
   deny reader login on primary. Install the separate non-root analytics worker with
   no SSH, RPC, indexer, writer or admin credentials, bounded CPU/RAM and no
   unnecessary outbound network. Stage the reviewed worker files/dependencies
   under `/opt/zecblock-analytics`, outside root's home, and install the provided
   `zecblock-ask-analytics.service`. Verify its effective systemd restrictions;
   unit-file presence is not proof of runtime isolation. Host egress rules should
   allow only loopback, the private standby and quota Redis endpoints.
   The supplied unit now permits only loopback traffic and binding port 3015;
   install it on standby so PostgreSQL and quota Redis are both local. Install
   a checksum-verified Node 22 runtime under `/opt/zecblock-analytics/runtime`
   without replacing the existing API/node runtime. The dedicated quota unit
   uses a root-only config delivered through LoadCredential, AOF fsync on each
   write, no eviction, 16MB data limit and 64MB service memory limit. Its only
   listener is 127.0.0.1:6391. Neither service is enabled at boot during preview.
3. Supply only a private standby DSN as `ASK_ANALYTICS_DATABASE_URL`, using the
   exact reader role and no URL query/options. Use a TLS/private tunnel appropriate
   to that topology; do not put a public plaintext Postgres connection in service
   config. Worker-only environment: `ASK_ANALYTICS_ENABLED=true`, reader DSN,
   `ASK_ANALYTICS_REDIS_URL`, `ASK_ANALYTICS_SERVICE_KEY` (random 32+ characters),
   `ASK_ANALYTICS_DAILY_QUERY_LIMIT` (e.g. 200 for beta), optional
   `ASK_ANALYTICS_PORT` (default 3015). Do not inherit the API/indexer environment.
   Public API receives only `ASK_ANALYTICS_ENABLED=true`,
   `ASK_ANALYTICS_SERVICE_URL=http://127.0.0.1:3015/` and the shared service key.
   Do not pass the reader DSN to the API. Do not proxy the worker to public ingress.
4. Execute `node server/api/scripts/audit-ask-analytics.js` with the worker-only
   environment and actual login on standby; test primary refusal,
   lag/unavailable Redis and permissions. Review replica disk/WAL headroom and
   replay conflicts. Budget counts must use a durable, access-restricted Redis;
   reset/eviction loses quotas, so monitor persistence and disallow eviction of
   allowance keys. Reader config alone must not advertise analytics as healthy.
5. Rotate the previously shared testing provider key before public activation.
   Restrict its provider endpoints/model and configure provider hard spend caps
   plus reviewed `ASK_MAX_*` rate bounds, app daily/monthly budget and Turnstile.
   Block bypass of the trusted proxy and verify `req.ip` forwarding cannot be
   forged. API `trust proxy=1` assumes exactly one trusted ingress.
6. Verify actual model intent/answer quality in supported languages and misleading
   prompts using small paid tests, then canary real replica execution. Unit/model
   fixtures and local PG14 tests are not production-role or live-model passes.

No production provisioning, deployment or AI activation is performed by tests.
Do not claim unrestricted query coverage or saved dashboards: those are later
milestones after this layer is verified under its actual deployment boundaries.

## Verification

```
node --test server/api/test/v1/ask-analytics.test.js
ASK_TEST_POSTGRES=1 node --test server/api/test/v1/ask-analytics-postgres.test.js
```

The opt-in integration test uses only local `/tmp` PostgreSQL, creates a disposable
database, refuses existing reader/owner roles, and removes its own fixtures. It
proves database permission denials even with the user-changeable read-only default
disabled, and tests PUBLIC/column/SECURITY DEFINER leaks and primary refusal.

## Local public-core synchronization prototype

The [disposable local store prototype](local-core-store.md) tests a separate
public-only schema, atomic bounded-window publication, retries and reorgs on
small fixtures. It does not deploy a database, implement production CDC, or
expand current Ask access.

## Public-core continuous synchronization candidate

The [PG16 logical replication plan and isolated fixture proof](logical-sync.md)
selects a column-filtered native feed as the first production candidate. Its
operator preflight is read-only; source logical WAL/restart, finite retention,
dedicated host, bootstrap admission and failover remain rollout gates. No
publication, slot, source role or configuration has been changed by this work.

## Dedicated destination schema

The [subscriber-core v1 migration](subscriber-core-v1.md) prepares the new
public-only store: exact native raw types/identities, canonical views, a dormant
NOLOGIN reader, and coverage that hides uninitialized/stale/uncovered data. The
real two-cluster PG16 fixture now uses this actual migration. It creates no
source connection/publication/subscription or query login; trusted reconciliation,
source maintenance, transport, backups and SQL/worker release gates remain open.

## Private source transport and bootstrap checks

[Private transport](private-transport.md) defines a dedicated tunnel-only SSH
account, hardened Unix-socket transport and passive bootstrap checks. This is
separate from a source database login/feed and from public SQL/AI admission.
