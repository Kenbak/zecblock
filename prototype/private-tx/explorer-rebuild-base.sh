#!/bin/bash
# explorer-rebuild-base.sh tx|block
#
# Rebuild one base table of the private explorer from the streaming replica,
# then swap it in without downtime: every canonical block up to the replica
# tip minus DEPTH (deep enough that reorgs cannot reach it), exported in
# chunks and streamed straight into the encoder, built, signed and verified.
# The matching recent table is published first, then the base link swaps;
# the server loads the new base beside the old one and replaces it.
#
# Environment: as explorer-publish-recent.sh, plus PUBLISH (path to it).
# A tx rebuild also derives the address tables (addresses, address-pages)
# from the same records, so all three describe the same snapshot.
# Optional: DEPTH (100), STEP (25000), KEEP (2).
set -euo pipefail
KIND=${1:?usage: explorer-rebuild-base.sh tx|block}
DATABASE=${DATABASE:-zcash_explorer_mainnet}
GROUP=${GROUP:-zecblock-pir-pilot}
DEPTH=${DEPTH:-100}
STEP=${STEP:-25000}
KEEP=${KEEP:-2}
: "${BIN:?}" "${TX_SQL:?}" "${BLOCK_SQL:?}" "${REPLICA:?}" "${KEY:?}" "${ROOT_DIR:?}" "${PUBLISH:?}"
case "$KIND" in
  tx) SQL=$TX_SQL ENCODE=explorer-encode BUILD=explorer-build BASE_ROOT=$ROOT_DIR/base PREFIX=b ;;
  block) SQL=$BLOCK_SQL ENCODE=explorer-encode-blocks BUILD=explorer-build-blocks BASE_ROOT=$ROOT_DIR/blocks PREFIX=k ;;
  *) echo "unknown kind $KIND" >&2; exit 2 ;;
esac

install -d -m 0750 -g "$GROUP" "$BASE_ROOT"
exec 8>"$BASE_ROOT/.lock"
flock -n 8 || { echo '{"skipped":"another base rebuild is running"}'; exit 0; }
work=$(mktemp -d "$BASE_ROOT/.work-XXXXXX")
trap 'rm -rf "$work"' EXIT
started=$(date +%s)

replica_tip=$(ssh -o BatchMode=yes "$REPLICA" "cd /tmp && sudo -u postgres psql -X -qAt -d $DATABASE -c 'select max(height) from blocks'")
tip=$((replica_tip - DEPTH))
echo "{\"kind\":\"$KIND\",\"replicaTip\":$replica_tip,\"baseTip\":$tip}"

for ((a = 0; a <= tip; a += STEP)); do
  b=$((a + STEP - 1)); ((b > tip)) && b=$tip
  sed -e "s/:a/$a/; s/:b/$b/" "$SQL" \
    | ssh -o BatchMode=yes "$REPLICA" "cd /tmp && nice -n 19 sudo -u postgres psql -X -q -v ON_ERROR_STOP=1 -d $DATABASE"
done | "$BIN" "$ENCODE" "$work/records.bin" > "$work/encode.json"
exported=$(date +%s)

# Signs and checks a built publication and moves it under <root>; the
# `current` links swap only after the matching recent tables exist.
stage() {
  local dir=$1 root=$2
  openssl pkeyutl -sign -rawin -inkey "$KEY" -in "$dir/manifest.json" -out "$dir/manifest.sig"
  "$BIN" explorer-verify "$dir/manifest.json" "$dir/manifest.sig" > /dev/null
  chgrp -R "$GROUP" "$dir"
  chmod -R g+rX,o-rwx "$dir"
  install -d -m 0750 -g "$GROUP" "$root"
  mv "$dir" "$root/$(basename "$dir")"
}
swap() {
  local root=$1 name=$2 prefix=$3
  ln -sfn "$name" "$root/current.tmp"
  mv -Tf "$root/current.tmp" "$root/current"
  ls -1dt "$root/$prefix"-* | tail -n +$((KEEP + 1)) | xargs -r rm -rf
}

stamp=$(date +%s)
name="$PREFIX-$tip-$stamp"
"$BIN" "$BUILD" "$work/records.bin" "$work/$name" "$tip" > "$work/build.json"
if [[ "$KIND" == tx ]]; then
  "$BIN" explorer-addresses-from-tx "$work/records.bin" "$work/addresses.bin" "$work/pages.bin" > "$work/addresses.json"
  "$BIN" explorer-build-addresses "$work/addresses.bin" "$work/a-$tip-$stamp" "$tip" > /dev/null
  "$BIN" explorer-build-address-pages "$work/pages.bin" "$work/p-$tip-$stamp" "$tip" > /dev/null
  rm -f "$work/addresses.bin" "$work/pages.bin"
  stage "$work/a-$tip-$stamp" "$ROOT_DIR/addresses"
  stage "$work/p-$tip-$stamp" "$ROOT_DIR/address-pages"
fi
rm -f "$work/records.bin"
stage "$work/$name" "$BASE_ROOT"

# Publish the recent tables for the new base, then point the bases at them.
# The server serves a recent table only when its base tip matches the loaded
# base, and the browser takes pages only from the matching snapshot.
BASE_TIP=$tip WAIT_LOCK=1 "$PUBLISH" "$KIND"
if [[ "$KIND" == tx ]]; then
  swap "$ROOT_DIR/address-pages" "p-$tip-$stamp" p
  swap "$ROOT_DIR/addresses" "a-$tip-$stamp" a
fi
swap "$BASE_ROOT" "$name" "$PREFIX"

python3 - "$KIND" "$work/build.json" "$started" "$exported" <<'PY'
import json, sys, time
kind, build = sys.argv[1], json.load(open(sys.argv[2]))
started, exported = int(sys.argv[3]), int(sys.argv[4])
print(json.dumps({"kind": kind, "published": build["snapshotTip"], "tipHash": build["tipHash"], "records": build["records"],
                  "mainInstances": build["main"]["instances"], "overflowInstances": build["overflow"]["instances"],
                  "exportAndEncodeSeconds": exported - started, "buildSeconds": round(build["buildSeconds"], 1),
                  "totalSeconds": int(time.time()) - started}))
PY
