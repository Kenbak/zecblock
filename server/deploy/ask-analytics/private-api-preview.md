# Private Ask API preview

The private preview runs the same Ask router and SQL worker client used by the
application. The API holds the provider key; the separate query worker holds
only its restricted reader connection. The browser receives neither credential.

`server/api/ask-preview-api.js` is an operator test fixture, **not a public API
entry point**. It requires `ASK_PRIVATE_PREVIEW=true`, refuses known database/RPC
credential configuration aliases, binds only127.0.0.1:3004 and validates local Host/Origin.
It supplies request IDs and cancellation signals for the normal response
contract. CAPTCHA verification is simulated with the published dummy site key.
Optional `ASK_PREVIEW_SIMULATE_IPS=true` admits only valid198.18/16 fixture
addresses; public ingress must never accept a client-selected IP.

The credential check rejects non-empty `DATABASE_URL`, `REPLICA_DATABASE_URL`,
`DB_PASSWORD`, `PGPASSWORD`, `ASK_ANALYTICS_DATABASE_URL` and
`ZCASH_RPC_PASSWORD`. This is configuration hygiene for known aliases, not proof
that no other secret was inherited. Provider, worker service-key and quota Redis
credentials are required by this API and remain allowed.

Install matching Linux API lockfile dependencies, including shared-library zod
resolution. Keep source, dependencies, runtime and all parent directories owned
by root and non-writable by ask_api. The protected api.env is root0600, loaded by
systemd; the service does not need filesystem read access to that file. Never
copy developer node_modules or source/indexer/database credentials.

The accompanying ask-api-preview.service uses ProtectSystem=strict, ProtectHome,
no privileges/capabilities, private temporary/devices, binding only TCP3004,
MemoryHigh384MiB/MemoryMax512MiB, CPUQuota100% and TasksMax64. HTTPS egress is
needed for provider requests. This caps the API process, not PostgreSQL. The
unit has no Install section: the test service is not enabled at boot.

Access through SSH forwarding. A local same-origin frontend proxy can forward
Ask to the tunnel and other public data requests to the public explorer API.
Verify capability envelopes in the browser; a command-line200 alone will not
catch a missing meta.requestId. The preview intentionally lacks the separate
indexed-record source: height/record tools can report unavailable even while
SQL research works. Do not describe that as proven production behavior.

## Research capability and limits

The security fix rejects ARRAY subqueries and forbidden/qualified ANY/ALL
operators. It preserves scalar subqueries, EXISTS, IN/NOT IN, ANY/SOME/ALL,
nonrecursive CTEs, joins, aggregates, sets and windows in the supported subset.
There is no change to SQL8KiB, result200rows/24columns/256KiB, quick3s and queued
30s execution, cancellation, two DB slots, one queued runner or six pending jobs.
Historical dates are not shortened to make a query fit. Maintained daily
summaries support larger historical analyses without replaying every raw row.

PostgreSQL work_mem/temp limits do not cap every backend allocation. The Node
worker's memory cgroup also does not cap PostgreSQL. Removing the demonstrated
ARRAY amplifier is not complete resource-exhaustion isolation. Separate database
resource containment/load/recovery qualification remains a public launch gate.
Do not raise queued execution without coordinating statement/client/outer
budgets, both Redis admission expiry mechanisms and job status contracts.

Use fixed reviewed queries for benchmarks and disposable fixtures for dangerous
memory/write tests. Preserve quotas and original failure evidence across service
restarts. Record exact commits, deployed hashes, small-sample timing limitations
and rollback stages in the private wiki. A release-directory name ceases to be
an exact source identity after an overlay; retain a separate overlay manifest.
