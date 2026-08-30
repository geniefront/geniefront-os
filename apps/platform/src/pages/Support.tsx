import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { platformGet } from '@/lib/api';

type Row = {
  id: string;
  locationName: string;
  organizationName: string;
  category: string;
  subject: string;
  status: string;
  priority: string;
  createdAt: string;
};

export function Support() {
  const [status, setStatus] = useState('');
  const list = useQuery({
    queryKey: ['platform', 'support', status],
    queryFn: () => platformGet<{ total: number; items: Row[] }>(
      `/v1/platform/support-requests?status=${encodeURIComponent(status)}`,
    ),
  });

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Support</h1>
      <select
        className="rounded-lg border border-slate-300 px-3 py-2"
        value={status}
        onChange={(e) => setStatus(e.target.value)}
      >
        <option value="">All statuses</option>
        {['open', 'in_progress', 'waiting', 'resolved', 'closed'].map((s) => (
          <option key={s} value={s}>{s}</option>
        ))}
      </select>
      <div className="overflow-auto rounded-xl border border-slate-200 bg-white">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-50 text-left text-slate-500">
            <tr>
              <th className="px-3 py-2">Subject</th>
              <th className="px-3 py-2">Store</th>
              <th className="px-3 py-2">Category</th>
              <th className="px-3 py-2">Priority</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">Created</th>
            </tr>
          </thead>
          <tbody>
            {(list.data?.items ?? []).map((row) => (
              <tr key={row.id} className="border-t border-slate-100">
                <td className="px-3 py-2">
                  <Link className="text-teal-700 hover:underline" to={`/support/${row.id}`}>{row.subject}</Link>
                </td>
                <td className="px-3 py-2">{row.locationName}</td>
                <td className="px-3 py-2">{row.category}</td>
                <td className="px-3 py-2">{row.priority}</td>
                <td className="px-3 py-2">{row.status}</td>
                <td className="px-3 py-2">{row.createdAt?.slice(0, 16)}</td>
              </tr>
            ))}
            {list.data && list.data.items.length === 0 ? (
              <tr><td className="px-3 py-6 text-slate-500" colSpan={6}>No support requests.</td></tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}
