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
      <p>For a client with an MCP configuration file:</p>
      <pre className={styles.code}><code>{JSON.stringify({ mcpServers: { zecblock: { url: endpoint } } }, null, 2)}</code></pre>
      <p>Try asking “What is the latest indexed Zcash block?”, “Show the public pool balances” or “Look up this transaction” with its complete hash. Answers come from your chosen assistant; inspect the returned source URL and metadata.</p>
    </section>
    <section className={styles.guide}>
      <h2>{tools.length} public read tools</h2>
      <p>The connector uses the same validated responses as the <Link href="/docs">REST API</Link>. Availability varies by network and source. Mainnet cross-chain tools distinguish indexed NEAR history from recent Maya and THORChain observations.</p>
      <ul>{tools.map(tool => <li key={tool.name}><code>{tool.name}</code> — {tool.description}</li>)}</ul>
    </section>
    <section className={styles.guide}>
      <h2>Data, privacy and limits</h2>
      <p>Zatoshi amounts remain exact decimal strings. Keep the response’s network, observation time, freshness, coverage and cursor metadata. Unknown is not zero; pool balances do not reveal individual shielded balances or transaction histories.</p>
      <p>The connector accepts public read tools only. It does not accept SQL, viewing keys or private keys, and does not broadcast transactions or run paid AI requests. Tool queries are sent to ZecBlock; your assistant provider receives the conversation and results under its own terms. <Link href="/privacy-policy">Read our privacy policy</Link>.</p>
      <p>Each process permits 60 MCP requests per client IP per minute and 16 concurrent requests. Requests are limited to 16 KiB and 15 seconds; tool results are limited to 1 MiB. Paginated tools default to 10 items and allow at most 25. Existing upstream timeouts and host rate limits also apply. A result that exceeds the limit returns an error; use a smaller page or the REST API.</p>
      <p>Streamable HTTP uses POST with JSON responses and no persistent sessions. There is no GET event stream. <Link href="/docs">Browse the API reference and exact field conventions</Link>.</p>
    </section>
  </div>;
}
