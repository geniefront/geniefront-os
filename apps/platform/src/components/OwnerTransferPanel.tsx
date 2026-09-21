import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ApiError } from '@/lib/api';
import { useIdempotentSend } from '@/lib/idempotency';
import { usePlatformSession } from '@/lib/session';

const errors: Record<string, string> = {
  new_owner_must_verify_email: '新号主需要先登录 GenieFront 并验证此邮箱，再进行转移。',
  owner_changed: '号主已发生变化，请刷新后核对。',
  same_owner: '这个邮箱属于当前号主，无需转移。',
  multiple_owners: '门店有多个号主，需要先明确转移范围。',
  org_owner_requires_scoped_transfer: '当前组织有多个门店，需要先拆分门店归属，避免同时影响其他门店。',
  shared_stripe_customer: '多个门店共用此 Stripe 客户，需要先拆分账单归属。',
  transfer_pending: '已有转移正在处理中，请先完成原转移。',
};
export function OwnerTransferPanel({ locationId, owners }: { locationId: string; owners: Array<{ membershipId: string; email: string | null }> }) {
  const { operator } = usePlatformSession();
  const send = useIdempotentSend();
  const qc = useQueryClient();
  const [email, setEmail] = useState('');
  const [reason, setReason] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  if (operator?.role !== 'super_admin') return null;
  return <section className="space-y-4 rounded-xl border border-slate-200 bg-white p-4 sm:p-6">
    <h2 className="text-lg font-semibold">更换号主 / Transfer ownership</h2>
    <p className="text-sm text-slate-600">当前号主：{owners.map(o => o.email).join(', ') || '未找到'}</p>
    <p className="text-sm text-slate-600">新号主须先登录并验证邮箱。转移后旧号主不能再访问此店，历史记录保留；Stripe 账单邮箱同步到新号主。通知收件人另行设置。</p>
    <form className="space-y-3" onSubmit={async event => {
      event.preventDefault();
      if (busy || !confirmed || owners.length !== 1) return;
      setBusy(true); setError(''); setDone(false);
      try {
        await send('POST', `/v1/platform/stores/${locationId}/transfer-owner`, {
          previousMembershipId: owners[0]!.membershipId, newOwnerEmail: email.trim(), reason: reason.trim(), acknowledgePaymentMethod: true,
        });
        setDone(true); setEmail(''); setReason(''); setConfirmed(false);
        await qc.invalidateQueries({ queryKey: ['platform', 'store', locationId] });
      } catch (e) {
        setError(e instanceof ApiError && typeof e.details.reason === 'string' && errors[e.details.reason]
          ? errors[e.details.reason]! : '转移未完成，输入已保留。请用相同邮箱和原因重试；系统会继续原转移，不重复授权。');
      } finally { setBusy(false); }
    }}>
      <fieldset disabled={busy} className="space-y-3">
        <label className="block text-sm">新号主邮箱<input required type="email" maxLength={320} value={email} onChange={e => setEmail(e.target.value)} className="mt-1 block w-full rounded-lg border p-2" /></label>
        <label className="block text-sm">转移原因<textarea required minLength={3} maxLength={1000} value={reason} onChange={e => setReason(e.target.value)} className="mt-1 block w-full rounded-lg border p-2" /></label>
        <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />确认转移门店权限；现有订阅及银行卡仍保留，可能继续扣原卡，新号主需在“套餐与账单”中确认或更换。</label>
        <button disabled={!confirmed || owners.length !== 1 || !email.trim() || reason.trim().length < 3} className="rounded-lg bg-teal-700 px-4 py-2 text-white disabled:opacity-50">{busy ? '转移中…' : '确认更换号主并同步 Stripe 邮箱'}</button>
      </fieldset>
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      {done && <p role="status" className="text-sm text-teal-700">号主已更换。请新号主登录后检查付款方式。</p>}
    </form>
  </section>;
}
