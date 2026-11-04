# Zcash WASM decoder

Local Orchard and Ironwood trial decryption with an Orchard UFVK, using
Zakura Common 4.0.0 and wasm-bindgen 0.2.127. The pools share key material and
use distinct note-encryption domains. Sapling decryption is unsupported.

The maintained Common transaction parser handles complete v5/v6 encodings and
known NU7 branch IDs without rewriting bytes. Transparent signing and circuits
are disabled; optional secp256k1 is not compiled into this WASM artifact.
Decoding does not verify transaction proofs, signatures or consensus validity.

From the repository's `packages/zcash-decoder` directory, run
`npm run build:wasm` to rebuild the npm artifact with the pinned Rust toolchain,
locked dependencies and source path remapping. `build-info.json` records the
source and generated artifact SHA-256 hashes. Root `wasm/BUILD.md` contains the
historical scanner benchmark and integration notes.

`new ScanSession(ufvk)` prepares external/internal incoming keys. Use
`filter_compact(Uint8Array)` for fixed 149-byte records and
`decrypt_memos(txHex)` for readable text memos plus integer `amount_zatoshis`.
Call `free()` when finished. This releases the Rust allocation; applications
must manage their own copies of viewing keys and decrypted data.
The legacy `decrypt_memo` API retains `{memo, amount}` with ZEC display units.

Transaction input is capped at 2,000,000 bytes. Each compact call accepts at most
4,096 records; the JSON compatibility API additionally caps input at 4,000,000
bytes. Decryption makes no network requests or key logs. Initial browser loading
fetches the static WASM artifact. Use a Web Worker for large scans.

Run `cargo test --manifest-path wasm/Cargo.toml --lib --locked` at the repository
root for parser/decryption regressions. Tests use public synthetic keys and a
public ZIP 244 vector, not private wallets.

MIT OR Apache-2.0.
