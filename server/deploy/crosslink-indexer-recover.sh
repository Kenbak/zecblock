#!/usr/bin/env bash
# Resume the verified public history, then hand off to live indexing. The
# indexer advances its live cursor only after a successful complete backfill.
set -euo pipefail
binary=${INDEXER_BINARY:-/root/cipherscan-rust-crosslink/target/release/cipherscan-indexer-crosslink}
"$binary" backfill
exec "$binary" live
