import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { platformGet } from '@/lib/api';

type Counts = {
  activeStores: number;
  trialStores: number;
  pastDueStores: number;
  setupIncomplete: number;
  openSupport: number;
  pending10Dlc: number;
  websiteRequests: number;
};

const CARDS: Array<{ key: keyof Counts; label: string; to: string; hint: string }> = [
  { key: 'activeStores', label: 'Active stores', to: '/stores', hint: 'locations.status = active' },
  { key: 'trialStores', label: 'Trial stores', to: '/stores', hint: 'billing_accounts.subscription_status = trialing' },
  { key: 'pastDueStores', label: 'Past due', to: '/stores', hint: 'billing_accounts.subscription_status = past_due' },
  { key: 'setupIncomplete', label: 'Setup incomplete', to: '/stores', hint: 'locations.status = setup' },
  { key: 'openSupport', label: 'Open support', to: '/support', hint: 'open / in_progress / waiting' },
  { key: 'pending10Dlc', label: 'Pending 10DLC', to: '/10dlc', hint: 'pending_review / under_review' },
  { key: 'websiteRequests', label: 'Website requests', to: '/website-requests', hint: 'submitted / drafted / chosen / launch requested' },
];

export function Dashboard() {
  const q = useQuery({
    queryKey: ['platform', 'dashboard'],
    queryFn: () => platformGet<Counts>('/v1/platform/dashboard'),
  });

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Dashboard</h1>
      <p className="text-sm text-slate-600">Counts from live tables. Empty means none, not a placeholder.</p>
      {q.isError ? <p className="text-red-600 text-sm">Failed to load counts.</p> : null}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
        {CARDS.map((card) => (
          <Link key={card.key} to={card.to} className="rounded-xl border border-slate-200 bg-white p-4 hover:border-teal-500">
            <div className="text-sm text-slate-500">{card.label}</div>
            <div className="text-3xl font-semibold mt-1">
              {q.data ? q.data[card.key] : q.isLoading ? '…' : '—'}
            </div>
            <div className="text-xs text-slate-400 mt-2">{card.hint}</div>
          </Link>
        ))}
      </div>
    </div>
  );
}
