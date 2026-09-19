import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { platformGet, platformSend, type StoreRow } from '@/lib/api';
import { centsFromUsdInput } from '@/lib/license';
import { ErrorText, Field } from './Licenses';
import { usePlatformSession } from '@/lib/session';

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
      <NewStorePanel />
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

/**
 * 运营直接开店（不经 Stripe，sql/0120 / 计划批 6）。
 *
 * ## 幂等靠「店名 + 老板邮箱」
 *
 * 服务端用这两个字段算出出生幂等键，所以**手一抖点两下不会变成两家店**，
 * 也不会白送一倍天数（第二次返回 `already: true` 并且不再挂订阅）。
 * 界面这一层因此不需要做防抖，只需要把「已存在」这件事说清楚。
 *
 * ## 激活信默认发
 *
 * 那是一封一次性登录链接（magic link），收到它的人就是这家店的老板。
 * 不发的话，运营点完「开店」之后什么都没发生 —— 而老板那边永远等不到，
 * 也没人会发现。只有在「先建好、稍后再通知」时才关掉它。
 */
function NewStorePanel() {
  const { operator } = usePlatformSession();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [shopName, setShopName] = useState('');
  const [ownerEmail, setOwnerEmail] = useState('');
  const [plan, setPlan] = useState<'voice_booking' | 'essential' | 'growth'>('essential');
  const [durationDays, setDurationDays] = useState('30');
  const [baseVoiceMinutes, setBaseVoiceMinutes] = useState('');
  const [timezone, setTimezone] = useState('America/New_York');
  const [businessType, setBusinessType] = useState('nail');
  const [locale, setLocale] = useState('en');
  const [collected, setCollected] = useState('');
  const [paymentNote, setPaymentNote] = useState('');
  const [sendActivation, setSendActivation] = useState(true);
  const [result, setResult] = useState<
    { locationId: string; already: boolean; periodEnd: string | null } | null
  >(null);

  const amountCents = collected.trim() === '' ? null : centsFromUsdInput(collected);
  const moneyBad = collected.trim() !== '' && amountCents === null;

  const create = useMutation({
    mutationFn: () => platformSend<{
      orgId: string; locationId: string; already: boolean; periodEnd: string | null;
    }>('POST', '/v1/platform/stores', {
      shopName: shopName.trim(),
      ownerEmail: ownerEmail.trim(),
      plan,
      durationDays: Number(durationDays),
      ...(baseVoiceMinutes.trim() === '' ? {} : { baseVoiceMinutes: Number(baseVoiceMinutes) }),
      timezone,
      businessType,
      locale,
      ...(amountCents === null ? {} : { amountCents }),
      paymentNote: paymentNote.trim(),
      sendActivation,
    }),
    onSuccess: (res) => {
      setResult(res);
      void qc.invalidateQueries({ queryKey: ['platform', 'stores'] });
    },
  });

  if (operator?.role !== 'super_admin') return null;

  if (!open) {
    return (
      <button
        type="button"
        className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm"
        onClick={() => setOpen(true)}
      >
        + Open a store without Stripe
      </button>
    );
  }

  const bad = shopName.trim() === '' || ownerEmail.trim() === ''
    || paymentNote.trim() === '' || moneyBad || create.isPending
    || (baseVoiceMinutes.trim() !== '' && (!Number.isInteger(Number(baseVoiceMinutes)) || Number(baseVoiceMinutes) < 0 || Number(baseVoiceMinutes) > 1000000));

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="flex items-center justify-between">
        <h2 className="font-medium">Open a store without Stripe</h2>
        <button type="button" className="text-sm text-slate-500" onClick={() => setOpen(false)}>Close</button>
      </div>
      <p className="mt-1 text-xs text-slate-600">
        Creates the organization and the shop, grants a subscription code for the days you
        entered, and emails the owner a one-time sign-in link. Submitting the same shop name
        and owner email twice returns the same shop — it does not grant the days again.
      </p>

      {result ? (
        <div className="mt-3 rounded-lg border border-teal-300 bg-teal-50 p-3 text-sm">
          {result.already ? (
            <p className="text-teal-900">
              This shop already existed — nothing was granted again.{' '}
              <Link className="underline" to={`/stores/${result.locationId}`}>Open it</Link>
              {' '}and use the billing panel to renew.
            </p>
          ) : (
            <p className="text-teal-900">
              Created. Service until {result.periodEnd?.slice(0, 10) ?? '—'}.{' '}
              <Link className="underline" to={`/stores/${result.locationId}`}>Open the store</Link>
            </p>
          )}
        </div>
      ) : null}

      <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Field label="Shop name"><input className={inputCls} value={shopName} onChange={(e) => setShopName(e.target.value)} /></Field>
        <Field label="Owner email" hint="The sign-in link goes here. It must be the owner.">
          <input className={inputCls} value={ownerEmail} onChange={(e) => setOwnerEmail(e.target.value)} />
        </Field>
        <Field label="Plan">
          <select className={inputCls} value={plan} onChange={(e) => setPlan(e.target.value as typeof plan)}>
            <option value="voice_booking">AI Voice Booking</option>
              <option value="essential">essential</option>
            <option value="growth">growth</option>
          </select>
        </Field>
        <Field label="Base voice minutes" hint="Blank uses the plan default. Changing this does not reset usage.">
          <input className={inputCls} type="number" min="0" max="1000000" value={baseVoiceMinutes} placeholder={plan === 'voice_booking' ? '200' : plan === 'growth' ? '500' : '60'} onChange={e => setBaseVoiceMinutes(e.target.value)} />
        </Field>
        <Field label="Days of service">
          <select className={inputCls} value={durationDays} onChange={(e) => setDurationDays(e.target.value)}>
            {['30', '90', '180', '365'].map((d) => <option key={d} value={d}>{d}</option>)}
          </select>
        </Field>
        <Field label="Business type">
          <select className={inputCls} value={businessType} onChange={(e) => setBusinessType(e.target.value)}>
            {['nail', 'massage', 'foot_spa', 'lash', 'scalp', 'hair', 'mixed'].map((b) => (
              <option key={b} value={b}>{b}</option>
            ))}
          </select>
        </Field>
        <Field label="Timezone" hint="Getting this wrong shifts a whole day of schedule, day-close and commission.">
          <input className={inputCls} value={timezone} onChange={(e) => setTimezone(e.target.value)} />
        </Field>
        <Field label="Owner language">
          <select className={inputCls} value={locale} onChange={(e) => setLocale(e.target.value)}>
            {['en', 'zh-Hans', 'zh-Hant', 'ko', 'vi', 'es'].map((l) => <option key={l} value={l}>{l}</option>)}
          </select>
        </Field>
        <Field label="Amount collected (USD)">
          <input
            className={`${inputCls} ${moneyBad ? 'border-red-400' : ''}`}
            inputMode="decimal"
            value={collected}
            onChange={(e) => setCollected(e.target.value)}
          />
        </Field>
        <Field label="Payment note (required)">
          <input className={inputCls} value={paymentNote} onChange={(e) => setPaymentNote(e.target.value)} />
        </Field>
      </div>

      <label className="mt-3 flex items-center gap-2 text-sm">
        <input type="checkbox" checked={sendActivation} onChange={(e) => setSendActivation(e.target.checked)} />
        Email the owner a sign-in link now
      </label>

      <div className="mt-3 flex items-center gap-3">
        <button
          type="button"
          disabled={bad}
          onClick={() => create.mutate()}
          className="rounded-lg bg-teal-700 px-3 py-1.5 text-sm text-white disabled:opacity-40"
        >
          {create.isPending ? 'Creating…' : 'Create store'}
        </button>
        {create.isError ? <ErrorText error={create.error} /> : null}
      </div>
    </section>
  );
}

const inputCls = 'w-full rounded-lg border border-slate-300 px-3 py-2 text-sm';
