import Link from 'next/link';
import { TurnstileTracker } from '@/components/pools/TurnstileTracker';
import { PageHeader } from '@/components/ui';
import { parseTurnstilePeriod } from '@/lib/turnstile-period';

export default async function TurnstilePage({ searchParams }: {
  searchParams: Promise<{ period?: string | string[] }>;
}) {
  const initialPeriod = parseTurnstilePeriod((await searchParams).period);
  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 sm:py-12">
      <PageHeader
        eyebrow="TURNSTILE_TRACKER"
        title="Turnstile Tracker"
        subtitle="Where does deshielded ZEC go? Track whether it stays on a transparent address, gets reshielded, moves to an exchange, or transfers elsewhere."
      />

      <div className="mb-6 flex flex-col sm:flex-row sm:items-center gap-3 p-4 rounded-xl border border-glass-6 bg-glass-3">
        <p className="text-xs text-secondary font-sans flex-1">
          Turnstile tracking follows ZEC after it exits a shielded pool. &quot;Still held&quot; means the tracked transparent outputs remain unspent. Transfers to labeled exchanges do not prove a sale.
        </p>
        <div className="flex flex-wrap gap-2 shrink-0">
          <Link
            href="/pools#flows"
            className="text-caption font-mono px-3 py-1.5 rounded-md border border-glass-6 text-muted hover:text-secondary hover:border-glass-12 hover:bg-glass-4 transition-colors"
          >
            Shield / Deshield Flows
          </Link>
          <Link
            href="/privacy-risks"
            className="text-caption font-mono px-3 py-1.5 rounded-md border border-glass-6 text-muted hover:text-secondary hover:border-glass-12 hover:bg-glass-4 transition-colors"
          >
            Privacy Risks
          </Link>
          <Link
            href="/pools"
            className="text-caption font-mono px-3 py-1.5 rounded-md border border-glass-6 text-muted hover:text-secondary hover:border-glass-12 hover:bg-glass-4 transition-colors"
          >
            Full Pool Analytics →
          </Link>
        </div>
      </div>

      <div className="animate-fade-in-up stagger-2">
        <TurnstileTracker key={initialPeriod} initialPeriod={initialPeriod} />
      </div>

      <div className="mt-8 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 border-t border-glass-4 pt-6">
        <Link
          href="/"
          className="text-caption font-mono text-muted hover:text-primary transition-colors"
        >
          <span className="text-cipher-gold font-semibold">ZecBlock</span>
          <span className="text-muted"> — Zcash Block Explorer</span>
        </Link>
      </div>
    </div>
  );
}
