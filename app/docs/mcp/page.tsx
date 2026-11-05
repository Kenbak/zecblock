import Link from 'next/link';
import { PageHeader } from '@/components/ui/SectionHeader';
import { buildPageMetadata, getBaseUrl, getNetwork } from '@/lib/seo';
import { getApiUrl } from '@/lib/api-config';
import { getTools } from '@/server/api/v1/mcp/catalog';
import styles from '../docs.module.css';

export const metadata = buildPageMetadata({
  title: 'Zcash MCP Server for AI Assistants | ZecBlock',
  description: 'Connect an AI assistant to ZecBlock’s read-only Zcash MCP server. Query public blocks, transactions, shielded pools and network data with exact amounts and coverage.',
  path: '/docs/mcp', index: true, networks: ['mainnet'],
});

export default function McpPage() {
  const network = getNetwork();
  const endpoint = `${getApiUrl()}/v1/mcp`;
  const tools = getTools(network);
  // Shown only once the API enables Zift SQL over MCP (ZIFT_MCP_SQL_ENABLED);
  // set NEXT_PUBLIC_ZIFT_MCP_SQL=true on the frontend at the same time.
  const sqlTools = network === 'mainnet' && process.env.NEXT_PUBLIC_ZIFT_MCP_SQL === 'true';
  const schema = {
    '@context': 'https://schema.org', '@type': 'TechArticle',
    '@id': `${getBaseUrl()}/docs/mcp#article`, url: `${getBaseUrl()}/docs/mcp`,
    headline: 'Zcash MCP server for AI assistants',
    description: metadata.description,
    isPartOf: { '@id': `${getBaseUrl()}/#website` },
    publisher: { '@id': 'https://zecblock.com/#organization' },
  };
  return <div className={styles.page}>
    <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(schema).replace(/</g, '\\u003c') }} />
    <PageHeader eyebrow="DEVELOPERS_MCP" title="Zcash MCP server" subtitle="Give your AI assistant access to public Zcash data: blocks, transactions, shielded pools and network activity, with exact amounts and source coverage." />
    <section className={styles.guide}>
      <h2>Connect your assistant</h2>
      <p>Add a remote MCP server in your assistant’s connector settings and use this URL for the selected network, <strong>{network}</strong>:</p>
      <pre className={styles.code}><code>{endpoint}</code></pre>
      <p>Choose Streamable HTTP and no authentication for the public API. Protected previews require their own preview key. Your assistant must support remote MCP servers; availability depends on the client.</p>
      <p>Claude Code:</p>
      <pre className={styles.code}><code>{`claude mcp add --transport http zecblock ${endpoint}`}</code></pre>
      <p>Codex:</p>
      <pre className={styles.code}><code>{`codex mcp add zecblock --url ${endpoint}`}</code></pre>
      <p>For a client with an MCP configuration file:</p>
      <pre className={styles.code}><code>{JSON.stringify({ mcpServers: { zecblock: { url: endpoint } } }, null, 2)}</code></pre>
      <p>Try asking “What is the latest indexed Zcash block?”, “Show the public pool balances” or “Look up this transaction” with its complete hash. Answers come from your chosen assistant; inspect the returned source URL and metadata.</p>
    </section>
    <section className={styles.guide}>
      <h2>{tools.length} public read tools</h2>
      <p>The connector uses the same validated responses as the <Link href="/docs">REST API</Link>. Availability varies by network and source. Mainnet cross-chain tools distinguish indexed NEAR history from recent Maya and THORChain observations.</p>
      <ul>{tools.map(tool => <li key={tool.name}><code>{tool.name}</code> — {tool.description}</li>)}</ul>
    </section>
    {sqlTools && <section className={styles.guide}>
      <h2>Custom SQL</h2>
      <p>Two more tools let your assistant write its own SQL over the same public datasets as <Link href="/zift">Zift</Link>. Your assistant’s model writes the query; ZecBlock only validates and runs it.</p>
      <ul>
        <li><code>sql_catalogue</code> — datasets, columns, units, query rules and worked examples. No key needed. Read it first.</li>
        <li><code>sql_query</code> — runs one read-only <code>SELECT</code> (CTEs, joins and window functions allowed) and returns up to 200 rows with units, coverage and a result fingerprint. Rejected SQL returns the reason, so your assistant can fix it.</li>
      </ul>
      <p>No key is needed: the setup commands above are enough. All MCP queries share a site-wide allowance per minute and per UTC day, so Zift stays available; nothing that identifies you or your IP address is stored. Queries are read-only and limited to 200 rows.</p>
      <p>Need more? ZecBlock can issue an API key with higher limits. Send it as <code>Authorization: Bearer &lt;key&gt;</code>; in Claude Code add <code>--header &quot;Authorization: Bearer &lt;key&gt;&quot;</code> to the command above, and in Codex set <code>bearer_token_env_var</code> in <code>~/.codex/config.toml</code> so the key stays in an environment variable.</p>
      <p>Try asking “Using sql_query, how did the Orchard pool balance change over the last 30 days?” or “Which miners found the most blocks this week?”.</p>
    </section>}
    <section className={styles.guide}>
      <h2>Data, privacy and limits</h2>
      <p>Zatoshi amounts remain exact decimal strings. Keep the response’s network, observation time, freshness, coverage and cursor metadata. Unknown is not zero; pool balances do not reveal individual shielded balances or transaction histories.</p>
      <p>{sqlTools ? 'The connector accepts public read tools and read-only SQL over the public datasets.' : 'The connector accepts public read tools only. It does not accept SQL.'} It does not accept viewing keys or private keys, and does not broadcast transactions or run paid AI requests. Tool queries are sent to ZecBlock; your assistant provider receives the conversation and results under its own terms. <Link href="/privacy-policy">Read our privacy policy</Link>.</p>
      <p>Each process permits 60 MCP requests per client IP per minute and 16 concurrent requests. Requests are limited to 16 KiB and 15 seconds{sqlTools ? ' (25 seconds while SQL tools are enabled)' : ''}; tool results are limited to 1 MiB. Paginated tools default to 10 items and allow at most 25. Existing upstream timeouts and host rate limits also apply. A result that exceeds the limit returns an error; use a smaller page or the REST API.</p>
      <p>Streamable HTTP uses POST with JSON responses and no persistent sessions. There is no GET event stream. <Link href="/docs">Browse the API reference and exact field conventions</Link>.</p>
    </section>
  </div>;
}
