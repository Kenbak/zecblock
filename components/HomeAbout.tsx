import Link from 'next/link';
import { getBaseUrl } from '@/lib/seo';
import { HOME_ABOUT_HEADING, HOME_ABOUT_INTRO, HOME_FAQ, buildHomeFaqJsonLd } from '@/lib/home-about';

/**
 * Server-rendered explanation of the explorer for the mainnet homepage.
 *
 * Static copy only: it adds no data fetch, so it cannot slow or fail the
 * homepage render. The FAQPage JSON-LD is built from the same list as the
 * visible questions.
 */
export function HomeAbout() {
  const schema = buildHomeFaqJsonLd(getBaseUrl());

  return (
    <section aria-labelledby="home-about-heading" className="home-about mt-12 sm:mt-16 border-t border-cipher-border pt-8 sm:pt-10">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(schema).replace(/</g, '\\u003c') }} />
      <div className="grid gap-8 lg:grid-cols-[1fr_2fr] lg:gap-12">
        <div>
          <h2 id="home-about-heading" className="type-section text-primary">{HOME_ABOUT_HEADING}</h2>
          <p className="type-prose text-secondary mt-3">{HOME_ABOUT_INTRO}</p>
        </div>
        <div className="grid gap-x-10 gap-y-7 sm:grid-cols-2">
          {HOME_FAQ.map(item => (
            <div key={item.question}>
              <h3 className="text-sm font-medium text-primary">{item.question}</h3>
              <p className="text-sm text-muted leading-relaxed mt-1.5">{item.answer}</p>
              {item.link.href.startsWith('/') ? (
                <Link href={item.link.href} className="mt-2 inline-block text-sm text-secondary hover:text-primary transition-colors">
                  {item.link.label} <span aria-hidden="true">→</span>
                </Link>
              ) : (
                <a href={item.link.href} className="mt-2 inline-block text-sm text-secondary hover:text-primary transition-colors">
                  {item.link.label} <span aria-hidden="true">→</span>
                </a>
              )}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
