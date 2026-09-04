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

const CARDS: Array<{ key: keyof Counts; label: string; to: string; attention?: boolean }> = [
  { key: 'activeStores', label: 'Active stores', to: '/stores' },
  { key: 'trialStores', label: 'Trial stores', to: '/stores' },
  { key: 'pastDueStores', label: 'Past due', to: '/stores', attention: true },
  { key: 'setupIncomplete', label: 'Setup incomplete', to: '/stores', attention: true },
  { key: 'openSupport', label: 'Open support', to: '/support', attention: true },
  { key: 'pending10Dlc', label: 'Pending 10DLC', to: '/10dlc', attention: true },
  { key: 'websiteRequests', label: 'Website requests', to: '/website-requests' },
];

export function Dashboard() {
  const q = useQuery({
    queryKey: ['platform', 'dashboard'],
    queryFn: () => platformGet<Counts>('/v1/platform/dashboard'),
  });

  return (
    <div className="space-y-6">
      <div className="border-b border-slate-200 pb-5">
        <h1>Dashboard</h1>
      </div>
      {q.isError ? (
        <div role="alert" className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-800">
          Failed to load the operational summary.
        </div>
      ) : null}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {CARDS.map((card) => (
          <Link
            key={card.key}
            to={card.to}
            className="group rounded-2xl border border-slate-200 bg-white p-5 shadow-[0_1px_2px_rgba(15,23,42,.04)] transition hover:border-teal-400 hover:shadow-[0_10px_30px_rgba(15,23,42,.07)]"
          >
            <div className="text-sm font-medium text-slate-500">{card.label}</div>
            <div className={`mt-3 text-3xl font-semibold tracking-tight ${card.attention ? 'text-slate-950' : 'text-teal-800'}`}>
              {q.data ? q.data[card.key] : q.isLoading ? '…' : '—'}
            </div>
            <div className="mt-4 text-xs font-semibold text-slate-400 transition-colors group-hover:text-teal-700">View details →</div>
          </Link>
        ))}
      </div>
    </div>
  );
}
