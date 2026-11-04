# CipherScan repository guidance

## SEO shipping checklist

Treat SEO as part of the definition of done for every new or changed page, route, or public feature. Before shipping, complete the applicable checks below.

### 1. Decide indexation and network policy

- Set an explicit `robots` policy for the route; do not rely on inherited defaults for pages whose lifecycle or network matters.
- Mainnet public content and useful tools should normally be `index, follow`.
- Only the testnet homepage is indexable by default. Testnet child routes and dynamic blocks, transactions, and addresses must be `noindex, follow` and omitted from the sitemap so developers can find one clear Zcash testnet/TAZ entry point without creating a duplicate explorer index.
- A future testnet-specific landing page may become indexable only with product-owner approval, distinct search intent and visible copy, an explicit `indexOnTestnet` opt-in, and sitemap inclusion. Do not canonicalize testnet pages to mainnet equivalents when their data and intent differ.
- Keep Crosslink pages `noindex, follow` until the product owner changes that policy. They still need accurate metadata for sharing.
- Filter, sort, search-result, error, and non-content URL variants should normally be canonicalized to the stable content URL or marked `noindex` as appropriate.
- Keep `app/robots.ts`, page-level robots metadata, canonical tags, and sitemap inclusion consistent.

### 2. Add complete, unique metadata

- Give every indexable route a unique, intent-specific title and meta description. Do not inherit homepage copy on a child route.
- Keep the primary topic first and include the approved brand for the target branch/release once. Resolve brand and host from its metadata configuration and the wiki launch status; do not assume a redesign's ZecBlock identity is already live in the CipherScan production release. Prefer natural language over repeated keyword variants.
- Add a self-referencing absolute canonical, using the correct network host.
- Add complete Open Graph and Twitter metadata: title, description, canonical URL, image, image dimensions/alt text where supported, site name, and card/type.
- When a route replaces an older URL, update internal links and add a permanent redirect from the old URL.

### 3. Server-render meaningful page content

- Render one unique `<h1>` in the initial HTML response. A heading that appears only after client-side fetching does not count.
- Server-render a short page introduction or meaningful data summary so loading shells are not duplicate thin pages.
- For transaction hashes, block hashes, addresses, names, and public keys, include the complete identifier in server HTML even if the visual title uses a shortened form.
- Keep title, H1, and visible introduction aligned while avoiding identical boilerplate across large sets of dynamic pages.

### 4. Handle dynamic URL lifecycles

- On mainnet, new and mempool transactions may be indexed while pending. Once confirmed, preserve the same transaction URL and update its status/content. Testnet transaction pages remain `noindex, follow` in every lifecycle state.
- If a pending transaction disappears and no record remains after the reorg/eviction retention window, switch it to `noindex` and return the correct missing-resource status rather than a soft 200.
- Use the numeric block-height page as the canonical URL for a block on the current canonical chain. Keep block-hash lookup pages available, but canonicalize a canonical-chain hash lookup to its current height page so the two views do not compete in search.
- On mainnet, keep persistent orphan-block hash pages self-canonical and indexable when they contain useful data. Label them clearly, describe the reorg state, and link to the canonical replacement height. If a reorg changes the block at a height, update that height page to the replacement block while preserving the orphaned hash page. Testnet orphan pages remain `noindex, follow`.
- On mainnet, index address pages only when the address has authoritative public activity. Empty, private-only, and all testnet address lookups should remain useful `200` pages but `noindex`; malformed or checksum-invalid values should be 404 once authoritative validation is available. Keep address sitemap discovery bounded to protect crawl budget.
- Invalid syntax and resources known not to exist must return `404` (or `410` when deliberately retired). Do not render a not-found message with HTTP 200.
- Cache existence/index lookups, but do not cache uncertain missing states long enough to hide newly arriving mempool or block data.

### 5. Add structured data

- Add the most specific valid JSON-LD type available and ensure it describes visible page content.
- Use stable `@id` values and connect pages to the target release's shared `WebSite`/`Organization` entities.
- Dynamic data cards should expose the full identifier, URL, network, lifecycle status, and relevant block/transaction facts. Do not invent unsupported schema properties or hidden claims.
- Validate JSON-LD and keep it consistent with canonical, title, description, and visible data.

### 6. Connect the page to the crawl graph

- Add stable indexable routes through `lib/sitemaps.ts`, `app/sitemap.xml/route.ts`, and `app/sitemaps/[slug]/route.ts`, as applicable, with the canonical URL and meaningful `lastModified` where available. Under the current policy, the testnet sitemap contains only its homepage.
- Add rolling dynamic URLs only when the sitemap can be refreshed reliably; use crawlable pagination/archive pages so older blocks and transactions remain discoverable after they leave the rolling window.
- Add at least one normal HTML link from a relevant hub, navigation, footer, list, related-content module, or breadcrumb. Do not rely on client-only controls or sitemap discovery alone.
- When adding pagination, use crawlable URLs and links, not only button state or API offsets.
- When IndexNow is configured, notify it only after durable public mainnet URL state changes: a new canonical block, a transaction first entering the mempool, confirmation/reconfirmation, a drop or reorg state change, or newsletter publication/update. Do not submit every poll, testnet/Crosslink pages under the current policy, private/API URLs, noindex pages, missing URLs, filter variants, or block-hash aliases that canonicalize to heights.
- Treat IndexNow as a discovery hint for supported engines, not a replacement for internal links, canonical tags, sitemaps, or Google Search Console.
- Check that no new link points through a redirect or to a missing route.

### 7. Verify before handoff

- Test raw server HTML for title, description, canonical, robots, Open Graph/Twitter tags, structured data, and exactly one non-empty H1.
- Test representative `200`, pending, confirmed, reorg/orphan, invalid, `404`, and redirect cases as applicable.
- Confirm sitemap URLs are canonical, indexable, successful responses and use the correct mainnet/testnet host.
- Confirm robots.txt does not contradict page metadata or sitemap inclusion.
- Run the relevant typecheck, lint, unit, and route tests. Add regression coverage when introducing a new route class or lifecycle state.

## Communication

Call out any assumption or guess that affects indexation, canonical identity, visible copy, or content accuracy. Do not silently infer editorial claims.

## Release verification and cross-repo consistency

- Identify the target branch, exact commit, network, and preview/production environment before release work. Keep redesign previews distinct from main-based production releases; do not infer a deployment from a push or merge.
- After a push that triggers deployments, check every affected Vercel project at that exact commit until it reaches a terminal state. A successful Next.js build does not prove Vercel accepted the routes or completed deployment. Report any pending, failed, or unverified target explicitly.
- Check GitHub Actions conclusions and the latest run attempt. Diagnose failures before retrying; record an unchanged successful retry without hiding the original failure or weakening tests.
- Verify applicable deployed routes and API health. Distinguish local tests, protected-preview checks, and production observations; authentication or sandbox limits must not become a claimed pass.
- Before deploying APIs/indexers, reconcile the intended release with current main and the source/artifact running on each affected host. Record node version, Rust dependency pin, and running indexer artifact separately; updating Zakura alone does not update the parser compiled into the indexer. Keep passive standby writers inactive.
- For routing changes, check platform constraints as well as Next.js behavior. Vercel permits at most 16 entries per `has` or `missing` condition array; retain regression coverage when filters grow.
- For NU7 claims, use serving-node activation parameters and exact zatoshi accounting. Separate measured historical replay capacity from native stream/reorg tests and real activation fixtures. Keep outstanding gates in `architecture/nu7-readiness.md` in the wiki.

## Wiki synchronization

Treat the private workspace wiki at `/Users/imaginarium/code/wiki` as part of
the definition of done for every CipherScan change that affects public
behavior, data meaning, API contracts, database schema, infrastructure,
deployment, operations, security posture, or product status.

- Update the canonical topic page, not only `log.md`.
- Update `entities/cipherscan.md` when product status or shipped capability
  changes, and add a dated `log.md` entry for material releases/incidents.
- Keep frontmatter `updated` dates and factual deployment state current.
- Document exact data authority, units, unavailable/stale semantics, migration
  numbers, and measured performance without inventing or rounding claims.
- Reconcile cross-repo changes with `architecture/data-pipeline.md`,
  `architecture/database-schema.md`, and `architecture/server-infrastructure.md`
  as applicable.
- Verify the wiki diff before handoff and commit it in the wiki repository. The
  wiki is currently local-only and has no Git remote; do not claim it was
  pushed unless a remote is later configured and the push succeeds.
- Preserve unrelated wiki edits and stage only the current task's changes. Keep
  historical entries dated and make the current verified state easy to find.

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
