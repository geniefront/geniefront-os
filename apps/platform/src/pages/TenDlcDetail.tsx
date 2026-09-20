import { formatPhoneDisplay } from '@gf/contracts';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { platformGet, platformSend } from '@/lib/api';

type Detail = {
  locationId: string;
  locationName: string;
  organizationName: string;
  status: string;
  legalBusinessName: string | null;
  ein: string | null;
  businessStructure: string | null;
  registeredAddress: string | null;
  repName: string | null;
  repTitle: string | null;
  repEmail: string | null;
  repPhone: string | null;
  optInMethod: string | null;
  sampleMessages: string[] | null;
  submittedAt: string | null;
  submitterEmail: string | null;
  reviewedAt: string | null;
  notes: string | null;
};

export function TenDlcDetail() {
  const { locationId } = useParams();
  const qc = useQueryClient();
  const [notes, setNotes] = useState('');
  const q = useQuery({
    queryKey: ['platform', '10dlc', locationId],
    queryFn: () => platformGet<Detail>(`/v1/platform/10dlc/${locationId}`),
    enabled: Boolean(locationId),
  });
  const review = useMutation({
    mutationFn: (action: string) => platformSend(
      'POST',
      `/v1/platform/10dlc/${locationId}/review`,
      { action, notes: notes.trim() || undefined },
    ),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['platform', '10dlc', locationId] }),
  });

  if (!q.data) return <p>{q.isLoading ? 'Loading…' : 'Not found.'}</p>;
  const d = q.data;

  return (
    <div className="space-y-4 max-w-3xl">
      <Link to="/10dlc" className="text-sm text-teal-700">← 10DLC</Link>
      <h1 className="text-2xl font-semibold">{d.locationName}</h1>
      <p className="text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
        Internal GenieFront review only. Approving does not file with TCR or a carrier.
      </p>
      <dl className="grid grid-cols-[160px_1fr] gap-y-1 text-sm bg-white border border-slate-200 rounded-xl p-4">
        <dt className="text-slate-500">Status</dt><dd>{d.status}</dd>
        <dt className="text-slate-500">Legal name</dt><dd>{d.legalBusinessName ?? '—'}</dd>
        <dt className="text-slate-500">EIN</dt><dd>{d.ein ?? '—'}</dd>
        <dt className="text-slate-500">Structure</dt><dd>{d.businessStructure ?? '—'}</dd>
        <dt className="text-slate-500">Address</dt><dd>{d.registeredAddress ?? '—'}</dd>
        <dt className="text-slate-500">Rep</dt><dd>{[d.repName, d.repTitle, d.repEmail, formatPhoneDisplay(d.repPhone)].filter(Boolean).join(' · ') || '—'}</dd>
        <dt className="text-slate-500">Opt-in</dt><dd>{d.optInMethod ?? '—'}</dd>
        <dt className="text-slate-500">Submitted</dt><dd>{d.submittedAt ?? '—'}</dd>
        <dt className="text-slate-500">Submitter</dt><dd>{d.submitterEmail ?? d.locationName}</dd>
        <dt className="text-slate-500">Reviewed</dt><dd>{d.reviewedAt ?? '—'}</dd>
        <dt className="text-slate-500">Notes</dt><dd className="whitespace-pre-wrap">{d.notes ?? '—'}</dd>
      </dl>
      <div>
        <div className="text-sm font-medium mb-1">Sample messages</div>
        <ul className="list-disc pl-5 text-sm">
          {(d.sampleMessages ?? []).map((m, i) => <li key={i}>{m}</li>)}
        </ul>
      </div>
      <textarea
        className="w-full rounded-lg border border-slate-300 p-2"
        rows={3}
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        placeholder="Review notes (required to reject or request changes)"
      />
      <div className="flex flex-wrap gap-2">
        <button type="button" className="rounded-lg border px-3 py-1.5 text-sm" onClick={() => review.mutate('under_review')}>Mark under review</button>
        <button type="button" className="rounded-lg border px-3 py-1.5 text-sm" onClick={() => review.mutate('request_changes')}>Request changes</button>
        <button type="button" className="rounded-lg border px-3 py-1.5 text-sm" onClick={() => review.mutate('reject')}>Reject</button>
        <button type="button" className="rounded-lg bg-teal-700 text-white px-3 py-1.5 text-sm" onClick={() => review.mutate('approve_internal')}>Approve internal review</button>
      </div>
      {review.isError ? <p className="text-sm text-red-600">Review failed. Notes are required to reject or request changes.</p> : null}
    </div>
  );
}
