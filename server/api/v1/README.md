# ZecBlock API v1

The frontend now uses `/v1` for explorer HTTP data, with one checked `{data, meta}`
parser for browser and server consumers. The manifest has 142 entries: 137 adapters,
4 native name routes, and one superseded legacy blocks alias. No implemented
capability is represented by a v1 stub. Production activation is a separate release.

## Contract and coverage

- `inventory/manifest.js` is the route/method/authority registry. Routes with literal
  names register before parameter routes, so `/uncles/stats` is not a hash lookup.
- `inventory/query-parameters.json` includes direct query reads and the shared
  limit/offset and limit/page helpers. Unknown, repeated or structured parameters
  receive HTTP 400. Source handlers retain their domain-specific value validation.
- Successful responses use `{data, meta}`. Top-level legacy `success` is removed;
  nested fields, arrays, zero and null retain their meaning. Errors use RFC 9457
  `application/problem+json`, preserve HTTP status and are never cached.
- `meta.generatedAt` is response generation time. Unknown source observation time
  and source height stay null. A current indexer tip is not a historical snapshot
  height. Missing age is `freshness.status=unknown`, not an invented fresh reading.
- Declared authoritative zatoshi fields are decimal strings. Address totals use
  exact source `*Zat` fields before legacy numeric fields; unsafe numeric amounts
  fail closed. Existing formatted ZEC/USD/percentage fields remain field-defined.
  Do not multiply a formatted float to manufacture an authoritative zatoshi value.
- Blocks, transactions, shielded flows and names expose `meta.page` with opaque
  cursors. Chain cursors bind the route and filters. Lists probe beyond the source's
  100-row ceiling and use complete tie-break keys, including transaction hashes
  when fully shielded transactions share a timestamp. Other domain-specific
  paginated payloads retain their documented bounded page/offset semantics.
- Name routes use the configured ZNS JSON-RPC service, normalize keys and expose
  bounded pagination. Voting-chain RPC and WebSockets remain separate protocols.
- Fork-monitor writes forward the caller's ownership token. Paid signal routes
  forward only their existing authorization/payment headers and never receive
  the adapter's internal service key. Payment challenge/receipt headers survive;
  HTTP 402 includes the original challenge in `problem.paymentRequired`.
  Authenticated responses use `private, no-store`. No payment is made by v1 itself.
- Scans have bounded block windows and rate limits. The wallet UI divides its
  supported 50,000-block window into 10,000-block requests and honors Retry-After
  and cancellation. Viewing keys remain in the browser.

Generate the API reference and OpenAPI from their source registries:

```sh
node server/api/v1/tools/query-inventory.js
node server/api/v1/tools/write-reference.js
node server/api/v1/tools/write-openapi.js
```

`server/api/openapi/v1.yaml` and `lib/generated/api-reference.json` are checked
artifacts. Core envelope, errors, queries and units are specified; domain payloads
retain their established fields. Generic domain schemas are not evidence that
all possible payload states have been validated.

## Private local testing

Run `npm run dev:v1` and `npm run dev` in separate terminals. The preview binds
only `127.0.0.1:3002`, fetching deployed mainnet data. Keep the ignored `.env.local`:

```dotenv
NEXT_PUBLIC_NETWORK=mainnet
NEXT_PUBLIC_API_URL=http://127.0.0.1:3002
CIPHERSCAN_API_URL=http://127.0.0.1:3002
NEXT_PUBLIC_WS_URL=wss://api.mainnet.cipherscan.app
```

Consumers append `/v1/...`, so base URLs omit that suffix. The preview rejects
foreign browser origins, non-loopback Host headers and writes. The one POST
exception is `/v1/ask/chat`, forced to reviewed-guide mode with paid AI disabled.
No shared preview
secret enters a browser bundle. Restart the Node preview after backend edits;
Next.js normally picks up frontend edits automatically.

For new source-handler validation against server-held data, the optional
`dev-mainnet-source.js` runs in a separate temporary checkout on the server.
It requires `V1_PRIVATE_SOURCE=true`, an explicit `V1_SOURCE_ENV_FILE`, and binds
only `127.0.0.1:3003`. It mounts the changed transaction-list/address handlers and the new search-interest read,
with a two-connection PostgreSQL pool enforcing read-only transactions and
8-second statement deadlines. It starts no indexer, Redis worker or production
service. Remaining reads use the existing local legacy API. Reach it through an
SSH local forward, then start `dev:v1` with
`V1_PREVIEW_UPSTREAM=http://127.0.0.1:<forwarded-port>`.
Never expose either development entry point publicly. Stop both with Ctrl-C.
No schema changes are applied by these helpers.

## Deployment and compatibility

`server/api/server.js` mounts the router under `/v1`, behind the existing CORS,
security and request limiter. V1 owns its 1 MB JSON parser and problem errors.
The feature gate defaults closed. `API_V1_ENABLED=true` requires
`X-API-Preview-Key` until `API_V1_LAUNCHED=true`; an absent preview key fails closed.
A publicly reachable preview gate can reveal its existence through a 401, so
use loopback/SSH access when the hostname must remain undiscoverable.

The intended mainnet base is `https://api.zecblock.com`. This code does not create
DNS/TLS or change production flags. Configure the host, allowed web origins,
WebSocket origin, and backend before shipping a frontend that depends on them.
Testnet and Crosslink retain explicit network configuration and indexation policy.

Adapters still call the existing handlers over bounded internal HTTP. They reuse
business logic but add a hop and JSON serialization; inspect `Server-Timing` and
measure release latency. Native shared service extraction can remove that hop
later. **Do not delete the legacy handlers while adapters depend on them.** Keep
external legacy compatibility until its consumers have migrated; no sunset date
has been selected. Do not redirect old URLs to incompatible payload shapes.

Relevant settings are documented in `config.js`: internal origin, timeout
(default 8 seconds), response limit (50 MiB), network, and scan limits.
`V1_INTERNAL_SERVICE_KEY` can bypass the legacy read limiter in a trusted deployment;
it must not bypass ownership or payments. Dedicated deployments need their own
CORS and global request limiting; the private development server is not a public
hosting configuration. Writes preserve source behavior and are not automatically
retried after an ambiguous timeout.

## Ask contextual assistant

### V1 answer quality and diagnostics — September 29

Exact advertised starters and supported control shortcuts bypass intent classification;
free-form and multilingual questions still use the classifier. The new yearly busiest-day
starter uses existing privacy history, requesting 366 rows so today's row does not displace
a completed day. Server evidence ranks up to five days by exact shielded + transparent
non-coinbase transaction count. Categories are mutually exclusive. Rankings exclude today
and future days, omit unknown categories, break ties by earliest date, and count missing
days against the requested completed UTC window. Missing coverage prevents a definitive
full-period maximum. This is a fixed API operation, not SQL access. Weekly flow/count
comparisons also exclude today's unfinished bucket.

Analytical chat replies add optional `dataContext` with `start`, `end`, `retrievedAt`,
`source` and `label`. Dates can be null for non-calendar rankings. Sources disclose guide
review dates separately from observation windows and retrieval time; neither retrieval nor
calendar completeness proves indexer synchronization. Cached answer identity includes
calculated facts so UTC-day eligibility cannot reuse yesterday's ranking under unchanged rows.

Reviewed knowledge adds shielded/transparent concepts, unified addresses/viewing keys and
the ZIP process. These use fixed public source URLs and per-document review dates; no live
crawler, private wiki retrieval or provider change is introduced.

Failures expose fixed `code` values: `ask-verification` (403), `ask-source`, `ask-provider`,
`ask-answer`, `ask-unavailable` (503), `ask-timeout` (504), `ask-quota` (429). Diagnostics log
only the fixed event/code, never prompts, histories, raw errors or provider output. Both chat
surfaces retain failed questions for manual retry; errors are not added as successful turns.
There is no automatic paid retry. Existing admission, reservations, concurrency and token
limits remain unchanged. Public activation and live-provider acceptance remain release gates.


Mainnet `POST /v1/ask/chat` accepts a validated page ID, question (1,000 characters),
optional analysis recipe, response locale and at most four previous questions.
The server selects reviewed public knowledge and/or fetches allowlisted analytics.
It exposes no SQL, arbitrary URL, shell, wallet or write tools to the model.
Sources come from `lib/ask-knowledge.js`; update their review dates when reviewing
official material. The private wiki is not a retrieval source. Dynamic record
pages currently receive conceptual guides, not analysis of that specific record.
Answer schemas permit only known numeric fact placeholders and supplied source
IDs. Citations are separate from prose. Final validation still rejects all Unicode
numeric literals, unknown placeholders and markup; schemas do not prove semantic
accuracy. Both answer paths constrain decoding to exact fact placeholders. Explanation caches
use v3. `lib/ask-insights.js` derives combined pool growth/share, observed lead dates,
complete rolling-week changes, recent pace, peaks/concentration and coverage with
integer arithmetic. Stock intervals require both endpoints and consecutive dates;
flow/count comparisons sum complete daily buckets. Missing observations stay unknown.
Narration leads with comparative findings; generic limitations are optional. No
extra narration calls or SQL access are introduced.

Ask also supports individual public shielding/deshielding transaction queries:
latest, largest or both, 1–10 results, over the trailing 24 hours, with optional
pool filtering. The classifier selects a strict server-side query; the reader
uses only `/api/shielded/list`. Results are structured transaction rows rendered
by the workspace/widget, with a deterministic localized introduction (one model
call total). No transaction IDs, amounts or links are invented by the model.
Largest rankings cover the complete time window above successively lower amount
thresholds (1,000, 100, then zero ZEC). A threshold is sufficient only when the
complete filtered window contains at least the requested number of records;
lower amounts then cannot enter the ranking. This relies on the canonical
`UNIQUE(txid, flow_type)` constraint. Duplicate transactions, incorrect order,
ignored filters or invalid cursors fail closed. Twenty upstream requests maximum;
an incomplete scan never produces a largest ranking. Source failures still fail
the request. The existing operation deadline and admission limits apply.

Exact `amountZat` strings are preferred when available. The current legacy source
returns formatted `amountZec` numbers; those are labelled `legacy-reported-zec`,
converted to integer display units and never presented as newly verified exact
zatoshi authority. Times are source block timestamps in UTC; the 24-hour boundary
is fixed at retrieval start. Results describe indexed canonical records, not a
snapshot guarantee across a concurrent reorg. No SQL/schema/API deployment was
needed for this capability. Other transaction windows remain unsupported.

Chart narratives now receive the latest returned observation date instead of a
hardcoded freshness status. The UI shows “Observations through” for daily series
and retrieval time for chain rankings, preserving any explicit stale-source flag.
Neither retrieval time nor a transaction timestamp proves indexer freshness.

The global mainnet widget and full Ask workspace share this endpoint. Opening the
widget or changing chart controls does not invoke paid inference. With no provider,
exact page-guide/product prompts and guided chart recipes remain usable in English.
Multilingual contextual answers require a configured and evaluated model.

Every mainnet header/footer destination now has an explicit Ask page descriptor
and reviewed guide. Network, Network Nodes and Privacy Score have distinct topics;
Mining, Mempool, Forks & Reorgs, tools and resource pages no longer fall back to the
generic explorer description. Suggested page questions use matching reviewed
answers in guided mode and the same source documents in paid mode.

Individual chart guides use the definitions in `lib/chart-catalog.ts`. Regenerate
the public descriptor snapshot with
`node server/api/v1/tools/write-ask-chart-guides.js` when that catalogue changes;
coverage tests check for drift and unknown chart routes. These guides explain
controls, units and methodology. They do not receive plotted rows, URL filters,
form contents, decrypted memos, article text or current node/mining readings.
They do not add data tools or enable a provider. Existing supported chart analysis,
block and transaction readers remain the separate source of live evidence.

Ask now has a bounded read-only block tool: latest indexed block, up to 25 recent
indexed blocks, or a specific height/hash. Exact English lookup prompts and
“Explain this page” on Blocks/block details also work without a model. Paid mode
classifies free-form/multilingual requests into the same validated tool and
narrates only server-supplied facts using the existing numeric placeholder checks.

The widget sends an optional strictly validated `block` height/hash for a selected
block; follow-ups and handoff to Ask preserve the returned hash. It never sends DOM
text, arbitrary URLs, table rows or query strings. Blocks-page explanations use an
explicitly **unfiltered latest indexed sample**, not the browser's filtered table.

The tool makes at most two fixed GET requests: `/api/blocks/list` with bounded
limits/height filters and, for a hash, `/api/block/:hash?summary=1`. It does not load
full canonical block transactions, execute SQL, follow model URLs or page through
history. Validate response fields, ordering/contiguity, requested heights and hash
identity. A hash reorg between reads fails rather than attributing replacement data
to the original block. Missing and orphaned results are distinct; orphan details
remain a link to their retained page. Fees are exact integer zatoshis rendered as
ZEC; missing fees/intervals remain unavailable, and transaction counts include
coinbase. Software markers are self-reported. Observation timestamps and retrieval
time do not prove indexer synchronization. Results carry `blocks` plus existing
`dataContext` and appear as native linked cards in both Ask surfaces.

Guided reads retain the existing request limiter and a 15-second deadline; paid
reads retain bot admission, distributed quotas, cost reservation and response
limits. No automatic provider retries or expanded spending allowance. Provider
activation is separate from this capability and remains unchanged.

Paid mode requires all of these **backend** settings:

- `ASK_ENABLED=true`, `ASK_PROVIDER=openai|anthropic`, `ASK_MODEL`, `ASK_API_KEY`.
- `ASK_DAILY_CALL_LIMIT` (1–10,000), `ASK_DAILY_BUDGET_USD`,
  `ASK_MONTHLY_BUDGET_USD` (each positive, at most 1,000 USD).
- `ASK_MAX_INPUT_USD_PER_MILLION`, `ASK_MAX_OUTPUT_USD_PER_MILLION`: reviewed
  upper bounds covering the selected model's applicable regional/cache premiums.
  Each call first reserves its worst case at these rates; when the provider
  reports token usage, the reservation is reduced to the billed cost, so the
  daily and monthly caps track real spend. Calls with no reported usage
  (network failure, timeout, cancellation) keep the full reservation.
- Optional `ASK_CACHED_INPUT_USD_PER_MILLION` (0 up to the input rate): the
  price of cached input tokens when reconciling. Unset, cached tokens bill at
  the full input rate.
- `ASK_ABUSE_SECRET` (at least 32 characters), `ASK_TURNSTILE_SECRET`,
  `ASK_TURNSTILE_SITE_KEY`, `ASK_TURNSTILE_HOSTNAME` (exact frontend hostname).
- Ready shared `app.locals.redisClient`. Configure durable, non-evicting storage
  for allowance counters; losing/resetting them invalidates cumulative limits.
- Optional OpenAI `ASK_REASONING_EFFORT`, supported by the selected model.

Only the public Turnstile site key is returned to browsers. Server verification
requires the configured hostname and `ask` action. Distributed limits admit five
requests per UTC minute and twenty per day per daily HMAC of the trusted client IP.
Verify reverse-proxy attribution before launch. IP quotas are not user identity;
attackers can rotate IPs or exhaust the shared allowance.

Atomic Redis reservations charge each provider call's conservative maximum against
both UTC day/month budgets before dispatch, including selection and explanation
separately. They use UTF-8 request bytes plus wrapper headroom, reviewed price
bounds and 500 output tokens. This is a conservative reservation ledger, not
measured invoice reconciliation; uncertain/failed calls receive no refund.
There are no automatic retries; three concurrent calls, 15-second provider
deadlines, 35-second operation deadlines and bounded bodies limit work. Missing
configuration, Redis failures or exhausted allowances fail closed. Also configure
provider-side controls; deployment-reviewed tokenization/pricing remains necessary.

For OpenAI, configure a project monthly spend limit with **Enforce a hard limit**
enabled; alerts alone do not stop requests. Enforcement can lag slightly behind
usage. See [OpenAI spend limits](https://developers.openai.com/api/docs/guides/spend-limits).
Application quotas do not protect against direct use of a leaked provider key.

For the private loopback AI harness, `AskChallenge` supplies Cloudflare's official
dummy token only with `NODE_ENV=development`, an exact localhost/loopback hostname,
and the official always-pass test site key. This avoids development-widget stalls.
Production builds, remote hosts and real site keys still load the widget. Server
validation and spending reservations remain required; this does not enable paid
AI in `dev:v1` or constitute production bot-protection verification.

Only generic public explanations are cached for five minutes by model, locale,
recipe, reviewed documents and evidence fingerprint. Arbitrary questions/history
are not cached or logged by Ask. Audit infrastructure/APM logging separately.

Page/chart explanations lead with measured findings and their significance,
using server-calculated changes, concentration and recent pace. Balance overviews
include exact totals and concentration across every selected pool; unknown
endpoints and single snapshots do not produce aggregate change comparisons.
The public-flow chart's **Explain this chart** action passes its validated pool
and period recipe into the widget and starts one explanation. The backend fetches
public observations again; browser HTML, rendered values and arbitrary queries
are not evidence. Other chart controls are not automatically shared with Ask.
English AI answers offer relevant follow-up questions; the shared allowlist
preserves the exact recipe and skips classification for these bounded requests. The same model, provider-call caps and spending controls apply.

The provider processes submitted text; `store:false` is not zero retention or
end-to-end privacy. Off-topic intent filtering and provenance checks do not prove
jailbreak resistance or semantic accuracy. Real-model multilingual/adversarial
evaluation, least-privilege runtime/egress review and live bot/cost tests remain
launch gates. No paid configuration or production deployment is included here.

A September 25 private GPT-6 Luna probe (`reasoning_effort=none`) passed the final
15 scripted knowledge/analytics/language/refusal cases and four repeated French
follow-ups after fixing citation/fact-placeholder confusion. These bounded live
checks do not establish comprehensive jailbreak resistance, live Turnstile
verification or production spending enforcement. The key was held only in the
test process memory; the public feature and loopback preview remain provider-off.

## Zift SQL over MCP

The public read-only MCP endpoint (`POST /v1/mcp`) can also expose Zift's SQL
datasets, so Claude, Codex or any MCP client can query them with its own model.
No ZecBlock AI runs and no AI budget is spent. Mainnet only, off by default:

- `ZIFT_MCP_SQL_ENABLED=true`, plus the existing `ASK_RESEARCH_ENABLED=true`,
  `ASK_ANALYTICS_STORE=logical_public_core` and analytics worker settings.
- Optional `ZIFT_MCP_SQL_MINUTE_LIMIT` (default 30) and
  `ZIFT_MCP_SQL_DAILY_LIMIT` (default 2000): site-wide keyless MCP queries per
  minute and per UTC day, so MCP cannot use up the worker's allowance that Zift
  relies on.
- Optional `ZIFT_MCP_SQL_KEYS`: comma-separated `label:sha256hex` entries for
  higher-limit keys. Issue one with `node scripts/mcp-sql-key.js <label>`; only
  the hash is stored.

Tools:

- `sql_catalogue` (no key): datasets, columns, units, query rules and examples.
- `sql_query` (no key needed): one read-only SELECT, compiled
  by the same AST policy as Zift's manual SQL and run by the read-only worker
  with its row, time and site-wide daily limits. At most 200 rows. Rejected
  SQL returns the policy or database message so the client can repair it.
  Without a key, all callers share the site-wide minute and day allowances;
  nothing identifying the client (not even a hashed IP) is stored. A
  recognized key gets its own 10 per minute and 300 per day instead; an
  unrecognized key is refused.

The MCP request deadline rises from 15 to 25 seconds when the SQL tools are
enabled. Turnstile does not apply to MCP; the shared site-wide quotas take its
place.

## Verification

```sh
npm run test:v1 --prefix server/api
npm run test:frontend
npm run test:server-regressions
npm run lint
npx tsc --noEmit
npm run build
npm run test:route-cache-build
# Optional local PostgreSQL integration; only temporary tables are created:
npm run test:v1-postgres
```

The route suite exercises every adapter with controlled source fixtures, payment
and ownership boundaries, name pagination, cursor traversal and malformed/error
responses. Browser checks and private mainnet reads complement these tests;
neither mock tests nor HTTP 200 alone establish production readiness. Database
migrations, new data feeds, write flows and each deployed network still require
release acceptance. See the private wiki's ZecBlock launch checklist.

### Ask transaction lookups

Ask also supports specific transaction IDs and the latest 1–10 indexed transactions
(default five for plural requests). `/txs` has a transaction page descriptor;
`/tx/:txid` supplies the optional strictly validated `transaction` request field.
The widget and workspace preserve the chosen ID across follow-ups and handoff.
The homepage guide now describes per-card Customize controls, stats-bar selection
and browser-local preferences; Ask does not change those preferences itself.

The strict `transactions` intent uses `transactionQuery={mode:latest|detail,
txid:null|64-hex,limit:1..10}`. Detail requires an ID and limit one; latest forbids
an ID. Latest performs one GET to `/api/transactions/list?limit=N`. Detail performs
one GET to `/api/seo/tx/:txid`, plus one `/api/mempool/tx/:txid` only on 404. A failed
source is not converted into not-found. No arbitrary URLs, pagination, raw detail
fanout, SQL, broadcast or other write methods are exposed. Existing deadlines,
rate limits, AI verification and budget controls are unchanged.

Replies contain `transactions`, linked native records and timestamped source
context. List ordering is block height then transaction index descending,
including coinbase; it is not a value ranking or a canonical-status check.
Individual summaries distinguish confirmed, stale, unknown and mempool pending.
Mempool `firstSeen` is not treated as an authoritative arrival timestamp. Only
allowlisted scalar fields enter model evidence. Exact fee zatoshis are converted
with integer arithmetic, and missing values remain unavailable. No payment
amount is inferred from fees or shielded component flags.

The existing lightweight transaction summary now adds `feeZat` (decimal string or
null), nullable `size`, `vinCount`, `voutCount`, and `hasSprout`. It still uses one
parameterized query and does not load input/output arrays. These additions require
deploying the legacy API handler; until then a preview pointed at an older API
can show confirmed status/components while summary fees and sizes remain unavailable.
Guided English lookups work without inference; paid narration and multilingual
selection use the existing validated fact/citation pipeline when AI is enabled.


### Private research SQL and browser library (2026-10-06)

`ASK_RESEARCH_ENABLED=true` is an explicit opt-in on both API and isolated worker;
only the `logical_public_core` profile is supported. No public rollout is implied.
`GET /v1/ask` reports `researchEnabled`. `POST /v1/ask/research/plan` accepts a
bounded question and challenge, returns a validated v3 SQL recipe or null, and
uses the existing provider reservation. With `execute:true`, the validated recipe is executed by the same isolated worker and returned with its result in one challenge-admitted request. Omitting this option only drafts SQL. The main Ask composer uses `/chat`: a validated research intent generates SQL, executes it through the same worker and explains the returned evidence. Optional `currentResearch` preserves the previous query for follow-ups. SQL remains available behind the optional SQL & data disclosure; no separate workspace tab exists.
`POST /v1/ask/research/query` accepts `{version:3,sql,limit,challenge}`. The manual
path uses the same challenge/IP admission and the authenticated worker's atomic
query quotas; it does not require or call the AI provider.

The pinned `pgsql-parser@18.2.9` (PostgreSQL 18 AST) parses one SELECT; the positive
subset is exercised against PostgreSQL 16. User AST, writes, recursive CTEs, locks,
private/catalogue relations, unreviewed functions/types/operators and string
concatenation are rejected. Reviewed aliases resolve to three admission-gated
public views. Joins, CTEs, subqueries, arithmetic, aggregates and windows are
supported; this does not certify arbitrary analytical semantics or prevent join
fanout. Results retain exact decimal strings/nulls, with a fingerprint, UTC
indexed-through/retrieval times, coverage and units. Limits: 8 KiB SQL, 24 columns,
200 rows, 256 KiB evidence, 3-second database statements, 500ms lock timeout,
1MB work_mem, 16MB temp_file_limit, two worker slots and a configured global daily
query cap. Node worker cgroup limits do not bound the PostgreSQL backend. Heavy
queries can fail safely and need aggregates or a separate asynchronous tier.

The unified `/ask` conversation stores an explicitly saved versioned library in localStorage
(`zecblock.research.v1`), not a user account or backend database. Limits: 25 queries,
12 dashboards with 12 items each, and 2 MiB portable/storage payloads. It exports
individual/library JSON and readable Markdown reports. Strict imports remap IDs,
validate references and shapes and never autoexecute SQL. Files are editable
snapshots, not signed evidence; users must rerun for live verification. Site-data
clearing loses local saves, so download a copy. SQL/results/notes do not go to the
model on manual runs. The standalone draft route sends the question and public schema. Ask chat also sends recent questions, the previous SQL recipe for follow-ups, and a bounded public-result preview for explanation; notes and saved browser libraries are not sent.
No passkeys, cross-device cloud saves, public ratings, publishing/discovery job,
MCP endpoint, private uploads or BYOK flow is implemented by this change.
