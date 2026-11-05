# ZNS integration

ZecBlock integrates the [Zcash Name System](https://github.com/zcashme/ZNS)
(ZNS) to resolve human-readable names to Zcash Unified Addresses and display
their public registration history. This document describes the current code;
the provider repository defines the protocol.

## Authority and networks

The configured ZNS indexer is the data authority. ZecBlock does not call the
SDK's `verify()` or display a cryptographic-attestation or custody badge.
Matching the provider's published endpoint and registry identity during release
verification does not turn subsequent responses into cryptographically verified
records.

Mainnet and testnet names belong to separate namespaces. Crosslink uses the
testnet registry while retaining its own explorer/API network identity.

| Explorer network | Default registry URL | Server-side override |
|---|---|---|
| `mainnet` | `https://light.zcash.me/zns-mainnet` | `ZNS_MAINNET_URL` |
| `testnet` | `https://light.zcash.me/zns-testnet` | `ZNS_TESTNET_URL` |
| `crosslink-testnet` | testnet registry (shared) | `ZNS_TESTNET_URL` |

The defaults match `zcashname-sdk@0.12.0`'s published `NETWORKS` configuration;
the repository dependency range is `^0.12.0`. On October 13, 2026, the former
mainnet `/zns-mainnet-test` endpoint returned HTTP 404. The current mainnet
endpoint answered status and registration-list requests successfully, with its
registry address and incoming viewing key matching the installed SDK's mainnet
constants and its admin public key matching the provider's documented key.
These are observations from that verification, not a future availability claim.

Both `lib/zns.ts` and `server/api/v1/config.js` select the network-specific
registry and preserve operator overrides. `getClient()` creates a server-side
SDK singleton whose `network` and URL agree; Crosslink collapses to `testnet`
for that SDK configuration. No user-provided URL chooses the upstream.

## Validation and search

`lib/name-validation.ts` is a dependency-free validator for 1–62 lowercase ASCII
letters or digits, with parity tests against the installed SDK. Name page
parameters are decoded and lowercased before validation. Malformed direct page
URLs return HTTP 404 at the request boundary; an unregistered valid name is a
useful availability page, not a missing resource.

`SearchBar` uses the validator re-exported by `lib/zns.ts` after its address,
block, transaction and known-label checks. Valid name submissions navigate to
`/name/[name]`. Dropdown suggestions are address labels, not ZNS registrations.

## Server rendering and browser refresh

`lib/name-server.ts` shares one request-local React-cached resolution between
metadata, heading/summary and page content. The registration lookup has a
three-second deadline and calls the configured registry directly through
`lib/zns-rpc.ts`. That transport uses an abortable JSON-RPC POST with
`cache: 'no-store'`, validates the response envelope and preserves the distinction
between a returned `null` registration and an upstream error. There is no
persistent cache of uncertain missing-name states.

Optional event history or availability pricing has a separate one-second
deadline. Failure of optional data preserves the resolved registration or
available-name state. Wire fields are normalized to camelCase, including the
current `lastAction` field; obsolete custody/expiry fields are not inferred.

The initial HTML includes the name H1 and a resolution summary. Registered
pages include the full resolved address and transaction identifier, last-action
block and marketplace data where supplied. Event history is limited to 50
events; failure displays explicit unavailability instead of an empty-history
claim. Pricing and listing values come from the registry in zatoshis and are
displayed as ZEC using 100,000,000 zatoshis per ZEC. Registration/marketplace
actions link to the provider's website; ZecBlock does not submit those actions.

`NameClient` starts from this server snapshot and refreshes details/history
through the explorer v1 names API every 60 seconds while visible, and on resume
events. Refresh requests bypass browser caches and have a body-inclusive
15-second deadline. A blocked or failed details refresh retains the last
successful snapshot and labels it accordingly; a successful available-name
response can replace a former registration. Unmounted requests cannot update
state. This behavior avoids replacing useful SSR content with a loading shell.

## API contracts and cache policy

The explorer API's native v1 routes use the same configured registry:

| Route | Purpose |
|---|---|
| `GET /v1/names/status` | Registry status and pricing |
| `GET /v1/names?limit=…&cursor=…` | Registered-name collection with cursor pagination; maximum limit 500 |
| `GET /v1/names/:name` | Registration, or `{ pricing }` when the registry authoritatively returns no registration |
| `GET /v1/names/:name/events` | Event history for the name, limited to 50 events |

Successful responses use the v1 `{ data, meta }` envelope and camelCase fields.
The API metadata retains the explorer network identity, including Crosslink;
registry freshness remains `unknown` unless separately established. Valid
unregistered lookups return HTTP 200. Invalid API names/collection parameters
return HTTP 400. Upstream failure returns a sanitized HTTP 502 problem response
with `Cache-Control: no-store`, rather than claiming the name is available.
Registry RPC requests have a five-second deadline bounded by the API request's
abort signal and a four-MiB response limit. Successful API responses have
`public, max-age=30, stale-while-revalidate=60` cache headers.

The retained frontend-origin compatibility routes `/api/name/:name` and
`/api/name/:name/events` use the SDK singleton and return unwrapped SDK data.
The first returns `{ pricing }` with HTTP 200 for an unregistered name. The v1
API and server page snapshot represent unavailable current-resolver pricing as
explicit `null`, rather than omitting it or inventing a price.
Successful registration responses use 60-second CDN caching with a 120-second
stale-while-revalidate window; successful event responses use 30/60 seconds.
Both routes return HTTP 502 on upstream failure. Current page browser refreshes
use v1, not these compatibility routes.

## Indexation and sitemap discovery

Registered mainnet name pages are eligible for indexing with their normalized
self-canonical, unique metadata, server-rendered content and JSON-LD. Valid
available-name pages and uncertain/error states return useful HTTP 200 pages
with `noindex, follow`. Testnet and Crosslink name pages remain `noindex, follow`
and are excluded from their sitemaps.

The mainnet names sitemap enumerates paginated registrations through the v1 API,
without depending on a registration count in status (the current resolver only
reports synchronization state). Discovery is bounded to 5,000 records and ten
pages with a shared ten-second fetch deadline. It deduplicates normalized names
and rejects invalid records, non-advancing cursors and partial source failures. Its data cache revalidates hourly, its process refresh wrapper
uses a five-minute age/30-second retry interval, and successful XML uses a
one-hour CDN age. A failed source without usable cached data returns HTTP 503,
`Cache-Control: no-store` and `Retry-After: 60`, rather than a fabricated empty
successful sitemap. Cached sitemap membership is a discovery hint; each page
independently resolves its current registration and index policy.

## Relevant source and regression coverage

- `lib/zns.ts`, `lib/zns-rpc.ts`: configured registry access and wire normalization.
- `lib/name-validation.ts`, `lib/name-server.ts`, `lib/name-types.ts`: validation,
  request-local server snapshots and explicit unavailable states.
- `app/name/[name]/`: metadata, H1/summary, SSR details and browser refresh.
- `server/api/v1/config.js`, `server/api/v1/routes/names.js`: native v1 registry
  selection, pagination, response envelopes and failure handling.
- `app/api/name/[name]/`: retained frontend-origin SDK compatibility routes.
- `app/sitemaps/[slug]/route.ts`: registered-name sitemap discovery and failure policy.
- `server/tests/name-rendering.test.js`: default endpoint parity with the installed
  SDK, independent network overrides, Crosslink namespace pairing, server HTML,
  refresh failure preservation and validation.
- `server/api/test/v1/names.test.js`: native API normalization, collection boundaries,
  missing names and sanitized failures.

Dedicated names browsing/marketplace, event-history pagination, name autocomplete,
reverse resolution on address pages and cryptographic-attestation badges remain
separate work.
