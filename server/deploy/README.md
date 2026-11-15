# CipherScan mainnet operations

These files are the version-controlled source for the mainnet API, Zebra,
scheduled jobs, and PostgreSQL backups. Deployment-local secrets remain outside
Git in `server/api/.env`.

The list-response cache uses the host's private Redis instance. Install Redis,
keep it bound to loopback/private interfaces, and enable persistence before
enabling `API_LIST_CACHE_ENABLED=1`. The API fails open to PostgreSQL if Redis
is unavailable, but archive TTFB will regress until Redis recovers.

Set the rollout controls in `server/api/.env`; the systemd unit deliberately
does not override them so changing the flag to `0` and restarting the API is a
quick rollback:

```dotenv
API_LIST_CACHE_ENABLED=1
API_CACHE_NAMESPACE=mainnet
API_LIST_CACHE_MAX_ENTRIES=1000
API_LIST_CACHE_REDIS_TIMEOUT_MS=50
```

## Install services

```bash
sudo cp server/deploy/zebrad-mainnet.service /etc/systemd/system/
sudo cp server/deploy/zcash-api-mainnet.service /etc/systemd/system/
sudo cp server/deploy/Caddyfile.example /etc/caddy/Caddyfile
sudo systemctl daemon-reload
sudo systemctl enable --now redis-server zebrad-mainnet zcash-api-mainnet caddy
```

## Scheduled jobs

During a full database rebuild, install the reduced profile so analytics do not
publish incomplete aggregates:

```bash
sudo mkdir -p /var/log/cipherscan
crontab server/deploy/crontab.backfill
```

After block coverage is complete and validated:

```bash
crontab server/deploy/crontab.production
```

## Calendar source watcher

`cipherscan-calendar-watch.timer` runs `server/jobs/watch-calendar-sources.js`
every six hours. It reads public forum announcements (governance, Foundation,
protocol, Zebra, ecosystem updates and retroactive-grants organizer posts) and
Zebra/zcashd/Zallet release notes, plus one X recent-search over the ecosystem
accounts in `server/lib/zcash-x-accounts.js` (override with
`CALENDAR_WATCH_X_ACCOUNTS`), extracts upcoming dates and mainnet block
heights, and sends one Telegram digest of candidates not yet in
`/calendar`. It never edits the calendar: approved events are added to
`lib/grant-rounds.ts` or `lib/zcash-calendar.ts` in a normal change.

```bash
node server/jobs/watch-calendar-sources.js --preview   # print candidates; no state, no Telegram
sudo cp server/deploy/cipherscan-calendar-watch.{service,timer} /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now cipherscan-calendar-watch.timer
```

X uses `X_BEARER_TOKEN` if set, otherwise it reads only the `X_ACCESS_TOKEN`
line from the bot's `/root/cipherscan/server/bot/.env`
(`CALENDAR_WATCH_X_TOKEN_FILE`). It never refreshes that token: X refresh
tokens are single-use and the bot owns them. An expired token skips X for that
run. Each run costs one paid X search request.

`node server/scripts/x-pulse.js` uses the same accounts and token rule to brief
what the ecosystem is posting (top posts, trending terms, format of what
performs, our accounts as a baseline) before drafting @zecblock posts.

State (seen sources) lives in `/var/lib/cipherscan-calendar-watch/state.json`;
a document is only marked seen after its digest is delivered.

## Node map

The node map resolves peer IP geolocation via the free ip-api.com batch endpoint
(no API key required). Lookups happen server-side during the cron job; no client
IPs are exposed to the frontend.

1. Apply `cipherscan-rust/schema/migrations/010_node_map.sql`.
2. Run `node server/jobs/sync-nodes.js` once and verify the aggregated node
   endpoints before installing the production crontab.

## PostgreSQL backups

The backup script mounts the Hetzner Storage Box over SSHFS and writes a
custom-format dump directly to that mount. It never creates a full dump on the
server's root disk. The temporary remote filename is verified and atomically
renamed before the success marker is updated.

Prerequisites:

1. Add the server's SSH public key to the Storage Box.
2. Verify key-only access on port 23.
3. Install SSHFS (`apt install sshfs` on Ubuntu).
4. Run `server/deploy/backup-postgres.sh` once manually. Before a destructive
   migration, use `FULL_VERIFY=true server/deploy/backup-postgres.sh` so every
   archive member is read and decompressed before the backup is published.
5. Confirm a non-empty `.dump` exists remotely and record a restore drill.

Override `DATABASE`, `STORAGEBOX`, `STORAGEBOX_PORT`, `STORAGEBOX_PATH`,
`MOUNT_DIR`, or `RETENTION_DAYS` through the environment when needed.
`FULL_VERIFY=true` enables a complete archive read; normal scheduled backups
always validate the custom archive header and table of contents.

Restore into a new database:

```bash
scp -P 23 "$STORAGEBOX":backups/<backup>.dump /tmp/
sudo -u postgres createdb zcash_explorer_restore_test
sudo -u postgres pg_restore \
  --exit-on-error \
  --no-owner \
  --dbname zcash_explorer_restore_test \
  /tmp/<backup>.dump
```

Never treat an upload as verified until a restore drill succeeds.

## Zero Indexer attestation monitor

See [ATTESTATIONS.md](./ATTESTATIONS.md) for the isolated public-endpoint observer,
its read-only API contract, and deployment/rollback instructions. This feature
does not operate a shim or hub and requires no database migration.
