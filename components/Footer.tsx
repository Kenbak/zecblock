'use client';

import { ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import { getNavigation, getActiveNavigationHref } from '@/lib/navigation';
import { BrandLogo } from '@/components/BrandLogo';
import Link from 'next/link';
import { DonateButton } from '@/components/DonateButton';
import { ThemeToggle } from '@/components/ThemeToggle';
import { NETWORK, isMainnet, MAINNET_URL, TESTNET_URL, CROSSLINK_URL } from '@/lib/config';

const LINK_CLASS = 'footer-link inline-block py-1.5 text-caption font-mono';
const SECONDARY_LINK_CLASS = 'inline-flex min-h-9 items-center text-caption font-mono text-secondary hover:text-primary hover:underline underline-offset-4 transition-colors';
const categories = getNavigation(NETWORK, 'footer');

const SOCIAL_LINKS = [
  {
    label: 'X', href: 'https://x.com/zecblock',
    path: 'M18.901 1.153h3.68l-8.04 9.19L24 22.846h-7.406l-5.8-7.584-6.64 7.584H.47l8.6-9.835L0 1.154h7.594l5.243 6.932 6.064-6.933Zm-1.29 19.49h2.039L6.487 3.24H4.3l13.31 17.403Z',
  },
  {
    label: 'GitHub', href: 'https://github.com/Kenbak/zecblock',
    path: 'M12 .297C5.37.297 0 5.67 0 12.297c0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.043-1.61-4.043-1.61-.546-1.387-1.333-1.756-1.333-1.756-1.09-.745.083-.729.083-.729 1.205.084 1.838 1.237 1.838 1.237 1.07 1.835 2.809 1.305 3.495.998.108-.776.418-1.305.762-1.605-2.665-.305-5.467-1.334-5.467-5.931 0-1.31.469-2.381 1.236-3.221-.124-.303-.536-1.524.117-3.176 0 0 1.008-.322 3.301 1.23a11.52 11.52 0 0 1 3.003-.404c1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.655 1.652.243 2.873.119 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222 0 1.606-.015 2.898-.015 3.293 0 .322.216.694.825.576C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12',
  },
  {
    label: 'YouTube', href: 'https://www.youtube.com/@AtmosphereLabsDev',
    path: 'M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.121 2.136c1.872.505 9.377.505 9.377.505s7.505 0 9.376-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814ZM9.545 15.568V8.432L15.818 12l-6.273 3.568Z',
  },
];

/**
 * Column key. Same `> KEY` device as PageHeader's eyebrow and SectionHeader,
 * so the footer reads as part of the same system rather than a separate
 * plain-uppercase treatment.
 */
function FooterHeading({ children }: { children: ReactNode }) {
  return (
    <p className="type-label text-muted uppercase mb-3">
      <span className="opacity-50">{'>'}</span> {children}
    </p>
  );
}

export function Footer() {
  const pathname = usePathname();
  const activeHref = getActiveNavigationHref(pathname, categories);

  return (
    <footer className="footer-container border-t border-cipher-border mt-12 sm:mt-16">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-10 sm:py-12">
        <nav aria-label="Footer navigation" className={`grid grid-cols-2 gap-x-6 gap-y-8 ${categories.length === 3 ? 'sm:grid-cols-3' : 'sm:grid-cols-4'}`}>
          {categories.map(category => (
            <div key={category.id}>
              <FooterHeading>{category.label}</FooterHeading>
              <ul className="flex flex-col">
                {category.items.map(item => (
                  <li key={item.href}>
                    <Link href={item.href} className={`${LINK_CLASS} ${activeHref === item.href ? '!text-primary underline underline-offset-4' : ''}`}
                      aria-current={activeHref === item.href ? 'page' : undefined}>
                      {item.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>

        <div className="mt-6 pt-4 border-t border-cipher-border-subtle flex flex-col items-start gap-y-2 sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-8">
          <nav aria-label="Community">
            <ul className="flex items-center">
              {SOCIAL_LINKS.map(social => (
                <li key={social.label}>
                  <a href={social.href} target="_blank" rel="noopener noreferrer"
                    aria-label={`${social.label} (opens in a new tab)`} title={social.label}
                    className="inline-flex h-11 w-11 items-center justify-center rounded-md text-secondary hover:text-primary hover:bg-cipher-hover transition-colors">
                    <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="currentColor" className="h-[18px] w-[18px]">
                      <path d={social.path} fillRule="evenodd" />
                    </svg>
                  </a>
                </li>
              ))}
            </ul>
          </nav>
          <nav aria-label="Ecosystem" className="flex flex-wrap items-center gap-x-4">
            <span className="type-label text-muted uppercase">Ecosystem</span>
            {isMainnet && <a href="https://cipherswap.app/" target="_blank" rel="noopener noreferrer" className={SECONDARY_LINK_CLASS}>CipherSwap ↗</a>}
            <a href="https://www.cipherpay.app/" target="_blank" rel="noopener noreferrer" className={SECONDARY_LINK_CLASS}>CipherPay ↗</a>
          </nav>
        </div>

        <div className="mt-4 pt-4 border-t border-cipher-border-subtle">
          <div className="flex items-center justify-between gap-4">
            <Link href="/" className="inline-flex min-h-11 items-center" aria-label="ZecBlock home">
              <BrandLogo compact />
            </Link>
            <div className="flex items-center gap-1 [&>button]:min-h-11 [&>button]:min-w-11 [&>button]:inline-flex [&>button]:items-center [&>button]:justify-center">
              <DonateButton compact />
              <ThemeToggle />
            </div>
          </div>

          <div className="mt-3 flex flex-col items-start gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between sm:gap-x-6">
            <nav aria-label="Network" className="inline-flex max-w-full flex-wrap items-center gap-x-4 text-caption font-mono">
              {[
                { id: 'mainnet', label: 'Mainnet', href: MAINNET_URL },
                { id: 'testnet', label: 'Testnet', href: TESTNET_URL },
                { id: 'crosslink', label: 'Crosslink', href: CROSSLINK_URL },
              ].map(network => network.id === NETWORK ? (
                <span key={network.id} aria-current="true" className="inline-flex min-h-9 items-center text-secondary underline decoration-cipher-border underline-offset-4">
                  {network.label}
                </span>
              ) : (
                <a key={network.id} href={network.href} className="footer-link inline-flex min-h-9 items-center">
                  {network.label}
                </a>
              ))}
            </nav>
            <nav aria-label="Legal and service information" className="flex flex-wrap items-center gap-x-5 sm:order-first text-caption font-mono">
              <Link href="/privacy-policy" className="footer-link inline-flex min-h-11 items-center">Privacy Policy</Link>
              <Link href="/terms" className="footer-link inline-flex min-h-11 items-center">Terms</Link>
              <a href="https://status.zecblock.com" target="_blank" rel="noopener noreferrer" className="footer-link inline-flex min-h-11 items-center" aria-label="Service status (opens in a new tab)">Status ↗</a>
            </nav>
          </div>

          <p className="mt-5 text-caption text-muted">
            <span className="block sm:inline">© {new Date().getFullYear()} ZecBlock</span>
            <span className="hidden sm:inline" aria-hidden="true"> · </span>
            <span className="mt-1 block sm:mt-0 sm:inline">Zcash blockchain explorer</span>
          </p>
        </div>
      </div>
    </footer>
  );
}
