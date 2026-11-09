# Current npm artifact build — 2026-11-04

The npm decoder now uses Zakura Common 4.0.0 for complete v5/v6 parsing and
Orchard/Ironwood decryption. From `packages/zcash-decoder`, use
`npm run build:wasm` with wasm-bindgen-cli 0.2.127. The script selects the pinned
Rust 1.97.1 toolchain from this directory, uses `Cargo.lock` with `--locked`,
remaps absolute source paths and generates `wasm/build-info.json` with source
and artifact SHA-256 receipts. It updates only the npm package artifact.
A separate explorer release must deliberately rebuild/copy and qualify its
`public/wasm` assets. Do not infer a deployed artifact from a source change.

The benchmark and wasm-pack integration notes below describe the earlier
scanner builds and are retained as dated history; they are not measurements
of the Common 4 artifact or its NU7 consensus-validation capability.

# 🛠️ Building the Zcash WASM Module

## 📋 Prerequisites

### 1. Install Rust

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source $HOME/.cargo/env
```

### 2. Install wasm-pack

```bash
cargo install wasm-pack
```

### 3. Add wasm32 target

```bash
rustup target add wasm32-unknown-unknown
```

---

## 🔨 Build Commands

### Development Build (with debug symbols)

```bash
cd wasm
wasm-pack build --target web --dev
```

**Output:** `pkg/` directory with:
- `zcash_wasm.js` (~15 KB)
- `zcash_wasm_bg.wasm` (~800 KB uncompressed)
- `zcash_wasm.d.ts` (TypeScript definitions)

---

### Production Build (optimized)

```bash
cd wasm
wasm-pack build --target web --release
```

**Optimizations:**
- ✅ Scan throughput optimization (`opt-level = 3`)
- ✅ Link Time Optimization (LTO)
- ✅ Dead code elimination
- ✅ Single codegen unit

**Expected size:**
- WASM: 547,786 bytes (gzip: 256,117 bytes for the measured scanner build)
- JS: generated wasm-bindgen wrapper (size varies with exports)

---

## 📦 Integration with Next.js

### 1. Copy WASM files to public directory

```bash
# After building
cp -r wasm/pkg public/wasm/
```

### 2. Update Next.js config

```javascript
// next.config.ts
const nextConfig = {
  webpack: (config) => {
    config.experiments = {
      ...config.experiments,
      asyncWebAssembly: true,
    };
    return config;
  },
};
```

### 3. Use in components

```typescript
// app/decrypt/page.tsx
import init, { decrypt_memo } from '@/public/wasm/zcash_wasm';

useEffect(() => {
  init(); // Initialize WASM
}, []);

const handleDecrypt = async () => {
  const memo = decrypt_memo(txHex, viewingKey);
  console.log('Memo:', memo);
};
```

---

## 🧪 Testing

### Run Rust tests

```bash
cd wasm
cargo test
```

### Run with browser

```bash
# Start a local server
python3 -m http.server 8000

# Open http://localhost:8000/test.html
```

---

## 🐛 Troubleshooting

### Error: "wasm-pack not found"

```bash
cargo install wasm-pack
```

### Error: "target 'wasm32-unknown-unknown' not found"

```bash
rustup target add wasm32-unknown-unknown
```

### Error: WASM file too large (>1 MB)

Check that you're using release build:
```bash
wasm-pack build --target web --release
```

Verify `Cargo.toml` has optimizations:
```toml
[profile.release]
opt-level = "z"
lto = true
```

---

## 📊 Build Performance

| Build Type | Time | WASM Size | Gzipped |
|------------|------|-----------|---------|
| Dev | ~30s | 800 KB | 250 KB |
| Release | ~2min | 300 KB | 120 KB |

---

## 🚀 Continuous Integration

### GitHub Actions

```yaml
name: Build WASM

on: [push]

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v2
      - uses: actions-rs/toolchain@v1
        with:
          toolchain: stable
          target: wasm32-unknown-unknown
      - run: cargo install wasm-pack
      - run: cd wasm && wasm-pack build --target web --release
      - uses: actions/upload-artifact@v2
        with:
          name: wasm-pkg
          path: wasm/pkg/
```

---

## 📝 Next Steps

After building:
1. ✅ Test in browser
2. ✅ Integrate with Next.js
3. ✅ Deploy to production
4. ✅ Monitor bundle size

## Scanner benchmark (2026-09-12)

The release profile favors throughput (`opt-level = 3`). A local Node 22.22.1
x64/Rosetta run on macOS, using 512 repetitions of a synthetic matching Orchard
action, one warmup and the median of five runs, measured:

| Build/path | Median ms | WASM bytes | gzip bytes |
| --- | ---: | ---: | ---: |
| Original bundled JSON API | 1620.669 | 326714 | 182838 |
| New size build, binary tagged session | 1437.390 | 333281 | 185704 |
| New speed build, binary tagged session | 1297.521 | 547786 | 256117 |

These are all-matching synthetic microbenchmarks, not wallet-download or mobile
measurements. The browser/API transport remains JSON. Known pool tags avoid the
second domain; old untagged data still uses both. The new speed build's untagged
binary path measured 1449.048 ms in this run. Performance varies by action mix
and device. Cold module initialization was sequential and is not a fair
cross-build startup comparison.

Reproduce without saving a real viewing key:

```sh
SCAN_FIXTURE_PATH=/tmp/scan-fixture.json cargo test --manifest-path wasm/Cargo.toml export_public_synthetic_fixture_when_requested
node server/scripts/benchmark-wasm.mjs /tmp/scan-fixture.json public/wasm
```

Run this from the repository root. For a size comparison, build from `wasm/`
with `CARGO_PROFILE_RELEASE_OPT_LEVEL=z wasm-pack build --target web --release --out-dir /tmp/wasm-size`.
Rebuild and copy the same generated artifacts to both `public/wasm/` and
`packages/zcash-decoder/wasm/` before shipping. The legacy decoder API remains
compatible; `ScanSession` adds scan-scoped prepared keys, fixed 149-byte records
and an all-memo API.
