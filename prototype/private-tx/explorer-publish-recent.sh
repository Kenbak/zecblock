#!/bin/bash
# Rebuild the private explorer's recent table: every canonical block after the
# base snapshot, plus "spent since the base" markers, read from the streaming
# replica in one REPEATABLE READ snapshot. The serving process follows
# $ROOT/current and swaps without a restart. Reorgs need no special handling:
# each run rebuilds the whole recent range from the canonical chain.
#
# Required environment: BIN (zecblock-pir-fixture), SQL (chunk query with
# :a/:b), BASE_TIP, REPLICA (ssh target). Optional: ROOT, DATABASE, GROUP.
set -euo pipefail
ROOT=${ROOT:-/var/lib/zecblock-pir-explorer/recent}
DATABASE=${DATABASE:-zcash_explorer_mainnet}
GROUP=${GROUP:-zecblock-pir-pilot}
: "${BIN:?}" "${SQL:?}" "${BASE_TIP:?}" "${REPLICA:?}"

install -d -m 0750 -g "$GROUP" "$ROOT"
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
current_tip=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["snapshotTip"])' "$ROOT/current/manifest.json" 2>/dev/null || echo 0)
if (( tip == current_tip )); then
  echo "{\"skipped\":\"tip unchanged\",\"tip\":$tip}"
  exit 0
fi

name="r-$tip-$(date +%s)"
"$BIN" explorer-build "$work/records.bin" "$ROOT/$name" "$tip" "$BASE_TIP" > "$work/build.json"
chgrp -R "$GROUP" "$ROOT/$name"
chmod -R g+rX,o-rwx "$ROOT/$name"
ln -sfn "$name" "$ROOT/current.tmp"
mv -Tf "$ROOT/current.tmp" "$ROOT/current"

# The server keeps the newest two loaded; keep three on disk.
ls -1dt "$ROOT"/r-* | tail -n +4 | xargs -r rm -rf

python3 - "$work/build.json" "$started" "$exported" <<'EOF'
import json, sys, time
build = json.load(open(sys.argv[1]))
started, exported = float(sys.argv[2]), float(sys.argv[3])
print(json.dumps({"published": build["snapshotTip"], "baseTip": build["baseTip"], "records": build["records"],
                  "spentMarkers": build["spentMarkers"], "mainRows": build["main"]["rows"], "overflowRows": build["overflow"]["rows"],
                  "exportSeconds": round(exported - started, 2), "totalSeconds": round(time.time() - started, 2)}))
EOF
