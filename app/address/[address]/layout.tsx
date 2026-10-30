import { CopyButton } from '@/components/CopyButton';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { buildPageMetadata, getAddressResolution, formatNumber, getBaseUrl } from '@/lib/seo';
import type { AddressMeta } from '@/lib/seo';
import { detectAddressType } from '@/lib/zcash';
import { isValidAddressSyntax } from '@/lib/address-syntax';
import { retainLastGoodOrBuildFallback } from '@/lib/isr-fallback';
import { CURRENCY } from '@/lib/config';

type Props = {
  params: Promise<{ address: string }>;
  children: React.ReactNode;
};

export const revalidate = 60;

export function generateStaticParams(): Array<{ address: string }> {
  return [];
}

function getAddressTypeLabel(addr: string, type: string): string {
  if (detectAddressType(addr) === 'tex') return 'TEX';
  if (addr.startsWith('u1') || addr.startsWith('utest')) return 'Unified';
  if (addr.startsWith('zs') || addr.startsWith('ztestsapling')) return 'Sapling Shielded';
  if (type === 'shielded') return 'Shielded';
  return 'Transparent';
}


function getAddressSummary(address: string, meta: AddressMeta | null): string {
  const detectedType = detectAddressType(address);
  const typeLabel = getAddressTypeLabel(address, meta?.type || detectedType);

  if (!meta) {
    return `${typeLabel} Zcash address lookup. Public activity details are temporarily unavailable.`;
  }

  if (meta.isShielded) {
    return `${typeLabel} Zcash address. Shielded balances and activity are private.${meta.type === 'unified' ? ' Transparent receiver activity, if present, can be inspected separately.' : ''}`;
  }

  const transactionSummary = meta.txCount === 0
    ? 'no indexed transactions'
    : `${formatNumber(meta.txCount)} indexed transaction${meta.txCount === 1 ? '' : 's'}`;

  return `${typeLabel} Zcash address with a public balance of ${meta.balance.toFixed(4)} ${CURRENCY} and ${transactionSummary}.`;
}

function serializeJsonLd(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { address } = await params;
  if (!isValidAddressSyntax(address)) notFound();

  const resolution = await getAddressResolution(address);
  const path = `/address/${encodeURIComponent(address)}`;

  const shortAddr = address.length > 20
    ? `${address.slice(0, 10)}...${address.slice(-8)}`
    : address;

  if (resolution.state === 'absent') notFound();

  if (resolution.state === 'unavailable') {
    const fallback = buildPageMetadata({
      title: `Zcash Address ${shortAddr} | ZecBlock`,
      description: `ZecBlock cannot currently verify public activity for Zcash address ${shortAddr} because the address index is temporarily unavailable.`,
      path,
      index: false,
    });
    return retainLastGoodOrBuildFallback(
      fallback,
      new Error(`Address ${shortAddr} metadata is unavailable`),
      'address detail metadata',
    );
  }

  const meta = resolution.meta;

  const typeLabel = getAddressTypeLabel(address, meta.type);
  const title = `Zcash Address ${shortAddr} | ZecBlock`;

  const descParts = [`${typeLabel} Zcash address.`];
  if (!meta.isShielded) {
    const balance = meta.balance.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
    descParts.push(`Public balance ${balance} ${CURRENCY}${meta.txCount > 0 ? ` across ${formatNumber(meta.txCount)} indexed transaction${meta.txCount !== 1 ? 's' : ''}` : ''}.`);
    descParts.push('See its history and address connections.');
  } else {
    descParts.push('Balance and transaction history are encrypted with zero-knowledge proofs.');
  }

  const description = descParts.join(' ');

  const hasPublicActivity = !meta.isShielded && (meta.txCount > 0 || meta.balance > 0);

  return buildPageMetadata({
    title,
    description,
    path,
    // A TEX page repeats the history of its P2PKH address; index that page only.
    index: hasPublicActivity && detectAddressType(address) !== 'tex',
    imageAlt: `${typeLabel} Zcash address ${shortAddr}`,
  });
}

export default async function AddressLayout({
  params,
  children,
}: Props) {
  const { address } = await params;
  if (!isValidAddressSyntax(address)) notFound();

  const resolution = await getAddressResolution(address);
  if (resolution.state === 'absent') notFound();
  if (resolution.state === 'unavailable') {
    retainLastGoodOrBuildFallback(
      undefined,
      new Error(`Address ${address} is unavailable`),
      'address detail',
    );
  }
  const meta = resolution.state === 'found' ? resolution.meta : null;
  const path = `/address/${encodeURIComponent(address)}`;
  const canonical = new URL(path, `${getBaseUrl()}/`).toString();
  const summary = getAddressSummary(address, meta);
  const typeLabel = getAddressTypeLabel(address, meta?.type || detectAddressType(address));
  const texTransparentAddress = detectAddressType(address) === 'tex' ? meta?.transparentAddress : undefined;
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'WebPage',
    '@id': `${canonical}#webpage`,
    url: canonical,
    name: `${typeLabel} Zcash address ${address}`,
    description: summary,
    isPartOf: { '@id': `${getBaseUrl()}/#website` },
    mainEntity: {
      '@type': 'Thing',
      '@id': `${canonical}#address`,
      name: `${typeLabel} Zcash address`,
      identifier: address,
      description: summary,
      url: canonical,
    },
  };

  return (
    <>
      <header className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pt-6 sm:pt-12">
        <span className="text-caption font-mono text-muted tracking-wider">&gt; ZCASH_ADDRESS</span>
        <h1 className="type-page mt-2 text-primary break-all">
          <span className="block">Zcash address</span>{' '}
          <span className="flex items-start gap-2 mt-3 text-sm sm:text-base font-mono font-normal"><span className="min-w-0 break-all">{address}</span><CopyButton text={address} label="address" size="md" /></span>
        </h1>
        <p className="mt-3 text-sm text-secondary">{meta?.isShielded ? `${typeLabel} address. Shielded balances and activity are private.` : 'Public balance, indexed activity and transparent address connections.'}</p>
        {texTransparentAddress ? (
          <p className="mt-2 text-sm text-secondary break-all">
            TEX form (ZIP 320) of transparent address{' '}
            <Link href={`/address/${texTransparentAddress}`} prefetch={false} className="font-mono text-primary underline">{texTransparentAddress}</Link>
            . Both forms share one balance and history.
          </p>
        ) : null}
      </header>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: serializeJsonLd(jsonLd) }}
      />
      {children}
    </>
  );
}
