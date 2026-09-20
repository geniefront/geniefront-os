import { formatPhoneDisplay } from '@gf/contracts';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { platformGet, type OperatorSession } from '@/lib/api';

/**
 * Test inbox: emails and SMS captured on local/staging.
 *
 * Test accounts cannot receive real mail or text messages, so on those
 * environments COMMUNICATION_DELIVERY_MODE=capture stops delivery at the
 * last step and leaves the fully rendered message in the outbox. This page
 * is the window onto it: recipient, body, links, status, error.
 */

type Row = {
  channel: 'email' | 'sms';
  id: string;
  locationId: string | null;
  locationName: string | null;
  kind: string;
  recipient: string;
  subject: string | null;
  preview: string;
  status: string;
  attempts: number;
  lastError: string | null;
  providerId: string | null;
  createdAt: string;
  sentAt: string | null;
  links: string[];
};

type Detail = Row & {
  bodyText: string;
  bodyHtml: string | null;
  entityType: string;
  entityId: string;
  segments?: number;
  fromE164?: string;
};

const STATUS_STYLE: Record<string, string> = {
  captured: 'bg-teal-100 text-teal-800',
  sent: 'bg-slate-100 text-slate-700',
  pending: 'bg-amber-100 text-amber-800',
  failed: 'bg-rose-100 text-rose-800',
  suppressed: 'bg-slate-100 text-slate-500',
};

function StatusChip({ status }: { status: string }) {
  return (
    <span className={`rounded px-2 py-0.5 text-xs ${STATUS_STYLE[status] ?? 'bg-slate-100 text-slate-700'}`}>
      {status}
    </span>
  );
}

function MessageDetail({ channel, id }: { channel: 'email' | 'sms'; id: string }) {
  const detail = useQuery({
    queryKey: ['platform', 'test-inbox', channel, id],
    queryFn: () => platformGet<Detail>(`/v1/platform/test-inbox/${channel}/${id}`),
  });

  if (detail.isLoading) return <div className="text-sm text-slate-500">Loading…</div>;
  if (!detail.data) return <div className="text-sm text-slate-500">Not found.</div>;
  const d = detail.data;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 text-sm">
        <div><span className="text-slate-500">To</span><div className="font-mono">{d.recipient}</div></div>
        <div><span className="text-slate-500">Kind</span><div>{d.kind}</div></div>
        <div><span className="text-slate-500">Store</span><div>{d.locationName ?? '—'}</div></div>
        <div><span className="text-slate-500">Status</span><div><StatusChip status={d.status} /> attempts {d.attempts}</div></div>
        <div><span className="text-slate-500">Created</span><div>{d.createdAt?.slice(0, 19).replace('T', ' ')}</div></div>
        <div><span className="text-slate-500">Provider id</span><div className="font-mono text-xs">{d.providerId ?? '—'}</div></div>
        <div><span className="text-slate-500">Entity</span><div className="font-mono text-xs">{d.entityType} {d.entityId?.slice(0, 8)}</div></div>
        {d.channel === 'sms' ? (
          <div><span className="text-slate-500">Segments</span><div>{d.segments} · from {formatPhoneDisplay(d.fromE164)}</div></div>
        ) : null}
      </div>

      {d.lastError ? (
        <div className="rounded-lg bg-rose-50 border border-rose-200 p-3 text-sm text-rose-800">
          <div className="font-semibold">Last error</div>
          <div className="font-mono text-xs break-all">{d.lastError}</div>
        </div>
      ) : null}

      {d.subject ? <div className="text-lg font-semibold">{d.subject}</div> : null}

      {d.links.length > 0 ? (
        <div className="rounded-lg border border-slate-200 p-3">
          <div className="text-sm font-semibold mb-1">Links</div>
          <ul className="space-y-1">
            {d.links.map((href) => (
              <li key={href}>
                <a
                  className="text-teal-700 hover:underline break-all text-sm"
                  href={href}
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  {href}
                </a>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div>
        <div className="text-sm font-semibold mb-1">Plain text</div>
        <pre className="whitespace-pre-wrap rounded-lg bg-slate-50 border border-slate-200 p-3 text-xs">
          {d.bodyText}
        </pre>
      </div>

      {d.bodyHtml ? (
        <div>
          <div className="text-sm font-semibold mb-1">HTML</div>
          {/*
            Rendered inside a sandboxed iframe with no allow-* flags: the body is
            template output, but this console is operator-privileged and the page
            must not execute anything that arrived from a message.
          */}
          <iframe
            title="Rendered email"
            sandbox=""
            srcDoc={d.bodyHtml}
            className="w-full h-96 rounded-lg border border-slate-200 bg-white"
          />
        </div>
      ) : null}
    </div>
  );
}

export function TestInbox() {
  const [channel, setChannel] = useState('');
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState<{ channel: 'email' | 'sms'; id: string } | null>(null);

  const session = useQuery({
    queryKey: ['platform', 'session', 'comms'],
    queryFn: () => platformGet<OperatorSession>('/v1/platform/session'),
  });

  const list = useQuery({
    queryKey: ['platform', 'test-inbox', channel, status, search],
    queryFn: () => platformGet<{ total: number; items: Row[] }>(
      `/v1/platform/test-inbox?channel=${encodeURIComponent(channel)}`
      + `&status=${encodeURIComponent(status)}&search=${encodeURIComponent(search)}`,
    ),
    refetchInterval: 10_000,
  });

  const comms = session.data?.comms;
  const capturing = comms?.deliveryMode === 'capture';

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">Test inbox</h1>
        <p className="text-sm text-slate-600">
          Emails and text messages captured on this environment. Test accounts cannot receive
          real mail or SMS, so capture mode stops delivery at the last step and keeps the
          rendered message in the outbox. Captured messages are deleted after 7 days.
        </p>
      </div>

      {comms ? (
        <div
          className={`rounded-lg border px-3 py-2 text-sm ${
            capturing
              ? 'bg-teal-50 border-teal-200 text-teal-900'
              : 'bg-amber-50 border-amber-200 text-amber-900'
          }`}
        >
          {`Environment ${comms.env} · delivery mode ${comms.deliveryMode}. `}
          {capturing
            ? 'New messages are captured here instead of being delivered.'
            : 'Messages are really being delivered. Nothing new will appear here; the rows below are history.'}
        </div>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <select className="rounded-lg border border-slate-300 px-3 py-2" value={channel} onChange={(e) => setChannel(e.target.value)}>
          <option value="">All channels</option>
          <option value="email">Email</option>
          <option value="sms">SMS</option>
        </select>
        <select className="rounded-lg border border-slate-300 px-3 py-2" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All statuses</option>
          {['captured', 'pending', 'sent', 'failed', 'suppressed'].map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
        <input
          className="rounded-lg border border-slate-300 px-3 py-2 min-w-64"
          placeholder="Recipient, subject or body"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      <div className="overflow-auto rounded-xl border border-slate-200 bg-white">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-50 text-left text-slate-500">
            <tr>
              <th className="px-3 py-2">When</th>
              <th className="px-3 py-2">Channel</th>
              <th className="px-3 py-2">To</th>
              <th className="px-3 py-2">Subject / body</th>
              <th className="px-3 py-2">Store</th>
              <th className="px-3 py-2">Status</th>
            </tr>
          </thead>
          <tbody>
            {(list.data?.items ?? []).map((row) => (
              <tr
                key={`${row.channel}:${row.id}`}
                className="border-t border-slate-100 cursor-pointer hover:bg-slate-50"
                onClick={() => setOpen({ channel: row.channel, id: row.id })}
              >
                <td className="px-3 py-2 whitespace-nowrap">{row.createdAt?.slice(0, 19).replace('T', ' ')}</td>
                <td className="px-3 py-2">{row.channel}</td>
                <td className="px-3 py-2 font-mono text-xs">{row.recipient}</td>
                <td className="px-3 py-2 max-w-md truncate">
                  {row.subject ? <span className="font-medium">{row.subject} · </span> : null}
                  <span className="text-slate-500">{row.preview}</span>
                  {row.links.length > 0 ? (
                    <span className="ml-2 rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-600">
                      {row.links.length} link{row.links.length > 1 ? 's' : ''}
                    </span>
                  ) : null}
                </td>
                <td className="px-3 py-2">{row.locationName ?? '—'}</td>
                <td className="px-3 py-2"><StatusChip status={row.status} /></td>
              </tr>
            ))}
            {list.data && list.data.items.length === 0 ? (
              <tr><td className="px-3 py-6 text-slate-500" colSpan={6}>No messages.</td></tr>
            ) : null}
          </tbody>
        </table>
      </div>

      {open ? (
        <div className="fixed inset-0 bg-slate-900/40 flex justify-end" onClick={() => setOpen(null)}>
          <div
            className="w-[min(720px,100%)] h-full overflow-auto bg-white p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex justify-between items-start mb-4">
              <h2 className="text-lg font-semibold">Message</h2>
              <button type="button" className="text-slate-500 hover:text-slate-900" onClick={() => setOpen(null)}>
                Close
              </button>
            </div>
            <MessageDetail channel={open.channel} id={open.id} />
          </div>
        </div>
      ) : null}
    </div>
  );
}
