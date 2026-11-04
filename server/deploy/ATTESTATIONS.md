# Zero Indexer attestation monitor

Scope: a public observer only. This does not deploy a shim/hub, change wallet
routing, or submit transactions. The active registry has two mainnet endpoints
(Zec.rocks shim and Caution hub) and one Zec.rocks testnet shim. Shielded Labs
requested removal of its retired test hub/shim on 2026-09-10; their registry
records are archived in `attestation-retired-endpoints.json`, and all historical
rebuild evidence remains under `server/data/attestation-builds/`. Archived records
are not polled or exposed through the active API.

Zec.rocks mainnet/testnet baselines are independently reproduced. Their deployment
tags were resolved with `git ls-remote --tags` on 2026-09-10 against the registered
source repositories: `deploy-fdb613db-a606726` → `a6067268a04d14f9821edf6c83d3bdd94dab3776`,
`deploy-a67b428a-da024a0` → `da024a0e3113810a4a10ffc085d43bb849f1a1a0`.
These are deployment-source tags, not an inferred application semver. The manifest's
`version: 1.0` is not used as the software release label. Tags are reviewed metadata;
commits and independent measurements remain the identity anchor. New releases and
tag movements require reviewed updates; polling never promotes a new baseline.

The mainnet rebuilt manifest contains `ZIS_HUB=54.251.201.143:443` and
`ZIS_HUB_TLS=hub.zcash.caution.co`. The API publishes this as reviewed
`hubConfiguration`; the page calls it confirmed only when the latest fresh evidence,
TLS and reproduced PCR match pass together. Missing, failed, mismatched and stale
observations retain reviewed details but explicitly withdraw current confirmation.
This proves a configured destination in the matching build, not network reachability,
actual routing, traffic flow, or the hub's own software status. Testnet's hub remains
unknown: absence of a startup override is not proof of runtime default behavior.
Caution hub's source/build version remains unconfirmed without a reviewed baseline.

Canary compatibility assessment: [CANARY-ASSESSMENT.md](CANARY-ASSESSMENT.md).

## Local preview with real data

Requires Node 22.23.4 or newer within Node 22 and OpenSSL 3 (`openssl` on PATH).
No API key or account.
For the preview, install the frontend and API packages with `npm ci` and
`npm ci --prefix server/api`. The collector itself has no npm dependencies.

```sh
export ATTESTATION_SNAPSHOT_PATH=/tmp/cipherscan-attestations-snapshot.json
npm run attestations:collect
node server/scripts/preview-attestations.js
```

In a second terminal, from the same checkout:

```sh
NEXT_PUBLIC_NETWORK=mainnet NEXT_PUBLIC_API_URL=http://127.0.0.1:3102 npm run dev -- --port 3101
```

Open `http://localhost:3101/network/attestations`. Preview API is loopback-only and runs the real
read-only router without chain/database dependencies. Other public GET reads are proxied to the
selected public API to populate the existing explorer shell, without credentials. It refreshes the snapshot
every five minutes. Use `ZCASH_NETWORK=testnet` for the preview API and
`NEXT_PUBLIC_NETWORK=testnet` for the page to see the testnet endpoint.

## Production installation

Ship the API route with the application, then install the observer. Frontend may
ship before the observer and will show “not checked”/unavailable rather than a
fabricated success. The worker has no npm dependencies: verifier primitives are
vendored at an exact MIT-licensed upstream commit with file hashes in PROVENANCE.
OpenSSL additionally validates the X.509 path against only the pinned Nitro root.

Install the following tree at `/opt/cipherscan-attestations`, root-owned,
directories 0755 and files 0644, from the reviewed main commit:

- `lib/attestation-status.js`
- `server/data/attestation-endpoints.json`
- `server/lib/attestation-store.js`
- `server/lib/attestation-verifier.mjs`
- `server/jobs/check-attestations.mjs`
- `server/vendor/tee-attestation-js/` (including license and provenance)

Require `/usr/bin/node` version 22.23.4 or newer within Node 22 and
`/usr/bin/openssl` version 3. Copy the service and timer files beside this
document into `/etc/systemd/system`, then:

```sh
sudo systemctl daemon-reload
sudo systemctl start cipherscan-attestations.service
sudo systemctl enable --now cipherscan-attestations.timer
sudo systemctl status cipherscan-attestations.timer
sudo journalctl -u cipherscan-attestations.service -n 10
```

The DynamicUser service writes an atomic snapshot to
`/var/lib/cipherscan/attestations/snapshot.json` using systemd StateDirectory.
The existing root API can read it; a future non-root API needs an explicit
read-only group/ACL arrangement. Do not grant the API write access. No schema,
Redis, Rust indexer or chain RPC change is required. The source deployment unit
must be reconciled with live service settings before installation.

Verify `GET /api/network/attestations` on the API host, and the public page's raw
HTML, metadata and displayed timestamps. Mainnet returns two endpoints; testnet
returns one. Unknown endpoint IDs return 404, as do mainnet IDs on testnet.
Crosslink returns an empty API registry and the public page returns 404/noindex.
The mainnet core sitemap includes the page; testnet sitemaps remain homepage-only.

For rollback, stop/disable the timer and service. Retained observations become
stale after 15 minutes; do not replace them with synthetic healthy values. API
and page changes can be reverted independently. Deleting the snapshot produces
an explicit unavailable response with the configured registry still present.

## Data and verification contract

- Worker requests only allowlisted HTTPS hosts on port 443, `/attestation`.
  Public IPv4-only DNS resolution is bound to the connection; redirects and
  private addresses are rejected. The deadline is 15 seconds including DNS,
  handshake and body, with a 64 KiB response limit and concurrency two.
- A fresh 32-byte nonce, pinned-root certificate path, COSE signature, SHA384,
  nonzero 96-hex PCR0/1/2, and timestamp (at most 5 minutes old / 30 seconds ahead)
  are required. TLS binding compares signed mode/domain/certificate fingerprint
  with the same verified HTTPS connection. It is not a wallet-session guarantee.
- `latest` records every attempt. `lastSuccessful` retains the last evidence/TLS
  success without a release mismatch. All times are ISO 8601 UTC; PCRs are
  SHA-384 hex; certificate/document hashes are SHA-256 hex. No money units or
  transaction telemetry are collected. Durations ending in `Ms` are milliseconds.
- `release=unconfirmed` means no baseline exists. `published_match` distinguishes
  externally published values from `reproduced_match`; `mismatch` is not approved.
  Baselines must include all three nonzero PCRs, a commit, an HTTPS reference and
  `authority: published|reproduced`. Add only after review; never promote observed
  values or manifest claims automatically. Changing any registry entry invalidates
  its previous observations until the next check.
- Only a bounded commit matching the registered source URL is exposed from the
  unsigned manifest, labeled claimed/unverified. Manifest URLs/commands are never
  executed or published as arbitrary links. No raw document or untrusted metadata
  is logged; the document digest allows comparing observations without pretending
  that the public API is itself a cryptographic attestation.
- Public API: `success`, `network`, `generatedAt`, `servedAt`, `available`,
  `freshForMs`, `pollIntervalMs`, `endpoints`. Each endpoint may include
  `baseline.tag`, `baseline.tagReferenceUrl` and `hubConfiguration` (hostname,
  dial address, reproduced authority and immutable evidence reference). These are
  reviewed metadata, not unconditional claims about the current runtime. The detail route replaces
  `endpoints` with `endpoint`. Missing/corrupt storage is HTTP 200 with
  `available:false`, null observations and the registry. A connection failure is
  separate from evidence failure. API is no-store and X-Robots-Tag noindex.
- Freshness is derived on API reads and every 15 seconds in the browser, including
  tab visibility changes. At 15 minutes an observation becomes stale, including
  failed observations. A later failure never inherits an earlier green result.
  No historical uptime/SLA claim is made from this single-snapshot store.

Checks: `npm run test:attestations`, relevant sitemap/HTML tests, typecheck/lint,
production build, and real endpoint smoke checks. Upstream verifier updates need
cryptographic negative tests and live checks; do not infer safety from a version
number or an unqualified CLI success line.

## Establish a release baseline

The monitor already compares all three PCRs. The build tooling below produces a
**candidate**, not an active baseline. It never copies measurements from the live
endpoint into a trusted release. `server/data/attestation-build-inputs.json` pins
the two active Zec.rocks source mappings plus two archived Shielded Labs
input records, with complete unsigned build manifests as reproduction inputs; they are not independently established measurements. Caution's hub is
excluded until its operator provides the source mapping.

### Published values

Obtain an operator's release record through a trusted channel, with this shape:

```json
{
  "sourceUrl": "https://github.com/zecrocks/zeronym-shim-mainnet-deploy",
  "commit": "<exact 40-character source commit>",
  "pcrs": { "PCR0": "<96 lowercase hex>", "PCR1": "<96 lowercase hex>", "PCR2": "<96 lowercase hex>" }
}
```

Run `npm run attestations:baseline -- published zecrocks-mainnet release.json
https://operator.example/release candidate.json` (one command). It validates the
record and requires fresh Nitro evidence/TLS and all PCRs to match. The reference
must identify the independently obtained release record, never this monitor's API
or an attestation response. A match has `authority: published`, not `reproduced`.

### Independent reproduction

Run the **Reproduce attestation build** GitHub Actions workflow manually for a
registered endpoint. It uses a disposable Ubuntu 24.04 runner, Docker and a CLI
built from pinned Caution source with locked Rust dependencies. No production
credentials, write token, build caches from other jobs or enclave hosting account
are supplied. The workflow has a 100-minute limit and is not run every five
minutes. It executes third-party build scripts only in that disposable runner.

The wrapper uses a fresh output directory, archives the pinned app commit,
requires the preflight manifest to match reviewed inputs, invokes source-backed
`caution verify --from-tarball ... --no-cache`, and validates the manifest actually
written into the rebuilt enclave. This last check rejects changes between the
preflight and the CLI's fetch. It requires newly written trusted state with the
correct TLS domain, then independently challenges the live HTTPS endpoint again.
An exit code or old `trusted_hashes.json` alone cannot produce a candidate.

On a separate disposable Linux machine with Docker and the CLI built from the
exact `cautionCommit` in the build-inputs file, the equivalent command is:

```sh
npm run attestations:baseline -- reproduce zecrocks-mainnet /path/to/caution \
  /path/to/zeronym-shim-mainnet-deploy /tmp/new-build-result https://example.com/durable-build-evidence
```

The output directory must not already exist. The application checkout must
contain the pinned commit. The candidate records CLI binary/source pins, source
archive hash, build-manifest hash, trusted-state hash and a fresh live check.
GitHub retains the JSON, log and build recipe artifact for 30 days. Archive that
evidence durably before using it as a long-term public baseline reference.
Neither input pinning nor a successful reproduction means the source is safe;
it establishes a reproducible link to the reviewed source/build configuration.

To inspect a changed manifest without executing it:

```sh
npm run attestations:baseline -- inspect zecrocks-mainnet /tmp/unsigned-inputs.json
```

Review new source/configuration/framework/EnclaveOS pins before updating the
build-inputs file. Inspect output is explicitly unsigned and never supplies PCRs.
A failed build, missing source mapping or changed manifest leaves the endpoint
unconfirmed. Do not relax the comparison to get a green result.

### Activation and release rotation

Review the candidate's source, commit, evidence and authority. Preserve the
provenance record, then copy **only its `baseline` object** into that endpoint's
`baseline` field in `server/data/attestation-endpoints.json`. Commit/review this
registry change and ship it to both API and observer; restart the API to reload
the registry. The next collector run validates the new baseline automatically.
The registry identity change invalidates earlier observations. Keep prior
baseline/evidence records in Git history for rollback. A deployment update that
changes PCRs remains a mismatch until its replacement baseline is established.

When rotating a baseline, re-review its optional tag and hub configuration too.
Never carry a previous tag or hub setting onto new measurements without checking
the replacement source and preserved rebuilt manifest.
