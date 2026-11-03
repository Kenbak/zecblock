# Experimental global transaction index

This is a separate, bounded protocol implemented in `prototype/pir-browser` and
`prototype/private-tx`. It maps every captured transaction into one shared hash
row, splits those rows across a fixed public set of layers, and retrieves the
same row from every layer with one encrypted query. The public manifest contains
no transaction-ID catalogue or selected partition locator.

The implementation is experimental and uncertified. The capture and native plan
described below exist; they do not establish a completed preparation, running
global service, successful Chrome acceptance, independent cryptographic approval
or full-history availability. Existing recent/collection pilot protocols and
their serving heads remain separate.

## Record and row layout

The source schema is `zecblock-private-global-source-v1`, with `network:mainnet`
and 1–2,048 full records. Each record uses `zecblock-private-tx-record-v1` and
retains its own `snapshot`, `coverage`, `txid`, `detail`, `raw`, `price` and
`source`. The source carries no synthetic shared snapshot. Native validation
checks each record against its own observation context and recomputes the raw
transaction ID. Exact decimal zatoshi strings, explicit nulls, raw hex and
node-decoded JSON survive recovery; these are publisher-supplied observations.

For a displayed 64-character hexadecimal txid, the row is:

```text
digest = SHA256(UTF8("ZBGL-KEY-v1\0") || hex_decode(displayed_txid))
row = little_endian_u64(digest[0:8]) mod 2048
```

The txid bytes are in display order, without the reversal used by the wire Txid
type. All records hashing to one row form a sorted collision bucket. The entire
bucket is encoded; records are never silently discarded to fit. A valid ID can
be absent from an empty row or from a populated collision bucket. That means
absent from this publication, rather than absent from Zcash.

`full-envelope-zlib-v1` compresses the complete canonical record. An equal
`raw.decoded.hex` duplicate is omitted only when it equals `raw.hex`, then
restored exactly. Decompression bounds both the stored representation and the
complete reconstructed envelope. A restored record may be at most **33,554,432
bytes (32 MiB)**; its encoded representation may be at most **8,322,944 bytes**.

The locally derived `global-2k-64k` profile uses table `txdirectory`:

- Each layer has **2,048 rows × 65,536 bytes = 134,217,728 bytes (128 MiB)**.
- A row reserves **512 bytes** for authentication and framing, leaving **65,024
  bytes** of bucket payload. The layer count is the maximum bucket length divided
  by 65,024, rounded up, with a minimum of one and maximum of **128 layers**.
- A complete framed bucket may be at most **8,323,072 bytes** across 128 layers.
  Hash collisions share this budget; the 2,048-record source limit does not
  guarantee that a particular source fits.
- Each row binds the pre-artifact context, row index, layer index/count, complete
  bucket length/digest and zero padding. Its fixed header holds an 11-level
  Merkle witness. The leaf includes the padded payload; the witness is excluded
  from its own leaf hash. Empty rows and layers beyond a bucket's payload still
  authenticate.

`contextId` hashes canonical manifest context before artifact commitments.
`publicationId` hashes the final manifest excluding only `publicationId`, and
therefore binds ordered Merkle roots, database/setup/prepared-file hashes and
any optional noise-certificate field. The native `sourceDigest` hashes canonical
source JSON; the capture receipt's `sourceRawFileSha256` hashes the exact written
JSON plus its final newline. These digests have different meanings.

## Fixed lookup transcript

`web/global-worker.js` downloads the generic manifest and **every** ordered public
setup before accepting a lookup. WASM derives the allowed profile locally,
checks manifest identities and checks each setup hash. The manifest exposes
aggregate source/observation summaries, publication identity and layer costs,
but no txid catalogue.

For each valid lookup, `GlobalPirBrowser` derives the row locally and creates a
fresh secret and **one 20,992-byte encrypted query**. The browser sends one POST
to `/pir/query`, with `Content-Type: application/octet-stream` and the public
`X-PIR-Publication` identity. The native evaluator parses that upload once and
evaluates the same ciphertext against every layer in public index order. It
does not receive the selected txid or a selected archive/layer path.

Each layer contributes **81,920 reply bytes**. The HTTP response contains the
complete `layerCount × 81,920` bundle. The worker consumes and length-checks the
whole bundle before decoding. WASM attempts decode/authentication for every
layer even when an earlier layer fails. Only after all rows authenticate does it
assemble/check the bucket, test membership, decompress the selected envelope
and release a complete result. A successful result adds `found:true` and the
global `publicationId` to the original record; it does not rewrite that record
to the newest observation context.

Absence and verification failure produce no partial record, automatic retry,
ordinary transaction-API fallback, related-data fetch or automatic manifest
refresh. The UI's Refresh publication action is manual. The request deadline is
**900,000 ms**; initialization has a **120,000 ms** public-setup deadline. A
wallet-style `/#tx=<id>` link is interpreted after setup and stripped with
`history.replaceState`. The fragment is browser state, readable by delivered
scripts, and never an HTTP selector. Manual entry follows the same worker path.

The shared transaction UI renders Overview, Inputs / Outputs and Raw from the
recovered envelope. Raw JSON/hex and explicit local JSON export retain the
captured facts. Confirmation counts, spent state and optional price/enrichment
values describe the original record snapshot, not current chain state. Public
detail links are inert in this private app.

## Artifacts and current input plan

Each immutable publication has `manifest.json`, canonical `anchors.json`, and
`layers/000/`, `layers/001/`, etc. Each layer has `database.bin`, `public.bin`
and two prepared native files, `prepared-00.bin` and `prepared-01.bin`. Each
prepared file holds 16 of the profile's 32 blocks. Preparation builds one hint
block at a time and one layer at a time, rather than preprocessing all layers
concurrently. Serving authenticates every layer on admission and reload, keeps
one layer's database/prepared mappings resident at a time, and processes the
entire layer list for every accepted query.

Per layer, the plan budgets **134,217,728 database bytes**, **360,448 public setup
bytes** and **1,074,791,712 prepared bytes** at the planned/maximum prepared
representation, for **1,209,369,888 planned artifact bytes**. Prepared minimum
size is **537,920,800 bytes per layer**; actual finalized sizes must be taken
from their manifest receipts. Manifest, anchors, capture inputs, staging
overhead, filesystem allocation, backups and application/WASM assets are
excluded from the artifact formula. The planner reports a **4,294,967,296-byte
process design budget**; it does not itself install an OS memory limit or prove
measured peak RSS.

The current read-only lab input captured complete blocks **0, 1,800,003 and
2,000,007**, containing **12 records** and three observation contexts. The source
file is **24,086,221 bytes**. Its two largest complete record envelopes are
**12,092,877** and **11,508,879 JSON bytes**, including raw transactions of
**1,997,331** and **1,905,925 bytes** respectively. These exceed the older pilot's
8 MiB restored-record bound. The capture receipt records completion at
`2026-11-03T03:44:02.817Z`; the user's local date was November 2.

The actual native `plan-global` result for that frozen input reports:

- **71 layers**, **4,585,664 maximum bucket bytes**, **9,094,129 compressed record
  bytes**, and **9,095,185 framed bucket bytes** in total.
- **9,529,458,688 database bytes**, **76,310,211,552 planned prepared bytes**,
  **25,591,808 public setup bytes**, and **85,865,262,048 planned artifact bytes**.
- **20,992 upload bytes** and **5,816,320 reply bytes per lookup**, excluding
  HTTP/application overhead. Initial public setup download is **25,591,808 bytes**.
- Four canonical anchors: the three captured block identities and the captured
  observation-tip identity. Declared height bounds **0–2,000,007** do not imply
  coverage of the intervening blocks; `coverageComplete` remains false.

These are input/plan measurements. They are not final artifact size, preparation
duration, query latency, browser memory, native peak RSS or throughput evidence.
At the admitted 128-layer maximum, the reply is **10,485,760 bytes** and public
setup is **46,137,344 bytes**; upload remains 20,992 bytes.

## Capture, plan and prepare

Run capture only on the explicitly selected source host, whose existing runtime
supports the bounded primary PostgreSQL reader and fixed loopback raw endpoint.
It opens per-range repeatable-read READ ONLY snapshots and separately obtains
raw data from `http://127.0.0.1:3001/v1/transactions/<txid>/verbose`. There is no
endpoint override or public-source fallback. Historical price is unavailable in
this indexed-only capture. Fresh canonical headers are read independently after
all raw observations and must still contain every captured block and snapshot
anchor.

The helper admits at most **8 ranges**, **16 complete blocks per range**, **128
blocks total**, **2,048 records**, **128 MiB source JSON**, and **32 MiB per raw
HTTP response**. Raw reads are sequential, paced by at least **200 ms**, with a
**20-second** per-response timeout and bounded rate-limit pauses. The whole
capture has a **10-minute** deadline. Existing output paths are refused before
source reads; output parents must be owned ordinary directories with mode 0700.
Capture is all-or-nothing and produces an input plus receipts, never a serving
head.

From the repository root, after the normal private-prototype dependencies,
native binary, WASM and UI have been built as described in [README.md](README.md):

```sh
PIR_RUNTIME="/absolute/existing/runtime/prototype/private-tx"
PIR_NATIVE="/absolute/zecblock-pir-fixture"
PIR_LAB="/absolute/owned/private/new-global-lab"
mkdir -m 700 "$PIR_LAB"

node prototype/private-tx/pilot/capture-global.mjs \
  --runtime "$PIR_RUNTIME" \
  --range 0:0 --range 1800003:1800003 --range 2000007:2000007 \
  --output "$PIR_LAB/source.json" \
  --receipt "$PIR_LAB/capture-receipt.json" \
  --anchors "$PIR_LAB/capture-anchors.json"

"$PIR_NATIVE" plan-global "$PIR_LAB/source.json" > "$PIR_LAB/plan.json"
```

Inspect the plan and allocate its disk/runtime budget before preparation.
`plan-global` validates/compresses the actual source and reports costs without
performing PIR preprocessing. Preparation requires a new destination, builds a
private random staging directory, syncs the artifacts and atomically finalizes
without replacing an existing directory:

```sh
"$PIR_NATIVE" prepare-global "$PIR_LAB/source.json" "$PIR_LAB/publication"
```

The complete source is unnecessary for native serving once immutable artifacts
have been prepared. Keep the frozen source separately as a private acceptance
oracle if running the Chrome test. `anchors.json` generated in the publication
is canonical native JSON bound by the manifest; the capture's separately
formatted `capture-anchors.json` is a receipt and must not replace it.

## Canonical guard and isolated HTTP service

The CLI service requires a fresh guard bound to the publication ID and canonical
anchor digest/count. `pilot/global-source-watch.mjs` checks all those anchors
against fresh primary canonical headers every **2 seconds**. A mismatch or read
failure writes an unavailable guard. The server accepts ready guards at most
**10 seconds** old and rechecks before and after evaluation. This rejects stale
or noncanonical observation anchors; it does not update immutable records or
backfill replacements.

In a terminal on that same source-capable lab host:

```sh
PRIVATE_TX_GLOBAL_DIR="$PIR_LAB/publication" \
PRIVATE_TX_GLOBAL_GUARD="$PIR_LAB/guard.json" \
node prototype/private-tx/pilot/global-source-watch.mjs
```

In another terminal, with the same explicit `PIR_LAB` and `PIR_NATIVE` values:

```sh
PRIVATE_TX_GLOBAL_DIR="$PIR_LAB/publication" \
PRIVATE_TX_GLOBAL_GUARD="$PIR_LAB/guard.json" \
PRIVATE_TX_EVALUATOR="$PIR_NATIVE" \
PRIVATE_TX_PORT=4320 \
node prototype/private-tx/global-server.mjs
```

The server binds only `127.0.0.1`, starts only the explicitly selected native
`serve-global` evaluator, and waits for artifact admission before listening.
The native child uses `RAYON_NUM_THREADS=2`; its JSONL transport carries only
bounded encrypted request/reply frames. The loopback listener checks Host,
Origin and fetch-site, rejects URL queries/fragments, and serves exact
app/WASM/font, manifest, ordered setup, query, health and robots paths. Source,
plaintext databases and prepared files have no HTTP route. CSP restricts scripts,
workers, connections and fonts to self; responses are `no-store`, `no-referrer`
and `noindex, nofollow, noarchive`. No production DNS, public listener, schema,
API/indexer or installed pilot service changes are required by this lab path.

## Actual Chrome acceptance

`test/global-browser.mjs` connects to an already-running immutable loopback
service; it does not prepare artifacts, control services or contact source APIs.
Its Node preflight checks the manifest identity, all setup hashes and serving
asset equality with the selected local worktree. Those operator reads are
reported separately from actual browser/worker requests.

With Google Chrome installed, from the repository root:

```sh
PRIVATE_TX_GLOBAL_ORIGIN="http://127.0.0.1:4320" \
PRIVATE_TX_GLOBAL_SOURCE="$PIR_LAB/source.json" \
PRIVATE_TX_GLOBAL_PUBLICATION="<exact immutable publicationId>" \
PRIVATE_TX_GLOBAL_OUTPUT="$PIR_LAB/browser-clean" \
node prototype/private-tx/test/global-browser.mjs
```

The default clean cases select the two largest envelopes, the smallest/genesis
record, repeat the largest record, probe valid absence in both empty and occupied
hash rows, and reject malformed input locally. The first case exercises fragment
selection; subsequent cases use manual entry. `PRIVATE_TX_GLOBAL_CASES` accepts
a comma-separated subset: `large1,large2,small,repeat,absent,occupied-absent,invalid`.

The driver deep-compares the complete returned envelope with the frozen source,
checks exact Raw JSON/hex and local export parity, preserves original snapshots
and null fees, checks fixed request/reply geometry, and tests no partial UI
output. It observes worker traffic through Playwright and dedicated-worker CDP,
checks selector bytes when upload bytes are available, compares repeated
ciphertext hashes when observable, and records observation gaps explicitly.
Missing DevTools bodies never become a claimed observed-byte or freshness pass.
It also checks CSP, origin/path/header restrictions, no cookies/storage,
analytics/external traffic or WebSockets, no typing requests, page overflow and
desktop/500px/390px Overview screenshots. After each absence/failure it observes
**35 seconds with zero additional requests**. Each lookup has a 15-minute limit;
the whole driver has a 45-minute deadline and closes Chrome in `finally`.

For independently prepared offline adversarial variants, set
`PRIVATE_TX_GLOBAL_MODE=poison-selection` or `poison-unused` and pin that
variant's new publication ID. Both modes expect the genesis/small lookup to
fail content authentication and the unaffected largest record to succeed, with
the same complete bundle shape and a quiet failure window. The native
`prepare-global-poison-test` command is an explicit offline test facility:
it rebuilds a changed database's consistent PIR setup while deliberately
retaining the original Merkle commitment. It is never an HTTP operation or
normal publication path. The browser driver does not generate poison variants
or restart a server.

Reports store counts, hashes, metadata, explicit gaps and screenshots; they do
not retain encrypted bodies, client secrets or full decrypted envelopes. A
passing run establishes only the cases and observations in its own receipt.
This document does not assert that such a run has completed.

## Remaining gates

The shared-query use across multiple database layers, chosen profile and
publisher-controlled data weights have **no noise/correctness certificate or
independent cryptographic approval** here. Manifest/Merkle validation protects
the selected publication's consistency; a malicious publisher can choose a
different manifest or false facts. It does not prove block inclusion, resolved
prevouts, exact fees, enrichment truth or source completeness. Decoding all
layers before feedback addresses one application failure channel; it does not
prove constant-time execution or eliminate every timing/resource side channel.

The protocol still has a **2,048-record / 128-layer** ceiling, collision-bucket
limits and large disk/setup/reply costs. The sparse three-block input is not a
full-history sample or capacity qualification. There is no full-history
backfill, durable resumable source journal, live publication refresh, automatic
canonical replacement/reorg recovery or production deployment in this path.
Future work must qualify ingestion, resource/throughput limits, overload and
failure behavior, integrity/privacy composition and operational recovery before
expanding those claims.

The browser trusts delivered application/WASM code. The service can observe IP,
timing, public publication identity and sizes; there is no Tor/OHTTP transport
or independently trusted installed client. This is a custom complete-transaction
protocol using the pinned upstream PIR engine, not a Vizor Transparent `/v2`
wallet provider or an established wallet-interoperability contract.
