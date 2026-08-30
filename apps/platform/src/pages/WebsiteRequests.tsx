import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { platformGet } from '@/lib/api';

type Row = {
  briefId: string;
  locationName: string;
  organizationName: string;
  status: string;
  submittedAt: string | null;
  launchRequestedAt: string | null;
  openRevisions: number;
};

export function WebsiteRequests() {
  const list = useQuery({
    queryKey: ['platform', 'website'],
    queryFn: () => platformGet<{ total: number; items: Row[] }>('/v1/platform/website-requests'),
  });

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">Website requests</h1>
        <p className="text-sm text-slate-600">
          Operational queue for storefront briefs, revisions, and launch requests.
          This is not a website builder.
        </p>
      </div>
      <div className="overflow-auto rounded-xl border border-slate-200 bg-white">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-50 text-left text-slate-500">
            <tr>
              <th className="px-3 py-2">Store</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">Submitted</th>
              <th className="px-3 py-2">Launch requested</th>
              <th className="px-3 py-2">Open revisions</th>
            </tr>
          </thead>
          <tbody>
            {(list.data?.items ?? []).map((row) => (
              <tr key={row.briefId} className="border-t border-slate-100">
                <td className="px-3 py-2">
                  <Link className="text-teal-700 hover:underline" to={`/website-requests/${row.briefId}`}>
                    {row.locationName}
                  </Link>
                </td>
                <td className="px-3 py-2">{row.status}</td>
                <td className="px-3 py-2">{row.submittedAt?.slice(0, 16) ?? '—'}</td>
                <td className="px-3 py-2">{row.launchRequestedAt?.slice(0, 16) ?? '—'}</td>
                <td className="px-3 py-2">{row.openRevisions}</td>
              </tr>
            ))}
            {list.data && list.data.items.length === 0 ? (
              <tr><td className="px-3 py-6 text-slate-500" colSpan={5}>No website requests.</td></tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}
