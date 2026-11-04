# @cipherscan/zcash-decoder

Local WebAssembly trial decryption for Zcash Orchard and Ironwood transaction
memos, and compact-output filtering with an Orchard Unified Full Viewing Key
(UFVK). The TypeScript API works in browsers, Web Workers and Node.js.

```sh
npm install @cipherscan/zcash-decoder
```

```ts
import { ZcashWASM } from '@cipherscan/zcash-decoder';

const decoder = await ZcashWASM.init();
const result = await decoder.decryptMemo(rawTransactionHex, orchardUfvk);
// result: { memo: string, amount: number } — amount is in ZEC.
```

`init()` loads the adjacent packaged WASM artifact. Browsers fetch that static
asset; Node reads it from the local package. Explicit `ArrayBuffer` or `Uint8Array` bytes can be supplied as `ZcashWASM.init(wasmBytes)` for custom
asset loading. The decoder does not transmit viewing keys, transaction bytes or
decrypted data, and does not log them. Applications control their own transport,
logging and rendering. The examples that fetch public transactions reveal the
queried transaction ID to the selected API, and keep the viewing key local.

## Supported data

- Raw v5 (ZIP 225) and v6 (ZIP 229) transactions, including known NU6.3 and NU7
  consensus branch IDs. Raw bytes are parsed unchanged using Zakura Common 4.0.0.
- Orchard and Ironwood note decryption with both external and internal scopes.
- UTF-8 text memos through `decryptMemo`; it returns the first readable nonempty
  memo. The existing `amount` field is a floating point ZEC display value.
- Orchard/Ironwood compact-output filtering. `pool: 'orchard' | 'ironwood'` tags
  select the domain; omitted tags retain the legacy dual-domain behavior.
- Sapling memo decryption and Sapling compact-output filtering are unsupported.
  Sapling-only raw transactions and scans containing only Sapling compact outputs
  return explicit errors. Mixed raw transactions and mixed compact blocks process
  their supported Orchard/Ironwood outputs; Sapling outputs are ignored. Matches
  therefore cover only Orchard/Ironwood, not all pools. Previous documentation incorrectly claimed Sapling
  domain support; the published 1.0.6 artifact did not implement it.

This is a decoder, not a consensus verifier: successful parsing/decryption does
not validate proofs, signatures, fees, chain membership or activation height.
Unknown branch IDs, invalid encodings, trailing bytes and incomplete transactions
are rejected. Raw transaction input is limited to 2,000,000 bytes; UFVK input is limited to 4,096 characters. Compact WASM
calls are limited to 4,096 outputs and 4,000,000 JSON bytes; the TypeScript wrapper
splits larger scans into bounded calls.

## Compact blocks

```ts
const matches = await decoder.filterCompactBlocks(blocks, orchardUfvk, progress => {
  // { blocksProcessed, totalBlocks, matchesFound }
});
// matches: Array<{ txid: string, height: number, timestamp: number }>
```

Blocks have `height` (decimal string), `time` (integer seconds) and `vtx`.
Each transaction has `hash` and optional `actions`; each action has `pool`
(optional), `nullifier`, `cmx`, `ephemeralKey` and `ciphertext` as hex strings.
The first three fields are 32 bytes; the compact ciphertext is 52 bytes.
Matches are deduplicated by transaction ID. Use a Web Worker for large browser
scans so synchronous WASM work does not block the interface.

`decoder.detectKeyType(key)` validates the UFVK encoding and returns
`'ufvk-mainnet'`, `'ufvk-testnet'` or `'unknown'`. It does not prove that a key has
a readable note in any transaction.

## Development and verification

From this repository's `packages/zcash-decoder` directory:

```sh
npm ci --ignore-scripts
npm test
npm run build:wasm
```

The WASM build uses the pinned Rust toolchain in `../../wasm/rust-toolchain.toml`,
`../../wasm/Cargo.lock`, and wasm-bindgen-cli **0.2.127**. Install that exact
CLI (`cargo install wasm-bindgen-cli --version 0.2.127 --locked`) and the toolchain's
`wasm32-unknown-unknown` target before rebuilding. `build:wasm` remaps absolute
source paths and writes the generated JS, type declarations and binary into
`wasm/`. It does not download or execute install hooks in this package.

Run Rust parser/decryption regressions with:

```sh
cargo test --manifest-path ../../wasm/Cargo.toml --lib --locked
cargo audit --file ../../wasm/Cargo.lock
```

Fixtures contain only public deterministic test keys and a public ZIP 244 vector.
Synthetic transactions have placeholder proofs/signatures and test encoding and
note decryption only. They are not valid transactions to broadcast. Real NU7
activation, full consensus verification and funded wallet compatibility are
separate qualification work.

MIT OR Apache-2.0.
