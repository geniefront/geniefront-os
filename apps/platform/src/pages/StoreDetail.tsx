import { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { platformGet, platformSend } from '@/lib/api';

type Detail = {
  overview: {
    locationId: string;
    orgId: string;
    locationName: string;
    organizationName: string;
    timezone: string;
    locationStatus: string;
    businessType: string;
    createdAt: string;
    ownerEmail: string | null;
    ownerName: string | null;
  };
  people: Array<{
    membershipId: string;
    email: string | null;
    fullName: string | null;
    status: string;
    roles: string[];
    isBookable: boolean;
    jobTitle: string | null;
  }>;
  billing: {
    stripeCustomerId: string | null;
    stripeSubscriptionId: string | null;
    plan: string;
    subscriptionStatus: string;
    trialEndsAt: string | null;
    currentPeriodEnd: string | null;
    paymentMethodLabel: string | null;
    creditBalance: number;
    voiceMinuteBalance: number;
    includedCreditsUsed: number;
    includedMinutesUsed: number;
  } | null;
  setup: {
    locationStatus: string;
    setupComplete: boolean;
    tenDlcStatus: string | null;
    storefrontStatus: string | null;
  };
};

/** 外发消息的两道闸门（sql/0089）。与门店详情分开一个请求。 */
type Messaging = {
  locationId: string;
  slug: string;
  shopEmail: string | null;
  tenDlcStatus: string;
  tenDlcReviewedAt: string | null;
  marketingEmailFrom: string | null;
  appointmentEmailCopyToShop: boolean;
};

type MarketingResult = {
  marketingEmailFrom: string | null;
  domain: string;
  domainStatus: string;
  dnsInstructions?: string;
};

function copy(value: string) {
  void navigator.clipboard.writeText(value);
}

export function StoreDetail() {
  const { locationId } = useParams();
  const q = useQuery({
    queryKey: ['platform', 'store', locationId],
    queryFn: () => platformGet<Detail>(`/v1/platform/stores/${locationId}`),
    enabled: Boolean(locationId),
  });
  const d = q.data;

  async function openPortal() {
    if (!locationId) return;
    const res = await platformSend<{ url: string }>(
      'POST',
      `/v1/platform/stores/${locationId}/billing/portal-session`,
      { returnUrl: `/stores/${locationId}` },
    );
    if (res.url) window.open(res.url, '_blank', 'noopener');
  }

  if (q.isLoading) return <p>Loading…</p>;
  if (!d) return <p className="text-red-600">Store not found.</p>;

  return (
    <div className="space-y-6">
      <div>
        <Link to="/stores" className="text-sm text-teal-700">← Stores</Link>
        <h1 className="text-2xl font-semibold">{d.overview.locationName}</h1>
        <p className="text-sm text-slate-500">{d.overview.organizationName}</p>
      </div>

      <section className="rounded-xl border border-slate-200 bg-white p-4 space-y-1">
        <h2 className="font-medium">Overview</h2>
        <Row label="Location id" value={d.overview.locationId} copyable />
        <Row label="Organization" value={d.overview.organizationName} />
        <Row label="Status" value={d.overview.locationStatus} />
        <Row label="Timezone" value={d.overview.timezone} />
        <Row label="Created" value={d.overview.createdAt} />
        <Row label="Owner" value={d.overview.ownerEmail ?? '—'} />
      </section>

      <section className="rounded-xl border border-slate-200 bg-white p-4">
        <h2 className="font-medium mb-2">People</h2>
        <table className="min-w-full text-sm">
          <thead className="text-left text-slate-500">
            <tr>
              <th className="py-1">Name</th>
              <th>Email</th>
              <th>Roles</th>
              <th>Status</th>
              <th>Bookable</th>
            </tr>
          </thead>
          <tbody>
            {d.people.map((p) => (
              <tr key={p.membershipId} className="border-t border-slate-100">
                <td className="py-1">{p.fullName ?? p.jobTitle ?? '—'}</td>
                <td>{p.email ?? '—'}</td>
                <td>{p.roles.join(', ') || '—'}</td>
                <td>{p.status}</td>
                <td>{p.isBookable ? 'yes' : 'no'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="rounded-xl border border-slate-200 bg-white p-4 space-y-1">
        <h2 className="font-medium">Billing (read-only)</h2>
        {d.billing ? (
          <>
            <Row label="Plan" value={d.billing.plan} />
            <Row label="Subscription" value={d.billing.subscriptionStatus} />
            <Row label="Trial end" value={d.billing.trialEndsAt ?? '—'} />
            <Row label="Period end" value={d.billing.currentPeriodEnd ?? '—'} />
            <Row label="Payment method" value={d.billing.paymentMethodLabel ?? '—'} />
            <Row label="Stripe customer" value={d.billing.stripeCustomerId ?? '—'} copyable={Boolean(d.billing.stripeCustomerId)} />
            <Row label="Stripe subscription" value={d.billing.stripeSubscriptionId ?? '—'} copyable={Boolean(d.billing.stripeSubscriptionId)} />
            <Row label="Purchased credits" value={String(d.billing.creditBalance)} />
            <Row label="Purchased voice minutes" value={String(d.billing.voiceMinuteBalance)} />
            <Row label="Included credits used" value={String(d.billing.includedCreditsUsed)} />
            <Row label="Included minutes used" value={String(d.billing.includedMinutesUsed)} />
            <p className="text-xs text-slate-500 pt-2">
              Paid plan and credit balances are Stripe truth. This console cannot set active, change plan locally, or grant credits.
            </p>
            <button type="button" onClick={() => void openPortal()} className="mt-2 rounded-lg bg-slate-900 text-white px-3 py-1.5 text-sm">
              Open Stripe Customer Portal
            </button>
          </>
        ) : <p className="text-sm text-slate-500">No billing account row.</p>}
      </section>

      <MessagingPanel locationId={locationId!} />

      <section className="rounded-xl border border-slate-200 bg-white p-4 space-y-1">
        <h2 className="font-medium">Setup / health</h2>
        <Row label="Setup complete" value={d.setup.setupComplete ? 'yes' : 'no'} />
        <Row label="Location status" value={d.setup.locationStatus} />
        <Row label="10DLC" value={d.setup.tenDlcStatus ?? 'none'} />
        <Row label="Storefront" value={d.setup.storefrontStatus ?? 'none'} />
      </section>
    </div>
  );
}

/**
 * 外发消息面板 —— 运营在人工配完 Resend 与 DNS 之后，从这里告诉后端
 * 「这家店可以发营销邮件了」。
 *
 * ⚠️ 这里**没有输入框让人填地址**。手填意味着一个笔误就把营销邮件指到一个
 * 不存在的地址上，而后果不是报错、是整批退信，退信率同样计入发信域名信誉。
 * 因此只有一个按钮：让服务端去问 Resend「这个域名验过没有」，验过了才写库。
 * 没通过时把要加的 DNS 记录原样显示出来。
 */
function MessagingPanel({ locationId }: { locationId: string }) {
  const qc = useQueryClient();
  const [label, setLabel] = useState('');
  const [result, setResult] = useState<MarketingResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const q = useQuery({
    queryKey: ['platform', 'store', locationId, 'messaging'],
    queryFn: () => platformGet<Messaging>(`/v1/platform/stores/${locationId}/messaging`),
  });

  const act = useMutation({
    mutationFn: (action: 'check' | 'disable') => platformSend<MarketingResult>(
      'POST',
      `/v1/platform/stores/${locationId}/marketing-email`,
      { action, ...(label.trim() ? { label: label.trim() } : {}) },
    ),
    onMutate: () => { setError(null); setResult(null); },
    onSuccess: (res) => {
      setResult(res);
      void qc.invalidateQueries({ queryKey: ['platform', 'store', locationId, 'messaging'] });
    },
    onError: (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
  });

  const m = q.data;
  if (!m) return null;

  const smsOpen = m.tenDlcStatus === 'approved';
  const emailOpen = Boolean(m.marketingEmailFrom);

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4 space-y-3">
      <h2 className="font-medium">Outbound messaging</h2>

      <p className="text-xs text-slate-500">
        预约确认 / 修改 / 取消 / 次日提醒走平台品牌，<strong>不受下面两道闸门影响</strong>，
        任何时候都在发。这两道管的是营销与前台手打。
      </p>

      <div className="space-y-1">
        <Row label="10DLC (marketing SMS)" value={`${m.tenDlcStatus}${smsOpen ? '' : ' — 营销短信 / 技师通知 / 前台手打全部停发'}`} />
        <Row label="Reviewed at" value={m.tenDlcReviewedAt ?? '—'} />
        <Link to={`/10dlc/${locationId}`} className="text-sm text-teal-700 inline-block">
          在 10DLC 页面审批 →
        </Link>
      </div>

      <div className="space-y-1 pt-2 border-t border-slate-100">
        <Row
          label="Marketing email from"
          value={m.marketingEmailFrom ?? '— 未配置，营销邮件停发'}
          copyable={emailOpen}
        />
        <Row label="Slug (子域按它推算)" value={m.slug} />
        <Row label="Appointment copy to shop" value={m.appointmentEmailCopyToShop ? `yes → ${m.shopEmail ?? '（门店没填邮箱，实际不抄送）'}` : 'no'} />
      </div>

      <div className="flex flex-wrap items-center gap-2 pt-1">
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="子域标签（留空按 slug 推算）"
          className="rounded-lg border border-slate-300 px-2 py-1 text-sm font-mono w-64"
        />
        <button
          type="button"
          disabled={act.isPending}
          onClick={() => act.mutate('check')}
          className="rounded-lg bg-slate-900 text-white px-3 py-1.5 text-sm disabled:opacity-60"
        >
          {act.isPending ? '正在向 Resend 核验…' : '检查 Resend 并启用'}
        </button>
        {emailOpen ? (
          <button
            type="button"
            disabled={act.isPending}
            onClick={() => act.mutate('disable')}
            className="rounded-lg border border-red-300 text-red-700 px-3 py-1.5 text-sm disabled:opacity-60"
          >
            停用
          </button>
        ) : null}
      </div>

      <p className="text-xs text-slate-500">
        顺序：① 在 Resend 建 domain 并在 Cloudflare 加 SPF / DKIM / DMARC（Proxy 关掉）
        → ② 回到这里点「检查 Resend 并启用」。核验通过才会写库 —— 这个按钮核验的是
        事实，不是你的声明。
      </p>

      {error ? <p className="text-sm text-red-600">{error}</p> : null}

      {result ? (
        result.marketingEmailFrom ? (
          <p className="text-sm text-green-700">
            已启用：{result.marketingEmailFrom}（{result.domain} 状态 {result.domainStatus}）
          </p>
        ) : result.domainStatus === 'disabled' ? (
          <p className="text-sm text-slate-700">已停用，营销邮件立刻停发。Resend 上的域名没有动。</p>
        ) : (
          <div className="text-sm space-y-2">
            <p className="text-amber-800">
              {result.domain} 当前状态 <strong>{result.domainStatus}</strong>，还没验证通过，未写库。
            </p>
            {result.dnsInstructions ? (
              <pre className="text-xs bg-slate-50 border border-slate-200 rounded-lg p-3 overflow-x-auto whitespace-pre-wrap">
                {result.dnsInstructions}
              </pre>
            ) : null}
          </div>
        )
      ) : null}
    </section>
  );
}

function Row({ label, value, copyable }: { label: string; value: string; copyable?: boolean }) {
  return (
    <div className="flex gap-3 text-sm py-0.5">
      <div className="w-44 text-slate-500 shrink-0">{label}</div>
      <div className="font-mono break-all">{value}</div>
      {copyable && value !== '—' ? (
        <button type="button" className="text-xs text-teal-700" onClick={() => copy(value)}>Copy</button>
      ) : null}
    </div>
  );
}
