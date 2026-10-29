# Pinned upstream PIR browser fixture

This directory binds the actual upstream native P8 PIR client to WebAssembly.
It is a local feasibility prototype over three existing public mainnet
coinbase fixtures, not a live ZecBlock lookup service or a production anonymity
set. It does not implement the production wallet-pir HTTP envelope, publication
discovery, private address history, or full transaction display.

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

## Interfaces and checks

WASM exports `PirBrowser(manifestJson, publicSetupBytes)`,
`make_query(txid)`, `decode_response(bytes)` and `cancel_query()`.

The native binary accepts `prepare <fixture-dir>` and `serve <fixture-dir>`.
The latter reads one JSON line `{id,query:<base64>}` per request and returns
`{id,response:<base64>}` or a generic error. It writes diagnostics only to
stderr. This framing is a local harness around the pinned native primitives,
not a claim of production endpoint compatibility.

```sh
CARGO_HOME=/path/to/writable/cache cargo test \
  --manifest-path prototype/pir-browser/Cargo.toml --release \
  -p zecblock-pir-fixture -p zecblock-pir-browser
```

Native known-answer checks cover all three fixture records and malformed query
length. Browser end-to-end tests live with the localhost application. No test
here establishes a cryptographic audit, production dataset capacity, IP
anonymity, or protection from compromised frontend delivery.
