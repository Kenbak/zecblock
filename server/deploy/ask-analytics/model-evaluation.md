# Private Ask model evaluation

These operator tools compare explicit model candidates through the actual private
Ask API, queued analytics worker and narrative path. They do not change the
serving model, public capabilities, SQL policy, credentials or existing quotas.
`ask-model-profile.js` is the single source for evaluation identities:
`mini-observed` selects `gpt-4o-mini` without reasoning effort; `luna-candidate`
selects the API model `gpt-6-luna` with `reasoning_effort=none`; `sol-candidate`
selects `gpt-6-sol` with `reasoning_effort=none`. These are not Codex app model
settings. Sol is a compatibility-based candidate, not verified SQL quality. The prior owner-authorized Luna probe is historical evidence,
not approval to silently change the current `ASK_MODEL`.

## Complex-question regression acceptance — October 28, 2026 Mexico City

Staging testing must grade SQL results separately from the natural-language
finding. A correct result table can accompany a wrong comparison. The fixed
annual operator case exposed that distinction: the model chose a December
decrease even though the returned October increase had larger magnitude.
A bounded checked narrator now independently compares exact consecutive monthly
count endpoints only when AST lineage proves a direct activity_daily month
bucket and SUM of the requested count field. It preserves ties, unknowns,
source identity and returned-row scope. Filters on hidden measures, partial
months, joins, unresolved expressions and unsupported meanings abstain;
those queries remain available through the ordinary model explanation path.
This is pipeline acceptance, not model-only arithmetic accuracy.

Two other fixed operator failures have model-only draft repair diagnostics:
missing input columns in a fully resolved simple CTE projection, and the known
month-wide daily address COUNT(DISTINCT address)/COUNT(*) shape. The latter
receives guidance to retain the full month using per-day correlated raw activity
counts driven by observed activity_daily dates. The independently run reference
returned all thirty days within the unchanged worker budget. The earlier coarse
resource failure does not independently establish a PostgreSQL temp-spill code.
The address hint also recognizes source-proven Boolean incidence predicates,
which must be retained unchanged in both per-day subqueries; it never assumes
these filters are redundant. Unrequested predicates should not be generated.
A further proven-ZEC diagnostic preserves zatoshi precision when an AI draft
silently rounds to fewer than eight decimals and the question requests no
rounding or approximation. Explicit precision requests, unknown monetary lineage
and handwritten ROUND expressions remain available.
These diagnostics use the existing single SQL repair, not additional retries;
unknown shapes and direct SQL retain their existing acceptance and limits.

Source-proven activity_daily month buckets render as month/year facts, rather
than falsely describing a full-month aggregate as activity on its first day.
This proof requires exact output-column binding and strict first-of-month values;
an arbitrary alias named month does not change an actual observation date.
Raw SQL, table cells and source timestamps remain unchanged.

Strict valid UTC-midnight date facts render as readable dates; nonmidnight,
nonzero-offset and arbitrary labels retain their original value. Unsupported
historical address-balance requests explain that current summaries cannot
establish earlier balances, without running SQL or changing the intent gate.
Browser assertions inspect actual checked values, dates, direction, denominator,
units, nulls and requested scope. A lexical grader flag requires review rather
than rewriting a valid user answer to match a preferred phrase. Fixed operator
fixtures are distinct from anonymous visitor telemetry; no visitor question or
SQL corpus is collected.

## Period grain and source-bound month context — staging acceptance pending

The current implementation adds a narrow **AI-draft** grain diagnostic for an
unambiguous whole-period total/share request naming one completed calendar month.
It requires a direct `activity_daily` source, matching half-open month bounds and
unaggregated date/count output. The repair asks for aggregation across that same
full month and recomputes shares from `SUM(numerator)/SUM(denominator)`, retaining
unclassified transactions in the denominator when requested. It does not average
daily percentages, shorten the dates or silently drop requested measures.

Explicit daily/per-day output, time series, raw or individual observations,
rankings, rolling comparisons, multiple periods and unresolved intent abstain.
CTEs, joins, extra source filters, windows, limits and other unresolved SQL shapes
also retain the ordinary path. This diagnostic is not a new query restriction:
handwritten SQL remains compiler-admitted with its existing capabilities, and no
user SQL is rewritten. AI drafts use the **existing single SQL repair** and fail
conservatively if that repair does not resolve a diagnosed mismatch. There is no
extra retry loop, model change, quota reset or expansion of execution resources.

For a separately proven scalar aggregate over the exact requested month,
narration can receive a checked `period_label` such as a month and year. The
label comes from the matching parsed question/source bounds, not a column alias
or an invented interpretation of a first-day constant. A literal date aliased
`month` remains a date fact; the independent period fact prevents describing a
whole-month total as activity on that single day. Unknown filters, source scope,
nonaggregate results and explicit unaggregated requests receive no such context.
The context labels query bounds only: it does not certify source completeness,
calculation correctness, result cardinality or an unknown metric. SQL, exact
table cells, source timestamps and evidence fingerprints remain unchanged.

These are implementation contracts and regression expectations, **not a claim
that a new artifact is deployed or that the staging retest has passed**. Record
subsequent exact-commit deployment and live result/narrative outcomes separately,
preserving earlier failed observations. Existing call/spend/admission ledgers,
the twelve-attempt evaluation ceiling and all worker limits remain in force.

## Expanded research catalogue — October 28, 2026

The catalogue now has **40 operator-authored cases**: 33 research cases and
seven clarification/unavailable cases. Five research cases are explicitly
synthetic, offline-only fixtures. They verify null/zero distinctions, a zero
baseline, an exact count above JavaScript's safe-integer range, boolean unknowns
and empty results; they are not chain observations or live model successes.
The remaining cases cover all nine admitted datasets, grouped/multi-key/scalar
results, bounded joins, rolling windows, pool stocks, public flows, swaps,
address incidences, units and unavailable information.

These cases are tests, **not a list of questions users are allowed to ask**.
The production query compiler does not import this catalogue. Supported
handwritten and model-generated SQL remains open-ended under the existing
read-only, syntax, admission and resource controls.

Validate every reference and its composed verification query without any
network or provider call:

```sh
node server/api/scripts/evaluate-ask-research.js --all
```

`--all` is validation-only and is rejected together with `--allow-paid` or
individual case IDs. The default live selection remains the original five IDs;
explicit live batches still have at most six cases and twelve actual outbound
provider attempts. Synthetic fixture IDs are rejected for live selection. A research case requires room for at most four actual provider attempts: SQL draft, one SQL repair, explanation and one explanation-format repair. Clarification/unavailable cases require room for at most two. The harness checks both the remaining budget before admission and the attested per-case delta; these bounds fit inside the unchanged twelve-attempt run ceiling. A smaller remaining budget ends the run without sending the next question.
Existing IP/call/spend/worker ledgers are shared and must not be reset, bypassed
or expanded to finish the catalogue. A partial live run is not a full-catalogue
accuracy result.

The annual case now explicitly requests the **largest absolute** month-to-month
change, including decreases. Its reference already used that interpretation;
the wording clarification means earlier runs are not an unchanged-prompt model
comparison. The bounded block/transaction comparison also explicitly requests
all twenty rows before a separate leading finding, matching its existing oracle.
Declared equivalent wording includes shield/shielding and non-coinbase
denominators, with exact cell/unit/key checks retained. The original IDs and
default selection are retained.

The generalized verifier preserves exact decimal strings, signs, nulls and
typed boolean wire values. It supports declared scalar/multiset, composite-key
and ordered result contracts instead of assuming every table has a unique date
column. The ordinary same-snapshot wrapper still has its own bounded SQL,
width and row allowances. `verification-unavailable` is an evaluation limitation,
not evidence that a user's otherwise supported complex query is forbidden.
Initial-result drift is unverified, not a model-correctness pass.

Reports separate `result`, `narrative` and `expectedOutcome` dimensions. Each is
`passed`, `failed`, `not-applicable` or `not-checked`. API failure diagnostics
contain only fixed checked codes/status, and unclear prose retains an explicit
manual-review reason. Numeric presence alone cannot establish the correct
subject, denominator, direction or ranking. These bounded English canaries do
not prove arbitrary prose semantics or certify additional result columns.
The source digest now also binds the catalogue, grader, CLI and extrema helper.

Native SQL/transport acceptance uses a disposable PostgreSQL 16 cluster with
no TCP listener, private Unix socket, owner-only base tables, published views
and an independent read-only reader:

```sh
ASK_EVAL_TEST_POSTGRES=1 ASK_LOGICAL_PG_BIN=/usr/lib/postgresql/16/bin \
  node --test --test-timeout=45000 server/api/test/v1/ask-research-eval-postgres.test.js
```

Run it as a non-root OS user. It executes all 33 reference/comparison paths
against small synthetic seeds and checks five independent exact oracles;
this does not establish real historical coverage. Cleanup stops the private
cluster even after startup failure. CI runs this opt-in fixture separately and
pins its backend runner to Ubuntu 24.04, whose published image includes
[PostgreSQL 16](https://github.com/actions/runner-images/blob/main/images/ubuntu/Ubuntu2404-Readme.md).
No provider credentials or serving database are required by that fixture.

The runtime explanation task now distinguishes bare SQL cells from chart facts
that already carry units. A bounded exact-cell helper supplies signed minimum,
maximum and largest-magnitude fact references for the narrative preview; ties,
nulls and preview scope remain explicit. It does not calculate unreturned
changes, certify metric labels or rewrite SQL. Generated-query guidance keeps
requested table rows separate from the leading narrative finding.

AI draft quality checks also diagnose a narrowly proven lag/lead-derived
descending ranking with omitted null ordering, which otherwise puts an unknown
boundary change first in PostgreSQL. It uses the existing single repair attempt.
Explicit null ordering, matching known-value filters and unresolved lineage stay
accepted. Handwritten SQL and the SQL security compiler do not take this draft
repair path; their supported relational operations and limits remain unchanged.

For explicit public boundary-record questions, a directly resolved `flow_daily`
COUNT draft gets the same single SQL repair: its rows are daily/pool/direction
aggregates, while `SUM(records)` counts underlying records. Explicit coverage
row counts, joins and unresolved lineage stay accepted. A valid record sum
divided by an observed-day count also stays accepted. This is a narrow quality
hint, not a general proof of aggregation grain or a restriction on manual SQL.

If generated research prose contains an unbound English calendar month, it can
receive one format-only explanation repair using the same checked evidence and
schema. The repair must use date facts or neutral period wording. It cannot
modify SQL or result rows; failure retains the existing guarded fallback.
It uses the ordinary provider reservation and attempt accounting, so it may be
unavailable when allowance runs out. No extra request is made for already valid
prose, and there is no repeated repair loop.

Direct daily observations now have a source-grounded natural-language fallback
before a receipt. It resolves reviewed `daily`/`activity_daily` fields through
simple projections, CTEs and subquery aliases, with exact denomination changes
and one actual source date. It compares complete returned tables of two through
forty observations, keeping nulls, zeros, ties and exact decimals distinct.
Metric names come from source fields rather than query aliases. Aggregates,
derived/fabricated dates, lossy casts, joins, truncated results and unsupported
question meanings do not acquire a source-measure interpretation. The fixed
published source-column order is checked against the destination view SQL and
the disposable native fixture; it is not a new runtime schema attestation.

The older paired-pool shortcut also checks true source identity and question
meaning before describing balances. Swapping monetary column aliases cannot
swap the pools in a checked explanation. Valid model prose stays intact; when
an unbound month would remove a recognized finding, the server renders the
checked comparison directly and skips the otherwise redundant format call.
Other supported research keeps its model path. No SQL is rewritten or newly
forbidden by this explanation layer. The evaluation digest binds the new
helper, its catalogue and comparison/fallback dependencies. Pipeline acceptance
that uses this renderer must not be described as model-only prose accuracy.

## Prerequisites

- Use a reviewed exact application commit and Node 22 with the API dependencies.
  Keep the API and worker source reconciled; record optional local test skips.
- Run `server/api/scripts/ask-eval-preview.js` only as the non-root private API
  service account on server loopback `127.0.0.1:3007`, without public ingress.
  Keep the existing protected server environment file and key on the server;
  never copy credentials to a laptop, command output or this document.
- Explicitly set `ASK_EVAL_ISOLATED=true`, `ASK_PRIVATE_PREVIEW=true`,
  `ASK_EVAL_PROFILE`, the verified `ASK_EVAL_REVISION`, and
  `ASK_EVAL_PROVIDER_ATTEMPT_LIMIT=12`. Set only this isolated process's
  `ASK_MODEL`/`ASK_REASONING_EFFORT` to its selected profile. Keep the normal
  private API configuration unchanged.
- Reuse the existing private Redis admission/spend ledger and worker credentials.
  Required research flags are `ASK_ANALYTICS_ENABLED`, `ASK_RESEARCH_ENABLED`,
  `ASK_RESEARCH_EXTENDED`, and `ASK_RESEARCH_JOBS_ENABLED` set to `true`, with
  `ASK_ANALYTICS_STORE=logical_public_core`. `ASK_ANALYTICS_SERVICE_URL` and
  `ASK_ANALYTICS_SERVICE_KEY` stay in the protected server environment.
  Do not reset, bypass or raise the existing daily/monthly/call/IP allowances.
- The isolated wrapper pins outbound OpenAI `service_tier=default` before
  dispatch, selecting Standard processing. Startup rejects reservation rates
  below the explicit profile minimums. Omitting the field would mean
  `auto`, which follows project settings. The shared OpenAI request path also pins Standard as of `57f39c8f`;
  the small additional field fits the existing reservation overhead allowance.

The wrapper attests its actual provider/model/effort, unique process `runId`,
revision, critical-serving-source SHA-256 digest, hard attempt limit and actual
outbound-attempt counter at `GET /__ask_eval/runtime`. It refuses a mismatched
outbound model and increments before dispatch, including failed or uncertain
provider requests. The client requires a fresh zero counter and stable source,
identity and cap. Lost attestation fails the run and reports the attempt count as
unknown; it never substitutes HTTP request counts for provider attempts.

## Pricing reservations checked 2026-10-16

Official Standard prices per million tokens: Luna input **$0.10**, output
**$0.50**; mini input **$0.15**, output **$0.60**. Luna long-context input/output
are **$0.20/$0.75**; long-context cache writes are **$0.25**. Conservative common
reservation bounds for mini/Luna are `ASK_MAX_INPUT_USD_PER_MILLION=0.25` and
`ASK_MAX_OUTPUT_USD_PER_MILLION=0.75` for these Standard global-endpoint runs.
These are upper reservation rates, not measured charges. Fast/regional modes
require separate bounds. Existing per-request body and output limits still apply.

Sol Standard prices are **$2 input / $10 output** per million tokens; cache
writes are **$2.50**. Its profile requires minimum reservation rates of
`ASK_MAX_INPUT_USD_PER_MILLION=2.5` and
`ASK_MAX_OUTPUT_USD_PER_MILLION=10`. These bounds rely on the existing hard
**48,000-byte** serialized request limit plus **4,096** overhead allowance,
keeping input well below the **272,000-token** long-context threshold, and the
wrapper's Standard global-processing pin. If that bound or processing mode
changes, re-review prices; Sol long-context/cache-write bounds would be **5/15**.
The mini/Luna profiles retain minimum reservation rates **0.25/0.75**; do not
reuse those lower rates for Sol. All rates are USD per million tokens.

The approved **$1 daily / $5 monthly** allowances remain unchanged. The current
Sol upper reservation is $0.145240 per maximum-size SQL attempt; twelve such
attempts would reserve $1.742880. The daily ledger can therefore stop an isolated
run before its twelve-attempt cap. Do not raise or reset allowances to complete
a benchmark. A successful small sample still does not prove general quality.

Sources: [Luna model](https://developers.openai.com/api/docs/models/gpt-6-luna),
[mini model](https://developers.openai.com/api/docs/models/gpt-4o-mini),
[Sol model and pricing](https://developers.openai.com/api/docs/models/gpt-6-sol),
[GPT-6 compatibility](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-6-sol),
[pricing](https://developers.openai.com/api/docs/pricing),
[Chat Completions processing tiers](https://developers.openai.com/api/reference/python/resources/chat/subresources/completions/methods/create),
[evaluation guidance](https://developers.openai.com/api/docs/guides/evals).
The mini model page currently marks it deprecated; it remains an explicit
comparison profile here, not a recommendation or a serving-default change.

## Preceding-window input bounds

Check the input window separately from the requested output period. A daily
source restricted to thirty dates cannot provide thirty preceding observations
for any row. The model-only quality path carries proven bounds and short-window
counter lineage through simple date-preserving CTEs. It requests the existing
single repair only when a consumer actually requires an impossible full count;
unused counters and explicitly requested partial windows remain valid. Unknown
joins, renamed/expanded dates and grouped inputs do not acquire inferred bounds.
Keep the lookback in the source, calculate windows there, and filter output dates
afterward. Direct SQL admission remains unchanged.

## All-transaction share semantics

A zero-unclassified observation can hide the wrong denominator: a shielded share
of shielded plus transparent counts coincides with an all-transaction share only
in that special case. Review the generated expression as well as the observed
number. The model-only quality path diagnoses a source-proven shielded division
by classified counts when the question explicitly requests all transactions; it
uses the existing single repair. Classified-only research and manually submitted
SQL remain supported. Unknown lineage stays unresolved rather than acquiring
meaning from an output alias. The disposable PostgreSQL counterexample includes
nonzero unclassified counts and verifies that both legitimate shares differ.

## Run and interpret

From the checkout root, the default command validates fixed cases and compiles
reference/verification SQL with **zero network or provider calls**:

```sh
node server/api/scripts/evaluate-ask-research.js
```

Only after operator authorization and wrapper preparation, run the same selected
case IDs separately for each model, each in a fresh isolated wrapper process:

```sh
ASK_EVAL_API_URL=http://127.0.0.1:3007/v1/ask node server/api/scripts/evaluate-ask-research.js --allow-paid --profile=luna-candidate --max-provider-calls=12
```

Use `--profile=mini-observed` for the comparison or `--profile=sol-candidate`
for the stronger compatible candidate. `gpt-6-sol` supports Chat Completions,
strict Structured Outputs and reasoning `none`; `gpt-6.1-sol` does not support
`none` and is not this profile. The existing 1,500-token SQL output allowance
stays unchanged and still requires truncation/correctness testing. Default fixed IDs are
`annual_2025`, `shielded_baseline`, `fee_units`, `ambiguous_growth` and
`private_ownership`; additional eligible IDs are in the operator catalogue.
There are at most six selected cases per live run and twelve **actual**
provider attempts, including the bounded repairs. The client pauses thirty-one seconds between live cases to preserve existing
per-IP admission, without simulated identities or quota resets. The API retains
its existing single SQL repair. Research cases need room for selection, possible repair and
explanation and any calendar-format repair; insufficient remaining allowance
fails rather than overruns it.
A subset's acceptance applies only to that selected subset.

The research verifier re-executes candidate and reviewed reference SQL in one
admitted SELECT, so both use the same database snapshot. It rejects changed
initial tables, truncation, incomplete result coverage and missing measures. It
compares exact-decimal measures using each case's declared scalar, multiset,
composite-key or ordered contract independently of column aliases;
averages/percentages use two decimal places and ZEC uses eight. It checks
annual counts/share/partial rolling windows, a preceding-observation percentage
baseline, and ZEC/missing-fee semantics. Clarification and private-fact cases must
avoid a data query and provide a useful clarification or explicit unavailability.

Every selected case must pass both result and requested-finding checks for
`accepted=true`. Generic table receipts are reported as UX failures even when
SQL values are correct. Finding checks are bounded deterministic checks, not a
proof of every sentence, all SQL semantics, causal explanations, model
nondeterminism, historical completeness or public launch readiness. Review
unusual prose and repeat the fixed questions before choosing a serving model.

Reports contain fixed case IDs, pass/failure codes, counts, timing and attested
model/source identity. They do not retain questions, SQL, raw rows, capabilities,
provider bodies or credentials. Cases are reviewed operator fixtures; never build
an evaluation corpus from raw visitor questions or SQL. Record measured outcomes,
exact source commit/digest, and remaining failures separately before rollout.
A comparison with changed prompt/source digests cannot attribute gains solely
to the model.


## Private observations — 2026-10-16

No candidate was accepted or promoted. The normal private API still uses
`gpt-4o-mini`; local evaluation changes do not change the serving model.

- At source `3d26cbaf`, mini passed one of five fixed cases using eight actual
  provider attempts, with two receipt fallbacks. Luna completed the same five
  cases with two passes and seven attempts. Luna's earlier quota-interrupted
  run is separate evidence, not a model accuracy score.
- At source `57f39c8f`, Sol passed one of three research cases using six attempts:
  the baseline case passed, annual verification failed and the fee finding was
  missing. Prompt/source changes prevent attributing differences solely to the
  model. No generic receipt was returned in that run.
- One later, separately capped annual reproduction used two attempts and passed
  both the original and corrected graders. The original annual failure was not
  reproduced; its exact failed stage remains unknown. This retry does not turn
  the initial run into a pass or establish repeatability.
- Offline regression coverage found a verifier transport edge: PG BOOLEAN
  `t/f` output differs from `::text` `true/false`. Equivalence is now restricted
  to worker-typed boolean columns; text, true, false and null remain distinct.
  The annual reproduction had no boolean column, so that fix is not credited
  for its pass. Singular/plural fee wording is accepted while exact value and
  unit checks remain. New failure diagnostics contain only fixed stages,
  counts and differing column indices, never SQL, values or prose.

The owner approved raising private monthly reservations to **$5**. The **$1
daily** cap, existing counters, admission and per-run attempt caps were retained.
The temporary evaluation units are stopped. These operator-fixture observations
must not become a visitor prompt/SQL collection pipeline. Sanitized evidence is
recorded in the private wiki under `assets/ask-beta-foundations-2026-10-16/`.
