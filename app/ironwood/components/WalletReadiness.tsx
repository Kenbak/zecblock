import { MIGRATION_LIBRARIES, READINESS_REVIEWED_AT, WALLET_READINESS, type ReadinessEntry } from './wallet-readiness-data';
import { WalletReadinessLogo } from '@/components/WalletImplementationLogo';

function ReadinessList({ entries, label }: { entries: ReadinessEntry[]; label: string }) {
  return (
    <ul aria-label={label} className="divide-y divide-cipher-border">
      {entries.map(entry => (
        <li key={`${entry.name}-${entry.platform}`} className="grid gap-3 py-4 lg:grid-cols-[13rem_12rem_1fr] lg:gap-6">
          <div>
            <h3 className="flex items-center gap-2 text-sm font-medium text-primary">
              <WalletReadinessLogo name={entry.name} />
              <span className="min-w-0 break-words">{entry.name}</span>
            </h3>
            <p className="text-caption text-muted mt-1">{entry.platform}</p>
          </div>
          <div>
            <span className="inline-flex items-center gap-2 text-caption text-primary">
              <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${entry.status === 'available' ? 'bg-cipher-green' : 'bg-cipher-orange'}`} />
              {entry.status === 'available' ? 'Available' : 'Limited support'}
            </span>
            <p className="text-caption text-muted mt-1">{entry.method}</p>
          </div>
          <div>
            <p className="text-sm text-muted leading-relaxed">{entry.detail}</p>
            <div className="flex flex-wrap gap-x-5 mt-1">
              {entry.sources.map(source => (
                <a key={source.href} href={source.href} target="_blank" rel="noopener noreferrer"
                  className="inline-flex min-h-11 items-center gap-1 text-caption text-secondary underline decoration-cipher-border underline-offset-4 hover:text-primary hover:decoration-current">
                  {source.label} <span aria-hidden="true">↗</span><span className="sr-only"> for {entry.name} ({entry.platform}); opens in a new tab</span>
                </a>
              ))}
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}

export function WalletReadiness() {
  return (
    <section aria-labelledby="wallet-readiness-heading" className="mt-4 rounded-lg border border-cipher-border card-surface p-4 sm:p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2 mb-2">
        <h2 id="wallet-readiness-heading" className="type-section text-primary">Wallet readiness</h2>
        <p className="text-caption text-muted">Reviewed <time dateTime={READINESS_REVIEWED_AT}>17 Sep 2026</time></p>
      </div>
      <p className="text-sm text-muted leading-relaxed max-w-3xl mb-5">
        Mainnet migration support from published releases and documentation. Availability and migration method are shown separately.
      </p>
      <div aria-hidden="true" className="hidden lg:grid lg:grid-cols-[13rem_12rem_1fr] gap-6 border-b border-cipher-border pb-3 text-caption font-mono text-muted uppercase">
        <span>Wallet</span><span>Migration</span><span>Notes & sources</span>
      </div>
      <ReadinessList entries={WALLET_READINESS} label="Wallet migration support" />
      <details className="border-t border-cipher-border mt-2 pt-2">
        <summary className="min-h-11 py-3 cursor-pointer text-sm text-primary">SDKs & migration libraries <span className="text-muted text-caption ml-2">3</span></summary>
        <ReadinessList entries={MIGRATION_LIBRARIES} label="Migration SDKs and libraries" />
      </details>
      <p className="text-caption text-muted leading-relaxed border-t border-cipher-border pt-4 mt-2">
        Availability is not a ZIP-318 compliance audit. Immediate or full-balance transfers expose the amount crossing between pools.
      </p>
    </section>
  );
}
