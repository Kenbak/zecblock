import { MetadataRoute } from 'next';
import { getBaseUrl, getNetwork } from '@/lib/seo';

export default function robots(): MetadataRoute.Robots {
  if (process.env.VERCEL_ENV === 'preview' && process.env.ASK_STAGING_ENABLED === 'true') {
    return { rules: { userAgent: '*', allow: '/', disallow: ['/api/'] } };
  }
  const network = getNetwork();
  const baseUrl = getBaseUrl();

  if (network === 'crosslink-testnet') {
    return {
      rules: [
        {
          userAgent: '*',
          allow: '/',
          disallow: ['/api/'],
        },
      ],
    };
  }

  // Testnet child pages remain crawlable so bots can read their noindex tags.
  // Crawl-delay is only a hint to supporting crawlers; Googlebot ignores it.
  if (network === 'testnet') {
    return {
      rules: [
        {
          userAgent: 'Googlebot',
          allow: '/',
          disallow: ['/api/'],
        },
        {
          userAgent: 'Bingbot',
          allow: '/',
          disallow: ['/api/'],
          crawlDelay: 10,
        },
        {
          userAgent: '*',
          allow: '/',
          disallow: ['/api/'],
          crawlDelay: 10,
        },
      ],
      sitemap: `${baseUrl}/sitemap.xml`,
    };
  }

  // These are crawl permissions, not server-side rate limits. Googlebot
  // manages its own crawl rate and does not support Crawl-delay. The public
  // announcement JSON is a render dependency; its X-Robots-Tag keeps it noindex.
  return {
    rules: [
      {
        userAgent: 'Googlebot',
        allow: ['/', '/api/governance/announcement$'],
        disallow: ['/api/'],
      },
      {
        userAgent: 'Bingbot',
        allow: ['/', '/api/governance/announcement$'],
        disallow: ['/api/'],
        crawlDelay: 5,
      },
      {
        userAgent: '*',
        allow: ['/', '/api/governance/announcement$'],
        disallow: ['/api/'],
        crawlDelay: 5,
      },
    ],
    sitemap: `${baseUrl}/sitemap.xml`,
  };
}
