#!/bin/bash
# explorer-site.sh <pir-origin> <out-dir>
#
# Assembles the private explorer's static frontend for hosting apart from the
# PIR service (Vercel): the built UI (PRIVATE_UI_OUT=.local/explorer-ui node
# ui/build.mjs), the worker, the page with the PIR origin in its worker URL
# and content security policy, and vercel.json with the same strict headers.
# Encrypted queries then go from the browser straight to <pir-origin>; the
# static host only ever serves these files.
set -euo pipefail
PIR=${1:?usage: explorer-site.sh https://pir.example <out-dir>}
OUT=${2:?usage: explorer-site.sh https://pir.example <out-dir>}
[[ "$PIR" =~ ^https://[a-z0-9.-]+$ ]] || { echo "PIR origin must look like https://host" >&2; exit 2; }
HERE=$(cd "$(dirname "$0")" && pwd)
UI=$HERE/.local/explorer-ui
[[ -f "$UI/app.js" && -d "$UI/wasm" ]] || { echo "build the UI first: PRIVATE_UI_OUT=.local/explorer-ui node ui/build.mjs" >&2; exit 2; }

rm -rf "$OUT"
mkdir -p "$OUT"
cp -R "$UI"/. "$OUT"/
cp "$HERE/web/explorer-worker.js" "$OUT/explorer-worker.js"
cp "$HERE/web/explorer-theme.js" "$OUT/theme.js"
CSP="default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self' $PIR; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self'; manifest-src 'none'; base-uri 'none'; form-action 'none'"
sed -e "s|content=\"/explorer-worker.js\"|content=\"/explorer-worker.js?pir=$PIR\"|" \
    -e "s|connect-src 'self';|connect-src 'self' $PIR;|" \
    "$HERE/web/explorer-index.html" > "$OUT/index.html"
grep -q "pir=$PIR" "$OUT/index.html" && grep -q "connect-src 'self' $PIR;" "$OUT/index.html" || { echo "index.html was not rewritten" >&2; exit 1; }

python3 - "$OUT/vercel.json" "$CSP" <<'PY'
import json, sys
path, csp = sys.argv[1], sys.argv[2]
headers = [
    {"key": "Content-Security-Policy", "value": csp + "; frame-ancestors 'none'"},
    {"key": "Referrer-Policy", "value": "no-referrer"},
    {"key": "X-Content-Type-Options", "value": "nosniff"},
    {"key": "X-Frame-Options", "value": "DENY"},
    {"key": "Cross-Origin-Opener-Policy", "value": "same-origin"},
    {"key": "Permissions-Policy", "value": "camera=(), microphone=(), geolocation=(), interest-cohort=()"},
    {"key": "Strict-Transport-Security", "value": "max-age=31536000"},
    {"key": "X-Robots-Tag", "value": "noindex, nofollow, noarchive"},
    # Every visit gets the current code, so a fix or key change applies at once.
    {"key": "Cache-Control", "value": "no-cache"},
]
json.dump({"cleanUrls": False, "trailingSlash": False, "headers": [{"source": "/(.*)", "headers": headers}]}, open(path, "w"), indent=2)
PY
(cd "$OUT" && find . -type f ! -name vercel.json | sort | xargs shasum -a 256 > SHA256SUMS)
echo "{\"site\":\"$OUT\",\"pir\":\"$PIR\",\"files\":$(find "$OUT" -type f | wc -l | tr -d ' ')}"
