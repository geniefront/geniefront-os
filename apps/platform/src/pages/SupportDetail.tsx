import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { platformGet, platformSend } from '@/lib/api';

type Detail = {
  id: string;
  locationName: string;
  organizationName: string;
  submitterEmail: string | null;
  category: string;
  subject: string;
  description: string;
  status: string;
  priority: string;
  createdAt: string;
  messages?: Array<{ id: string; body: string; authorKind: string; createdAt: string }>;
  notes: Array<{ id: string; body: string; createdAt: string }>;
};

export function SupportDetail() {
  const { id } = useParams();
  const qc = useQueryClient();
  const [note, setNote] = useState('');
  const [reply, setReply] = useState('');
  const q = useQuery({
    queryKey: ['platform', 'support', id],
    queryFn: () => platformGet<Detail>(`/v1/platform/support-requests/${id}`),
    enabled: Boolean(id),
  });
  const update = useMutation({
    mutationFn: (status: string) => platformSend('PATCH', `/v1/platform/support-requests/${id}`, { status }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['platform', 'support', id] }),
  });
  const addNote = useMutation({
    mutationFn: () => platformSend('POST', `/v1/platform/support-requests/${id}/notes`, { body: note }),
    onSuccess: () => {
      setNote('');
      void qc.invalidateQueries({ queryKey: ['platform', 'support', id] });
    },
  });

  const sendReply = useMutation({
    mutationFn: () => platformSend('POST', `/v1/platform/support-requests/${id}/notes`, { body: reply, publicReply: true }),
    onSuccess: () => { setReply(''); void qc.invalidateQueries({ queryKey: ['platform', 'support', id] }); },
  });
  if (!q.data) return <p>{q.isLoading ? 'Loading…' : 'Not found.'}</p>;
  const d = q.data;

  return (
    <div className="space-y-4 max-w-3xl">
      <Link to="/support" className="text-sm text-teal-700">← Support</Link>
      <h1 className="text-2xl font-semibold">{d.subject}</h1>
      <p className="text-sm text-slate-500">{d.locationName} · {d.organizationName} · {d.submitterEmail ?? 'unknown submitter'}</p>
      <p className="whitespace-pre-wrap rounded-xl border border-slate-200 bg-white p-4">{d.description}</p>
      <div className="flex gap-2 items-center">
        <span className="text-sm">Status</span>
        <select
          className="rounded-lg border border-slate-300 px-3 py-2"
          value={d.status}
          onChange={(e) => update.mutate(e.target.value)}
        >
          {['open', 'in_progress', 'waiting', 'resolved', 'closed'].map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
        <span className="text-sm text-slate-500">Priority: {d.priority}</span>
      </div>
      <section className="space-y-2"><h2 className="font-medium">Public conversation</h2>
        {(d.messages ?? []).map(message => <div key={message.id} className="rounded border p-3"><p className="text-xs text-slate-500">{message.authorKind} · {message.createdAt}</p><p className="whitespace-pre-wrap">{message.body}</p></div>)}
        <textarea aria-label="Public reply" value={reply} onChange={e => setReply(e.target.value)} className="w-full rounded border p-2" />
        <button disabled={!reply.trim() || sendReply.isPending} onClick={() => sendReply.mutate()} className="rounded bg-teal-700 px-3 py-2 text-white">Send public reply</button>
        {sendReply.isError && <p role="alert">{sendReply.error.message}</p>}
      </section>
      <section className="space-y-2">
        <h2 className="font-medium">Internal notes</h2>
        {(d.notes ?? []).map((n) => (
          <div key={n.id} className="rounded-lg border border-slate-200 bg-white p-3 text-sm">
            <div className="text-xs text-slate-400">{n.createdAt}</div>
            <div className="whitespace-pre-wrap">{n.body}</div>
          </div>
        ))}
        <textarea
          className="w-full rounded-lg border border-slate-300 p-2"
          rows={3}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Internal note (not shown to the customer)"
        />
        <button
          type="button"
          disabled={!note.trim() || addNote.isPending}
          className="rounded-lg bg-slate-900 text-white px-3 py-1.5 text-sm"
          onClick={() => addNote.mutate()}
        >
          Add note
        </button>
      </section>
    </div>
  );
}
