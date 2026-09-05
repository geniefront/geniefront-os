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

      <Link className="block rounded-xl border bg-white p-4 text-teal-700" to="/email">Email delivery, subaccounts and DNS work orders →</Link>
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
 * 外发消息面板 —— 运营从这里告诉后端「这家店可以发营销邮件了」。
 *
 * ⚠️ 这里**没有输入框让人填地址**。手填意味着一个笔误就把营销邮件指向一个
 * 不存在的地址，而后果不是报错、是整批退信，退信率同样计入发信域名信誉。
 * 因此只有一个按钮：让服务端去问当前邮件供应商「营销域验过没有」，
 * 验过了才写库。
 *
 * 营销域是**所有门店共用的一个域**（`mkt.geniefront.com`），门店身份体现在
 * 本地部分上 —— 因此这里不需要任何 DNS 操作，也没有逐店的域名要建。
 */
function MessagingPanel({ locationId }: { locationId: string }) {
  const q=useQuery({queryKey:['platform','messaging',locationId],queryFn:()=>platformGet<Messaging>(`/v1/platform/stores/${locationId}/messaging`)});
  return <section className="rounded-xl border bg-white p-4"><h2 className="font-medium">Appointment notifications</h2>
    <p>Shop copy: {q.data?.appointmentEmailCopyToShop ? q.data.shopEmail ?? 'No shop email configured' : 'Off'}</p>
    <p>Marketing email is coming soon.</p>
  </section>;
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
