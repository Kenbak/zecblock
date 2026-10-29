# Local private transaction lookup

A standalone localhost prototype on `new/private-tx-browser-prototype`. It adds
no Next.js route, production API, database migration, DNS or deployment.

The browser creates a real upstream P8/ReinspiRING PIR query in WebAssembly. A
native local evaluator scans the fixture table and packs an encrypted answer.
The browser retains the query secret, decodes the answer and renders the
upstream transaction Display summary. The evaluator receives no plaintext
transaction ID or selected row.

## Run locally

Prerequisites: Rust with `wasm32-unknown-unknown`, `wasm-bindgen-cli` **0.2.127**,
Python **3.12+**, and Node **22+**. Build downloads public source archives and
Rust dependencies. Running the prototype needs no external network service.

From the repository root:

```sh
bash prototype/pir-browser/build.sh
node prototype/private-tx/server.mjs
```

Open **http://127.0.0.1:4318**. Select a public fixture, then choose **Look up
privately**. The address bar stays generic. The server always binds to loopback
and rejects other Host/Origin values. Stop it with Ctrl-C.

`PRIVATE_TX_PORT` selects another loopback port. `PRIVATE_TX_FIXTURE_DIR` and
`PRIVATE_TX_EVALUATOR` can select locally built fixture artifacts and evaluator.
No environment file, credential, RPC connection or production hostname is used.

Build artifacts, dependency sources, the generated fixture and test results are
Git-ignored. `CARGO_HOME` can reuse an existing local cache; otherwise the build
uses the ignored `prototype/pir-browser/.cargo-home` directory. Dependencies are
locked and upstream archives have exact revisions and SHA-256 checks.

## Data and protocol scope

- Three historical **mainnet transparent coinbase** fixtures from
  `server/tests/fixtures/browser-transactions.json`. Preparation parses their raw
  transactions, verifies full transaction IDs and coinbase status, and derives
  outputs with upstream `zcash_transaction_wire`.
- A bounded **2,048-row × 2,048-byte** sparse table using the upstream Display
  codec, `Tag`/`placement_row`, `TableProfile` P8, native publication/query
  primitives and client decryption. This fixture geometry and local envelope
  are **not** the production wallet-PIR HTTP contract.
- Exact amounts are decimal-string **zatoshis**. Coinbase display fees are zero.
  Display includes at most the first two transparent outputs and marks summaries
  with more outputs. Historical height labels come from the fixture capture;
  this demo does not independently verify block inclusion or current chain state.
- Every browser downloads the same public setup and catalogue of sample IDs.
  Lookup discovery is local. The catalogue does not contain the Display results.
  `expected.json` is a private-to-the-test oracle and is never served by HTTP.
- Unknown IDs describe absence **from this fixture table**, not absence from
  Zcash. There is no mempool, live freshness, address history or reorg support.

Pinned sources:

- `zakura-core/wallet-libraries`:
  `a7c842fd4f16790ed6739346f44557a97065d242`
- `valargroup/ipir-sp`:
  `5ea080a3281a01c5459f585e0a1bbbde50ec2bd2`

The source bootstrap checks the upstream files against verified archives. There
are no patches to the upstream cryptographic implementation.

## Verify the complete flow

```sh
node --test prototype/private-tx/test/server.test.mjs
```

For the real browser test, install the isolated development dependency and have
Google Chrome installed:

```sh
npm --prefix prototype/private-tx ci --ignore-scripts
node prototype/private-tx/test/browser.mjs
```

The browser test starts its own ephemeral loopback server and native evaluator,
blocks non-local traffic, checks two different decoded records against raw-fixture
facts, and verifies that repeated queries differ while their lengths agree. It
checks request URLs, headers and bodies for text, raw and reversed transaction
IDs. It also exercises invalid input, query failure, malformed answers and
recovery without fallback, and checks empty browser storage. It writes a request
summary and screenshots under `test-results/` without storing query secrets or
raw encrypted request bodies. Native tests exercise genuine upstream roundtrips
and malformed-query rejection; run them with:

```sh
cargo test --locked --release --workspace --manifest-path prototype/pir-browser/Cargo.toml
```

## Privacy boundary

The worker performs query generation/decryption. Network paths are fixed and
queries are binary POST bodies. There are no third-party resources, analytics,
identifier-bearing URLs, ordinary explorer fetches, storage or silent fallbacks.
The generic shell is `noindex` and is not in any sitemap. CSP limits requests to
the local origin. Setup checksums detect inconsistency; a checksum served by the
same publisher is not independent authentication.

This is a correctness/feasibility experiment with a tiny public fixture domain,
**not a production privacy or anonymity guarantee**. The server sees connection
metadata, query sizes and timing. The browser trusts its delivered JS/WASM. PIR
does not authenticate the truth or completeness of publisher summaries. This
prototype adds no Tor/OHTTP transport, trusted client distribution, cryptographic
audit, full-scale capacity qualification or production release.
