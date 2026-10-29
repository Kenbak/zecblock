# Experimental private transaction explorer

This standalone application on `new/private-tx-browser-prototype` renders the
existing ZecBlock transaction design over full recent confirmed mainnet records
retrieved with browser-side PIR. The default workflow runs the app, publisher and
query service locally. Source capture uses bounded, unauthenticated **GET-only**
reads from `https://api.zecblock.com`. The optional [isolated Linux pilot](pilot/README.md)
uses a separate unprivileged runtime/data directory on the mainnet primary,
accessed only through an SSH loopback tunnel. It changes no production explorer
route, API/indexer code, database schema, DNS or public listener.

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
enrichments describe the captured state. Browser metadata refresh runs every
30 seconds, outside active lookups; a new publication clears the prior result.
An unavailable publisher or publication older than ten minutes is visibly warned.
Old/unknown generations are rejected, with no ordinary lookup fallback.

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
