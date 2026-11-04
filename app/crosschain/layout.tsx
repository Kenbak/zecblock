import { buildPageMetadata, getBaseUrl } from "@/lib/seo";

export const metadata = buildPageMetadata({
  title: "Crosschain - ZEC Cross-Chain Swap Analytics | ZecBlock",
  description:
    "Explore native ZEC swaps through NEAR Intents, Maya and THORChain with venue-specific charts, transaction records and explicit historical coverage.",
  keywords: [
    "zcash crosschain",
    "ZEC swaps",
    "NEAR Intents",
    "Maya Protocol",
    "THORChain",
    "zcash bridge",
    "ZEC cross-chain",
    "zcash swap volume",
    "ZEC latency",
  ],
  path: "/crosschain",
  networks: ["mainnet"],
});

export default function CrosschainLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const url = `${getBaseUrl()}/crosschain`;
  const schema = {
    "@context": "https://schema.org",
    "@type": "WebPage",
    "@id": `${url}#webpage`,
    url,
    name: metadata.title,
    description: metadata.description,
    isPartOf: { "@id": `${getBaseUrl()}/#website` },
  };
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(schema).replace(/</g, "\\u003c"),
        }}
      />
      {children}
    </>
  );
}
