import { useState } from 'react';
import { useLanguage } from '@/LanguageContext';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { SectionError } from '@/components/ui/QueryState';
import { useErrorMessage } from '@/lib/errorMessage';
import { toast } from '@heroui/react';
import { AlertCircle, CheckCircle2, PhoneCall, Sparkles, Ticket } from 'lucide-react';
import {
  useBillingQuery,
  useCreateBillingPortalSession,
  useCreatePaymentMethodSession,
  useCreateTopup,
  useInvoicesQuery,
  useRedeemLicenseCode,
  useSetAutoTopup,
} from './api';
import { useDeskSettingsQuery, useSetEmailLocale } from '@/features/settings/api';
import type { EmailLocale } from '@/features/settings/types';
import {
  formatIsoDate,
  formatUsdFromCents,
  invoiceStatusKey,
  isLicenseBilling,
  planLabelKey,
  PORTAL_RETURN_PATH,
  safeHttpsUrl,
  statusBadgeVariant,
  stripeHostedUrl,
  stripePortalUrl,
  subscriptionStatusKey,
  subscriptionNotice,
} from './display';
import type { BillingView, QuotaUnit, QuotaView } from './types';

/**
 * 账单类邮件的可选语言。
 *
 * ⚠️ 与界面语言（个人资料里那一项）刻意分开：界面语言会随操作者变化，
 * 而账单邮件的收件人恒为店主本人。
 * ⚠️ 顾客侧的邮件与短信恒为英语，不受此处影响。
 */
const EMAIL_LOCALES: Array<{ value: EmailLocale; label: string }> = [
  { value: 'en', label: 'English' },
  { value: 'zh-Hans', label: '简体中文' },
  { value: 'zh-Hant', label: '繁體中文' },
  { value: 'ko', label: '한국어' },
  { value: 'vi', label: 'Tiếng Việt' },
  { value: 'es', label: 'Español' },
];

function usagePercent(quota: QuotaView | undefined): number {
  if (!quota?.included || quota.included.total <= 0) return 0;
  return Math.min(100, Math.round((quota.included.used / quota.included.total) * 100));
}

export function BillingPanel() {
  const { t } = useLanguage();
  const errorMessage = useErrorMessage();
  const billingQuery = useBillingQuery();
  const invoicesQuery = useInvoicesQuery();
  const portalMutation = useCreateBillingPortalSession();
  const paymentMethodMutation = useCreatePaymentMethodSession();
  const topupMutation = useCreateTopup();
  const autoTopupMutation = useSetAutoTopup();
  const deskSettingsQuery = useDeskSettingsQuery();
  const emailLocaleMutation = useSetEmailLocale();
  const emailLocale: EmailLocale = deskSettingsQuery.data?.emailLocale ?? 'en';
  const [pendingTopupUnit, setPendingTopupUnit] = useState<QuotaUnit | null>(null);
  const [savingAutoTopupUnit, setSavingAutoTopupUnit] = useState<QuotaUnit | null>(null);

  const billing = billingQuery.data?.billing ?? null;
  const invoices = invoicesQuery.data?.invoices ?? [];
  const voiceQuota = billing?.quotas.find((quota) => quota.unit === 'voice_minute');
  const creditQuota = billing?.quotas.find((quota) => quota.unit === 'credit');
  const voiceUsagePercent = usagePercent(voiceQuota);
  const creditUsagePercent = usagePercent(creditQuota);
  const trialing = billing?.trialing === true;
  const statusKey = subscriptionStatusKey(billing?.subscriptionStatus, trialing);
  const badgeVariant = statusBadgeVariant(billing?.subscriptionStatus, trialing);
  const trialEnds = formatIsoDate(billing?.trialEndsAt);
  const periodEnd = formatIsoDate(billing?.currentPeriodEnd);
  /**
   * ⚠️ 期末取消时 Stripe 的 status **仍然是 active** —— 只有这一位能表达
   * 「还能用，但到期即止」。不显示的话老板会在到期那天突然发现全店冻结。
   */
  const cancelPending = billing?.cancelAtPeriodEnd === true;
  const notice = subscriptionNotice(billing);
  const pastDue = !trialing && (billing?.subscriptionStatus === 'past_due'
    || billing?.subscriptionStatus === 'unpaid'
    || billing?.subscriptionStatus === 'incomplete_expired');
  const canceled = billing?.subscriptionStatus === 'canceled' && !trialing;
  const hasPaymentMethod = billing?.hasPaymentMethod === true;
  /**
   * ⭐ 由订阅码付费的门店（迁移 0120）。
   *
   * 它**没有** Stripe 客户门户，也没有卡 —— 那两个按钮给他等于给一个 404
   * 和一句「请绑卡」，而他的续期对象是我们。
   */
  const licenseBilled = isLicenseBilling(billing);
  const expired = billing?.subscriptionStatus === 'expired';
  const packPrice = billing ? formatUsdFromCents(billing.topupPriceCents) : '$50.00';

  const openPortal = async () => {
    try {
      const res = await portalMutation.mutateAsync(PORTAL_RETURN_PATH);
      const url = stripePortalUrl(res);
      if (!url) {
        toast.danger(t('settings.stPortalUrlMissing'));
        return;
      }
      window.open(url, '_blank', 'noopener,noreferrer');
    } catch (err: unknown) {
      toast.danger(errorMessage(err));
    }
  };

  const addPaymentMethod = async () => {
    try {
      const res = await paymentMethodMutation.mutateAsync(PORTAL_RETURN_PATH);
      const url = stripeHostedUrl(res);
      if (!url) {
        toast.danger(t('settings.stPaymentMethodUrlMissing'));
        return;
      }
      window.location.assign(url);
    } catch (err: unknown) {
      toast.danger(errorMessage(err));
    }
  };

  const buyPack = async (unit: QuotaUnit) => {
    if (!hasPaymentMethod) {
      toast.danger(t('settings.stTopupNeedsCard'));
      return;
    }
    try {
      const res = await topupMutation.mutateAsync(unit);
      if (!res.ok && res.pending) {
        setPendingTopupUnit(unit);
        return;
      }
      if (res.ok) {
        setPendingTopupUnit(null);
        toast.success(t('settings.stTopupRecorded'));
        void billingQuery.refetch();
      }
    } catch (err: unknown) {
      toast.danger(errorMessage(err));
    }
  };

  const saveAutoTopup = async (unit: QuotaUnit, enabled: boolean, thresholdUnits: number) => {
    setSavingAutoTopupUnit(unit);
    try {
      await autoTopupMutation.mutateAsync({ unit, enabled, thresholdUnits });
      toast.success(t('settings.stAutoTopupSaved'));
      void billingQuery.refetch();
    } catch (err: unknown) {
      toast.danger(errorMessage(err));
    } finally {
      setSavingAutoTopupUnit(null);
    }
  };

  return (
    <Card className="border border-slate-200/90 shadow-sm rounded-2xl overflow-hidden bg-white">
      <CardHeader className="bg-slate-50/50 px-6 py-4 border-b border-slate-100 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2.5">
            <CardTitle className="text-sm font-bold text-slate-900">{t('settings.stBillingTitle')}</CardTitle>
            {billing && (
              <Badge variant={badgeVariant} className="text-xs font-bold gap-1">
                {trialing || billing.subscriptionStatus === 'active'
                  ? <CheckCircle2 className="w-3.5 h-3.5" />
                  : <AlertCircle className="w-3.5 h-3.5" />}
                {t(planLabelKey(billing.plan))} · {t(statusKey)}
              </Badge>
            )}
          </div>
          <CardDescription className="text-xs text-slate-500 mt-0.5">{t('settings.stBillingDesc')}</CardDescription>
        </div>
      </CardHeader>
      <CardContent className="p-6">
        {billingQuery.isLoading ? (
          <p className="text-xs text-slate-500">{t('settings.stBillingLoading')}</p>
        ) : billingQuery.isError ? (
          /* 取不到与「没有订阅」是两回事：前者要重试，后者要去开通 */
          <SectionError error={billingQuery.error} onRetry={() => void billingQuery.refetch()} />
        ) : !billing ? (
          <EmptyState title={t('settings.stBillingUnavailable')} />
        ) : (
          <>
            <div
              className={`p-5 rounded-2xl text-white shadow-md flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 mb-6 ${
                pastDue || cancelPending
                  ? 'bg-gradient-to-r from-amber-900 to-slate-900'
                  : expired
                    ? 'bg-gradient-to-r from-red-900 to-slate-900'
                    : canceled
                    ? 'bg-gradient-to-r from-slate-700 to-slate-900'
                    : 'bg-gradient-to-r from-teal-900 to-slate-900'
              }`}
            >
              <div className="space-y-1">
                <span className="text-[10px] uppercase tracking-wider text-teal-300 font-bold">
                  {t('settings.stCurrentSubscription')}
                </span>
                <h3 className="text-xl font-black text-white">
                  {t(planLabelKey(billing.plan))} · {t(statusKey)}
                </h3>
                <p className={`text-xs ${cancelPending ? 'text-amber-200 font-bold' : 'text-teal-100/80'}`}>
                  {notice.date
                    ? t(notice.key, { p0: formatIsoDate(notice.date) ?? '' })
                    : t(notice.key)}
                </p>
                {/* license 店没有卡，也不需要有 —— 少说一句「未绑定支付方式」 */}
                {licenseBilled ? null : (
                  <p className="text-xs text-teal-100/80">
                    {hasPaymentMethod
                      ? (billing.paymentMethodLabel
                        ? t('settings.stPaymentMethod', { p0: billing.paymentMethodLabel })
                        : t('settings.stPaymentMethodOnFile'))
                      : t('settings.stNoPaymentMethod')}
                  </p>
                )}
              </div>
              <div className="flex flex-col items-stretch sm:items-end gap-2">
                {licenseBilled ? (
                  /*
                   * ⚠️ 这里**一个 Stripe 按钮都不给**。这家店没有 Stripe 客户，
                   * 「管理订阅」会打开一个 404，「添加支付方式」则是在问一个
                   * 他从来没答应过的问题。
                   */
                  <p className="text-[11px] text-white/70 max-w-[18rem] sm:text-right">
                    {t('settings.stLicenseHint')}
                  </p>
                ) : (
                  <>
                    <Button
                      isPending={portalMutation.isPending}
                      variant="secondary"
                      size="sm"
                      disabled={portalMutation.isPending}
                      onClick={() => void openPortal()}
                      className="text-xs font-bold bg-white/10 hover:bg-white/20 text-white border-white/20"
                    >
                      {portalMutation.isPending ? t('settings.stBillingLoading') : t('settings.stManageSubscription')}
                    </Button>
                    {!hasPaymentMethod && (
                      <Button
                        isPending={paymentMethodMutation.isPending}
                        variant="secondary"
                        size="sm"
                        disabled={paymentMethodMutation.isPending}
                        onClick={() => void addPaymentMethod()}
                        className="text-xs font-bold bg-white/10 hover:bg-white/20 text-white border-white/20"
                      >
                        {paymentMethodMutation.isPending
                          ? t('settings.stBillingLoading')
                          : t('settings.stAddPaymentMethod')}
                      </Button>
                    )}
                    <p className="text-[11px] text-white/70 max-w-[16rem] sm:text-right">
                      {t('settings.stPortalHint')}
                    </p>
                  </>
                )}
              </div>
            </div>

            <div className="space-y-3 mb-6">
              <h4 className="font-bold text-xs uppercase tracking-wider text-slate-500">
                {t('settings.stUsageQuotas')}
              </h4>
              {pendingTopupUnit && (
                <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2">
                  {t('settings.stTopupPending')}
                </p>
              )}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="p-4 rounded-2xl border border-slate-200 bg-white space-y-2.5 shadow-2xs">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold text-slate-700 flex items-center gap-1.5">
                      <PhoneCall className="w-4 h-4 text-teal-600" />
                      {t('settings.stVoiceMinutes')}
                    </span>
                    <span className="text-xs font-mono font-bold text-teal-700">
                      {voiceQuota ? `${voiceQuota.included.used} / ${voiceQuota.included.total}` : '—'}
                    </span>
                  </div>
                  <div className="w-full h-2 rounded-full bg-slate-100 overflow-hidden">
                    <div className="h-full bg-teal-600 rounded-full" style={{ width: `${voiceUsagePercent}%` }} />
                  </div>
                  <p className="text-[11px] text-slate-400">{t('settings.stVoiceMinutesDesc')}</p>
                  {voiceQuota && (
                    <QuotaActions
                      quota={voiceQuota}
                      packLabel={t('settings.stBuyVoicePack')}
                      packPrice={packPrice}
                      pending={pendingTopupUnit === 'voice_minute'}
                      saving={savingAutoTopupUnit === 'voice_minute'}
                      topupPending={topupMutation.isPending}
                      onBuy={() => void buyPack('voice_minute')}
                      onAutoTopup={(enabled) => void saveAutoTopup(
                        'voice_minute',
                        enabled,
                        voiceQuota.autoTopup.thresholdUnits,
                      )}
                      t={t}
                    />
                  )}
                </div>

                <div className="p-4 rounded-2xl border border-slate-200 bg-white space-y-2.5 shadow-2xs">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold text-slate-700 flex items-center gap-1.5">
                      <Sparkles className="w-4 h-4 text-purple-600" />
                      {t('settings.stAiTokens')}
                    </span>
                    <span className="text-xs font-mono font-bold text-purple-700">
                      {creditQuota
                        ? `${creditQuota.included.used} / ${creditQuota.included.total} (${creditUsagePercent}%)`
                        : '—'}
                    </span>
                  </div>
                  <div className="w-full h-2 rounded-full bg-slate-100 overflow-hidden">
                    <div className="h-full bg-purple-600 rounded-full" style={{ width: `${creditUsagePercent}%` }} />
                  </div>
                  <p className="text-[11px] text-slate-400">{t('settings.stAiTokensDesc')}</p>
                  {creditQuota && (
                    <QuotaActions
                      quota={creditQuota}
                      packLabel={t('settings.stBuyCreditPack')}
                      packPrice={packPrice}
                      pending={pendingTopupUnit === 'credit'}
                      saving={savingAutoTopupUnit === 'credit'}
                      topupPending={topupMutation.isPending}
                      onBuy={() => void buyPack('credit')}
                      onAutoTopup={(enabled) => void saveAutoTopup(
                        'credit',
                        enabled,
                        creditQuota.autoTopup.thresholdUnits,
                      )}
                      t={t}
                    />
                  )}
                </div>
              </div>
              <p className="text-[11px] text-slate-400">{t('settings.stAutoTopupHint')}</p>
            </div>

            <RedeemCodeSection billing={billing} />

            <div className="space-y-3">
              <h4 className="font-bold text-xs uppercase tracking-wider text-slate-500">
                {t('settings.stInvoicesTitle')}
              </h4>
              {invoicesQuery.isLoading ? (
                <p className="text-xs text-slate-500">{t('settings.stBillingLoading')}</p>
              ) : invoicesQuery.isError ? (
                <div className="border border-slate-200 rounded-2xl">
                  <SectionError error={invoicesQuery.error} onRetry={() => void invoicesQuery.refetch()} className="py-8" />
                </div>
              ) : invoices.length === 0 ? (
                <div className="border border-slate-200 rounded-2xl">
                  <EmptyState title={t('settings.stNoInvoices')} className="py-8" />
                </div>
              ) : (
                <div className="border border-slate-200 rounded-2xl overflow-hidden text-xs">
                  <div className="bg-slate-50 p-3 font-bold text-slate-600 grid grid-cols-4 border-b border-slate-200">
                    <span>{t('settings.stInvoiceNo')}</span>
                    <span>{t('settings.stBillingPeriod')}</span>
                    <span>{t('settings.stInvoiceAmount')}</span>
                    <span className="text-right">{t('settings.stDownloadReceipt')}</span>
                  </div>
                  {invoices.map((inv) => {
                    const pdfUrl = safeHttpsUrl(inv.receiptPdfUrl);
                    return (
                      <div
                        key={inv.id}
                        className="p-3 grid grid-cols-4 items-center border-b last:border-b-0 border-slate-100 hover:bg-slate-50/50"
                      >
                        <span className="font-mono font-bold text-slate-800">
                          {inv.invoiceNumber}
                          <span className="block font-sans font-medium text-[10px] text-slate-400 mt-0.5">
                            {t(invoiceStatusKey(inv.status))}
                          </span>
                        </span>
                        <span className="text-slate-600">{inv.period || inv.date}</span>
                        <span className="font-mono font-bold text-slate-900">
                          {formatUsdFromCents(inv.amountCents)}
                        </span>
                        <div className="text-right">
                          {pdfUrl ? (
                            <a
                              href={pdfUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-xs font-bold text-teal-600 hover:text-teal-700 hover:underline"
                            >
                              {t('settings.stDownloadPdf')}
                            </a>
                          ) : (
                            <span className="text-xs text-slate-400">{t('settings.stNoReceipt')}</span>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* ── 账单邮件语言 ─────────────────────────────────────── */}
            <div className="mt-8 pt-6 border-t border-slate-100">
              <label
                htmlFor="billing-email-locale"
                className="text-xs font-bold text-slate-900 block mb-1"
              >
                {t('settings.stBillingEmailLanguage')}
              </label>
              <p className="text-xs text-slate-500 mb-3">
                {t('settings.stBillingEmailLanguageHint')}
              </p>
              <select
                id="billing-email-locale"
                className="text-sm border border-slate-200 rounded-lg px-3 py-2 bg-white
                           focus:outline-none focus:ring-2 focus:ring-teal-500 disabled:opacity-60"
                value={emailLocale}
                disabled={emailLocaleMutation.isPending}
                onChange={(e) => {
                  const next = e.target.value as EmailLocale;
                  emailLocaleMutation.mutate(next, {
                    onSuccess: () => toast.success(t('settings.stBillingEmailLanguageSaved')),
                    onError: (err) => toast.danger(errorMessage(err)),
                  });
                }}
              >
                {EMAIL_LOCALES.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * 兑换订阅码 / 额度包码（迁移 0120）。
 *
 * ## ⭐ 到期的门店照样能在这里兑
 *
 * 到期之后整店写操作被冻结（`bus.ts` 的闸门），但 `billing.` 前缀是**放行**
 * 的 —— 欠费时唯一还该能做的写操作，就是把欠费这件事解决掉。所以这一块
 * 不能因为 `expired` 就禁用，那会把唯一的自救出口关掉。
 *
 * ## 失败只有三句话
 *
 * 服务端把「不存在 / 已用过 / 已撤销 / 过了兑换期」一律收敛成一个
 * `code_invalid`（避免这个接口变成枚举探针），所以界面上也只能说
 * 「这个码不能用」。另外两句是限频和「你还在 Stripe 上」。
 */
function RedeemCodeSection({ billing }: { billing: BillingView }) {
  const { t } = useLanguage();
  const redeem = useRedeemLicenseCode();
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    setDone(null);
    try {
      const res = await redeem.mutateAsync(code.trim());
      setCode('');
      if (res.kind === 'quota_pack' && res.unit !== null && res.amount !== null) {
        const amountText = t(
          res.unit === 'voice_minute' ? 'settings.stRedeemUnitMinutes' : 'settings.stRedeemUnitCredits',
          { p0: String(res.amount) },
        );
        setDone(t('settings.stRedeemOkQuota', { p0: amountText }));
      } else {
        setDone(t('settings.stRedeemOkSubscription', {
          p0: formatIsoDate(res.periodEnd) ?? '',
        }));
      }
      toast.success(t('settings.stRedeemButton'));
    } catch (err: unknown) {
      /*
       * ⚠️ 这三档要分开说。把它们合成一句「兑换失败」的话，
       * 一个正在被 Stripe 扣款的老板会一直重试一张本来就对的码。
       */
      const e = err as { code?: string; details?: Record<string, unknown> };
      const reason = e.details?.['reason'];
      if (e.code === 'RATE_LIMITED') {
        setError(t('settings.stRedeemTooMany'));
      } else if (reason === 'stripe_active_switch_required') {
        setError(t('settings.stRedeemStripeConflict'));
      } else {
        setError(t('settings.stRedeemInvalid'));
      }
    }
  };

  return (
    <div className="space-y-2 mb-6">
      <h4 className="font-bold text-xs uppercase tracking-wider text-slate-500 flex items-center gap-1.5">
        <Ticket className="w-4 h-4 text-teal-600" />
        {t('settings.stRedeemTitle')}
      </h4>
      <p className="text-[11px] text-slate-400">{t('settings.stRedeemDesc')}</p>
      <div className="flex flex-col sm:flex-row gap-2">
        <input
          className="flex-1 rounded-xl border border-slate-200 px-3 py-2 text-sm font-mono tracking-wide uppercase"
          placeholder="GF-XXXXX-XXXXX-XXXXX-XXXXX"
          value={code}
          onChange={(e) => { setCode(e.target.value); setError(null); }}
          onKeyDown={(e) => { if (e.key === 'Enter' && code.trim() !== '') void submit(); }}
          aria-label={t('settings.stRedeemTitle')}
        />
        <Button
          isPending={redeem.isPending}
          size="sm"
          disabled={code.trim().length < 8 || redeem.isPending}
          onClick={() => void submit()}
          className="text-xs font-bold"
        >
          {redeem.isPending ? t('settings.stBillingLoading') : t('settings.stRedeemButton')}
        </Button>
      </div>
      {error ? (
        <p className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-xl px-3 py-2">{error}</p>
      ) : null}
      {done ? (
        <p className="text-xs text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-xl px-3 py-2">{done}</p>
      ) : null}
      {/* 已经归订阅码管的店，顺手把「到期日」再说一遍 —— 兑换成功之后
          他第一件想确认的事就是「现在到哪天了」 */}
      {billing.billingSource === 'license' && billing.licensePeriodEnd ? (
        <p className="text-[11px] text-slate-400">
          {t('settings.stLicenseUntil', { p0: formatIsoDate(billing.licensePeriodEnd) ?? '' })}
        </p>
      ) : null}
    </div>
  );
}

function QuotaActions({
  quota,
  packLabel,
  packPrice,
  pending,
  saving,
  topupPending,
  onBuy,
  onAutoTopup,
  t,
}: {
  quota: QuotaView;
  packLabel: string;
  packPrice: string;
  pending: boolean;
  saving: boolean;
  topupPending: boolean;
  onBuy: () => void;
  onAutoTopup: (enabled: boolean) => void;
  t: (key: string, params?: Record<string, string | number>) => string;
}) {
  return (
    <div className="space-y-2 pt-1 border-t border-slate-100">
      <p className="text-[11px] font-mono text-slate-500">
        {t('settings.stPurchasedBalance', { p0: String(quota.balance) })}
      </p>
      <Button
        variant="outline"
        size="sm"
        disabled={topupPending}
        onClick={onBuy}
        className="text-xs font-bold w-full"
      >
        {topupPending && pending ? t('settings.stBillingLoading') : packLabel}
      </Button>
      <label className="flex items-center justify-between gap-2 text-[11px] text-slate-600">
        <span>{t('settings.stAutoTopup', { p0: String(quota.autoTopup.thresholdUnits) })} · {packPrice}</span>
        <input
          type="checkbox"
          checked={quota.autoTopup.enabled}
          disabled={saving}
          onChange={(event) => onAutoTopup(event.target.checked)}
          className="w-4 h-4 rounded text-teal-600 focus:ring-teal-500 cursor-pointer"
        />
      </label>
    </div>
  );
}
