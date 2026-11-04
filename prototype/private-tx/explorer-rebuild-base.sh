#!/bin/bash
# Rebuild the private explorer's base table from the streaming replica, then
# swap it in without downtime: every canonical block up to the replica tip
# minus DEPTH (deep enough that reorgs cannot reach it), exported in chunks
# and streamed straight into the encoder, built, signed and verified. A
# recent table for the new base is published first, then both links swap;
# the server loads the new base beside the old one and replaces it.
#
# Required environment: as explorer-publish-recent.sh, plus PUBLISH (path to
# that script). Optional: BASE_ROOT, ROOT, DEPTH (100), STEP (25000), KEEP (2).
set -euo pipefail
BASE_ROOT=${BASE_ROOT:-/var/lib/zecblock-pir-explorer/base}
DATABASE=${DATABASE:-zcash_explorer_mainnet}
GROUP=${GROUP:-zecblock-pir-pilot}
DEPTH=${DEPTH:-100}
STEP=${STEP:-25000}
KEEP=${KEEP:-2}
: "${BIN:?}" "${SQL:?}" "${REPLICA:?}" "${KEY:?}" "${PUBLISH:?}"

install -d -m 0750 -g "$GROUP" "$BASE_ROOT"
exec 8>"$BASE_ROOT/.lock"
flock -n 8 || { echo '{"skipped":"another base rebuild is running"}'; exit 0; }
work=$(mktemp -d "$BASE_ROOT/.work-XXXXXX")
trap 'rm -rf "$work"' EXIT
started=$(date +%s)

replica_tip=$(ssh -o BatchMode=yes "$REPLICA" "cd /tmp && sudo -u postgres psql -X -qAt -d $DATABASE -c 'select max(height) from blocks'")
tip=$((replica_tip - DEPTH))
echo "{\"replicaTip\":$replica_tip,\"baseTip\":$tip}"

for ((a = 0; a <= tip; a += STEP)); do
  b=$((a + STEP - 1)); ((b > tip)) && b=$tip
  sed -e "s/:a/$a/; s/:b/$b/" "$SQL" \
    | ssh -o BatchMode=yes "$REPLICA" "cd /tmp && nice -n 19 sudo -u postgres psql -X -q -v ON_ERROR_STOP=1 -d $DATABASE"
done | "$BIN" explorer-encode "$work/records.bin" > "$work/encode.json"
exported=$(date +%s)

name="b-$tip-$(date +%s)"
"$BIN" explorer-build "$work/records.bin" "$work/$name" "$tip" > "$work/build.json"
rm -f "$work/records.bin"
openssl pkeyutl -sign -rawin -inkey "$KEY" -in "$work/$name/manifest.json" -out "$work/$name/manifest.sig"
"$BIN" explorer-verify "$work/$name/manifest.json" "$work/$name/manifest.sig" > /dev/null
chgrp -R "$GROUP" "$work/$name"
chmod -R g+rX,o-rwx "$work/$name"
mv "$work/$name" "$BASE_ROOT/$name"

# Publish the recent table for the new base, then point the base at it. The
# server serves a recent table only when its base tip matches the loaded base.
BASE_TIP=$tip WAIT_LOCK=1 "$PUBLISH"
ln -sfn "$name" "$BASE_ROOT/current.tmp"
mv -Tf "$BASE_ROOT/current.tmp" "$BASE_ROOT/current"

ls -1dt "$BASE_ROOT"/b-* | tail -n +$((KEEP + 1)) | xargs -r rm -rf

python3 - "$work/encode.json" "$work/build.json" "$started" "$exported" <<'PY'
import json, sys, time
encode, build = json.load(open(sys.argv[1])), json.load(open(sys.argv[2]))
started, exported = int(sys.argv[3]), int(sys.argv[4])
print(json.dumps({"published": build["snapshotTip"], "tipHash": build["tipHash"], "records": build["records"],
                  "mainInstances": build["main"]["instances"], "overflowInstances": build["overflow"]["instances"],
                  "exportAndEncodeSeconds": exported - started, "buildSeconds": round(build["buildSeconds"], 1),
                  "totalSeconds": int(time.time()) - started}))
PY
