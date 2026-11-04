#!/bin/bash
# Rebuild the private explorer's recent table: every canonical block after the
# current base snapshot, plus "spent since the base" markers, read from the
# streaming replica in one REPEATABLE READ snapshot, then signed. The serving
# process follows $ROOT/current and swaps without a restart. Reorgs need no
# special handling: each run rebuilds the whole recent range.
#
# Required environment: BIN (zecblock-pir-fixture), SQL (chunk query with
# :a/:b), REPLICA (ssh target), KEY (Ed25519 PEM). Optional: ROOT, BASE_ROOT,
# BASE_TIP (defaults to the current base's tip), DATABASE, GROUP.
set -euo pipefail
ROOT=${ROOT:-/var/lib/zecblock-pir-explorer/recent}
BASE_ROOT=${BASE_ROOT:-/var/lib/zecblock-pir-explorer/base}
DATABASE=${DATABASE:-zcash_explorer_mainnet}
GROUP=${GROUP:-zecblock-pir-pilot}
: "${BIN:?}" "${SQL:?}" "${REPLICA:?}" "${KEY:?}"
manifest_field() { python3 -c 'import json,sys; v=json.load(open(sys.argv[1]))[sys.argv[2]]; print(v if v is not None else 0)' "$1" "$2"; }
BASE_TIP=${BASE_TIP:-$(manifest_field "$BASE_ROOT/current/manifest.json" snapshotTip)}

install -d -m 0750 -g "$GROUP" "$ROOT"
exec 9>"$ROOT/.lock"
# A base rebuild sets WAIT_LOCK so its recent table is always published.
if [[ -n "${WAIT_LOCK:-}" ]]; then flock -w 900 9; else flock -n 9 || { echo '{"skipped":"another publish is running"}'; exit 0; }; fi
work=$(mktemp -d "$ROOT/.work-XXXXXX")
trap 'rm -rf "$work"' EXIT
started=$(date +%s.%N)

sed -e "s/:a/$((BASE_TIP + 1))/; s/:b/2147483647/" "$SQL" \
  | ssh -o BatchMode=yes "$REPLICA" "cd /tmp && nice -n 19 sudo -u postgres psql -X -q -v ON_ERROR_STOP=1 -d $DATABASE" > "$work/lines.tsv"
exported=$(date +%s.%N)

report=$("$BIN" explorer-encode "$work/records.bin" < "$work/lines.tsv")
tip=$(python3 -c 'import json,sys; print(int(json.loads(sys.argv[1])["maxHeight"]))' "$report")
if (( tip <= BASE_TIP )); then
  echo "{\"skipped\":\"no blocks after base\",\"baseTip\":$BASE_TIP}"
  exit 0
fi
if [[ -e "$ROOT/current/manifest.json" ]] && (( tip == $(manifest_field "$ROOT/current/manifest.json" snapshotTip) )) \
   && (( BASE_TIP == $(manifest_field "$ROOT/current/manifest.json" baseTip) )); then
  echo "{\"skipped\":\"tip unchanged\",\"tip\":$tip}"
  exit 0
fi

name="r-$tip-$(date +%s)"
"$BIN" explorer-build "$work/records.bin" "$work/$name" "$tip" "$BASE_TIP" > "$work/build.json"
openssl pkeyutl -sign -rawin -inkey "$KEY" -in "$work/$name/manifest.json" -out "$work/$name/manifest.sig"
"$BIN" explorer-verify "$work/$name/manifest.json" "$work/$name/manifest.sig" > /dev/null
chgrp -R "$GROUP" "$work/$name"
chmod -R g+rX,o-rwx "$work/$name"
mv "$work/$name" "$ROOT/$name"
ln -sfn "$name" "$ROOT/current.tmp"
mv -Tf "$ROOT/current.tmp" "$ROOT/current"

# The server keeps the newest eight loaded; keep nine on disk.
ls -1dt "$ROOT"/r-* | tail -n +10 | xargs -r rm -rf

python3 - "$work/build.json" "$started" "$exported" <<'PY'
import json, sys, time
build = json.load(open(sys.argv[1]))
started, exported = float(sys.argv[2]), float(sys.argv[3])
print(json.dumps({"published": build["snapshotTip"], "baseTip": build["baseTip"], "records": build["records"],
                  "spentMarkers": build["spentMarkers"], "mainRows": build["main"]["rows"], "overflowRows": build["overflow"]["rows"],
                  "exportSeconds": round(exported - started, 2), "totalSeconds": round(time.time() - started, 2)}))
PY
