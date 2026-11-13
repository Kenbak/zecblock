# Open data export

Publishes canonical Zcash mainnet tables as Parquet to the
[`zecblock/zcash-mainnet`](https://huggingface.co/datasets/zecblock/zcash-mainnet)
dataset on Hugging Face.

`catalogue.py` lists every published table, with its columns, units and
definition version. Bump a table's `version` when its meaning changes.

## How a snapshot is built

1. Read from the reviewed `analytics_public` views as `ask_public_reader`.
2. Select the last completed UTC date whose blocks are all at least 100 blocks deep.
3. Hold observation tables (`block_timing`, `reorgs`, `orphaned_blocks`) 30 days
   behind that date.
4. Reconcile every partition: row counts against the view, one row per height for
   `blocks` and `issuance`, and `transactions` against block totals minus coinbase.
5. Stage the bundle, verify every file, then swap it in. A failed run keeps the
   previous bundle and publishes nothing.

Finished height buckets are reused between runs. A bucket is rebuilt if its row
count changes or its table's definition version is bumped. `export --full`
rebuilds everything.

Export has database access and no network. Publish has network access and a
token, and no database. Publish refuses a bundle that fails its checksums, has
stray files or would move the dataset backwards, and it never creates the
repository.

## Install on the analytics host

Run as root, from a checkout of the release commit:

```bash
NEEDRESTART_MODE=l apt-get install -y python3.12-venv
install -d -o ask_query -g ask_db_socket -m 0755 /srv/open-data
install -d -m 0755 /opt/zecblock-open-data/server
cp -R server/open-data /opt/zecblock-open-data/server/
python3 -m venv /opt/zecblock-open-data/venv
/opt/zecblock-open-data/venv/bin/pip install -r server/open-data/requirements.txt
cp server/deploy/ask-analytics/zecblock-open-data-*.{service,timer} /etc/systemd/system/
systemctl daemon-reload
```

Store a fine-grained Hugging Face token with write access to the
`zecblock/zcash-mainnet` dataset in `/etc/zecblock/open-data-hf-token`, owned by
root with mode 0600. The dataset repository must already exist.

Run the first export by hand, inspect `/srv/open-data/current`, then
enable the daily timer:

```bash
systemctl start zecblock-open-data-export.service
systemctl enable --now zecblock-open-data-export.timer
```

A successful export starts the publish unit.

## Test

```bash
OPEN_DATA_PG_BIN=/usr/lib/postgresql/16/bin python3 -m unittest discover -s server/open-data
```
