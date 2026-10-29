# Isolated few-block Linux PIR pilot

This is a controlled experiment on mainnet primary `zcash-mainnet`, not a public
private explorer release. The existing production API/node/indexer/database units
are not edited or restarted. No production checkout, schema, DNS, reverse proxy,
firewall rule, wallet endpoint or public listener is changed. The sample database
contains public plaintext chain records; PIR encrypts the selected lookup and
response. It does not hide the operator's IP or qualify every active attack.

## Layout and limits

- Root-owned immutable release: `/opt/zecblock-pir-pilot/releases/<commit>`;
  `/opt/zecblock-pir-pilot/current` selects it.
- State: `/var/lib/zecblock-pir-pilot`, owned by the dedicated nologin account
  `zecblock-pir-pilot`. The query service mounts it read-only; only publication
  can write it. No production credentials are supplied.
- `zecblock-pir-pilot.service` binds **127.0.0.1:4319** only and forbids outbound
  `connect` syscalls. HTTP has no request/access logger. Native stderr is discarded;
  journal output is generic startup/publication status, without query bodies.
- Query/publisher/native descendants share `zecblock-pir-pilot.slice`: aggregate
  **200% CPU quota, 4 GiB MemoryMax, 3 GiB MemoryHigh, zero pilot swap allowance**,
  low CPU/IO weight and 128-task maximum. Two Rayon threads per native child do
  not substitute for the shared quota.
- Serialized one-shot publisher reads four complete confirmed blocks ending two
  blocks behind the observed indexed tip, capped at 64 transactions. It uses
  existing unauthenticated public API GETs and prepares a 16 MiB table, independent
  of browser searches. The optional timer runs 180 seconds after prior completion.
  Disk keeps four publications; the query service keeps three loaded evaluators.
- A 5 GiB state budget reserves 1 GiB for preparation. Each source/artifact file
  is limited to 128 MiB by the publisher unit; only five known candidate files
  are written. Abandoned candidate directories from a killed serialized invocation
  are removed on its next run; symlinks in state are rejected. This is an
  application budget with per-file limits, not a filesystem/project quota.
- Units have no boot enablement. Publisher failures retain the previous pointer
  and report unavailable status; the browser also warns on snapshot age.

## Build and install

Build native Rust in a pinned Linux/amd64 environment with Rust 1.97.1, Cargo.lock
and the existing verified upstream pins. Use baseline x86-64, not `target-cpu=native`
from a different host. Run native tests and retain image digest, toolchain, ABI,
CPU requirements, source commit and executable SHA-256. Build the UI/WASM locally
and run the prototype tests before packaging. No compiler/dependency installation
on the production host is necessary; the runtime uses its existing Node 22.

After committing reviewed source on the same feature branch:

```sh
node prototype/private-tx/pilot/bundle.mjs /absolute/path/to/Linux-native-binary /absolute/path/to/build-receipt.json
```

The bundle records the exact feature commit and every served/executed file hash.
Transfer it into the pilot's own incoming directory. Inspect current production
PIDs, unit-file hashes and health; verify the pilot port/path/account are unused.
Run the reviewed `install.py` as root with archive path, SHA-256 and source commit.
It checks the archive, files and unit syntax and installs only the new pilot
account, directories and units. It refuses existing differing units/releases.
It does **not** start or enable services. Start a one-shot publication, then the
query service, and verify real encrypted answers before starting the timer.

The installer does run `systemctl daemon-reload` to register the new units; it
does not restart existing services. Record all resulting artifact and process
identities separately from production main, node and indexer artifacts.

## Access and verify

Use the same local and remote port because Host/Origin checks are strict:

```sh
ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:4319:127.0.0.1:4319 zcash-mainnet
```

Open `http://127.0.0.1:4319/`; the existing local prototype on4318 is separate.
Copy the active publication's `source.json` through SSH into a local test directory
as an independent public-data oracle; it is never HTTP-served. Keep the publication
fixed while running the acceptance audit, then verify an explicit refresh/handover.

```sh
PRIVATE_TX_TEST_ORIGIN=http://127.0.0.1:4319 \
PRIVATE_TX_TEST_SOURCE=/absolute/path/to/copied/source.json \
node prototype/private-tx/test/tunnel-browser.mjs
```

The browser audit verifies complete detail/raw/price/source parity, reviewed
JS/CSS/WASM hashes, fixed successful chunk shapes/counts, repeated ciphertext
randomness, no selector in URL/header/text/raw/reversed request bytes, no external
traffic/storage or ordinary lookup fallback, and source/database HTTP rejection.
Browser-only fault injection is reported separately from real server answers.
Use host evidence for actual loopback listener, journal output, runtime user,
shared cgroup limits/peak use, no OOM/paging and unchanged production PIDs/unit
hashes/health. A successful `/health` alone does not verify native readiness.

## What remains observable

The server knows publication identity and its complete public catalogue, record
locations/sizes/digests, request/response sizes, counts, timing and completion.
Counts are uniform only within a successful publication lookup; failures abort
early. It sees a loopback HTTP peer through this tunnel, while SSH/network
operators still observe the operator's source IP and connection timing. Browser
code delivery remains trusted. Request scans are regression checks, not a proof
against adaptive malicious responses or a malicious frontend distributor.
Publisher correctness, full history, mempool, concurrency/availability and
independent IP-hiding transport remain separate qualification work.

## Stop / recover

```sh
sudo systemctl stop zecblock-pir-pilot-publish.timer
sudo systemctl stop zecblock-pir-pilot-publish.service zecblock-pir-pilot.service
```

Stop only the SSH forwarding process to close local access. Pilot data and
immutable release remain available for inspection/restart. A host reboot does
not start this experiment automatically. Never enable or restart production or
standby writers as part of this pilot. For failed refresh, retain the previous
publication and use the browser's explicit age/unavailable warning.
