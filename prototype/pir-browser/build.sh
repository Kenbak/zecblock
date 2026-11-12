#!/usr/bin/env bash
set -euo pipefail

prototype_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$prototype_dir"
export CARGO_HOME="${CARGO_HOME:-$prototype_dir/.cargo-home}"
python3 "$prototype_dir/bootstrap.py"

if [[ "$(wasm-bindgen --version)" != "wasm-bindgen 0.2.127" ]]; then
  echo "This lockfile requires wasm-bindgen-cli 0.2.127; install or select that version." >&2
  exit 1
fi

cargo build --locked --manifest-path "$prototype_dir/Cargo.toml" --release -p zecblock-pir-fixture
cargo build --locked --manifest-path "$prototype_dir/Cargo.toml" --release \
  --target wasm32-unknown-unknown -p zecblock-pir-browser
wasm-bindgen "$prototype_dir/target/wasm32-unknown-unknown/release/zecblock_pir_browser.wasm" \
  --target web --out-dir "$prototype_dir/pkg"

fixture_dir="${1:-$prototype_dir/../private-tx/.local/fixture}"
"$prototype_dir/target/release/zecblock-pir-fixture" prepare "$fixture_dir"
echo "Local fixture prepared in $fixture_dir"
