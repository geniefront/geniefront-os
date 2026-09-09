import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Copy, Check, AlertTriangle } from 'lucide-react';
import { platformGet, platformSend, ApiError } from '@/lib/api';
import {
  centsFromUsdInput, intFromInput, licenseTermsText, usdFromCents,
  LICENSE_STATUS_STYLE, type IssuedLicense, type LicenseRow,
} from '@/lib/license';
import { usePlatformSession } from '@/lib/session';

/**
 * 订阅码（sql/0120，计划批 8）。
 *
 * ## 这一页在回答什么问题
 *
 * 「这家店的钱收到了没有、服务开到哪天、是谁开的」。所以列表上第一等的信息
 * 不是码本身，而是 **收款说明 + 面值 + 谁签的**。码只显示前缀 —— 明文在
 * 签发那一刻之后就不存在了，这一页也拿不回来。
 *
 * ## 签发限 super_admin
 *
 * 判定在数据库里（`gf_license_issue`）。界面这一层只是把按钮藏起来，
 * 免得 support 点了之后收到一个看不懂的 403 —— **不是**权限本身。
 */
export function Licenses() {
  const { operator } = usePlatformSession();
  const canIssue = operator?.role === 'super_admin';
  const qc = useQueryClient();

  const [status, setStatus] = useState('');
  const [kind, setKind] = useState('');
  const [q, setQ] = useState('');

  const list = useQuery({
    queryKey: ['platform', 'licenses', status, kind, q],
    queryFn: () => platformGet<{ total: number; items: LicenseRow[] }>(
      `/v1/platform/licenses?status=${encodeURIComponent(status)}`
      + `&kind=${encodeURIComponent(kind)}&q=${encodeURIComponent(q)}`,
    ),
  });

  const invalidate = (): void => {
    void qc.invalidateQueries({ queryKey: ['platform', 'licenses'] });
  };

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold">Subscription codes</h1>
        <p className="text-sm text-slate-600">
          For shops that pay us outside Stripe (WeChat, Alipay, Zelle, cash). A code carries a
          plan and a number of days, or a pack of AI credits. Redeeming one makes this shop&apos;s
          billing authority <span className="font-mono">license</span> instead of Stripe.
        </p>
      </div>

      {canIssue ? <IssueForm onIssued={invalidate} /> : (
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          Your role is <span className="font-mono">{operator?.role}</span> — read only.
          Issuing a code releases paid service, so it requires super_admin.
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        <select
          className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
          value={status}
          onChange={(e) => setStatus(e.target.value)}
        >
          <option value="">All statuses</option>
          {['active', 'redeemed', 'revoked'].map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <select
          className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
          value={kind}
          onChange={(e) => setKind(e.target.value)}
        >
          <option value="">All kinds</option>
          {['subscription', 'quota_pack', 'store_open'].map((k) => (
            <option key={k} value={k}>{k}</option>
          ))}
        </select>
        <input
          className="min-w-[240px] flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm"
          placeholder="Prefix (GF-3F7K), payment note, or location id"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>

      <div className="overflow-auto rounded-xl border border-slate-200 bg-white">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-50 text-left text-slate-500">
            <tr>
              <th className="px-3 py-2">Code</th>
              <th className="px-3 py-2">Terms</th>
              <th className="px-3 py-2">Collected</th>
              <th className="px-3 py-2">Payment note</th>
              <th className="px-3 py-2">Target</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">Issued</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {(list.data?.items ?? []).map((row) => (
              <tr key={row.codeId} className="border-t border-slate-100 align-top">
                <td className="px-3 py-2 font-mono">{row.codePrefix}…</td>
                <td className="px-3 py-2">{licenseTermsText(row)}</td>
                <td className="px-3 py-2">{usdFromCents(row.amountCents)}</td>
                <td className="max-w-[260px] px-3 py-2 text-slate-600">{row.paymentNote}</td>
                <td className="px-3 py-2">
                  {row.targetLocationId ? (
                    <Link className="text-teal-700 hover:underline" to={`/stores/${row.targetLocationId}`}>
                      {row.targetLocationName ?? row.targetLocationId.slice(0, 8)}
                    </Link>
                  ) : <span className="text-slate-400">any shop</span>}
                </td>
                <td className="px-3 py-2">
                  <span className={`rounded border px-1.5 py-0.5 text-xs ${LICENSE_STATUS_STYLE[row.status] ?? ''}`}>
                    {row.status}
                  </span>
                  {row.maxRedemptions > 1 ? (
                    <span className="ml-1 text-xs text-slate-500">
                      {row.redeemedCount}/{row.maxRedemptions}
                    </span>
                  ) : null}
                  {row.revokeReason ? (
                    <div className="mt-0.5 text-xs text-slate-500">{row.revokeReason}</div>
                  ) : null}
                </td>
                <td className="px-3 py-2 text-slate-500">{row.issuedAt.slice(0, 10)}</td>
                <td className="px-3 py-2">
                  {canIssue && row.status === 'active' && row.redeemedCount === 0
                    ? <RevokeButton codeId={row.codeId} onDone={invalidate} />
                    : null}
                </td>
              </tr>
            ))}
            {list.data && list.data.items.length === 0 ? (
              <tr><td className="px-3 py-6 text-slate-500" colSpan={8}>No codes.</td></tr>
            ) : null}
          </tbody>
        </table>
      </div>
      {list.data ? (
        <p className="text-xs text-slate-500">{list.data.total} total</p>
      ) : null}
    </div>
  );
}

/**
 * 签发表单。
 *
 * ⭐ 明文码只在提交成功那一次的响应里出现，之后**任何地方都取不回来**。
 * 所以这里把它显示在一块显眼的、必须手动关掉的面板上，并且给一个复制按钮。
 * 不做「重新查看」—— 那需要把明文存下来，而它是「捡到就能用」的凭证。
 */
function IssueForm({ onIssued }: { onIssued: () => void }) {
  const [kind, setKind] = useState<'subscription' | 'quota_pack' | 'store_open'>('subscription');
  const [plan, setPlan] = useState<'essential' | 'growth'>('essential');
  const [durationDays, setDurationDays] = useState('30');
  const [unit, setUnit] = useState<'credit' | 'voice_minute'>('credit');
  const [amount, setAmount] = useState('500');
  const [collected, setCollected] = useState('');
  const [paymentNote, setPaymentNote] = useState('');
  const [targetLocationId, setTargetLocationId] = useState('');
  const [validForDays, setValidForDays] = useState('90');
  const [issued, setIssued] = useState<IssuedLicense | null>(null);

  const amountCents = collected.trim() === '' ? null : centsFromUsdInput(collected);
  const moneyBad = collected.trim() !== '' && amountCents === null;
  /*
   * 数量与天数一律先解析成整数（`intFromInput`），解析不出来就禁用提交 ——
   * 而不是把 `500.5` 发出去换一个服务端 400。
   */
  const amountUnits = intFromInput(amount, { min: 1, max: 1_000_000 });
  const days = intFromInput(durationDays, { min: 1, max: 3650 });
  const validDays = intFromInput(validForDays, { min: 1, max: 365 });
  const termsBad = kind === 'quota_pack' ? amountUnits === null : days === null;

  const issue = useMutation({
    mutationFn: () => platformSend<IssuedLicense>('POST', '/v1/platform/licenses', {
      kind,
      ...(kind === 'quota_pack'
        ? { unit, amount: amountUnits }
        : { plan, durationDays: days }),
      ...(amountCents === null ? {} : { amountCents }),
      paymentNote: paymentNote.trim(),
      ...(targetLocationId.trim() === '' ? {} : { targetLocationId: targetLocationId.trim() }),
      validForDays: validDays,
    }),
    onSuccess: (res) => {
      setIssued(res);
      setPaymentNote('');
      setCollected('');
      onIssued();
    },
  });

  const disabled = paymentNote.trim() === '' || moneyBad || termsBad
    || validDays === null || issue.isPending;

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4">
      <h2 className="font-medium">Issue a code</h2>

      {issued ? (
        <div className="mt-3 rounded-lg border-2 border-teal-500 bg-teal-50 p-3">
          <div className="flex items-center gap-2 text-sm font-medium text-teal-900">
            <AlertTriangle className="h-4 w-4" />
            Copy this now — it is shown once and cannot be retrieved.
          </div>
          <div className="mt-2 flex items-center gap-3">
            <code className="select-all rounded bg-white px-3 py-2 text-lg font-semibold tracking-wide">
              {issued.code}
            </code>
            <CopyButton value={issued.code} />
          </div>
          <p className="mt-2 text-xs text-teal-900">
            {issued.kind} · redeemable until {issued.validUntil.slice(0, 10)}
          </p>
          <button
            type="button"
            className="mt-2 text-xs text-teal-800 underline"
            onClick={() => setIssued(null)}
          >
            I have sent it to the shop — hide
          </button>
        </div>
      ) : null}

      <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Field label="Kind">
          <select className={inputCls} value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
            <option value="subscription">subscription — buy N days of a plan</option>
            <option value="quota_pack">quota_pack — add AI credits or minutes</option>
            <option value="store_open">store_open — for opening a new shop</option>
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
                <option value="essential">essential ($99/mo)</option>
                <option value="growth">growth ($199/mo)</option>
              </select>
            </Field>
            <Field label="Days of service">
              <select className={inputCls} value={durationDays} onChange={(e) => setDurationDays(e.target.value)}>
                {['30', '90', '180', '365'].map((d) => <option key={d} value={d}>{d}</option>)}
              </select>
            </Field>
          </>
        )}

        <Field
          label="Amount collected (USD)"
          hint="Optional. Leave empty for a goodwill code — no money, no invoice. Non-USD payments: enter the USD equivalent."
        >
          <input
            className={`${inputCls} ${moneyBad ? 'border-red-400' : ''}`}
            inputMode="decimal"
            placeholder="1500 or 1500.00"
            value={collected}
            onChange={(e) => setCollected(e.target.value)}
          />
          {moneyBad ? <p className="mt-1 text-xs text-red-600">Digits with at most 2 decimals.</p> : null}
        </Field>

        <Field label="Payment note (required)" hint="Where the money came from. This is the only record that answers “why is this shop free until December”.">
          <input
            className={inputCls}
            placeholder="wechat 2026-09-09 ¥1500 Zhang"
            value={paymentNote}
            onChange={(e) => setPaymentNote(e.target.value)}
          />
        </Field>

        <Field label="Target location id" hint="Optional. Empty = any shop can redeem it.">
          <input className={inputCls} value={targetLocationId} onChange={(e) => setTargetLocationId(e.target.value)} />
        </Field>

        <Field label="Redeemable for (days)" hint="How long the code itself stays usable — not the length of service.">
          <input className={inputCls} inputMode="numeric" value={validForDays} onChange={(e) => setValidForDays(e.target.value)} />
        </Field>
      </div>

      <div className="mt-3 flex items-center gap-3">
        <button
          type="button"
          disabled={disabled}
          onClick={() => issue.mutate()}
          className="rounded-lg bg-teal-700 px-3 py-1.5 text-sm text-white disabled:opacity-40"
        >
          {issue.isPending ? 'Issuing…' : 'Issue code'}
        </button>
        {issue.isError ? <ErrorText error={issue.error} /> : null}
      </div>
    </section>
  );
}

function RevokeButton({ codeId, onDone }: { codeId: string; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const revoke = useMutation({
    mutationFn: () => platformSend('POST', `/v1/platform/licenses/${codeId}/revoke`, {
      reason: reason.trim(),
    }),
    onSuccess: () => { setOpen(false); onDone(); },
  });

  if (!open) {
    return (
      <button type="button" className="text-xs text-red-700 hover:underline" onClick={() => setOpen(true)}>
        Revoke
      </button>
    );
  }
  return (
    <div className="space-y-1">
      <input
        className="w-40 rounded border border-slate-300 px-2 py-1 text-xs"
        placeholder="Reason (required)"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
      />
      <div className="flex gap-2">
        <button
          type="button"
          disabled={reason.trim() === '' || revoke.isPending}
          className="text-xs text-red-700 disabled:opacity-40"
          onClick={() => revoke.mutate()}
        >
          Confirm
        </button>
        <button type="button" className="text-xs text-slate-500" onClick={() => setOpen(false)}>Cancel</button>
      </div>
      {revoke.isError ? <ErrorText error={revoke.error} /> : null}
    </div>
  );
}

export function CopyButton({ value }: { value: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-xs"
      onClick={() => {
        void navigator.clipboard.writeText(value);
        setDone(true);
        setTimeout(() => setDone(false), 1500);
      }}
    >
      {done ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      {done ? 'Copied' : 'Copy'}
    </button>
  );
}

const inputCls = 'w-full rounded-lg border border-slate-300 px-3 py-2 text-sm';

export function Field(
  { label, hint, children }: { label: string; hint?: string; children: React.ReactNode },
) {
  return (
    <label className="block text-sm">
      <span className="mb-1 block text-slate-600">{label}</span>
      {children}
      {hint ? <span className="mt-1 block text-xs text-slate-500">{hint}</span> : null}
    </label>
  );
}

/**
 * 后端的拒绝原因原样显示出来。
 *
 * ⚠️ 不要在这里把 `code_invalid` 之类翻译成一句友好的话 —— 运营台的读者是
 * 我们自己，而「服务端到底说了什么」是排查时唯一有用的信息。
 */
export function ErrorText({ error }: { error: unknown }) {
  const e = error as ApiError | undefined;
  const reason = e?.details?.['reason'];
  return (
    <p className="text-xs text-red-600">
      {e?.code ?? 'ERROR'}
      {typeof reason === 'string' ? ` · ${reason}` : ''}
    </p>
  );
}
