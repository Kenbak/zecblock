import Link from 'next/link';

export function Resources() {
  return (
    <div className="mt-4 rounded-xl border border-cipher-border bg-cipher-card p-5">
      <h2 className="text-sm font-semibold text-primary">Resources</h2>
      <p className="text-xs text-muted mt-2 leading-relaxed max-w-3xl">
        A ZIP-318 migration is a v6 transaction with no transparent I/O whose Orchard value balance is positive
        and Ironwood value balance is negative. The magnitude of the Ironwood value balance equals the output
        denomination. Cohorts are grouped by 144-block anchor boundaries (~3h).
      </p>
      <div className="flex flex-wrap gap-4 mt-4 text-caption font-mono">
        <a href="https://zips.z.cash/zip-0258" target="_blank" rel="noopener" className="text-cipher-gold hover:underline">
          ZIP-258 (NU6.3 Deployment)
        </a>
        <a href="https://zips.z.cash/zip-0318" target="_blank" rel="noopener" className="text-cipher-gold hover:underline">
          ZIP-318 (Migration Spec)
        </a>
        <Link href="/privacy-risks" className="text-cipher-gold hover:underline">
          ZecBlock Privacy Scanner
        </Link>
      </div>
    </div>
  );
}
