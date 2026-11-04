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

name="$PREFIX-$tip-$(date +%s)"
"$BIN" "$BUILD" "$work/records.bin" "$work/$name" "$tip" "$BASE_TIP" > "$work/build.json"
openssl pkeyutl -sign -rawin -inkey "$KEY" -in "$work/$name/manifest.json" -out "$work/$name/manifest.sig"
"$BIN" explorer-verify "$work/$name/manifest.json" "$work/$name/manifest.sig" > /dev/null
chgrp -R "$GROUP" "$work/$name"
chmod -R g+rX,o-rwx "$work/$name"
mv "$work/$name" "$ROOT/$name"
ln -sfn "$name" "$ROOT/current.tmp"
mv -Tf "$ROOT/current.tmp" "$ROOT/current"

# The server keeps the newest eight loaded; keep nine on disk.
ls -1dt "$ROOT/$PREFIX"-* | tail -n +10 | xargs -r rm -rf

python3 - "$KIND" "$work/build.json" "$started" "$exported" <<'PY'
import json, sys, time
kind, build = sys.argv[1], json.load(open(sys.argv[2]))
started, exported = float(sys.argv[3]), float(sys.argv[4])
print(json.dumps({"kind": kind, "published": build["snapshotTip"], "baseTip": build["baseTip"], "records": build["records"],
                  "spentMarkers": build["spentMarkers"], "mainRows": build["main"]["rows"], "overflowRows": build["overflow"]["rows"],
                  "exportSeconds": round(exported - started, 2), "totalSeconds": round(time.time() - started, 2)}))
PY
