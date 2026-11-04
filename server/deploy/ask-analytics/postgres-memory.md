# PostgreSQL memory and bounded load acceptance

This repository provides reviewed policy templates and opt-in acceptance
tooling. Host installation is an operator action; the dated acceptance below
records the private analytics rollout, not a public capacity claim. The private analytics PostgreSQL service is
`postgresql@16-main.service` on the analytics host. Never apply this policy or
run this probe against the source/indexer database.

The 2026-10-16 read-only inventory found 134,983,872,512 bytes host RAM,
16GiB PostgreSQL `shared_buffers`, and no reserved huge pages. PostgreSQL was
using about 656MB of charged memory shortly after its restart. That idle sample
does not represent the eventual 16GiB buffer allocation or research capacity.
The target's existing `MemoryMax=infinity`, `OOMPolicy=stop`, `Restart=no`
left database memory uncontained and an OOM service stop without automatic
service restart. API/Node worker cgroups do not contain their PostgreSQL backends.

`postgres-memory.conf.example` proposes `MemoryHigh=24G`, `MemoryMax=32G`, and
`MemorySwapMax=1G` for this whole PostgreSQL service. The soft threshold leaves
8GiB above configured shared buffers for backends, replication, maintenance and
cache charges. The hard threshold leaves substantial host headroom, subject to
review of the other services on this particular 125.7GiB host. These values
require a representative load observation before beta acceptance. They are not
a per-query allocator bound: sort/hash work may multiply `work_mem`, other
allocations need not spill, page cache is charged, and a sufficiently fast spike
can still reach the hard cap and crash the entire analytics database. Changes to
huge-page reservations or PostgreSQL settings require a fresh containment review.

The separate `postgres-restart.conf.example` proposes `Restart=on-failure`,
`RestartSec=5`, `StartLimitIntervalSec=300`, `StartLimitBurst=3`. It retains the
distro `OOMPolicy=stop`/`KillMode=control-group`. A database service restart runs
native WAL crash recovery. It neither enables a subscription nor resets error
counters. Recovery of the data feed remains subject to the existing exact
transport evidence, origin/identity pins, acknowledgement ledger and stale/
quarantine gates. A startup rate limit requires operator review; do not schedule
blind `reset-failed`, subscription enable, origin advance or counter resets.

## Pressure admission

The worker can reject new work before the hard cap by setting these operator
environment values in its dedicated root-only environment file:

```dotenv
ASK_POSTGRES_CGROUP_PATH=/sys/fs/cgroup/system.slice/system-postgresql.slice/postgresql@16-main.service
ASK_POSTGRES_PRESSURE_PERCENT=85
ASK_POSTGRES_PSI_AVG10_PERCENT=5
```

The path is fixed in code to the intended PG unit. No visitor-supplied path,
threshold or SQL is accepted. The worker reads only five cgroup v2 files, caches
the result for at most 200ms, and requires finite ordered high/max values. New
quick queries, new job tickets, and queued queries at execution time are refused
with the existing resource error if memory reaches 85% of High (20.4GiB with
this candidate), PSI some/full avg10 reaches 5%, or a high/max/OOM counter changes.
An event or event counter rewind holds admission closed for at least 30 seconds
before a healthy sample can reopen it. Invalid/unreadable configured data fails
closed. Unconfigured legacy previews retain their previous behavior and do not
qualify for this memory acceptance gate. The unit's `ProtectControlGroups=yes`
must keep sysfs read-only and readable by its non-root worker account.

Status/cancel remain available; existing active queries are not cancelled by this
guard. Two SQL slots, one queued runner, 3s quick/30s queued statement budgets,
200-row output limit and AST policy remain unchanged. This guard is a short
cached admission decision, not a promise of graceful handling of every memory
spike. It does not validate query meaning or natural-language accuracy.

## Before applying anything live

1. Run `python3 test-query-load.py` and `python3 test-postgres-memory.py`, then the
   Node pressure/worker/jobs tests with the exact staged dependency runtime.
2. On a PG16 systemd/cgroup-v2 host, run the explicit disposable proof below.
   It writes only a unique `/run/ask-pg-memory-proof-*` cluster and transient
   unit. It observes bounded cancellation under its 128MiB soft threshold, then
   raises **only that fixture's** High to its unchanged 192MiB hard cap for a
   prompt kernel OOM. It proves native WAL rows survive an automatic restart,
   keeps an unknown duplicate-key feed
   failure disabled and its admission closed, and exhausts the fixture's bounded
   restart budget. It removes the unit/cluster afterward. It never restarts or
   changes `postgresql@16-main.service`.

   ```sh
   ASK_MEMORY_TEST_SYSTEMD=1 ASK_LOGICAL_PG_BIN=/usr/lib/postgresql/16/bin \
     python3 server/deploy/ask-analytics/test-postgres-memory.py
   ```

   The fixture uses a 2s restart delay/60s window to bound test time; the proposed
   live policy uses a 5s delay/300s window with the same three-start ceiling.
   A skipped native test is not an OOM/WAL proof.
3. Inspect the exact currently serving worker artifact/dependency runtime and
   PG unit, all coexisting services, shared buffers, huge-page accounting and
   host reserve. Record current memory events/PSI, restart count and target
   physical system identifier. Confirm backup deferral remains explicit for
   beta; production backup/restore acceptance remains open.
4. Have the operator review both drop-ins and pressure guard deployment together.
   Keep public activation closed. Installing files/daemon reload alone does not
   prove that running resource limits, restart rules or new worker code apply.
   For a no-PG-restart rollout, use reviewed `systemctl set-property --runtime`
   resource values on the live PG unit and verify its cgroup files. Persist the
   reviewed drop-ins separately and verify `systemctl show`; do not restart PG
   merely to demonstrate the configuration. Restart only the versioned worker
   after its overlay/source manifest is reconciled. Any runtime resource change
   can cause reclaim; do not lower a cap beneath existing use.

## Safe representative sample

`query-load.py` defaults to metadata-only inspection. The target's pinned
physical system identifier is required; passing a different identifier fails
closed. The tool checks finite memory/swap limits, backend cgroup membership,
the exact bounded restart/OOM policy, 16GiB host reserve, pressure headroom,
installed running worker guard, stable
postmaster identity/restarts, core admission, all six datasets, active apply and
operator error acknowledgement. No provider calls, visitor questions, SQL text,
returned cell values, credentials or job capabilities are written to its report.
Only the fixed worker loopback endpoint is used; the key is parsed without
sourcing a shell from `/etc/zecblock/ask-analytics.env` (root-owned mode0600).

Run from the staged repository with its reviewed Node dependencies alongside
the script; do not copy this script alone or install new packages on the host:

```sh
python3 server/deploy/ask-analytics/query-load.py --system-identifier TARGET_ID
python3 server/deploy/ask-analytics/query-load.py --system-identifier TARGET_ID \
  --run --profile serial --node /absolute/reviewed/runtime/bin/node
python3 server/deploy/ask-analytics/query-load.py --system-identifier TARGET_ID \
  --run --profile overlap --node /absolute/reviewed/runtime/bin/node
```

Each profile submits the same eleven reviewed research cases once, including
CTEs, window functions, requested date ranges, address incidence and independent
aggregate joins. Serial submits one queued request at a time; overlap submits
six concurrently through the same one-runner queue. At most four fixed small
quick reads overlap each profile, for at most fifteen executions. Cache remains
in its serving configuration; a pass is a **warm/cache-capable private sample**,
not cold throughput or an open public load limit. No SQL budget is increased.

The monitor stops new submissions and asks the child to abort/cancel its known
tickets if charged memory reaches 80% of High, PSI/events increase, readiness
changes, the service restarts, the probe fails, or the overall deadline expires
(default360s, maximum600s). Graceful cleanup gets ten seconds before forced
child exit; transport loss can still leave server-side work until its existing
lease/cancellation/statement timeout expires. It never terminates other clients
or changes roles/subscriptions. Do not use this as a destructive limit finder.

For beta acceptance record: both native and unit test output, exact worker/source
manifest, exact applied cgroup/restart values, serial+overlap report, queue/quick
outcomes and latency, observed peak memory and unchanged pressure/restart
counters, and fresh post-load coverage/source checkpoints. Public admission
requires a separate product/abuse/load decision; these fixed samples do not
certify semantic correctness, universal safety or capacity.

## Measured verification on 2026-10-16

The disposable native proof passed on the analytics host's PostgreSQL16.15:
unit `ask-pg-memory-proof-bbd7e92304d1.service`, four tests, 13.802 seconds.
An initial attempt that only reached statement timeout did not count as an OOM
pass. Later fixture assertions were corrected to recognize Ubuntu systemd's
actual startup-limit behavior: its final `Result` remains `signal`, while the
journal says `Start request repeated too quickly` and no additional start occurs.

The successful run observed soft-throttle statement cancellation, an actual
kernel OOM at the fixture's 192MiB hard cap, one automatic restart and two durable
committed rows after WAL recovery. A real duplicate-key logical apply failure
was counted before the crash (`apply_error_count=1`) and kept the subscription
disabled. The unclean crash reset that volatile counter to zero; the durable
acknowledgement ledger's previous epoch still refused it. Both before and after
the crash, `disable_on_error=true`, acknowledged=false, enabled=false and public
coverage ready=false. Two more deliberate fixture-only main-process kills
exhausted the three-start limit. Cleanup removed the fixture unit, runtime
property drop-in and cluster; a separate read-only inventory found no leftovers.
The disposable proof itself never restarted or changed the live target/source
PostgreSQL services.

The live metadata-only baseline correctly refused workload execution with
unbounded high/max/swap values and an unset running worker pressure guard.
It observed charged PG memory 671,014,912 bytes, host available 132,000,530,432
bytes, PSI 0, zero PG high/max/OOM events, six ready datasets, healthy acknowledged
apply and the unchanged postmaster start at `2026-10-16T06:57:24.622491+00:00`.
Host `Committed_AS` was 17,586,332KiB against `CommitLimit` 74,289,480KiB.
The largest other running service charges were the worker 51,703,808 bytes
(128MiB cap), private API 36,515,840 bytes (512MiB cap), quota 10,080,256 bytes
(64MiB cap), and source tunnel 1,863,680 bytes (128MiB cap). No competing large
node/indexer service was observed in that running-service inventory. These are
point samples, not reserved-capacity guarantees for future cohosted workloads.

Local integration verification passed the pressure/worker/jobs tests, including
a real HTTP/Redis run of all eleven fixed queued cases and the bounded quick
lane. Its database results were fixtures; this does not establish real query
semantics or live workload performance. The subsequent private installation passed those separate gates: worker
`1fdb4937` was reconciled under its existing Node 22.22.1 and locked Linux dependencies;
High 24GiB / Max 32GiB / swap 1GiB and restart 5s / 300s / 3-start policy were applied without
restarting PostgreSQL. Its postmaster PID 1421348 / start 06:57:24.622491 UTC stayed
unchanged. Serial 11 queued + 4 quick completed in 21.148s; overlap 11 queued + 4 quick
in 19.980s. Queued end-to-end P95 was 6595ms / 13027ms respectively, observed PG
peak 2258149376 bytes, with no memory/PSI/restart/readiness event. Core 3519778 and
all six dataset gates were ready at 11:58:26.7757 UTC. This is a warm/cache-capable
fixed private sample; long-job/public-capacity and backup/restore claims remain
separate. Owner deferred off-host backup for beta. The private API later moved
to `57f39c8f` without changing the worker/SQL budgets or serving model. Sanitized
evidence lives in the private wiki at assets/ask-beta-foundations-2026-10-16/.

Authoritative behavior references:
[systemd resource controls](https://www.freedesktop.org/software/systemd/man/latest/systemd.resource-control.html),
[service restart/OOM policy](https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html),
[unit startup limits](https://www.freedesktop.org/software/systemd/man/latest/systemd.unit.html),
[PostgreSQL16 resource configuration](https://www.postgresql.org/docs/16/runtime-config-resource.html).
