'use client';

import Link from 'next/link';
import { Card, CardBody } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { NETWORK } from '@/lib/config';
import { useApiQuery } from '@/hooks/useApiQuery';
import { UpgradeClock } from '@/components/network/UpgradeClock';
import { BlockPulse } from '@/components/network/BlockPulse';
import { ChartShareControl } from '@/components/charts/ChartShareControl';
import { HISTORICAL_UPGRADES } from '@/lib/upgrade-history-data';
import { ANNOUNCED_MAINNET_NU7, readUpgradeSnapshot, getFutureBlockUpgrade, estimateBlockArrival, estimateBlockArrivalDate, formatUpgradeTime } from '@/lib/network-upgrades';

export function FutureBlockView({
  targetHeight,
  currentHeight: initialCurrentHeight,
  initialStats,
}: {
  targetHeight: number;
  currentHeight: number;
  initialStats?: unknown;
}) {
  const network = NETWORK === 'crosslink' ? 'crosslink-testnet' : NETWORK;
  const { data, error } = useApiQuery<unknown>('/v1/network/stats', undefined, {
    enabled: NETWORK !== 'crosslink', refreshInterval: 30_000,
    initialData: initialStats ?? undefined,
  });
  const lastVerifiedSnapshot = readUpgradeSnapshot(data, network);
  const snapshot = error ? null : lastVerifiedSnapshot;
  const currentHeight = lastVerifiedSnapshot?.height ?? initialCurrentHeight;
  const upgrade = getFutureBlockUpgrade(targetHeight, network, lastVerifiedSnapshot);
  const announced = upgrade?.authority === 'announcement';
  const blocksRemaining = Math.max(0, targetHeight - currentHeight);
  const estimate = estimateBlockArrival(snapshot, targetHeight);
  const arrivalDate = estimateBlockArrivalDate(snapshot, targetHeight);
  const progressHeight = Number.isSafeInteger(targetHeight) && targetHeight > 0
    && Number.isSafeInteger(currentHeight) && currentHeight >= 0
    ? Math.min(currentHeight, targetHeight) : null;
  // NU7 progress runs from the previous upgrade, so the bar shows this epoch rather than all of chain history.
  const isNu7 = upgrade?.upgradeId === 'nu7' || announced;
  const previous = isNu7 && network !== 'crosslink-testnet'
    ? HISTORICAL_UPGRADES.map(u => ({ label: u.label, height: u.heights[network] })).filter(u => u.height < targetHeight).sort((a, b) => b.height - a.height)[0] ?? null
    : null;
  const progressStart = previous?.height ?? 0;
  const progress = progressHeight === null ? null : Math.max(0, progressHeight - progressStart) / (targetHeight - progressStart) * 100;
  // Reserve a displayed 100% for a chain that has reached the target block.
  const decimals = previous ? 2 : 4;
  const progressLabel = progress === null ? null : (Math.floor(progress * 10 ** decimals) / 10 ** decimals).toFixed(decimals);

  // If the block has been mined while we're on this page, link to it
  if (blocksRemaining <= 0 && !error) {
    return (
      <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-8 animate-fade-in">
        <Card>
          <CardBody className="text-center py-16">
            <h1 className="type-page font-mono text-primary mb-3">
              Block #{targetHeight.toLocaleString()} has been reached
            </h1>
            {announced ? (
              <p className="text-secondary mb-6">The announced NU7 block has been reached. Activation is unverified because the serving node does not report this upgrade.</p>
            ) : upgrade ? (
              <p className="text-secondary mb-6">
                <span className="text-cipher-yellow-bright font-semibold">{upgrade.name}</span> has reached its scheduled block. Open it to check the latest status.
              </p>
            ) : (
              <p className="text-secondary mb-6">
                The network has reached this block. Open it to see the details.
              </p>
            )}
            <div className="flex flex-wrap items-center justify-center gap-3">
              <Link
                href={`/block/${targetHeight}`} prefetch={false}
                className="btn btn-md btn-primary"
              >
                View Block →
              </Link>
              {upgrade?.link && (
                <Link
                  href={upgrade.link}
                  className="btn btn-md btn-secondary"
                >
                  {upgrade.linkText || 'Migration Tracker →'}
                </Link>
              )}
            </div>
          </CardBody>
        </Card>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-6 sm:py-8 animate-fade-in">
      {/* Header */}
      <div className="mb-6">
        <span className="text-caption font-mono text-muted tracking-wider">{upgrade ? 'Network upgrade' : 'Upcoming block'} · Zcash {NETWORK === 'testnet' ? 'testnet' : NETWORK === 'crosslink' ? 'Crosslink testnet' : 'mainnet'}</span>
        <div className="flex flex-wrap items-center gap-3 mt-1">
          <h1 className="type-page font-mono text-primary">
            {announced ? 'NU7 Mainnet Preview' : upgrade?.name === 'NU7 activation' ? 'NU7 Activation' : 'Zcash Block'} #{targetHeight.toLocaleString('en-US')}
          </h1>
          {upgrade ? (
            <Badge color="amber">{upgrade.badge || 'NETWORK UPGRADE'}</Badge>
          ) : (
            <Badge color="muted">UPCOMING</Badge>
          )}
        </div>
        <p className="mt-3 text-xs sm:text-sm text-secondary">
          {announced ? 'Preview the announced NU7 mainnet block and its approximate arrival.' : error ? 'We’re having trouble getting the latest block.' : upgrade ? 'Follow the countdown to the next network upgrade.' : 'This block is still ahead. Follow its progress below.'}
        </p>
      </div>

      {/* Network Upgrade Banner */}
      {upgrade && (
        <div className="mb-6 rounded-xl border border-cipher-yellow-bright/30 bg-gradient-to-r from-cipher-yellow-bright/5 to-transparent p-4 sm:p-5">
          <div className="flex items-start gap-3">
            <div className="flex-shrink-0 mt-0.5">
              <span className="inline-flex items-center justify-center w-8 h-8 rounded-lg bg-cipher-yellow-bright/10 border border-cipher-yellow-bright/20">
                <svg className="w-4 h-4 text-cipher-yellow-bright" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                </svg>
              </span>
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex flex-wrap items-center gap-2 mb-1">
                <span className="text-sm font-semibold text-cipher-yellow-bright">{upgrade.name}</span>
                {upgrade.zip && <Badge color="amber">{upgrade.zip}</Badge>}
              </div>
              <p className="text-xs sm:text-sm text-secondary leading-relaxed">
                {upgrade.description}
              </p>
              {upgrade.link && (
                <Link
                  href={upgrade.link}
                  className="inline-flex items-center gap-1.5 mt-3 text-sm font-medium text-cipher-yellow-bright hover:text-cipher-ironwood transition-colors"
                >
                  {upgrade.linkText || 'Migration tracker →'}
                </Link>
              )}
            </div>
          </div>
        </div>
      )}

      {error && <p role="status" className="mb-4 text-sm text-muted">We can’t update the countdown right now. The block count is from our last update, and the time estimate is paused.</p>}

      <Card className="mb-6">
        <CardBody className="!p-6 sm:!p-8">
          <div className="text-center py-4 sm:py-6">
            {isNu7 && !announced && <div className="flex justify-end -mt-2 -mr-2 mb-1"><ChartShareControl title="NU7 countdown"
              shareUrl={`${NETWORK === 'testnet' ? 'https://testnet.zecblock.com' : 'https://zecblock.com'}/block/${targetHeight}`} shareText="NU7 is coming to Zcash"
              fileName="zecblock-nu7-countdown.png" capture={async () => {
                const response = await fetch('/network/upgrades/card/countdown');
                if (!response.ok) throw new Error('Countdown card unavailable');
                return response.blob();
              }} /></div>}
            <p className="text-sm text-secondary mb-3">{announced ? 'The announced block is expected in' : upgrade ? `${upgrade.name === 'NU7 activation' ? 'NU7' : upgrade.name} arrives in` : 'This block is expected in'}</p>
            {isNu7 && arrivalDate && !announced ? <UpgradeClock target={arrivalDate.dateTime} /> : (
              <div className="text-4xl sm:text-5xl font-semibold tracking-tight text-primary tabular-nums">
                {estimate === null ? 'Time unavailable' : `About ${formatUpgradeTime(estimate.seconds)}`}
              </div>
            )}
            <p className="mt-3 text-sm text-secondary"><span className="font-medium text-primary tabular-nums">{blocksRemaining.toLocaleString('en-US')}</span> {blocksRemaining === 1 ? 'block' : 'blocks'} to go</p>
            {announced ? (
              <p className="mt-3 text-sm text-secondary">Announced date: <time dateTime={upgrade.announcedDate} className="font-medium text-primary">{ANNOUNCED_MAINNET_NU7.dateLabel}</time></p>
            ) : arrivalDate ? (
              <p className="mt-3 text-sm text-secondary">Estimated arrival: <time dateTime={arrivalDate.dateTime} className="font-medium text-primary">{arrivalDate.label}</time></p>
            ) : null}
          </div>
          <div className="mt-6">
            <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
              <span className="text-caption font-mono text-muted uppercase tracking-wider">{previous ? `${previous.label} → NU7` : 'Chain progress'}</span>
              <span className="text-caption font-mono text-secondary tabular-nums">{progressLabel === null ? 'Unavailable' : `${progressLabel}%`}</span>
            </div>
            {progress !== null && progressHeight !== null && (
              <div
                role="progressbar"
                aria-label={previous ? `Progress from ${previous.label} to NU7` : 'Chain progress'}
                aria-valuemin={progressStart}
                aria-valuemax={targetHeight}
                aria-valuenow={progressHeight}
                aria-valuetext={`Block ${currentHeight.toLocaleString('en-US')} of ${targetHeight.toLocaleString('en-US')}; ${blocksRemaining.toLocaleString('en-US')} ${blocksRemaining === 1 ? 'block' : 'blocks'} remaining`}
                className="h-1.5 rounded-full bg-cipher-border overflow-hidden"
              >
                <div
                  className="h-full rounded-full bg-gradient-to-r from-cipher-gold to-cipher-purple transition-[width] duration-1000 motion-reduce:transition-none"
                  style={{ width: `${progress}%` }}
                />
              </div>
            )}
          </div>
          <dl className="mt-6 grid grid-cols-1 gap-5 border-t border-cipher-border pt-6 sm:grid-cols-2 sm:gap-8">
            <div>
              <dt className="text-sm text-secondary mb-2">Latest block</dt>
              <dd className="font-mono text-primary tabular-nums"><Link href={`/block/${currentHeight}`} prefetch={false} className="hover:text-cipher-gold transition-colors">#{currentHeight.toLocaleString('en-US')}</Link></dd>
            </div>
            <div>
              <dt className="text-sm text-secondary mb-2">{announced ? 'Announced block' : upgrade ? 'Activation block' : 'Upcoming block'}</dt>
              <dd className="font-mono text-primary tabular-nums">#{targetHeight.toLocaleString('en-US')}</dd>
            </div>
          </dl>
        </CardBody>
      </Card>
      {isNu7 && <Card className="mb-6">
        <CardBody className="!p-6 sm:!p-8">
          <h2 className="text-sm font-semibold text-primary mb-1">Live blocks</h2>
          <p className="text-caption text-muted mb-4">Every block from the last 20 minutes at its header time. At activation the target drops from 75 to 25 seconds and gold NU7 blocks start arriving about three times as often.</p>
          <BlockPulse nu7Height={targetHeight} targetSeconds={snapshot?.schedule.eras.findLast(era => era.height <= currentHeight)?.seconds ?? null} />
        </CardBody>
      </Card>}
      <p className="text-center text-xs sm:text-sm text-muted leading-relaxed">
        {estimate ? `Timing is based on ${estimate.basis} and updates every 30 seconds. ` : ''}
        {announced ? 'The announced date is approximate; activation still requires a supporting node release. ' : upgrade ? 'The upgrade starts at its activation block. ' : ''}The arrival time may change as blocks are mined.
      </p>
    </div>
  );
}
