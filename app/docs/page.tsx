import Link from 'next/link';
import { PageHeader } from '@/components/ui/SectionHeader';
import { getApiUrl, NETWORK } from '@/lib/api-config';
import { getBaseUrl } from '@/lib/seo';
import ApiReference from './components/ApiReference';
import { getEndpointsByCategory } from './endpoints';
import styles from './docs.module.css';

export default function DocsPage() {
  const baseUrl = getApiUrl();
  const categories = getEndpointsByCategory(baseUrl);
  const endpoints = categories.flatMap(c => c.endpoints);
  const count = (method: string) => endpoints.filter(e => e.method === method).length;
  const networkLabel = NETWORK === 'mainnet' ? 'Mainnet' : NETWORK === 'crosslink-testnet' ? 'Crosslink' : 'Testnet';
  const base = getBaseUrl();
  const schema = { '@context': 'https://schema.org', '@type': 'TechArticle', '@id': `${base}/docs#article`, url: `${base}/docs`, headline: 'Zcash API documentation', description: 'The public ZecBlock v1 endpoint reference, request formats, pagination and response conventions.', isPartOf: { '@id': `${base}/#website` }, publisher: { '@id': 'https://zecblock.com/#organization' } };
  return <div className={styles.page}>
    <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(schema).replace(/</g, '\\u003c') }} />
    <PageHeader eyebrow="DEVELOPERS_API" title="API documentation" subtitle="Build with Zcash data. Explore the v1 endpoints for blocks, transactions, shielded pools and network analytics." actions={<a className="btn btn-sm btn-secondary" href="/openapi-v1.json" download>Download OpenAPI ↗</a>} />
    <div className={styles.metrics}><span><strong>{endpoints.length}</strong> public operations</span><span>{count('GET')} GET · {count('POST')} POST · {count('DELETE')} DELETE</span><span>{networkLabel}</span><span>API base <code>{baseUrl}/v1</code></span></div>
    <ApiReference categories={categories}>
      <section id="quickstart" className={styles.guide}>
        <h2>Quick start</h2>
        <p>Connecting an AI assistant? Use the <Link href="/docs/mcp">read-only Zcash MCP server</Link>.</p>
        <p>Make a request to the API base above. Paths in this reference already include <code>/v1</code>; append them to the host only.</p>
        <pre className={styles.code}><code>{`curl '${baseUrl}/v1/blocks?limit=5'`}</code></pre>
        <p className={styles.note}>The public {networkLabel} v1 API uses <code>{baseUrl}/v1</code>. Endpoint availability follows the selected network. Protected previews may require <code>X-API-Preview-Key</code>; public production reads do not require that header.</p>
        <div className={styles.guideGrid}><div><h3>Access</h3><p>Public data reads do not require an account. Writes can have endpoint-specific requirements: updating or deleting a Crosslink node registration requires its ownership token. Paid/private services and operational routes are excluded from this reference.</p></div><div><h3>Network</h3><p>Confirm <code>meta.network</code> in the response. Endpoint availability and data coverage vary by network; Crosslink routes require a Crosslink deployment.</p></div></div>
      </section>
      <section id="parameters" className={styles.guide}>
        <h2>Using parameters</h2>
        <p>Each endpoint lists its required values, types and known limits. Start with the request template, then add the optional filters you need.</p>
        <div className={styles.guideGrid}>
          <div><h3>Path · choose a resource</h3><p>Replace <code>:heightOrHash</code> in <code>/v1/blocks/:heightOrHash</code> with a block height, such as <code>/v1/blocks/3000000</code>. Do not include the colon or angle brackets.</p></div>
          <div><h3>Query · filter the result</h3><p>Add <code>?</code> before the first value and <code>&amp;</code> between values. For example, <code>?limit=5</code> requests five blocks. Omit an optional parameter to use the endpoint’s default.</p></div>
        </div>
        <pre className={styles.code}><code>{`curl --get '${baseUrl}/v1/blocks' \\
  --data-urlencode 'limit=5'

# Continue the same list using the cursor returned in meta.page.
curl --get '${baseUrl}/v1/blocks' \\
  --data-urlencode 'limit=5' \\
  --data-urlencode 'cursor=<nextCursor>'`}</code></pre>
        <p><code>--get</code> keeps this a GET request; <code>--data-urlencode</code> safely encodes query values. In JavaScript, build query strings with <code>URLSearchParams</code>. Keep the same filters when following a cursor, and do not combine filters unless the endpoint supports that combination.</p>
        <div className={styles.guideGrid}>
          <div><h3>Header · supply access credentials</h3><p>Headers stay outside the URL: <code>-H 'X-Node-Token: &lt;ownership-token&gt;'</code>. Use your registration’s token only for the matching node operation. Preview access uses the separate <code>X-API-Preview-Key</code> header.</p></div>
          <div><h3>JSON body · send structured values</h3><p>POST endpoints show an example <code>request.json</code> and the accepted fields. Save your values in that file, then use <code>--data @request.json</code> with <code>Content-Type: application/json</code>. JSON numbers and booleans are unquoted; strings use double quotes.</p></div>
        </div>
      </section>
      <section id="response-contract" className={styles.guide}>
        <h2>Responses &amp; units</h2>
        <p>Successful responses contain <code>data</code> and <code>meta</code>. The payload belongs to the endpoint; lists with cursor pagination return an array in <code>data</code>. Read freshness and network from <code>meta</code>.</p>
        <pre className={styles.code}><code>{`const response = await fetch('${baseUrl}/v1/blocks?limit=5');
const body = await response.json();
if (!response.ok) {
  throw new Error(body.detail ?? body.title ?? 'Request failed');
}
const { data: blocks, meta } = body;
console.log(blocks, meta.network, meta.freshness);`}</code></pre>
        <div className={styles.guideGrid}><div><h3>Exact amounts</h3><p>Fields identified as zatoshis are decimal strings: <code>100000000</code> zatoshis = 1 ZEC. Preserve them as strings or integers such as JavaScript <code>BigInt</code>. Other monetary fields keep their field-defined units.</p></div><div><h3>Observation time</h3><p><code>meta.generatedAt</code> is response generation time. Data observation time is <code>meta.source.observedAt</code>; it can be null. Missing or unavailable values do not mean zero.</p></div></div>
        <details><summary>Privacy and schema coverage</summary><p>Individual shielded balances and shielded address histories are not publicly queryable. Transparent receivers have public activity; a Unified Address is not itself a public account history. Pool totals are public aggregates.</p><p>The OpenAPI file defines requests and the shared envelope. Many domain payloads still use broad object schemas, so it is not a complete field-by-field data dictionary. This reference avoids fabricating response examples. <Link href="/learn#privacy">Learn about Zcash privacy →</Link></p></details>
      </section>
      <section id="pagination" className={styles.guide}>
        <h2>Pagination</h2>
        <p>Endpoints marked <strong>Cursor pagination</strong> return navigation in <code>meta.page</code>. Use the returned cursor unchanged and retain the same filters. Other endpoints explicitly list their own <code>page</code> or <code>offset</code> parameters.</p>
        <pre className={styles.code}><code>{`// Continue a cursor-paginated block list.
if (meta.page?.hasNext && meta.page.nextCursor) {
  const query = new URLSearchParams({
    limit: '5', cursor: meta.page.nextCursor,
  });
  const next = await fetch('${baseUrl}/v1/blocks?' + query);
  if (!next.ok) throw new Error('Next page failed: ' + next.status);
  const page = await next.json();
  console.log(page.data);
}`}</code></pre>
        <p>Standard cursor lists default to 25 items and allow 1–100. The names collection defaults to 100 and allows 1–500. Endpoint parameters show the applicable bounds.</p>
      </section>
      <section id="errors" className={styles.guide}>
        <h2>Errors &amp; limits</h2>
        <p>Failures use <code>application/problem+json</code> with <code>type</code>, <code>title</code>, <code>status</code> and, when available, <code>detail</code>. Check the HTTP status before reading <code>data</code>. Rate limits are deployment-specific; honor <code>Retry-After</code> on 429 responses.</p>
        <dl className={styles.errorList}>{[['400','Invalid path, query or body.'],['401/403','Preview access or endpoint ownership authorization is missing or denied.'],['404','The resource or enabled route was not found.'],['413','The request body exceeds the accepted size.'],['429','Too many requests; wait before retrying.'],['500','An internal error occurred.'],['502/504','An upstream request failed or timed out.'],['503','The source is unavailable or still building.']].map(([status, description]) => <div key={status} className="contents"><dt><code>{status}</code></dt><dd>{description}</dd></div>)}</dl>
        <p>Scan endpoints have additional range and rate limits. Avoid automatically retrying writes after a timeout: the operation may already have completed.</p>
      </section>
    </ApiReference>
  </div>;
}
