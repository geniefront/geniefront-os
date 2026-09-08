/**
 * 结账 / 工单里的组合套餐明细卡（U10 / 计划 §7「结账套餐视图」）。
 *
 * 只读展示：每份套餐的原价合计、套餐优惠、套餐价，以及它展开出的子项。
 * 机器账务里子项 `totalCents` 已是分摊后净额，这里的「原价」取下单时锁定的
 * `bundleListPriceCents`，收据口径「原价 170 / 套餐优惠 20 / 套餐价 150」由此而来。
 *
 * Checkout.tsx 与 pages/queue/modals/CheckoutModal.tsx 共用。
 */
import { Badge } from '@/components/ui/Badge';
import { useLanguage } from '@/LanguageContext';
import { centsToDollars } from '@/features/checkout/api';

const money = (cents: number) => `$${centsToDollars(cents)}`;

/** 结账页 / 看板结账弹窗两处的工单形状略有差异，这里只取共有的最小字段。 */
interface SummaryBundle {
  instanceId: string;
  name: string;
  bundlePriceCents: number;
  extraDiscountCents: number;
  unitCount: number;
  doneCount: number;
  fulfilled: boolean;
  status: string;
}
interface SummaryItem {
  ticketItemId: string;
  name: string;
  totalCents: number;
  bundleInstanceId?: string | null;
  bundleListPriceCents?: number | null;
}

export function BundleCheckoutSummary({
  bundles, items,
}: {
  bundles: readonly SummaryBundle[] | undefined;
  items: readonly SummaryItem[];
}) {
  const { t } = useLanguage();
  const visible = (bundles ?? []).filter((b) => b.status !== 'split' && b.status !== 'cancelled');
  if (visible.length === 0) return null;

  return (
    <div className="bg-white p-4 rounded-2xl border border-teal-200 shadow-sm space-y-3">
      <h3 className="font-bold text-slate-900 text-xs uppercase tracking-wider flex items-center gap-1.5">
        <Badge className="bg-teal-600 text-white">{t('bundle.checkoutGroupLabel')}</Badge>
      </h3>
      {visible.map((b) => {
        const units = items.filter((i) => i.bundleInstanceId === b.instanceId);
        const listTotal = units.reduce(
          (n, i) => n + (i.bundleListPriceCents ?? i.totalCents), 0);
        const savings = Math.max(0, listTotal - b.bundlePriceCents);
        return (
          <div key={b.instanceId} className="rounded-xl bg-teal-50/60 border border-teal-100 p-3 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <span className="font-semibold text-teal-900 truncate">{b.name}</span>
              <span className="text-[11px] font-semibold text-teal-700">
                {b.fulfilled
                  ? t('bundle.cardFulfilled')
                  : t('bundle.cardProgress', { done: b.doneCount, total: b.unitCount })}
              </span>
            </div>
            <ul className="text-[11px] text-slate-600 space-y-0.5 pl-2 border-l-2 border-teal-200">
              {units.map((u) => (
                <li key={u.ticketItemId} className="flex justify-between gap-2">
                  <span className="truncate">{u.name}</span>
                  <span className="text-slate-400 line-through">
                    {money(u.bundleListPriceCents ?? u.totalCents)}
                  </span>
                </li>
              ))}
            </ul>
            <div className="flex justify-between text-[11px]">
              <span className="text-slate-500">{t('bundle.checkoutListPrice')}</span>
              <span className="font-mono text-slate-500 line-through">{money(listTotal)}</span>
            </div>
            {savings > 0 && (
              <div className="flex justify-between text-[11px] text-emerald-600 font-semibold">
                <span>{t('bundle.checkoutBundleSaving')}</span>
                <span className="font-mono">−{money(savings)}</span>
              </div>
            )}
            {b.extraDiscountCents > 0 && (
              <div className="flex justify-between text-[11px] text-emerald-600 font-semibold">
                <span>{t('bundle.checkoutExtraAddon')}</span>
                <span className="font-mono">−{money(b.extraDiscountCents)}</span>
              </div>
            )}
            <div className="flex justify-between text-xs font-bold text-teal-900 border-t border-teal-200 pt-1.5">
              <span>{t('bundle.checkoutBundlePrice')}</span>
              <span className="font-mono">{money(b.bundlePriceCents)}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
