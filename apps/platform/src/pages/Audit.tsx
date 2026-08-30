import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { platformGet } from '@/lib/api';

type Row = {
  id: string;
  locationName: string | null;
  actorId: string | null;
  actorKind: string;
  command: string;
  entityType: string | null;
  at: string;
};

export function Audit() {
  const [locationId, setLocationId] = useState('');
  const [command, setCommand] = useState('');
  const [submitted, setSubmitted] = useState({ locationId: '', command: '' });
  const list = useQuery({
    queryKey: ['platform', 'audit', submitted],
    queryFn: () => {
      const params = new URLSearchParams();
      if (submitted.locationId) params.set('locationId', submitted.locationId);
      if (submitted.command) params.set('command', submitted.command);
      return platformGet<{ total: number; items: Row[] }>(`/v1/platform/audit?${params.toString()}`);
    },
  });

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">Audit</h1>
        <p className="text-sm text-slate-600">Read-only investigation log. Secret fields are stripped.</p>
      </div>
      <form
        className="flex flex-wrap gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setSubmitted({ locationId: locationId.trim(), command: command.trim() });
        }}
      >
        <input
          className="rounded-lg border border-slate-300 px-3 py-2 w-80"
          placeholder="Location id"
          value={locationId}
          onChange={(e) => setLocationId(e.target.value)}
        />
        <input
          className="rounded-lg border border-slate-300 px-3 py-2 w-64"
          placeholder="Command (e.g. platform.review10Dlc)"
          value={command}
          onChange={(e) => setCommand(e.target.value)}
        />
        <button type="submit" className="rounded-lg bg-slate-900 text-white px-4 py-2">Filter</button>
      </form>
      <div className="overflow-auto rounded-xl border border-slate-200 bg-white">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-50 text-left text-slate-500">
            <tr>
              <th className="px-3 py-2">Time</th>
              <th className="px-3 py-2">Store</th>
              <th className="px-3 py-2">Command</th>
              <th className="px-3 py-2">Actor</th>
              <th className="px-3 py-2">Entity</th>
            </tr>
          </thead>
          <tbody>
            {(list.data?.items ?? []).map((row) => (
              <tr key={row.id} className="border-t border-slate-100">
                <td className="px-3 py-2 whitespace-nowrap">{row.at?.slice(0, 19)}</td>
                <td className="px-3 py-2">{row.locationName ?? '—'}</td>
                <td className="px-3 py-2 font-mono text-xs">{row.command}</td>
                <td className="px-3 py-2">{row.actorKind}{row.actorId ? ` · ${row.actorId.slice(0, 8)}` : ''}</td>
                <td className="px-3 py-2">{row.entityType ?? '—'}</td>
              </tr>
            ))}
            {list.data && list.data.items.length === 0 ? (
              <tr><td className="px-3 py-6 text-slate-500" colSpan={5}>No audit rows.</td></tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}
