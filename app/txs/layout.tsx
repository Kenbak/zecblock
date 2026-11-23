import { PageAbout } from '@/components/HomeAbout';
export default function TransactionsLayout({ children }: { children: React.ReactNode }) {
  return <>{children}<PageAbout path="/txs" /></>;
}
