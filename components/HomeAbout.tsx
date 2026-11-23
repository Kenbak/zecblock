import Link from 'next/link';
import { SectionHeader } from '@/components/ui/SectionHeader';
import { InfoSectionIcon } from '@/components/icons/home-section';
import type { AboutPart, HomeAbout as HomeAboutCopy } from '@/lib/home-about';

const LINK = 'text-primary underline decoration-cipher-border underline-offset-4 transition-colors hover:decoration-current';

function Parts({ parts }: { parts: AboutPart[] }) {
  return <>{parts.map((part, i) => typeof part === 'string'
    ? part
    : part.href.startsWith('http')
      ? <a key={i} href={part.href} className={LINK}>{part.text}</a>
      : <Link key={i} href={part.href} prefetch={false} className={LINK}>{part.text}</Link>)}</>;
}

/**
 * Server-rendered explanation at the bottom of the homepage: live data stays
 * first, and search engines and readers still get what this explorer is.
 */
export function HomeAbout({ about }: { about: HomeAboutCopy }) {
  return (
    <section aria-label={about.heading} className="home-about home-table-section mt-12 sm:mt-14 lg:mt-16 border-t border-cipher-border pt-10 sm:pt-12">
      <SectionHeader label={about.heading} icon={<InfoSectionIcon />} size="lg" />
      <p className="type-prose text-secondary max-w-3xl font-sans"><Parts parts={about.intro} /></p>
      <div className="mt-8 grid grid-cols-1 gap-x-10 gap-y-7 md:grid-cols-2 lg:grid-cols-3">
        {about.items.map(item => (
          <div key={item.question}>
            <h3 className="text-sm font-medium text-primary font-sans">{item.question}</h3>
            <p className="mt-2 text-sm leading-relaxed text-secondary font-sans"><Parts parts={item.answer} /></p>
          </div>
        ))}
      </div>
    </section>
  );
}
