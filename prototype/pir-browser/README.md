# Pinned upstream PIR browser fixture

This directory binds the actual upstream native P8 PIR client to WebAssembly.
It supports the original three-coinbase Display fixture and a bounded full
confirmed-transaction snapshot imported from an explicit source file. It is a
local feasibility prototype, not a public ZecBlock service or a qualified
production anonymity set. It does not implement the production wallet-pir HTTP
envelope, private address history or mempool retrieval.

`bootstrap.py` downloads and verifies wallet-libraries
`a7c842fd4f16790ed6739346f44557a97065d242` and ipir-sp
`5ea080a3281a01c5459f585e0a1bbbde50ec2bd2`, including pinned archive checksums
and source-file comparisons. No upstream source adaptation or cryptographic
replacement is used. `Cargo.lock` pins the remaining dependencies. The build
requires Rust 1.97.1 with `wasm32-unknown-unknown`, Python 3.12 or newer, and
`wasm-bindgen-cli` 0.2.127.

From the repository root:

```sh
prototype/pir-browser/build.sh
```

The build downloads source into ignored `.upstream/`, uses ignored
`.cargo-home/` by default (`CARGO_HOME` may override it), builds the native
fixture service and browser WASM, generates ignored `pkg/`, and prepares the
local fixture in `prototype/private-tx/.local/fixture`. It makes no production
requests and starts no public service. Build downloads require network access.

## Retrieval boundary

The browser constructs the pinned upstream `TableProfile` for a fixture-only
2,048-row, 2,048-byte-per-row `txdirectory`. Upstream `Tag::of` and
`placement_row` derive the selected row locally from the internal-order txid;
the user enters the conventional display-order txid. The client verifies the
whole derived native scheme and the published setup digest against its local
manifest before generating a query.

`PirBrowser.make_query(txid)` uses upstream `TableClientExt::prepare`: a fresh
secret, packing key, selection noise and dithered rounding are generated using
browser cryptographic entropy. Only the upstream binary key/selection upload
leaves WASM. A single pending secret stays in WASM until decode or cancellation.
`decode_response` uses upstream packed-response decryption followed by the
upstream canonical Display row/placement/tag validation. Results expose exact
zatoshi integers as decimal strings. This validation does not authenticate the
publisher's chain data or prove completeness.

The native helper parses the existing raw transaction fixtures with upstream
`zakura-transaction-wire`, checks their txids and coinbase status, derives the
limited Display entries and prepares the published masks. For each encrypted
request, upstream query parsing, a full ring-valued table scan and upstream
packing produce the response. The evaluator never receives a plaintext txid
or row selector. Every admitted query and response has the same fixed size.

The generated `expected.json` is a local test oracle and is not a public
retrieval resource. Manifest catalogue heights/labels are uniformly downloaded
fixture context; the Display codec does not contain or authenticate heights.
Only the first two transparent outputs fit in the upstream Display codec;
count/omission flags preserve that limitation.

## Full confirmed snapshot mode

After building, a separate read-only exporter can supply a source file:

```sh
prototype/pir-browser/target/release/zecblock-pir-fixture \
  prepare-full /absolute/path/source.json /absolute/path/publication
```

The source schema is `zecblock-private-tx-source-v1`, with `network: mainnet`,
`snapshot: {height, hash, publishedAt}`, declared `coverage: {startHeight,
endHeight, ...}`, and `records: [{txid, detail, raw: {hex, decoded}, price?,
source?}]`. `detail` preserves the full indexed API response and exact zatoshi
string/null fields. The exporter, its capture/recheck policy and its update
schedule are separate from this Rust library. Publishing never depends on
which transaction a browser selects.

`prepare-full` now defaults to the publication-bound `json-context-zlib-v1`
codec. It removes repeated shared context, conditionally deduplicates equal raw
hex fields and compresses each record, with bounded exact decompression before
validation. `plan-full <source.json>` reports actual encoded allocation and
capacity without preparing a PIR table. `prepare-full-legacy` retains the older
uncompressed compact encoding. Add `--debug-oracle` to `prepare-full` only when
an offline test needs `expected.json`; normal full preparation omits that copy.
The serving evaluator never reads source DTOs or test oracles. The archive
publisher removes those build inputs after checking the prepared artifacts.

`prepare-full` verifies confirmed/canonical state, declared coverage and raw
transaction IDs, then emits a `zecblock-private-tx-full-v1` publication. The
fixed profile has 2,048 rows of 8,192 bytes. Each row has a 128-byte header
binding the publication ID, internal txid, ordinal, record chunk count, payload
length, record length and SHA-256 commitment. The remaining 8,064 bytes hold
record content or canonical zero padding. The largest serialized record sets
the publication's query count. Compact publications allocate each record's actual
rows and reserve one zero cover row; shorter records still make the same number
of encrypted queries by selecting that cover row for their remaining slots.
Decrypted cover rows must be all zero. Legacy publications retain their original
uniform row padding and unchanged identities. Publications exceeding table capacity fail
instead of truncating records. Both stored databases contain public plaintext
chain facts; PIR encrypts the selection and returned answer.

The uniform public catalogue supplies each record's row allocation, length and
digest. Publication identity commits to the layout, snapshot, coverage and
catalogue. `FullPirBrowser` verifies that identity, the pinned native scheme and
setup digest. It assembles all chunks locally, checks every header, canonical
padding, whole-record digest, JSON encoding, confirmed range and raw txid before
returning the result. A failure discards partial state. An unknown txid is
outside that publication, not proof that it is missing from the chain.

Full-mode exports are `FullPirBrowser(manifestJson, publicSetupBytes)`,
`begin_query(txid) -> chunkCount`, `make_chunk_query(index) -> bytes`,
`decode_chunk_response(bytes) -> string | undefined` and `cancel_query()`.
Full mode admits **1–64 chunks**. Generate **all** chunk queries before decoding
any response; interleaved generation/decoding is intentionally rejected. The host
must dispatch its fixed plan and collect every transport slot before calling the
decoder, so private content cannot decide later requests. The client retains a
fresh upstream secret per query and consumes replies in ordinal order. Wrong
sequence, failed decode and cancellation discard partial content and remaining
secrets. Host transport/scheduling remains part of this security contract.
Only the final response returns JSON. It preserves `detail`, `raw`, optional
`price`/`source`, snapshot and coverage, and adds `found: true`/`publicationId`.
Chunk ordinals and selected identifiers stay local; transport may name the
public publication ID to pin the generation.

Raw txid recomputation verifies byte identity, not block inclusion or truth of
prevout-resolved fees, spent state, indexer enrichment or complete coverage.
Those fields retain the captured publisher/source trust and as-of semantics.
There is no wall-clock freshness assertion in decoding. Exact source snapshots,
generation retention, safe refresh and no-fallback behavior require the host
application's own checks. Full mode uses 20,992-byte queries, 10,240-byte replies
per chunk, 45,056-byte setup and a 16 MiB plaintext table; these sizes are not a
production capacity qualification.

`examples/reply-attack-fixture.rs` is an **offline test-only** repacker: it corrupts
one selected chunk header before rebuilding setup, preserving the original
catalogue/record commitments and publication identity. An affected transaction
must fail while an unaffected transaction still succeeds under that same setup.
This tests selective failures rather than a generic bad packet. The helper is not
part of the serving binary, deployment bundle or production CLI.

## Interfaces and checks

WASM exports `PirBrowser(manifestJson, publicSetupBytes)`,
`make_query(txid)`, `decode_response(bytes)` and `cancel_query()`.

The native binary accepts `prepare <fixture-dir>`,
`prepare-full <source.json> <publication-dir>` and `serve <publication-dir>`.
The latter reads one JSON line `{id,query:<base64>}` per request and returns
`{id,response:<base64>}` or a generic error. It writes diagnostics only to
stderr. This framing is a local harness around the pinned native primitives,
not a claim of production endpoint compatibility.

```sh
CARGO_HOME=/path/to/writable/cache cargo test \
  --manifest-path prototype/pir-browser/Cargo.toml --release \
  -p zecblock-pir-fixture -p zecblock-pir-browser
```

Native known-answer checks cover the original fixture records, actual padded
multi-chunk PIR, row-header/padding tampering and invalid source records.
Browser end-to-end tests live with the localhost application. No test
here establishes a cryptographic audit, production dataset capacity, IP
anonymity, or protection from compromised frontend delivery.
