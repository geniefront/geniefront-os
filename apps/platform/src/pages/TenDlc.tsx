import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { platformGet } from '@/lib/api';

type Row = {
  locationId: string;
  locationName: string;
  organizationName: string;
  status: string;
  legalBusinessName: string | null;
  submittedAt: string | null;
};

export function TenDlc() {
  const [status, setStatus] = useState('');
  const list = useQuery({
    queryKey: ['platform', '10dlc', status],
    queryFn: () => platformGet<{ total: number; items: Row[] }>(
      `/v1/platform/10dlc?status=${encodeURIComponent(status)}`,
    ),
  });

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">10DLC internal review</h1>
        <p className="text-sm text-slate-600">
          pending_review means GenieFront received the application. This queue is internal review only.
          It does not submit to TCR or a carrier.
        </p>
      </div>
      <select className="rounded-lg border border-slate-300 px-3 py-2" value={status} onChange={(e) => setStatus(e.target.value)}>
        <option value="">All submitted</option>
        {['pending_review', 'under_review', 'approved', 'rejected'].map((s) => (
          <option key={s} value={s}>{s}</option>
        ))}
      </select>
      <div className="overflow-auto rounded-xl border border-slate-200 bg-white">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-50 text-left text-slate-500">
            <tr>
              <th className="px-3 py-2">Store</th>
              <th className="px-3 py-2">Legal name</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">Submitted</th>
            </tr>
          </thead>
          <tbody>
            {(list.data?.items ?? []).map((row) => (
              <tr key={row.locationId} className="border-t border-slate-100">
                <td className="px-3 py-2">
                  <Link className="text-teal-700 hover:underline" to={`/10dlc/${row.locationId}`}>
                    {row.locationName}
                  </Link>
                </td>
                <td className="px-3 py-2">{row.legalBusinessName ?? '—'}</td>
                <td className="px-3 py-2">{row.status}</td>
                <td className="px-3 py-2">{row.submittedAt?.slice(0, 16) ?? '—'}</td>
              </tr>
            ))}
            {list.data && list.data.items.length === 0 ? (
              <tr><td className="px-3 py-6 text-slate-500" colSpan={4}>No applications.</td></tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}
