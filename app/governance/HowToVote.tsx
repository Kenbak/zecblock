import Link from 'next/link';

const ZODL_GUIDE = 'https://zodl.com/zodl-3-10-0-coinholder-polling-with-ironwood-support/';

/** General instructions; eligibility and availability belong to each poll. */
export function HowToVote({ snapshotHeight }: { snapshotHeight?: number }) {
  return (
    <section
      id="how-to-vote"
      aria-labelledby="how-to-vote-title"
      className="scroll-mt-48 rounded-xl border border-cipher-border bg-cipher-card p-4 sm:p-5"
    >
      <h2 id="how-to-vote-title" className="text-base font-semibold text-primary">How to vote</h2>
      <p className="mt-1 text-sm text-secondary">When a poll is open, cast your vote in your wallet. Use ZecBlock to explore the proposals and results.</p>

      <ol className="mt-5 grid gap-5 md:grid-cols-3">
        <li>
          <h3 className="text-sm font-medium text-primary"><span className="mr-2 font-mono text-cipher-gold">01</span>Open a supported wallet</h3>
          <p className="mt-2 text-sm leading-relaxed text-secondary">Update your wallet to the latest version and let it finish syncing. Use its voting section to find the poll.</p>
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-2 text-xs text-cipher-gold">
            <a href="https://zodl.com/" target="_blank" rel="noopener noreferrer" className="hover:underline">Zodl ↗</a>
            <a href="https://vizor.cash/" target="_blank" rel="noopener noreferrer" className="hover:underline">Vizor ↗</a>
            <a href="https://hhanh00.github.io/zkool2/" target="_blank" rel="noopener noreferrer" className="hover:underline">Zkool ↗</a>
          </div>
        </li>
        <li>
          <h3 className="text-sm font-medium text-primary"><span className="mr-2 font-mono text-cipher-gold">02</span>Check your eligible balance</h3>
          <p className="mt-2 text-sm leading-relaxed text-secondary">Follow the wallet’s eligibility check. Each poll uses a snapshot: an earlier point in the blockchain used to determine which funds can vote.</p>
          {snapshotHeight !== undefined && (
            <Link href={`/block/${snapshotHeight}`} prefetch={false} className="mt-2 inline-block text-xs text-cipher-gold hover:underline">
              This poll’s snapshot: block {snapshotHeight.toLocaleString('en-US')} →
            </Link>
          )}
        </li>
        <li>
          <h3 className="text-sm font-medium text-primary"><span className="mr-2 font-mono text-cipher-gold">03</span>Review, choose &amp; submit</h3>
          <p className="mt-2 text-sm leading-relaxed text-secondary">Read the proposals, choose your answers or abstain where offered, then submit in your wallet before the deadline. Check the wallet’s status to confirm submission.</p>
        </li>
      </ol>

      <div className="mt-5 border-t border-cipher-border-subtle pt-3 text-xs leading-relaxed">
        <p className="text-secondary">
          <span className="font-medium text-primary">Using Zodl?</span>{' '}
          Open Settings → Coinholder Polling → select the poll.{' '}
          <a href={ZODL_GUIDE} target="_blank" rel="noopener noreferrer" className="text-cipher-gold hover:underline">Wallet guide ↗</a>
        </p>
        <p className="mt-2 text-muted">No poll or eligible balance showing? Check that your wallet supports this poll and has finished syncing. Your current balance alone does not establish eligibility.</p>
        <p className="mt-2 text-muted">ZecBlock never asks for your recovery phrase or private keys. You do not send ZEC to ZecBlock to vote.</p>
        <a href="https://shieldedlabs.net/governance/" target="_blank" rel="noopener noreferrer" className="mt-2 inline-block text-muted underline decoration-cipher-border underline-offset-4 hover:text-secondary">Supported wallets &amp; participation information ↗</a>
      </div>
    </section>
  );
}
