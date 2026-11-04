# Private analytics source transport

## Current rollout — October 6, 2026 JST

Dedicated PostgreSQL authentication/publication/subscription is now active through
this socket. Initial three-table copy finished; new store remains reconciling and
not admitted to Ask. Health timer now uses explicit `--stage copying` via its
reviewed drop-in, covering copying/reconciling with readiness false plus native
worker/enabled/error checks. The bootstrap-only instructions below are the earlier
transport baseline. See [source-feed-operations.md](source-feed-operations.md) for
current source maintenance, WAL guard, verification and pending admission gates.


Dedicated SSH transport carries PostgreSQL traffic from the analytics host to
source loopback `127.0.0.1:5432`. It is a connection path, not a source database
login, publication/subscription or permission for an Ask worker to query primary.
No PostgreSQL restart is needed for this transport-only stage.

The source account `ask_feed_tunnel` has no password, sudo, database grant or
shell, and uses a root-owned home/authorized_keys file. Generate a fresh dedicated
Ed25519 key ON the analytics server; never copy a reusable operator/root key.
Restrict the source authorized key to the analytics egress IPv4 with
`from="ANALYTICS_IPV4",restrict,port-forwarding,permitopen="127.0.0.1:5432",command="/usr/sbin/nologin"`.
Install the reviewed `ask-source-tunnel.conf` SSH Match policy for this account:
only local TCP forwarding, exact destination, no remote/streamlocal forward,
zero sessions, no agent/X11/PTY/user-rc or tunnel interfaces. The account must
have `/usr/sbin/nologin` as its shell, root-owned immutable-by-account key files
and no privileged group membership.

Before reloading SSH, validate `sshd -t` and compare `sshd -T -C user=root,...`
before/after to establish unchanged operator policy. Reconnect through the
existing strictly verified operator key after reload. Do not reload/restart
PostgreSQL or modify its HBA as part of this step. A key option alone that enables
port forwarding also re-enables remote forwarding: the Match policy is required.

On destination substitute SOURCE_HOST in `zecblock-ask-source-transport.service`
with the fixed reviewed source IPv4. Pin its public host key from authenticated
operator access in `/etc/zecblock-ask-source-transport/known_hosts`; do not accept
an unverified ssh-keyscan result. Private identity remains root:root 0600 and
systemd LoadCredential supplies it to the dedicated unprivileged
`ask_feed_transport` process. The service's primary group is postgres so only
trusted local database processes can use the 0660 source Unix socket inside a
0750 directory. Ask query users must not be in this group, mount this directory,
read service credentials or join this service's namespace. There is no new TCP
listener on the analytics host.

Transport options use strict host checking, no agent/config fallback, explicit
IPv4, keepalives, exit-on-forward failure and a systemd restart loop. Egress is
restricted to source IPv4; privileges/devices/home/system writes are restricted.
The endpoint is `/run/ask-source-transport/.s.PGSQL.15432` (libpq host directory
`/run/ask-source-transport`, port15432). Encryption/authentication of the network
hop is SSH; this is not PostgreSQL end-to-end TLS/client-certificate auth.
A later dedicated replication login and separate database grants/HBA are still
required; their secret never goes into the model or query worker.

## Verify and recover

A PostgreSQL handshake via `pg_isready` proves connection reachability, not an
authenticated query or readiness/completeness. Independently verify source and
physical standby health, unchanged WAL/publication/slot state, and destination
NOLOGIN/not-ready boundaries. Test actual server-side refusals for command/SFTP,
non-PostgreSQL forwarding and `-R`, plus denial of the local socket to an
unprivileged account. Authentication/network failure cannot count as a privilege
denial pass. Restart the new tunnel service and verify reconnection/socket modes.

If the tunnel fails, keep public readiness closed; fix transport without falling
back to direct/public primary access. Rollback: stop/disable the destination
transport; remove its dedicated source authorized key and scoped Match file,
validate SSH and reload it with fresh operator access. Remove only the newly
created accounts/files after confirming they are unused. Do not remove existing
operator keys or alter other users' policies. Never silently accept a new source
host key after failover: review source identity and logical-slot continuity too.

## Backup and passive checks

An empty-schema `pg_dump -Fc`/`pg_restore --exit-on-error` drill can run during
mirror initialization. Restore into a newly created disposable destination DB,
verify owners/ACLs/view guards, and delete only that probe DB. It does not verify
full-history backup/PITR, role recreation, off-host recovery or an independent
backup. Do not copy production Storage Box credentials to analytics. Provision
separate repository access/encryption, retention and verified restoration after
implementation works as intended: the owner deferred analytics backups on
October 5, 2026. No analytics backup account/repository/schedule is configured at
this stage; backups do not block the initial private copy. Source PostgreSQL
backups continue unchanged. Monitoring/WAL capacity and reconciliation gates
remain separate.

`host-health.py` and the bootstrap health timer perform fixed read-only checks
for mirror member health/sync status, free disk, private database listener/socket,
dormant reader, bootstrap state and tunnel/socket permissions. Logs go to the
system journal only; no external notifications are configured. Resource warning
thresholds (15% free AND at least128GiB) are conservative operator policy, not
measured query/retention capacity. Transition out of bootstrap intentionally
raises a review alert until its monitoring policy is updated. This monitor is not
the applied-checkpoint/canonical-coverage admission service or SQL sandbox.

An observed WAL delta is a limited sample. Account for source-wide writes,
maintenance/backfills, logical-WAL overhead, copy duration and outage recovery;
short quiet samples cannot size a safe production retention budget.

References: [OpenSSH key restrictions](https://man.openbsd.org/sshd.8),
[OpenSSH Match policy](https://man.openbsd.org/sshd_config.5).
See [logical feed gates](logical-sync.md).
