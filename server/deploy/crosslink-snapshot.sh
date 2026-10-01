#!/usr/bin/env bash
# Private, consistent Season One recovery snapshots. Never publish this archive:
# it includes the node identity and may include wallet data.
set -euo pipefail
umask 077
SNAPSHOT_DIR=${SNAPSHOT_DIR:-/root/zebra-snapshots}
CONFIG=${CONFIG:-/root/.config/zebrad.toml}
RPC_URL=${ZEBRA_RPC_URL:-http://127.0.0.1:8232}
LOCK_FILE=${LOCK_FILE:-/run/crosslink-snapshot.lock}
mkdir -p "$SNAPSHOT_DIR"
exec 9>"$LOCK_FILE"
flock -n 9 || exit 0
stage=''
archive=''
restart=0
cleanup() {
    local status=$?
    trap - EXIT
    if (( restart )); then systemctl start zebrad-crosslink || status=1; fi
    if [[ -n "$archive" ]]; then rm -f -- "$archive"; fi
    if [[ -n "$stage" ]]; then rm -rf -- "$stage"; fi
    exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
# These are unpublished leftovers, never completed recovery snapshots.
find "$SNAPSHOT_DIR" -maxdepth 1 -type f -name 'zebra-*.tar.gz.tmp' -mtime +1 -delete
find "$SNAPSHOT_DIR" -maxdepth 1 -type d -name '.stage-*' -mtime +1 -exec rm -rf -- {} +
rpc() {
    curl -fsS --connect-timeout 3 --max-time 15 -H 'Content-Type: application/json' \
        -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$1\",\"params\":[]}" "$RPC_URL"
}
tip=$(rpc getblockcount | python3 -c 'import json,sys; x=json.load(sys.stdin); assert not x.get("error"); n=x["result"]; assert type(n) is int and n>0; print(n)')
final=$(rpc get_tfl_final_block_height_and_hash | python3 -c 'import json,sys; x=json.load(sys.stdin); assert not x.get("error"); r=x["result"]; n=r["height"] if isinstance(r,dict) else r[0]; assert type(n) is int and n>0; print(n)')
if (( tip < final || tip - final > 10 )); then
    echo "Snapshot skipped: tip=$tip final=$final"
    exit 0
fi
cache=$(python3 - "$CONFIG" <<'PY'
import pathlib,sys,tomllib
p=pathlib.Path(tomllib.load(open(sys.argv[1], 'rb'))['state']['cache_dir'])
assert p.is_absolute() and p.is_dir()
# Season One appends its network suffix to the configured base cache path.
# Refuse ambiguous caches instead of choosing whichever find returns first.
if not p.name.startswith('zebra_crosslink_workshop'):
    candidates=[d for d in p.glob('zebra_crosslink_workshop*') if d.is_dir()]
    assert len(candidates)==1, 'ambiguous or absent network cache'
    p=candidates[0]
assert (p/'state').is_dir() and (p/'pos.chain').is_file()
print(p)
PY
)
source_bytes=$(du -sb "$cache" | awk '{print $1}')
available=$(df -B1 --output=avail "$SNAPSHOT_DIR" | tail -1)
if (( available < source_bytes * 2 + 10737418240 )); then
    echo 'Snapshot skipped: insufficient space for staging, archive and 10 GiB reserve' >&2
    exit 1
fi
stage=$(mktemp -d "$SNAPSHOT_DIR/.stage-XXXXXXXX")
# Freeze both RocksDB and pos.chain together. Copy first, then resume the node
# before compression. A tar of a live RocksDB directory is not a checkpoint.
systemctl is-active --quiet zebrad-crosslink
restart=1
systemctl stop zebrad-crosslink
if systemctl is-active --quiet zebrad-crosslink; then exit 1; fi
cp -a --reflink=auto "$cache" "$stage/"
systemctl start zebrad-crosslink
restart=0
name="zebra-$(date -u +%Y%m%dT%H%M%SZ)-tip${tip}.tar.gz"
archive="$SNAPSHOT_DIR/$name.tmp"
tar -C "$stage" -czf "$archive" "$(basename "$cache")"
gzip -t "$archive"
mv -- "$archive" "$SNAPSHOT_DIR/$name"
archive=''
mapfile -t snapshots < <(find "$SNAPSHOT_DIR" -maxdepth 1 -type f -name 'zebra-*.tar.gz' -printf '%f\n' | sort -r)
for old in "${snapshots[@]:3}"; do rm -f -- "$SNAPSHOT_DIR/$old"; done
echo "Completed consistent private snapshot: $name"
