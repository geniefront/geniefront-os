import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { platformGet, type StoreRow } from '@/lib/api';

export function Stores() {
  const [q, setQ] = useState('');
  const [submitted, setSubmitted] = useState('');
  const list = useQuery({
    queryKey: ['platform', 'stores', submitted],
    queryFn: () => platformGet<{ total: number; items: StoreRow[] }>(
      `/v1/platform/stores?q=${encodeURIComponent(submitted)}&limit=50`,
    ),
  });

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Stores</h1>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setSubmitted(q.trim());
        }}
      >
        <input
          className="flex-1 rounded-lg border border-slate-300 px-3 py-2"
          placeholder="Search name, organization, owner email, or location id"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <button type="submit" className="rounded-lg bg-slate-900 text-white px-4 py-2">Search</button>
      </form>
      {list.isError ? <p className="text-red-600 text-sm">Search failed.</p> : null}
      <div className="overflow-auto rounded-xl border border-slate-200 bg-white">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-50 text-left text-slate-500">
            <tr>
              <th className="px-3 py-2">Store</th>
              <th className="px-3 py-2">Organization</th>
              <th className="px-3 py-2">Owner</th>
              <th className="px-3 py-2">Setup</th>
              <th className="px-3 py-2">Plan</th>
              <th className="px-3 py-2">Subscription</th>
              <th className="px-3 py-2">Created</th>
            </tr>
          </thead>
          <tbody>
            {(list.data?.items ?? []).map((row) => (
              <tr key={row.locationId} className="border-t border-slate-100">
                <td className="px-3 py-2">
                  <Link className="text-teal-700 hover:underline" to={`/stores/${row.locationId}`}>
                    {row.locationName}
                  </Link>
                </td>
                <td className="px-3 py-2">{row.organizationName}</td>
                <td className="px-3 py-2">{row.ownerEmail ?? '—'}</td>
                <td className="px-3 py-2">{row.locationStatus}</td>
                <td className="px-3 py-2">{row.plan ?? '—'}</td>
                <td className="px-3 py-2">{row.subscriptionStatus ?? '—'}</td>
                <td className="px-3 py-2">{row.createdAt?.slice(0, 10)}</td>
              </tr>
            ))}
            {list.data && list.data.items.length === 0 ? (
              <tr><td className="px-3 py-6 text-slate-500" colSpan={7}>No stores match.</td></tr>
            ) : null}
          </tbody>
        </table>
      </div>
      {list.data ? <p className="text-xs text-slate-500">{list.data.total} stores</p> : null}
    </div>
  );
}
