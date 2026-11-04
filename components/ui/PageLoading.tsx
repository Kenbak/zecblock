import { PageHeader } from './SectionHeader';
import { SkeletonTable } from './EmptyState';
import { ChartCardSkeleton, ControlsSkeleton, VisualizationSkeleton, LoadingRegion, MetricSkeletons, Skeleton } from './Skeleton';

export type LoadingLayout = 'blocks' | 'transactions' | 'mempool' | 'privacy' | 'network' | 'nodes' | 'pools' | 'charts' | 'wallets' | 'mining' | 'valuation' | 'rich-list';

/** Page-specific composition of the same primitives used by inline loaders. */
export function PageLoadingBody({ layout }: { layout: LoadingLayout }) {
  if (layout === 'blocks' || layout === 'transactions') {
    const blocks = layout === 'blocks';
    return <LoadingRegion>
      <MetricSkeletons compact labels={blocks ? ['Block height', 'Blocks (24h)', 'Avg block time', 'Avg block fee (24h)', 'TXs per block'] : ['Total transactions', 'Transactions (24h)', '% shielded (24h)', 'TXs per block']} className={`${blocks ? 'sm:grid-cols-3 lg:grid-cols-5' : 'lg:grid-cols-4'} mb-6`} />
      {!blocks && <ControlsSkeleton />}
      <div className="card p-0 overflow-hidden"><SkeletonTable rows={25} headers={blocks ? ["Height", "Hash", "Miner", "TXs", "Size", "Fees", "Interval", "Age"] : ["TXID", "Type", "Flow", "Amount", "Block", "Size", "Age"]} columnClasses={blocks ? ["", "hidden sm:table-cell", "hidden lg:table-cell", "", "hidden md:table-cell", "hidden lg:table-cell", "hidden lg:table-cell", ""] : ["", "", "hidden lg:table-cell", "", "hidden sm:table-cell", "hidden md:table-cell", ""]} label={null} /></div>
      <div className="mt-6"><ControlsSkeleton /></div>
    </LoadingRegion>;
  }
  if (layout === 'valuation') return <LoadingRegion><ControlsSkeleton /><MetricSkeletons labels={['ZEC / USD','24h change','200-day average','365-day drawdown']} className="sm:grid-cols-2 lg:grid-cols-4 mb-4" /><MetricSkeletons labels={['Reported market cap','Reported volume · 24h','Volume / market cap']} className="sm:grid-cols-3 mb-5" /><div className="card card-static p-6 mb-12"><Skeleton className="h-6 w-64 mb-4" /><Skeleton className="h-16 w-full mb-6" /><Skeleton className="h-8 w-full" /></div><ChartCardSkeleton height={300} /><div className="grid xl:grid-cols-2 gap-5 mt-5"><ChartCardSkeleton height={300} /><ChartCardSkeleton height={300} /></div></LoadingRegion>;
  if (layout === 'mining' || layout === 'rich-list') return <LoadingRegion>
    <ControlsSkeleton />
    {layout === 'rich-list' ? <><MetricSkeletons compact labels={['Top 10 concentration', 'Top 100 concentration', 'Transparent supply']} className="sm:grid-cols-3 mb-6" /><div className="card p-0 overflow-hidden"><SkeletonTable rows={25} columns={5} label={null} /></div></> : <>
      <ChartCardSkeleton height={layout === 'mining' ? 280 : 380} />
      <div className="mt-10"><ChartCardSkeleton height={360} /></div>
    </>}
  </LoadingRegion>;
  if (layout === 'privacy') return <LoadingRegion>
    <div className="card card-static mb-5"><div className="card-body"><div className="grid gap-6 pb-6 sm:grid-cols-[220px_minmax(0,1fr)] sm:gap-8">
      <div><p className="text-caption font-mono text-muted mb-3">PRIVACY SCORE</p><Skeleton className="h-12 w-36" /><Skeleton className="h-4 w-32 mt-3" /></div>
      <div className="sm:border-l border-cipher-border sm:pl-8"><Skeleton className="h-5 w-64 mb-3" /><Skeleton className="h-4 w-full mb-2" /><Skeleton className="h-4 w-4/5 mb-4" /><Skeleton className="h-4 w-3/4" /></div>
    </div></div><div className="border-t border-cipher-border px-5 sm:px-6 py-3"><Skeleton className="h-4 w-2/3" /></div></div>
    <div className="rounded-lg border border-cipher-border p-5 sm:p-6 mb-10"><Skeleton className="h-5 w-32 mb-2" /><Skeleton className="h-4 w-96" /></div>
    <Skeleton className="h-5 w-24 mb-5" /><ChartCardSkeleton height={320} title="Historical trends" />
    <div className="grid xl:grid-cols-2 gap-5 mt-10"><ChartCardSkeleton height={340} /><ChartCardSkeleton height={340} /></div>
  </LoadingRegion>;
  if (layout === 'mempool') return <LoadingRegion>
    <MetricSkeletons labels={['Total TXs', 'Shielded', 'Transparent', 'Shielded share']} className="md:grid-cols-4 mb-8" />
    <ControlsSkeleton /><div className="card p-0 overflow-hidden"><VisualizationSkeleton /></div><Skeleton className="h-4 w-4/5 mt-4 mb-8" />
    <div className="card p-0 overflow-hidden mt-6"><SkeletonTable rows={10} columns={6} label={null} /></div>
  </LoadingRegion>;
  if (layout === 'network' || layout === 'nodes') return <LoadingRegion>
    <div className="card card-static mb-10">
      {layout === 'network' && <div className="network-summary-grid network-protocol-facts border-b border-cipher-border">{['Active upgrade', 'Block subsidy', 'Maximum supply', 'Target spacing'].map(label => <div key={label}><p className="type-label text-muted uppercase">{label}</p><Skeleton className="h-5 w-28 mt-2" /></div>)}</div>}
      <div className="network-summary-grid network-live-facts">{(layout === 'network' ? ['Latest block', 'Block interval', 'Transactions · 24h', 'Network hashrate'] : ['Observed active IPs', 'Countries', 'Tor classified', 'Crawler latency']).map(label => <div key={label}><p className="type-label text-muted mb-2">{label}</p><Skeleton className="h-9 w-32" /><Skeleton className="h-4 w-36 mt-2" /></div>)}</div>
    </div>
    <div className="card card-static"><div className="card-body"><Skeleton className="h-6 w-48 mb-3" /><Skeleton className="h-4 w-2/3 mb-5" /><ControlsSkeleton /><VisualizationSkeleton className={layout === 'nodes' ? 'h-[360px] sm:h-[500px]' : 'h-[220px] sm:h-[460px]'} /></div></div>
    <div className="grid lg:grid-cols-2 gap-5 mt-10"><ChartCardSkeleton /><ChartCardSkeleton /></div>
  </LoadingRegion>;
  if (layout === 'pools') return <LoadingRegion><div className="card card-static"><div className="card-body">
    <Skeleton className="h-5 w-48 mb-6" /><Skeleton className="h-4 w-2/3 mb-5" />
    <Skeleton className="h-[132px] sm:h-[156px] w-full" />
    <div className="sm:hidden mt-4 space-y-2">{Array.from({ length: 3 }, (_, i) => <Skeleton key={i} className="h-4 w-full" />)}</div><Skeleton className="h-5 w-1/2 mt-3" />
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-2 border-t border-cipher-border mt-6 pt-5">{Array.from({ length: 4 }, (_, i) => <div key={i} className="p-3"><Skeleton className="h-4 w-20 mb-2" /><Skeleton className="h-5 w-28 mb-2" /><Skeleton className="h-4 w-24" /></div>)}</div>
    <div className="mt-5 border-t border-cipher-border pt-5">
      <div className="mb-3 flex flex-wrap justify-between gap-3"><Skeleton className="h-5 w-44" /><Skeleton className="h-8 w-28" /></div>
      <Skeleton className="h-6 w-full" />
      <div className="mt-2 flex justify-between"><Skeleton className="h-4 w-24" /><Skeleton className="h-4 w-24" /></div>
      <div className="mt-4 grid grid-cols-2 sm:grid-cols-4 gap-2">{Array.from({ length: 4 }, (_, i) => <div key={i} className="p-3"><Skeleton className="h-4 w-20" /><Skeleton className="mt-1 h-4 w-24" /></div>)}</div>
      <Skeleton className="mt-3 h-4 w-2/3" /><Skeleton className="mt-2 h-4 w-3/4" />
    </div><Skeleton className="h-4 w-2/3 mt-3" />
  </div></div></LoadingRegion>;
  if (layout === 'wallets') return <LoadingRegion><ControlsSkeleton /><Skeleton className="h-6 w-48 mb-3" /><Skeleton className="h-4 w-2/3 mb-6" /><MetricSkeletons labels={['Standard fee', 'Priority fee (4x)', 'Custom fee']} columns={1} className="md:grid-cols-3 mb-6" /><ChartCardSkeleton /></LoadingRegion>;
  return <LoadingRegion><ControlsSkeleton /><div className="grid xl:grid-cols-2 gap-5">{Array.from({ length: 6 }, (_, i) => <ChartCardSkeleton key={i} height={240} />)}</div></LoadingRegion>;
}

export function PageLoading({ layout, title, eyebrow, subtitle }: { layout: LoadingLayout; title: string; eyebrow: string; subtitle?: string }) {
  return <div className={`max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 ${layout === 'blocks' || layout === 'transactions' ? 'py-6' : 'py-8'} sm:py-12`}>
    <PageHeader title={title} eyebrow={eyebrow} subtitle={subtitle} titleAsHeading={false} />
    {['privacy', 'network', 'nodes', 'pools'].includes(layout) && <div className="mb-8"><ControlsSkeleton /></div>}
    <PageLoadingBody layout={layout} />
  </div>;
}
