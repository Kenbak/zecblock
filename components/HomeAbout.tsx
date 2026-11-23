import Link from 'next/link';
import { SectionHeader } from '@/components/ui/SectionHeader';
import { InfoSectionIcon } from '@/components/icons/home-section';
import type { AboutPart, HomeAbout as AboutCopy } from '@/lib/home-about';
import { PAGE_ABOUT } from '@/lib/page-about';
import { getNetwork } from '@/lib/seo';

const LINK = 'text-primary underline decoration-cipher-border underline-offset-4 transition-colors hover:decoration-current';

function Parts({ parts }: { parts: AboutPart[] }) {
  return <>{parts.map((part, i) => typeof part === 'string'
    ? part
    : part.href.startsWith('http')
      ? <a key={i} href={part.href} className={LINK}>{part.text}</a>
      : <Link key={i} href={part.href} prefetch={false} className={LINK}>{part.text}</Link>)}</>;
}

/**
 * Server-rendered explanation placed after a page's live data, so readers and
 * search engines learn what the page shows without pushing the data down.
 */
export function AboutSection({ about, size = 'sm', className = '' }: { about: AboutCopy; size?: 'sm' | 'lg'; className?: string }) {
  return (
    <section aria-label={about.heading} className={`about-section border-t border-cipher-border ${className}`}>
      <SectionHeader label={about.heading} icon={<InfoSectionIcon />} size={size} />
      <p className="type-prose text-secondary max-w-3xl font-sans"><Parts parts={about.intro} /></p>
      {about.more?.map((paragraph, i) => <p key={i} className="type-prose text-secondary max-w-3xl font-sans mt-3"><Parts parts={paragraph} /></p>)}
      {about.items.length > 0 && (
        <div className="mt-8 grid grid-cols-1 gap-x-10 gap-y-7 md:grid-cols-2 lg:grid-cols-3">
          {about.items.map(item => (
            <div key={item.question}>
              <h3 className="text-sm font-medium text-primary font-sans">{item.question}</h3>
              <p className="mt-2 text-sm leading-relaxed text-secondary font-sans"><Parts parts={item.answer} /></p>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

export function HomeAbout({ about }: { about: AboutCopy }) {
  return <AboutSection about={about} size="lg" className="home-about home-table-section mt-12 sm:mt-14 lg:mt-16 pt-10 sm:pt-12" />;
}

/** The About section for a page path; mainnet only (other networks' pages are noindex). */
export function PageAbout({ path }: { path: keyof typeof PAGE_ABOUT }) {
  const about = PAGE_ABOUT[path];
  if (!about || getNetwork() !== 'mainnet') return null;
  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pb-12">
      <AboutSection about={about} className="page-about mt-4 pt-10" />
    </div>
  );
}
