# Private explorer

[private.zecblock.com](https://private.zecblock.com) looks up any Zcash
transaction, block or transparent address with private information retrieval
(PIR): the browser encrypts the search, the server computes over every row of
the table, and only the browser can decrypt the answer.

| Part | Files |
|---|---|
| Static site (Vercel) | `ui/`, `web/explorer-worker.js`, built by `explorer-site.sh <pir-origin> <out-dir>` |
| Browser PIR client (WASM) and table builder (`zecblock-pir-fixture`) | `../pir-browser/` |
| Export queries | `explorer-tx.sql`, `explorer-blocks.sql`, `explorer-addresses*.sql` |
| Publishing | `explorer-rebuild-base.sh` (daily base tables), `explorer-publish-recent.sh` (blocks since the base, every 10 s) |
| Server timers and services | `systemd/` |

Each publication is signed with Ed25519; the browser checks the signature
against its pinned key and checks every row against the signed roots. After each
search the page shows what the browser sent: the requests, their sizes, and a
check that the search text appears in none of them.

## Experimental private transaction explorer

This standalone application on `new/private-tx-browser-prototype` renders the
existing ZecBlock transaction design over full recent confirmed mainnet records
retrieved with browser-side PIR. The default workflow runs the app, publisher and
query service locally. The legacy capture path uses bounded, unauthenticated **GET-only**
reads from `https://api.zecblock.com`. The optional [isolated Linux pilot](pilot/README.md)
uses a separate unprivileged runtime/data directory on the mainnet primary,
accessed only through an SSH loopback tunnel. It changes no production explorer
route, API/indexer code, database schema, DNS or public listener.

## Separate global-index experiment

[GLOBAL.md](GLOBAL.md) documents the implemented shared hash-row/layer lab
protocol, bounded read-only capture, native planning/preparation, isolated
loopback service and actual Chrome acceptance driver. It uses a separate
`global-2k-64k` profile with no public transaction catalogue. Its sparse
12-record / 71-layer publication is prepared and passes clean/adversarial Chrome
acceptance through the separate loopback/SSH demo at port 4320. Large lookups
currently take about 93–96 seconds. Independent cryptographic approval, full-history
backfill and live global publication remain open; existing pilot paths stay separate.

The separate optimized v2 demo is at `http://127.0.0.1:4324/`: 33 layers,
39.42 GB artifacts, 3.58–3.88-second browser lookups and 7.05-second initialization
in the reduced Chrome test. It uses a 48-GiB-high/52-GiB-max cache budget.
Same-4-GiB server evaluation is 39.5 s baseline versus 16.2 s cached.
Historical record bodies are estimated at 397 GB (approximate interval 301–492 GB),
excluding the final PIR layout and operational headroom. [Measured scope](GLOBAL.md).

## Retained archive and live publication

The archive implementation reuses the same pinned PIR engine and transaction
view. `json-context-zlib-v1` stores bounded compressed records, omits repeated
publication context, and reconstructs an equal duplicate verbose hex field in
the browser. The publication identity binds the codec and shared context; old
uncompressed publications remain readable. `plan-full` measures the actual
encoded allocation before preparation. On 219 real transactions the payload
allocation falls from 1,063 to 341 rows and the fixed lookup batch from 31 to 9
queries. Every physical table remains 16 MiB.

`pilot/publish-archive.mjs` commits immutable segments and one fsynced
`collection.json` head under a single Linux writer lock. Previously published
IDs cannot disappear without explicit canonical retirement. Restart progress
comes from the committed head; cleanup preserves its referenced generations.
Finalized segments retain only `database.bin`, `public.bin` and `manifest.json`;
the validated input DTO and test oracle are not permanent serving requirements.

`pilot/archive-source.mjs` runs bounded PostgreSQL16 extended-protocol read-only
capture and fresh canonical-header checks. `pilot/archive-watch.mjs` prioritizes
the indexed live tip, retains older published ranges, and records intervening
gaps explicitly. Canonical replacement retires affected observations before
replacement publication. Payload capacity/failure does not reuse old source
facts or disable independent fresh checks of healthy archives. Confirmation,
spent and optional enrichment observations remain tied to each segment snapshot.

For a collection, the browser downloads **every** setup before lookup and sends
the same complete query schedule to **every** published segment. Unselected
segments receive real encrypted zero-cover queries. All replies settle before
any decode; one invalid real or cover reply fails the complete lookup without
an automatic retry or ordinary API fallback. The query service uses a bounded
FIFO and one native evaluator at a time.

This mode currently admits at most **8 segments / 64 aggregate queries** and an
8 MiB public collection manifest. This is a deliberate resource bound, **not a
globally private full-history routing implementation**. Choosing just one
archive openly would reveal a cohort; the implementation does not make that
tradeoff. Genesis backfill and public release remain gated on scalable private
routing and historical/large-record qualification. The upgrade config initially
omits `backfillFrom`; it retains the earlier cohort and catches the live tip with
explicitly disclosed gaps. No all-history availability is implied.

The existing loopback service can select the archive runtime with
`PRIVATE_TX_COLLECTION_DIR` and `PRIVATE_TX_SOURCE_DIR`. The controlled main-box
upgrade and rollback are in `pilot/upgrade-archive.py`; the legacy commands below
continue to run the recent-publication workflow.

## Measure historical records without publishing

`pilot/measure-history.mjs` can run from a separate private scratch directory
against an explicit existing runtime directory and evaluator binary. It uses
the same bounded read-only PostgreSQL capture, full transaction/raw exporter,
fresh canonical-header checks and native `plan-full` codec. It never prepares
tables, changes a serving head or starts a service.

```sh
node pilot/measure-history.mjs --runtime /absolute/runtime/private-tx \
  --binary /absolute/zecblock-pir-fixture --start 419200 --end 419215 \
  --scratch /absolute/owned-private-scratch
```

The scratch directory must already exist, be owned by the process UID and have
mode 0700. The default raw-read interval is 200 ms; operators must also respect
the source API's shared rate limit. Each job admits at most 128 complete blocks,
2,048 transactions and eight planned segments. Output contains aggregate sizes,
type counts, canonical block identities and input hashes. Complete-block and
collection capacity failures remain explicit. The output is a bounded sample;
it makes no full-history size or availability claim. Temporary native planning
inputs are removed after each call.

## Run

Prerequisites: Rust **1.97.1**, `wasm32-unknown-unknown`, wasm-bindgen-cli
**0.2.127**, Python **3.12+**, Node **22+**. Google Chrome is needed for the
automated browser test. From the repository root:

```sh
npm --prefix prototype/private-tx ci --ignore-scripts
npm --prefix prototype/private-tx run build
npm --prefix prototype/private-tx run publish
npm --prefix prototype/private-tx start
```

Open **http://127.0.0.1:4318**. Choose a catalogue example or enter any transaction
ID in the publication's disclosed block range. The app has **Overview**, full
**Inputs / Outputs**, and **Raw** (decoded JSON / exact hex) tabs. References are
local text/copy controls, with external navigation disabled.

For continuous local refresh, run this in a second terminal:

```sh
npm --prefix prototype/private-tx run publish:watch
```

The independent publisher captures four complete recent blocks, ending two blocks
behind the observed indexed tip, every **180 seconds**. Override
`PRIVATE_TX_BLOCKS` (1–8), `PRIVATE_TX_DEPTH` (1–100), or
`PRIVATE_TX_REFRESH_SECONDS` (120–3600). It caps capture at 64 transactions and
fails the complete publication instead of silently omitting excess/invalid data.
Refresh is independent of browser searches. Stop each local process with Ctrl-C.

The server uses loopback only; `PRIVATE_TX_PORT` can select another local port.
Legacy native three-fixture Display preparation remains for regression tests;
the current React UI requires a full-record publication.

## What changed from the three-fixture proof

- `export-recent.mjs` captures complete indexed detail, resolved inputs/outputs,
  raw bytes/node-decoded JSON and a bundled historical-price observation for
  every transaction in the selected contiguous block range. It brackets block
  identities before/after capture and rejects reorg/incomplete/noncanonical data.
- `publish-recent.mjs` invokes native `prepare-full`, stages an immutable
  generation, then atomically advances `.local/current.json`. Failure retains
  the previous generation and publishes an explicit unavailable status. Disk
  retention keeps four recent generations; the query server retains three
  loaded generations for in-flight lookups.
- The WASM `FullPirBrowser` resolves IDs locally from a uniformly downloaded
  directory. It retrieves a fixed number of padded chunks for every record in
  the publication, checks publication/ID/ordinal/length/digest bindings and
  recomputes the raw transaction ID before releasing the complete result.
- The private React adapter injects decrypted data into the actual existing
  transaction presentation components. It reuses the same CSS design tokens,
  Geist fonts, cards, flow, badges, tabs and input/output components. The build
  rejects ordinary lookup modules and duplicate React runtimes. Production
  components are unchanged.

The full table has **2,048 rows × 8,192 bytes = 16,777,216 bytes**. Upstream P8
query uploads are **20,992 bytes** and replies **10,240 bytes** per chunk. Setup
is **45,056 bytes**. Every record uses the publication's maximum chunk count;
smaller records receive validated zero padding. The initial 15-record capture
used nine queries per lookup: **188,928 upload / 92,160 reply bytes**, excluding
HTTP, manifest, setup and application downloads. This is a bounded prototype
layout/local envelope, not the production wallet-PIR wire contract.

Exact upstream sources remain wallet-libraries
`a7c842fd4f16790ed6739346f44557a97065d242` and ipir-sp
`5ea080a3281a01c5459f585e0a1bbbde50ec2bd2`. Bootstrap verifies archive checksums
and source-file equality, with no upstream cryptographic changes. Cargo/npm
lockfiles pin dependencies. Generated dependency sources, Rust/WASM artifacts,
publications and test reports are ignored. `CARGO_HOME` may reuse a writable
cache; otherwise build uses `prototype/pir-browser/.cargo-home`.

## Authority, units and freshness

The API's authoritative `*Zat` fields and input/output amounts remain exact decimal
strings or explicit nulls in the recovered record. The original full detail/raw
objects are retained; only `detail.confirmations` is normalized to the captured
indexed tip, with the original API observation preserved in `record.source`.
UI block height is normalized from API BIGINT string to a safe integer.

The capture is **independent HTTP observations over a recorded interval**, not an
atomic PostgreSQL snapshot or independent chain validation. Block height/hash
membership is checked before/after capture. Confirmations, spent flags and
enrichments describe the captured state. A page pins its initial publication;
**Refresh publication** explicitly reloads metadata. There is no automatic metadata
polling or lookup retry. An unavailable publisher or publication older than ten
minutes is warned at initialization. The snapshot time and pinned-page notice
remain visible. Old/unknown generations are rejected, with no ordinary fallback.

Historical USD estimates use the bundled observation and disclose its actual
date when it is a nearest-date fallback. Bridge facts are retained if the source
supplied them; external icons/navigation are excluded. Privacy-risk graphs,
live address labels, mempool tracking and full-history search are unavailable.
An ID outside the catalogue means **outside this publication**, not missing from
Zcash. The browser never contacts the source API to resolve a search.

## Verify

```sh
npm --prefix prototype/private-tx test
npm --prefix prototype/private-tx run typecheck
npm --prefix prototype/private-tx run build:ui
cargo test --locked --release --workspace --manifest-path prototype/pir-browser/Cargo.toml
npm --prefix prototype/private-tx run test:browser
```

The real browser test reads the active captured source as its oracle, starts an
ephemeral local server, and blocks non-local traffic. It checks full record parity
for Ironwood/mixed, many-input, many-output and coinbase records; all three tabs;
exact raw hex/JSON; uniform randomized encrypted queries; request/header/body
selector absence; invalid/outside input; outage/malformed-response rejection;
recovery; storage and desktop/mobile layout. If the current window lacks those
representative types, retain an earlier acceptance publication or capture a larger
bounded range before running that coverage-specific test.

Reports/screenshots are in ignored `test-results/`. The server serves only exact
allowlisted app/setup/query paths, never source records, expected results or
database files. Generic static HTML has one H1, `noindex`, no public canonical
identity or sitemap entry. CSP restricts scripts, fonts and connections to self.

## Privacy limits

The database contains public plaintext chain facts; **query selection and answers**
use actual upstream PIR. Secret query state remains in WASM. This is not an IP
anonymity service, security audit, production capacity qualification or complete
private explorer. The service sees connection metadata, query sizes/counts and
timing. The uniformly downloaded directory also exposes the public coverage and
record commitments. Browser code delivery remains trusted.

Record digests bind the retrieved publication, not its truth. Recomputing a raw
txid verifies those raw bytes' identity; it does not authenticate block inclusion,
resolved prevouts, fees, spent status, enrichments or publisher completeness.
These remain explicit source trust assumptions. There is no Tor/OHTTP transport,
independently trusted installed client or claim of production resilience here.

## Compatibility and the next indexing contract

The pinned upstream PIR encryption/evaluation core is reused. The full transaction
codec, public txid-to-row catalogue, fixed table and `/pir/query` transport are
custom. This is not a Vizor-compatible Transparent `/v2` provider or its script
receive/spend directory/history-page indexes. The upstream txid Display product
also has different, more limited fields than this complete explorer record.
Matching the engine does not establish matching indexes, wallet interoperability
or application-level privacy protections.

The current importer validates transaction-only records and raw txids; blocks and
addresses cannot simply be inserted into it. The current 2,048-row table and
publication-wide maximum chunk count are bounded feasibility geometry. Retaining
more rolling copies does not create an arbitrary-history private lookup service.

Before a substantial backfill, define a durable source journal with canonical
height/hash checkpoints, resumable bounded read-only ingestion, immutable archive
segments and a reorg-aware live tail. Separate immutable transaction/raw facts
from lifecycle/spent/enrichment observations and generic tip context. Full
snapshots should not be rewritten for every new confirmation. The canonical wiki
records this as proposed work, not a deployed historical indexer.

Reuse ingestion, publication, PIR evaluation and transport across separately
versioned record products:

- Transaction: private txid directory/locator and privately retrieved complete
  payload pages, plus versioned lifecycle/spent overlays.
- Block: height/hash directory, block metadata and padded transaction-list pages.
- Transparent address: normalized supported locking-script directory, resolved
  receive/spend event pages, exact amounts and explicit historical coverage.

Shielded address histories/balances cannot be derived from public chain facts
alone; any wallet-side viewing-key recovery is a separate client protocol. Related
transaction/page lookups must remain private. A private directory followed by a
plaintext locator URL would reveal the selection. Domain routing, page counts,
padding/cover policy and failure/retry transcripts need separate acceptance.

The full-record client admits **1–64 padded chunks**. It generates the complete
fresh query batch before dispatch. The worker invokes every fixed-path fetch
without awaiting reply content, collects all transport slots under one **30-second
deadline**, and only then decrypts/validates. Each accepted reply is exactly
**10,240 bytes**; the maximum retained reply payload is **655,360 bytes**. Content,
framing and transport failures produce one generic error after collection, with
no partial result, automatic retry, metadata refresh, fallback or related fetch.
Publisher admission rejects larger batches before changing the pointer; it keeps
the previous publication instead of dropping oversized transactions.

This closes the tested automatic selective-reply reaction within a **fixed accepted
publication and trusted client**. It does not promise constant physical timing,
that every issued HTTP call reaches the server before a deadline, or privacy of
manual user reactions. Browser connection queues and network stalls remain
observable. Targeted/equivocating publications, malicious delivered JS/WASM,
publisher completeness, IP anonymity and cryptographic-profile qualification are
separate boundaries. Reusing the engine alone does not establish those protections.
See the pinned
[package contracts](https://github.com/zakura-core/wallet-libraries/blob/a7c842fd4f16790ed6739346f44557a97065d242/docs/pir-packages.md)
and [reaction-leak plan](https://github.com/zakura-core/wallet-libraries/blob/a7c842fd4f16790ed6739346f44557a97065d242/docs/pir-reaction-leak-closure.md).

The dedicated VM and actual native/WASM/Chrome regressions compare successful and
selectively poisoned first/middle/last rows for targeted and unaffected records.
They retain an old-client negative control so the former early-stop leak must be
reproduced before the fixed transcripts are accepted. Run the actual browser
matrix with a frozen publication (see the test's required environment variables):

```sh
node --test prototype/private-tx/test/reply-privacy.test.mjs
PRIVATE_TX_REPLY_CLEAN_DIR=/absolute/path/to/frozen/publication \
node prototype/private-tx/test/reply-privacy-browser.mjs
```
