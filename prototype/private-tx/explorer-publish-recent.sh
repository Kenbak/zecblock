#!/bin/bash
# explorer-publish-recent.sh tx|block
#
# Rebuild one recent table of the private explorer: every canonical block after
# its base snapshot, read from the streaming replica in one REPEATABLE READ
# snapshot, then signed. For transactions it also carries "spent since the
# base" markers; for blocks, the homepage feed. The server follows
# <set>/current and swaps without a restart. Reorgs need no special handling:
# each run rebuilds the whole recent range.
#
# Required environment: BIN (zecblock-pir-fixture), TX_SQL and BLOCK_SQL
# (export queries with :a/:b), REPLICA (ssh target), KEY (Ed25519 PEM),
# ROOT_DIR (holds base/, recent/, blocks/, blocks-recent/). Optional:
# BASE_TIP (defaults to the current base's tip), DATABASE, GROUP, WAIT_LOCK.
# A tx run also publishes the recent address table, derived from the same
# records, into addresses-recent.
set -euo pipefail
KIND=${1:?usage: explorer-publish-recent.sh tx|block}
DATABASE=${DATABASE:-zcash_explorer_mainnet}
GROUP=${GROUP:-zecblock-pir-pilot}
: "${BIN:?}" "${TX_SQL:?}" "${BLOCK_SQL:?}" "${REPLICA:?}" "${KEY:?}" "${ROOT_DIR:?}"
case "$KIND" in
  tx) SQL=$TX_SQL ENCODE=explorer-encode BUILD=explorer-build ROOT=$ROOT_DIR/recent BASE_ROOT=$ROOT_DIR/base PREFIX=r ;;
  block) SQL=$BLOCK_SQL ENCODE=explorer-encode-blocks BUILD=explorer-build-blocks ROOT=$ROOT_DIR/blocks-recent BASE_ROOT=$ROOT_DIR/blocks PREFIX=kr ;;
  *) echo "unknown kind $KIND" >&2; exit 2 ;;
esac
manifest_field() { python3 -c 'import json,sys; v=json.load(open(sys.argv[1]))[sys.argv[2]]; print(v if v is not None else 0)' "$1" "$2"; }
if [[ -z "${BASE_TIP:-}" ]]; then
  [[ -e "$BASE_ROOT/current/manifest.json" ]] || { echo "{\"skipped\":\"no $KIND base yet\"}"; exit 0; }
  BASE_TIP=$(manifest_field "$BASE_ROOT/current/manifest.json" snapshotTip)
fi

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

report=$("$BIN" "$ENCODE" "$work/records.bin" < "$work/lines.tsv")
tip=$(python3 -c 'import json,sys; print(int(json.loads(sys.argv[1])["maxHeight"]))' "$report")
if (( tip <= BASE_TIP )); then
  echo "{\"kind\":\"$KIND\",\"skipped\":\"no blocks after base\",\"baseTip\":$BASE_TIP}"
  exit 0
fi
if [[ -e "$ROOT/current/manifest.json" ]] && (( tip == $(manifest_field "$ROOT/current/manifest.json" snapshotTip) )) \
   && (( BASE_TIP == $(manifest_field "$ROOT/current/manifest.json" baseTip) )); then
  echo "{\"kind\":\"$KIND\",\"skipped\":\"tip unchanged\",\"tip\":$tip}"
  exit 0
fi

# Signs and checks a built publication, moves it under <root>, points
# <root>/current at it and keeps the newest nine (the server loads eight).
publish() {
  local dir=$1 root=$2 prefix=$3 name
  name=$(basename "$dir")
  openssl pkeyutl -sign -rawin -inkey "$KEY" -in "$dir/manifest.json" -out "$dir/manifest.sig"
  "$BIN" explorer-verify "$dir/manifest.json" "$dir/manifest.sig" > /dev/null
  chgrp -R "$GROUP" "$dir"
  chmod -R g+rX,o-rwx "$dir"
  install -d -m 0750 -g "$GROUP" "$root"
  mv "$dir" "$root/$name"
  ln -sfn "$name" "$root/current.tmp"
  mv -Tf "$root/current.tmp" "$root/current"
  ls -1dt "$root/$prefix"-* | tail -n +10 | xargs -r rm -rf
}

stamp=$(date +%s)
name="$PREFIX-$tip-$stamp"
"$BIN" "$BUILD" "$work/records.bin" "$work/$name" "$tip" "$BASE_TIP" > "$work/build.json"
if [[ "$KIND" == tx ]]; then
  "$BIN" explorer-addresses-from-tx "$work/records.bin" "$work/addresses.bin" > "$work/addresses.json"
  "$BIN" explorer-build-addresses "$work/addresses.bin" "$work/ar-$tip-$stamp" "$tip" "$BASE_TIP" > /dev/null
  publish "$work/ar-$tip-$stamp" "$ROOT_DIR/addresses-recent" ar
fi
publish "$work/$name" "$ROOT" "$PREFIX"

python3 - "$KIND" "$work/build.json" "$started" "$exported" <<'PY'
import json, sys, time
kind, build = sys.argv[1], json.load(open(sys.argv[2]))
started, exported = float(sys.argv[3]), float(sys.argv[4])
print(json.dumps({"kind": kind, "published": build["snapshotTip"], "baseTip": build["baseTip"], "records": build["records"],
                  "spentMarkers": build["spentMarkers"], "mainRows": build["main"]["rows"], "overflowRows": build["overflow"]["rows"],
                  "exportSeconds": round(exported - started, 2), "totalSeconds": round(time.time() - started, 2)}))
PY
