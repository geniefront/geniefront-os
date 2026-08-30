import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { platformGet, platformSend } from '@/lib/api';

type Detail = {
  briefId: string;
  locationName: string;
  organizationName: string;
  status: string;
  usp: string | null;
  tone: string | null;
  voice: string | null;
  sections: unknown;
  painPoints: unknown;
  audience: unknown;
  submittedAt: string | null;
  launchRequestedAt: string | null;
  publicUrl: string | null;
  revisions: Array<{ id: string; text: string; status: string; response: string | null; createdAt: string }>;
};

export function WebsiteRequestDetail() {
  const { briefId } = useParams();
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['platform', 'website', briefId],
    queryFn: () => platformGet<Detail>(`/v1/platform/website-requests/${briefId}`),
    enabled: Boolean(briefId),
  });
  const markDrafted = useMutation({
    mutationFn: () => platformSend('POST', `/v1/platform/website-requests/${briefId}/mark-drafted`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['platform', 'website', briefId] }),
  });
  const revision = useMutation({
    mutationFn: (args: { id: string; status: string }) =>
      platformSend('PATCH', `/v1/platform/website-requests/${briefId}/revisions/${args.id}`, { status: args.status }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['platform', 'website', briefId] }),
  });

  if (!q.data) return <p>{q.isLoading ? 'Loading…' : 'Not found.'}</p>;
  const d = q.data;

  return (
    <div className="space-y-4 max-w-3xl">
      <Link to="/website-requests" className="text-sm text-teal-700">← Website requests</Link>
      <h1 className="text-2xl font-semibold">{d.locationName}</h1>
      <p className="text-sm text-slate-500">{d.organizationName} · {d.status}</p>
      {d.status === 'submitted' ? (
        <button
          type="button"
          className="rounded-lg bg-slate-900 text-white px-3 py-1.5 text-sm"
          onClick={() => markDrafted.mutate()}
        >
          Mark in progress (drafted)
        </button>
      ) : null}
      <section className="rounded-xl border border-slate-200 bg-white p-4 text-sm space-y-2">
        <div><span className="text-slate-500">USP: </span>{d.usp ?? '—'}</div>
        <div><span className="text-slate-500">Voice: </span>{d.voice ?? '—'}</div>
        <div><span className="text-slate-500">Tone: </span>{d.tone ?? '—'}</div>
        <div><span className="text-slate-500">Submitted: </span>{d.submittedAt ?? '—'}</div>
        <div><span className="text-slate-500">Launch requested: </span>{d.launchRequestedAt ?? '—'}</div>
        <div><span className="text-slate-500">Public URL: </span>{d.publicUrl ?? 'not live'}</div>
      </section>
      <section className="space-y-2">
        <h2 className="font-medium">Revisions</h2>
        {(d.revisions ?? []).length === 0 ? <p className="text-sm text-slate-500">None.</p> : null}
        {(d.revisions ?? []).map((rv) => (
          <div key={rv.id} className="rounded-xl border border-slate-200 bg-white p-3 text-sm space-y-2">
            <div className="text-xs text-slate-400">{rv.createdAt} · {rv.status}</div>
            <p className="whitespace-pre-wrap">{rv.text}</p>
            <div className="flex gap-2">
              {['in_progress', 'accepted', 'declined'].map((s) => (
                <button
                  key={s}
                  type="button"
                  className="rounded border px-2 py-1 text-xs"
                  onClick={() => revision.mutate({ id: rv.id, status: s })}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        ))}
      </section>
    </div>
  );
}
