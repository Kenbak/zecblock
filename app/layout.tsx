import { Suspense } from 'react';
import { AskWidget } from '@/components/ask/AskWidget';
import type { Metadata } from "next";
import localFont from "next/font/local";
import { PrivateAnalytics } from "@/components/PrivateAnalytics";
import { NavBar } from "@/components/NavBar";
import { StatsBar } from "@/components/StatsBar";
import { Footer } from "@/components/Footer";
import { MaintenanceBanner } from "@/components/MaintenanceBanner";
import { ChainSyncBanner } from "@/components/ChainSyncBanner";
import { GovernanceBanner } from "@/components/GovernanceBanner";
import { ThemeProvider } from "@/contexts/ThemeContext";
import { WebSocketProvider } from "@/contexts/WebSocketContext";
import { getBaseUrl, getNetwork, getSiteCopy } from "@/lib/seo";
import { HOME_FEED_PREFERENCE_BOOTSTRAP } from '@/lib/home-feed-preferences';
import "./globals.css";

const geistSans = localFont({
  src: "../node_modules/geist/dist/fonts/geist-sans/Geist-Variable.woff2",
  variable: "--font-geist-sans",
  display: "swap",
});

const geistMono = localFont({
  src: "../node_modules/geist/dist/fonts/geist-mono/GeistMono-Variable.woff2",
  variable: "--font-geist-mono",
  display: "swap",
});

const network = getNetwork();
const baseUrl = getBaseUrl();

const siteCopy = getSiteCopy();

// Site-wide defaults only. Title, description, canonical, robots and social
// cards belong to each page (the homepage's live in app/page.tsx), so a page
// without its own metadata never impersonates the homepage.
export const metadata: Metadata = {
  metadataBase: new URL(baseUrl),
  applicationName: 'ZecBlock',
  authors: [{ name: "Kenbak" }],
  creator: "Kenbak",
  publisher: "ZecBlock",
  referrer: 'no-referrer',
  icons: {
    icon: "/brand/zecblock-mark.svg",
    shortcut: "/brand/zecblock-mark.svg",
    apple: "/apple-icon",
  },
  manifest: "/manifest.json",
  alternates: {
    types: {
      'application/rss+xml': `${baseUrl}/newsletter/rss`,
    },
  },
  category: 'technology',
};

// Site-wide JSON-LD structured data.
// WebSite.name + alternateName teach Google the site-name entity for the
// "ZecBlock" brand query; Organization with sameAs links the domain to
// our social/code profiles for entity disambiguation.
const websiteAlternateNames = network === 'mainnet'
  ? ['ZecBlock Zcash Explorer', 'zecblock.com']
  : network === 'testnet'
    ? ['ZecBlock Testnet', 'Zcash Testnet Explorer', 'TAZ Explorer']
    : ['ZecBlock Crosslink', 'Zcash Crosslink Explorer'];

const siteJsonLd = {
  '@context': 'https://schema.org',
  '@graph': [
    {
      '@type': 'WebSite',
      '@id': `${baseUrl}/#website`,
      name: 'ZecBlock',
      alternateName: websiteAlternateNames,
      description: siteCopy.description,
      url: `${baseUrl}/`,
      publisher: { '@id': 'https://zecblock.com/#organization' },
    },
    {
      '@type': 'Organization',
      '@id': 'https://zecblock.com/#organization',
      name: 'ZecBlock',
      alternateName: 'CipherScan',
      url: 'https://zecblock.com',
      logo: 'https://zecblock.com/brand/zecblock-mark.svg',
      sameAs: [
        'https://x.com/zecblock',
        'https://github.com/Kenbak/zecblock',
        'https://z.cash/ecosystem/zecblock/',
      ],
    },
  ],
};

function AppContent({ children }: { children: React.ReactNode }) {
  return (
    <>
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[100] focus:rounded-md focus:bg-cipher-surface focus:px-4 focus:py-2 focus:text-primary focus:shadow-lg"
      >
        Skip to main content
      </a>
      <MaintenanceBanner />
      <ChainSyncBanner />
      <NavBar />
      <StatsBar />
      <GovernanceBanner />
      <main id="main-content" tabIndex={-1} className="min-h-screen">{children}</main>
      <Footer />
      <Suspense fallback={null}><AskWidget /></Suspense>
    </>
  );
}

// Script to prevent flash of wrong theme
const themeScript = `
  (function() {
    try {
      var theme = localStorage.getItem('theme');
      var userChose = localStorage.getItem('theme-user-set');
      if (!theme || !userChose) {
        theme = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
      }
      document.documentElement.classList.remove('light', 'dark');
      document.documentElement.classList.add(theme);
    } catch (e) {}
  })();
`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Supports sitemap-detection tools; robots.txt remains the standards-based declaration. */}
        <link rel="sitemap" type="application/xml" href="/sitemap.xml" />
        {/*
          Site-wide structured data. This lives here, in the server-rendered
          <head>, rather than inside AppContent: AppContent sits under
          ThemeProvider/WebSocketProvider, so it is part of a client subtree,
          and React 19 hoists a <script> rendered by a component out of its
          position. The server emitted it in <body> while the client hoisted
          it, and that divergence was the hydration mismatch reported against
          the element immediately after it (the skip link). Rendering it from
          the server-only layout keeps it in the initial HTML for crawlers,
          which is the whole point of using a plain <script> for JSON-LD.
        */}
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(siteJsonLd) }}
        />
        {/*
          Must be a plain inline script. In the App Router, next/script's
          beforeInteractive emits a self.__next_s queue entry that only runs
          once Next's client runtime loads, so a saved light theme painted
          dark first whenever JavaScript was slow.
        */}
        <script id="theme-init" dangerouslySetInnerHTML={{ __html: themeScript }} />
        <script id="home-feed-preferences" dangerouslySetInnerHTML={{ __html: HOME_FEED_PREFERENCE_BOOTSTRAP }} />
      </head>
      <body className={`${geistSans.variable} ${geistMono.variable}`}>
        <ThemeProvider>
          <WebSocketProvider>
            <AppContent>{children}</AppContent>
          </WebSocketProvider>
        </ThemeProvider>
        <PrivateAnalytics />
      </body>
    </html>
  );
}
