import { useIdempotentSend } from '../lib/idempotency';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { platformGet, platformSend } from '@/lib/api';
import {
  centsFromUsdInput, intFromInput, usdFromCents, type LicensePanel as PanelData,
} from '@/lib/license';
import { usePlatformSession } from '@/lib/session';
import { CopyButton, ErrorText, Field } from '@/pages/Licenses';

export const licensePanelKey = (locationId: string): unknown[] =>
  ['platform', 'license', locationId];

export function useLicensePanel(locationId: string) {
  return useQuery({
    queryKey: licensePanelKey(locationId),
    queryFn: () => platformGet<PanelData>(`/v1/platform/stores/${locationId}/license`),
    enabled: Boolean(locationId),
  });
}

const SOURCE_STYLE: Record<string, string> = {
  none: 'bg-slate-100 text-slate-600 border-slate-200',
  stripe: 'bg-indigo-50 text-indigo-700 border-indigo-200',
  license: 'bg-teal-50 text-teal-700 border-teal-200',
};

const STATUS_STYLE: Record<string, string> = {
  active: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  trialing: 'bg-sky-50 text-sky-700 border-sky-200',
  none: 'bg-slate-100 text-slate-600 border-slate-200',
  past_due: 'bg-amber-50 text-amber-800 border-amber-200',
  canceled: 'bg-slate-100 text-slate-600 border-slate-200',
  expired: 'bg-red-50 text-red-700 border-red-200',
};

const daysLeft = (iso: string | null): number | null => {
  if (iso === null) return null;
  return Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000);
};

/**
 * 一家店的计费权威面板（sql/0120，计划批 8）。
 *
 * ## 为什么四个动作长得不一样
 *
 *   · **Grant / extend**  这家店已经归订阅码管，加天数就完了
 *   · **Switch from Stripe** 这家店还在被 Stripe 按月扣款 —— 必须**先**在
 *     Stripe 那边停掉这家店那个 item（多店共用一条订阅，取消整条会把老板
 *     另外两家店一起停掉），所以它是一条**独立的**按钮，不是 Grant 的一个选项
 *   · **Revoke** 当场到期，冻结写入、读照常。不动兑换历史
 *
 * 界面上把 Grant 在 `billingSource === 'stripe'` 时藏起来 —— 服务端那时会
 * 直接拒（`stripe_active_switch_required`），而那个拒绝是对的：两个权威
 * 同时生效的话，客户会一边用着订阅码一边被按月扣款。
 */
export function LicensePanel({ locationId }: { locationId: string }) {
  const { operator } = usePlatformSession();
  const canWrite = operator?.role === 'super_admin';
  const qc = useQueryClient();
  const q = useLicensePanel(locationId);
  const [tab, setTab] = useState<'grant' | 'switch' | 'period' | 'revoke' | null>(null);

  const invalidate = (): void => {
    void qc.invalidateQueries({ queryKey: licensePanelKey(locationId) });
    void qc.invalidateQueries({ queryKey: ['platform', 'store', locationId] });
    void qc.invalidateQueries({ queryKey: ['platform', 'licenses'] });
    setTab(null);
  };

  const acct = q.data?.account ?? null;
  const source = acct?.billingSource ?? 'none';
  const left = daysLeft(acct?.licensePeriodEnd ?? null);

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="font-medium">Billing authority</h2>
        <span className={`rounded border px-1.5 py-0.5 text-xs ${SOURCE_STYLE[source] ?? ''}`}>
          {source}
        </span>
        {acct ? (
          <span className={`rounded border px-1.5 py-0.5 text-xs ${STATUS_STYLE[acct.subscriptionStatus] ?? ''}`}>
            {acct.subscriptionStatus}
          </span>
        ) : null}
      </div>

      {q.isLoading ? <p className="mt-2 text-sm text-slate-500">Loading…</p> : null}

      {acct ? (
        <>
          <dl className="mt-3 grid grid-cols-[180px_1fr] gap-y-1 text-sm">
            <dt className="text-slate-500">Plan</dt><dd>{acct.plan}</dd>
            {source === 'license' ? (
              <>
                <dt className="text-slate-500">Service until</dt>
                <dd>
                  {acct.licensePeriodEnd?.slice(0, 10) ?? '—'}
                  {left !== null ? (
                    <span className={left <= 7 ? 'ml-2 text-red-700' : 'ml-2 text-slate-500'}>
                      {left >= 0 ? `${left} days left` : `expired ${-left} days ago`}
                    </span>
                  ) : null}
                </dd>
                <dt className="text-slate-500">Current code</dt>
                <dd className="font-mono">{acct.licenseCodePrefix ?? '—'}…</dd>
              </>
            ) : (
              <>
                <dt className="text-slate-500">Period end (Stripe)</dt>
                <dd>{acct.currentPeriodEnd?.slice(0, 10) ?? '—'}</dd>
                <dt className="text-slate-500">Stripe subscription</dt>
                <dd className="flex items-center gap-2 font-mono break-all">
                  {acct.stripeSubscriptionId ?? '—'}
                  {acct.stripeSubscriptionId ? <CopyButton value={acct.stripeSubscriptionId} /> : null}
                </dd>
              </>
            )}
            <dt className="text-slate-500">Purchased credits</dt><dd>{acct.creditBalance}</dd>
            <dt className="text-slate-500">Purchased minutes</dt><dd>{acct.voiceMinuteBalance}</dd>
          </dl>

          {canWrite ? (
            <div className="mt-3 flex flex-wrap gap-2">
              {source !== 'stripe' ? (
                <TabButton active={tab === 'grant'} onClick={() => setTab(tab === 'grant' ? null : 'grant')}>
                  Grant / renew with a code
                </TabButton>
              ) : (
                <TabButton active={tab === 'switch'} onClick={() => setTab(tab === 'switch' ? null : 'switch')}>
                  Switch off Stripe → code
                </TabButton>
              )}
              {source === 'license' ? (
                <>
                  <TabButton active={tab === 'period'} onClick={() => setTab(tab === 'period' ? null : 'period')}>
                    Change end date
                  </TabButton>
                  <TabButton active={tab === 'revoke'} onClick={() => setTab(tab === 'revoke' ? null : 'revoke')}>
                    Revoke now
                  </TabButton>
                </>
              ) : null}
            </div>
          ) : (
            <p className="mt-3 text-xs text-slate-500">
              Read only — changing paid service requires super_admin.
            </p>
          )}

          {tab === 'grant' ? <GrantForm locationId={locationId} onDone={invalidate} /> : null}
          {tab === 'switch' ? <SwitchForm locationId={locationId} onDone={invalidate} /> : null}
          {tab === 'period' ? <PeriodForm locationId={locationId} onDone={invalidate} /> : null}
          {tab === 'revoke' ? <RevokeForm locationId={locationId} onDone={invalidate} /> : null}
        </>
      ) : q.isLoading ? null : (
        <p className="mt-2 text-sm text-slate-500">No billing account row.</p>
      )}

      {(q.data?.history.length ?? 0) > 0 ? (
        <div className="mt-4">
          <h3 className="text-sm font-medium">Redemption history</h3>
          <p className="text-xs text-slate-500">
            Append-only. This is the answer to “why is this shop paid until that date”.
          </p>
          <table className="mt-2 min-w-full text-sm">
            <thead className="text-left text-slate-500">
              <tr>
                <th className="py-1">When</th><th>Code</th><th>Kind</th>
                <th>Collected</th><th>Payment note</th>
              </tr>
            </thead>
            <tbody>
              {q.data!.history.map((h) => (
                <tr key={h.redemptionId} className="border-t border-slate-100">
                  <td className="py-1">{h.redeemedAt.slice(0, 16).replace('T', ' ')}</td>
                  <td className="font-mono">{h.codePrefix}…</td>
                  <td>{h.kind}</td>
                  <td>{usdFromCents(h.amountCents)}</td>
                  <td className="text-slate-600">{h.paymentNote}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}

function TabButton(
  { active, onClick, children }:
  { active: boolean; onClick: () => void; children: React.ReactNode },
) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-lg border px-3 py-1.5 text-sm ${
        active ? 'border-teal-600 bg-teal-50 text-teal-800' : 'border-slate-300'
      }`}
    >
      {children}
    </button>
  );
}

/** 定向签发 + 立即生效。等价于把一张码交给店家再替他兑掉 */
function GrantForm({ locationId, onDone }: { locationId: string; onDone: () => void }) {
  const send = useIdempotentSend();
  const [kind, setKind] = useState<'subscription' | 'quota_pack'>('subscription');
  const [plan, setPlan] = useState<'essential' | 'growth'>('essential');
  const [durationDays, setDurationDays] = useState('30');
  const [unit, setUnit] = useState<'credit' | 'voice_minute'>('credit');
  const [amount, setAmount] = useState('500');
  const [collected, setCollected] = useState('');
  const [paymentNote, setPaymentNote] = useState('');

  const amountCents = collected.trim() === '' ? null : centsFromUsdInput(collected);
  const moneyBad = collected.trim() !== '' && amountCents === null;
  const amountUnits = intFromInput(amount, { min: 1, max: 1_000_000 });
  const days = intFromInput(durationDays, { min: 1, max: 3650 });
  const termsBad = kind === 'quota_pack' ? amountUnits === null : days === null;

  const run = useMutation({
    mutationFn: () => send('POST', `/v1/platform/stores/${locationId}/license/apply`, {
      kind,
      ...(kind === 'quota_pack'
        ? { unit, amount: amountUnits }
        : { plan, durationDays: days }),
      ...(amountCents === null ? {} : { amountCents }),
      paymentNote: paymentNote.trim(),
    }),
    onSuccess: onDone,
  });

  return (
    <FormShell
      title="Grant / renew"
      note="Renewal stacks: 10 days left plus a 30-day grant is 40 days, not 30."
      disabled={paymentNote.trim() === '' || moneyBad || termsBad || run.isPending}
      pending={run.isPending}
      error={run.isError ? run.error : null}
      onSubmit={() => run.mutate()}
    >
      <Field label="Kind">
        <select className={inputCls} value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
          <option value="subscription">subscription</option>
          <option value="quota_pack">quota_pack</option>
        </select>
      </Field>
      {kind === 'quota_pack' ? (
        <>
          <Field label="Unit">
            <select className={inputCls} value={unit} onChange={(e) => setUnit(e.target.value as typeof unit)}>
              <option value="credit">credit</option>
              <option value="voice_minute">voice_minute</option>
            </select>
          </Field>
          <Field label="Amount">
            <input className={inputCls} inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </Field>
        </>
      ) : (
        <>
          <Field label="Plan">
            <select className={inputCls} value={plan} onChange={(e) => setPlan(e.target.value as typeof plan)}>
              <option value="essential">essential</option>
              <option value="growth">growth</option>
            </select>
          </Field>
          <Field label="Days">
            <select className={inputCls} value={durationDays} onChange={(e) => setDurationDays(e.target.value)}>
              {['30', '90', '180', '365'].map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
          </Field>
        </>
      )}
      <Field label="Amount collected (USD)" hint="Optional. Empty = no invoice row.">
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
    </FormShell>
  );
}

/**
 * Stripe → 订阅码。
 *
 * ⚠️ 文案里必须说清「会先在 Stripe 那边停掉这家店的收费」——
 * 运营点这个按钮时要知道它是一个**对外**的动作，不是本地改个状态。
 */
function SwitchForm({ locationId, onDone }: { locationId: string; onDone: () => void }) {
  const [plan, setPlan] = useState<'essential' | 'growth'>('essential');
  const [durationDays, setDurationDays] = useState('30');
  const [collected, setCollected] = useState('');
  const [paymentNote, setPaymentNote] = useState('');
  const amountCents = collected.trim() === '' ? null : centsFromUsdInput(collected);
  const moneyBad = collected.trim() !== '' && amountCents === null;
  const days = intFromInput(durationDays, { min: 1, max: 3650 });

  const run = useMutation({
    mutationFn: () => platformSend<{ stripeAction: string }>(
      'POST', `/v1/platform/stores/${locationId}/license/switch-from-stripe`,
      {
        kind: 'subscription', plan, durationDays: days,
        ...(amountCents === null ? {} : { amountCents }),
        paymentNote: paymentNote.trim(),
      },
    ),
    onSuccess: onDone,
  });

  return (
    <FormShell
      title="Switch off Stripe"
      note={
        'This removes THIS shop’s item from the Stripe subscription first (or cancels the '
        + 'subscription when it is the last item), then grants the code. Sibling shops on the '
        + 'same subscription keep running. Refunds are handled by hand in Stripe.'
      }
      disabled={paymentNote.trim() === '' || moneyBad || days === null || run.isPending}
      pending={run.isPending}
      error={run.isError ? run.error : null}
      onSubmit={() => run.mutate()}
    >
      <Field label="Plan">
        <select className={inputCls} value={plan} onChange={(e) => setPlan(e.target.value as typeof plan)}>
          <option value="essential">essential</option>
          <option value="growth">growth</option>
        </select>
      </Field>
      <Field label="Days">
        <select className={inputCls} value={durationDays} onChange={(e) => setDurationDays(e.target.value)}>
          {['30', '90', '180', '365'].map((d) => <option key={d} value={d}>{d}</option>)}
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
    </FormShell>
  );
}

/** 改到期日。`note` 必填 —— 没有原因的改期和一次误操作长得一模一样 */
function PeriodForm({ locationId, onDone }: { locationId: string; onDone: () => void }) {
  const send = useIdempotentSend();
  const [mode, setMode] = useState<'extend' | 'set'>('extend');
  const [extendDays, setExtendDays] = useState('30');
  const [periodEnd, setPeriodEnd] = useState('');
  const [note, setNote] = useState('');
  // 负数是合法的（缩期），所以下限给 -3650 而不是 1
  const extend = intFromInput(extendDays, { min: -3650, max: 3650 });

  const run = useMutation({
    mutationFn: () => send('PATCH', `/v1/platform/stores/${locationId}/license`, {
      ...(mode === 'extend'
        ? { extendDays: extend! }
        // 日期输入是本地日，按当天 23:59:59 结束 —— 「到 9 月 30 日」在
        // 老板读来是「30 日那天还能用」，收在 00:00 会少一天
        : { periodEnd: new Date(`${periodEnd}T23:59:59`).toISOString() }),
      note: note.trim(),
    }),
    onSuccess: onDone,
  });

  const bad = note.trim() === '' || (mode === 'set' && periodEnd === '')
    || (mode === 'extend' && extend === null);

  return (
    <FormShell
      title="Change end date"
      note="Extending starts from max(today, current end) — a shop that expired three months ago gets a month from today, not a date still in the past. Negative days shorten."
      disabled={bad || run.isPending}
      pending={run.isPending}
      error={run.isError ? run.error : null}
      onSubmit={() => run.mutate()}
    >
      <Field label="Mode">
        <select className={inputCls} value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}>
          <option value="extend">extend by days</option>
          <option value="set">set an exact date</option>
        </select>
      </Field>
      {mode === 'extend' ? (
        <Field label="Days (negative shortens)">
          <input className={inputCls} inputMode="numeric" value={extendDays} onChange={(e) => setExtendDays(e.target.value)} />
        </Field>
      ) : (
        <Field label="Service until (end of that day)">
          <input type="date" className={inputCls} value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} />
        </Field>
      )}
      <Field label="Reason (required)">
        <input className={inputCls} value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>
    </FormShell>
  );
}

function RevokeForm({ locationId, onDone }: { locationId: string; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const run = useMutation({
    mutationFn: () => platformSend('POST', `/v1/platform/stores/${locationId}/license/revoke`, {
      reason: reason.trim(),
    }),
    onSuccess: onDone,
  });
  return (
    <FormShell
      title="Revoke now"
      note="The shop becomes read-only immediately: it can still view and export data, but cannot open tickets. Redemption history is not touched."
      disabled={reason.trim() === '' || run.isPending}
      pending={run.isPending}
      error={run.isError ? run.error : null}
      onSubmit={() => run.mutate()}
      danger
    >
      <Field label="Reason (required)">
        <input className={inputCls} value={reason} onChange={(e) => setReason(e.target.value)} />
      </Field>
    </FormShell>
  );
}

function FormShell({
  title, note, children, disabled, pending, error, onSubmit, danger,
}: {
  title: string; note: string; children: React.ReactNode;
  disabled: boolean; pending: boolean; error: unknown; onSubmit: () => void; danger?: boolean;
}) {
  return (
    <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-3">
      <div className="text-sm font-medium">{title}</div>
      <p className="mt-0.5 text-xs text-slate-600">{note}</p>
      <div className="mt-2 grid gap-3 sm:grid-cols-2">{children}</div>
      <div className="mt-3 flex items-center gap-3">
        <button
          type="button"
          disabled={disabled}
          onClick={onSubmit}
          className={`rounded-lg px-3 py-1.5 text-sm text-white disabled:opacity-40 ${
            danger ? 'bg-red-700' : 'bg-teal-700'
          }`}
        >
          {pending ? 'Working…' : title}
        </button>
        {error ? <ErrorText error={error} /> : null}
      </div>
    </div>
  );
}

const inputCls = 'w-full rounded-lg border border-slate-300 px-3 py-2 text-sm';
