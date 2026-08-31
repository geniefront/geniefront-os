import { useState } from 'react';
import { useLanguage } from '@/LanguageContext';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { useErrorMessage } from '@/lib/errorMessage';
import { toast } from '@heroui/react';
import { AlertCircle, CheckCircle2, PhoneCall, Sparkles } from 'lucide-react';
import {
  useBillingQuery,
  useCreateBillingPortalSession,
  useCreatePaymentMethodSession,
  useCreateTopup,
  useInvoicesQuery,
  useSetAutoTopup,
} from './api';
import {
  formatIsoDate,
  formatUsdFromCents,
  invoiceStatusKey,
  planLabelKey,
  PORTAL_RETURN_PATH,
  safeHttpsUrl,
  statusBadgeVariant,
  stripeHostedUrl,
  stripePortalUrl,
  subscriptionStatusKey,
} from './display';
import type { QuotaUnit, QuotaView } from './types';

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
  const pastDue = !trialing && (billing?.subscriptionStatus === 'past_due'
    || billing?.subscriptionStatus === 'unpaid'
    || billing?.subscriptionStatus === 'incomplete_expired');
  const canceled = billing?.subscriptionStatus === 'canceled' && !trialing;
  const hasPaymentMethod = billing?.hasPaymentMethod === true;
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
        ) : !billing ? (
          <EmptyState title={t('settings.stBillingUnavailable')} />
        ) : (
          <>
            <div
              className={`p-5 rounded-2xl text-white shadow-md flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 mb-6 ${
                pastDue
                  ? 'bg-gradient-to-r from-amber-900 to-slate-900'
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
                <p className="text-xs text-teal-100/80">
                  {trialing && trialEnds
                    ? t('settings.stTrialEnds', { p0: trialEnds })
                    : periodEnd
                      ? t('settings.stRenewsOn', { p0: periodEnd })
                      : t('settings.stPortalHint')}
                </p>
                <p className="text-xs text-teal-100/80">
                  {hasPaymentMethod
                    ? (billing.paymentMethodLabel
                      ? t('settings.stPaymentMethod', { p0: billing.paymentMethodLabel })
                      : t('settings.stPaymentMethodOnFile'))
                    : t('settings.stNoPaymentMethod')}
                </p>
              </div>
              <div className="flex flex-col items-stretch sm:items-end gap-2">
                <Button
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

            <div className="space-y-3">
              <h4 className="font-bold text-xs uppercase tracking-wider text-slate-500">
                {t('settings.stInvoicesTitle')}
              </h4>
              {invoicesQuery.isLoading ? (
                <p className="text-xs text-slate-500">{t('settings.stBillingLoading')}</p>
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
          </>
        )}
      </CardContent>
    </Card>
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
