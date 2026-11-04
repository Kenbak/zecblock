# Authenticated staging Ask API

`ask-staging-api.js` is a separate entry point for an access-controlled staging
frontend. It never imports the production monolith, dotenv, database pools or
the local preview's dummy CAPTCHA/simulated-IP implementation. It composes the
same Ask router, bounded quotas, provider reservations and loopback SQL-worker
client. Existing `ask-preview-api.js` remains a loopback-only test fixture and
must not be exposed through this staging listener.

The intended path is: authenticated Vercel preview → same-origin Node gateway →
mutually authenticated HTTPS at `135.181.17.198:8443` → staging Ask router →
existing loopback worker3015 → restricted analytics PostgreSQL reader.
Ask chart/stats browser reads use the protected, fixed-origin GET bridge described
below; server rendering retains the explicit public API origin. Staging setup does not
change the public guided API, source feed, PostgreSQL grants or query budgets.

## Explicit admission contract

The API requires `ASK_STAGING_ENABLED=true`, a valid client CA, the exact pinned
gateway client leaf fingerprint, and a server certificate valid for IP SAN
`135.181.17.198`. HTTPS requires client certificates, verifies their chain and
then compares the peer leaf SHA256 with `ASK_STAGING_CLIENT_FINGERPRINT256`.
The server supports TLS1.2/1.3, bounds handshakes to5s and connections to16.
No plaintext or non-mTLS alternate listener is created.

Only after that certificate check does it accept a single valid IPv4/IPv6
`x-ask-staging-client-ip` and attach immutable server-side
`req.v1.authenticatedStaging=true`. A request body/header cannot set this state.
Requests must use Host `135.181.17.198:8443`. The gateway strips Origin, Cookie,
Authorization, Forwarded, X-Forwarded-For, X-Real-IP and X-Sim-IP; the API refuses
them. It does not trust Express proxy headers. The gateway derives the IP from
the deployment platform's trusted client-IP field, with an explicit fixed
shared bucket if that field is unavailable. Never accept a visitor-selected
simulated IP or put the client certificate/key in a browser bundle.

Authenticated mTLS staging admission **replaces CAPTCHA** for this service.
It is not simulated Turnstile verification and is not a test of production bot
protection. The capability response adds `authenticatedStaging:true` and sets
`siteKey:null`. Missing/empty challenge is valid only with this configured
staging router and its server-verified request state. Default production router
construction still requires and verifies real Turnstile action/hostname even
if a visitor sends staging-looking fields or headers.

IP5/minute and20/day admission, provider call/cost reservations, shared
concurrency, Redis-failure refusal, SQL leases, AST policy, dataset readiness,
3s quick/30s queued execution, two DB slots and output limits are unchanged.
The staging service shares the existing configured Redis budget ledger; there
is no reset or new independent allowance. Approved daily/monthly/model values
are inherited from the protected API environment file. Production readiness or
natural-language correctness is not implied by authenticated access.

## Runtime environment and files

Use `staging-api.service` as a reviewed template. Its `ask_stage` user/group is
separate from the private preview API and worker. Source, lockfile dependencies,
runtime, symlink targets and their parent directories must be root-owned and
non-writable by that user. The service inherits the existing root-only
`/opt/zecblock-ask-api-preview/api.env`, then reads the root-only
`/etc/zecblock/ask-staging.env` shown in `staging-api.env.example`.

Required new values:

```dotenv
ASK_STAGING_ENABLED=true
ASK_PRIVATE_PREVIEW=false
ASK_PREVIEW_SIMULATE_IPS=false
ASK_STAGING_CA_FILE=/etc/zecblock-ask-staging/ca.pem
ASK_STAGING_CERT_FILE=/etc/zecblock-ask-staging/server.pem
ASK_STAGING_KEY_FILE=/etc/zecblock-ask-staging/server.key
ASK_STAGING_CLIENT_FINGERPRINT256=APPROVED_CLIENT_LEAF_SHA256
```

The fingerprint accepts exactly64hex digits or OpenSSL's colon-separated SHA256
format. Every certificate directory parent must allow traversal by `ask_stage`;
keep the existing root-only `/etc/zecblock` directory private and put the
service-readable TLS material in `/etc/zecblock-ask-staging` (root:ask_stage0750).
Certificate/key files must be regular files of at most64KiB. The server
key may be root:ask_stage mode0640; it must have no group-write or other-user
access. Public certificates can use root:ask_stage0640. The CA **private key**
stays in a separate root-only operator location; it is never an application or
Vercel credential. A CA private key in a certificate/CA file is refused. Keep
the gateway client private key only in server-side preview-scoped secrets.
Retain normal CA/IP-SAN verification in the gateway; never set
`rejectUnauthorized:false` or override hostname checks to accept a mismatch.

`ASK_PRIVATE_PREVIEW` and `ASK_PREVIEW_SIMULATE_IPS` cannot enable any fixture
behavior. Known database/RPC credential aliases are refused before router
construction; this hygiene check is not proof that every possible inherited
secret was excluded. Provider, worker-service and quota credentials remain on
the server, as required by the existing separated design.

## Source adapter and request limits

The indexed-record/chart source adapter reuses `createInternalClient` with a
fixed `https://api.zecblock.com` origin, GET-only dispatch, no service key,
cookies, node tokens or payment/auth headers. It rejects redirects, retains
query parameters and parent cancellation, has an8s timeout and caps responses
at1MiB. Larger/unavailable source replies fail honestly; there is no direct
source database or RPC connection and no fallback to a privileged primary pool.

Only GET `/v1/ask` and the existing bounded Ask POST routes are admitted. No
query-selected upstream, arbitrary proxy, non-Ask routes or write methods are
exposed. Incoming JSON is capped at16KiB; response JSON at270000bytes. Headers,
request/idle/keep-alive times and active connections are bounded. The API uses
private/no-store and noindex/nofollow headers, generic failures, fresh request
IDs and abort signals. Questions, SQL, tokens, certificates and raw exceptions
must not be added to access/application logging.

## Browser public-data bridge

Protected previews have a different Origin from production. Do not weaken the
public API CORS policy to make the preview work. With preview-only
`ASK_STAGING_ENABLED=true` and browser mainnet `NEXT_PUBLIC_ASK_STAGING=true`,
`/api/staging-data/*` admits only the exact public GETs used by Ask evidence,
network statistics and freshness. It fixes the upstream to
`https://api.zecblock.com`, forwards only Accept and the bounded query string,
never credentials or the browser Origin, rejects redirects, and bounds the
complete JSON response to1MiB/9s including body consumption. Both JSON and
problem+json preserve status and Retry-After. All responses are no-store/noindex.
This allowance covers Ask acceptance, not every API on other preview pages.
Configure `NEXT_PUBLIC_WS_URL=wss://api.zecblock.com` explicitly so the relative
GET base is never interpreted as a WebSocket URL. If the public event feed
refuses the preview Origin, HTTP polling remains the data path.

## Acceptance and rollback

Local TLS tests generate disposable certificates and prove correct-client
success, missing-client failure, same-CA wrong-leaf refusal, wrong server name
refusal, plaintext refusal, malformed/oversized-body refusal and cancellation.
Router tests verify stage-only capabilities and unchanged production CAPTCHA
and budget paths. All provider/source traffic in these tests is mocked.

Before real staging acceptance, reconcile exact commits/source hashes of the
frontend, gateway, staging API and worker. Verify preview protection on the
actual preview and its gateway route; direct8443 access without a client cert
must fail. Then verify the pinned mTLS gateway, real client-IP attribution and
fixed fallback, request/body/abort handling, shared budget failures and browser
SQL/job lifecycle against fresh coverage. Do not describe local TLS fixtures as
Vercel egress/mTLS or real-model acceptance. Mark staging pages explicitly
noindex; production route metadata is separate.

Only the new staging unit and approved8443 firewall rule are installed for this
topology. No source/PG/worker/public API restart is necessary. Roll back by
closing that rule and stopping the staging unit, then remove the preview's
staging gateway configuration. Preserve quota counters and error evidence.
Certificate rotation updates the server-owned leaf pin and preview server-only
client material together; expired/mismatched identities fail closed.

The owner-authorized protected staging rollout may enable this separate service
at boot (`systemctl enable --now zecblock-ask-staging.service`). It must retain
SSO and mTLS, fail closed on certificate expiry, and be disabled when staging
is retired. Enabling this unit does not enable the loopback test fixture.
