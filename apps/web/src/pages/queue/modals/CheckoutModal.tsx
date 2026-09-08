/**
 * 前台收银结算：多技师分账、包厢明细、加项提成、税费与手续费、分阶段收款。
 *
 * 渲染与提交共用同一份 `computeCheckoutTotals` 结果 —— 此前两处各算各的，
 * 界面上的小费分账明细没有出口，前台看到的分配与技师实际拿到的提成对不上。
 * 收款阶段决定这里的可编辑范围：只收服务款时没有小费，只收小费时没有折扣、
 * 税与刷卡手续费。从 `pages/Queue.tsx` 原样搬出，状态仍留在页面。
 */
import { Award, BedDouble, Check, Coins, CreditCard, Gift, RefreshCw, Scissors, User, Wallet } from 'lucide-react';
import { Spinner } from '@heroui/react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Badge } from '@/components/ui/Badge';
import { cn } from '@/lib/utils';
import { useLanguage } from '@/LanguageContext';
import { useErrorMessage } from '@/lib/errorMessage';
import { toast } from '@/lib/toast';
import { centsToDollars, dollarsToCents, verifyGiftCard } from '@/features/checkout/api';
import { buildCheckoutStaffList, computeCheckoutTotals } from '@/features/queue/checkoutMath';
import { BundleCheckoutSummary } from '@/features/bundles/BundleCheckoutSummary';
import { customerInitials } from '@/lib/displayName';
import { PAYMENT_METHOD_LABEL_KEYS } from '../model';
import type { KanbanItem } from '../model';
import type { PaymentStage, OpenTicketsView } from '@/features/checkout/types';

export interface CheckoutModalState {
  isOpen: boolean;
  item: KanbanItem | null;
  discountDollars: string;
  enableTax: boolean;
  taxRatePercent: string;
  enableCardSurcharge: boolean;
  cardSurchargePercent: string;
  tipMode: 'total_split' | 'custom_per_staff';
  tipPercentage: number;
  totalTipDollars: string;
  splitStrategy: 'proportional' | 'equal';
  customStaffTips: Record<string, string>;
  paymentMethod: 'card' | 'cash' | 'gift_card' | 'apple_pay';
  paymentStage: PaymentStage;
  tenderedDollars: string;
  keepChange: boolean;
  giftCardCode: string;
  giftCardId: string;
  giftCardVerified: boolean;
  giftCardBalanceCents: number;
  isVerifyingGiftCard: boolean;
}

export interface CheckoutModalProps {
  state: CheckoutModalState;
  checkoutSettings: OpenTicketsView['checkoutSettings'];
  allowTipSplitOverride: boolean;
  isPending: boolean;
  onChange: React.Dispatch<React.SetStateAction<CheckoutModalState>>;
  onConfirm: () => void | Promise<void>;
}

export function CheckoutModal({
  state, checkoutSettings, allowTipSplitOverride, isPending, onChange, onConfirm,
}: CheckoutModalProps) {
  const { t } = useLanguage();
  const errorMessage = useErrorMessage();
  if (!state.isOpen || !state.item) return null;

  const item = state.item;
  const baseCents = item.priceCents || 0;

  /*
   * 渲染与提交共用同一份计算结果。
   * 此前两处各算各的，界面上的小费分账明细没有出口，前台看到的分配
   * 与技师实际拿到的提成对不上 —— 现在看到什么就发送什么。
   */
  const staffList = buildCheckoutStaffList(
    {
      serviceName: item.serviceName,
      priceCents: baseCents,
      staffId: item.staffId,
      staffName: item.staffName,
      rawTicket: item.rawTicket,
      addOns: item.addOns,
    },
    t('queue.quLeadTherapist'),
    (name) => t('queue.quAddOnPrefix', { p0: name }),
  );
  const totals = computeCheckoutTotals({
    staffList,
    baseCents,
    discountDollars: state.discountDollars,
    enableTax: state.enableTax,
    taxRatePercent: state.taxRatePercent,
    enableCardSurcharge: state.enableCardSurcharge,
    cardSurchargePercent: state.cardSurchargePercent,
    paymentMethod: state.paymentMethod,
    tipMode: state.tipMode,
    tipPercentage: state.tipPercentage,
    totalTipDollars: state.totalTipDollars,
    splitStrategy: state.splitStrategy,
    customStaffTips: state.customStaffTips,
    paymentStage: state.paymentStage,
    tipBaseCents: baseCents,
  });
  // 阶段决定界面的可编辑范围：只收服务款时没有小费，只收小费时没有折扣、税与手续费。
  const isServiceStage = state.paymentStage === 'service';
  const isTipStage = state.paymentStage === 'tip';
  const hasCard = state.paymentMethod === 'card' || state.paymentMethod === 'apple_pay';
  const tenderedCents = dollarsToCents(state.tenderedDollars || '0');
  const rawChangeDue = Math.max(0, tenderedCents - totals.chargedTotalCents);
  const tipPresets = checkoutSettings?.suggestedTipPercentages?.length
    ? [0, ...checkoutSettings.suggestedTipPercentages]
    : [0, 15, 18, 20, 25];

  return (
    <Modal
      isOpen={state.isOpen}
      onOpenChange={(open) => {
        if (!open) onChange((prev) => ({ ...prev, isOpen: false, item: null }));
      }}
      title={
        <div className="flex items-center gap-2 font-semibold text-slate-900">
          <CreditCard className="h-5 w-5 text-emerald-600" />
          <span>{t('queue.quCoTitle')}</span>
        </div>
      }
      size="lg"
      footer={
        <div className="flex w-full justify-end gap-2">
          <Button
            variant="secondary"
            isDisabled={isPending}
            onPress={() => onChange((prev) => ({ ...prev, isOpen: false, item: null }))}
          >
            {t('queue.quCheckoutCancel')}
          </Button>
          <Button
            className="gap-1 bg-teal-700 font-semibold text-white hover:bg-teal-800"
            isDisabled={isPending}
            onPress={onConfirm}
          >
            {isPending
              ? <><Spinner size="sm" />{t('queue.quProcessing')}</>
              : <><Check className="h-4 w-4" />{t('queue.quCoConfirm', { p0: centsToDollars(totals.chargedTotalCents) })}</>}
          </Button>
        </div>
      }
    >
      <div className="space-y-3 py-1 text-sm text-slate-700">
        {/* 1. 客户与服务场地概览 */}
        <div className="flex items-center justify-between rounded-2xl border border-slate-200 bg-slate-50 p-3">
          <div className="flex items-center gap-3">
            <div className="grid h-10 w-10 place-items-center rounded-xl bg-teal-700 text-sm font-semibold text-white">
              {customerInitials(item.customerName)}
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="font-semibold text-slate-900">{item.customerName}</span>
                <Badge variant="secondary">{item.serviceName}</Badge>
              </div>
              <span className="mt-0.5 flex items-center gap-1.5 text-xs text-slate-500">
                <BedDouble className="h-3.5 w-3.5 text-slate-400" />
                <span>{item.roomName || t('queue.quCoUnassignedRoom')}</span>
                <span aria-hidden>·</span>
                <span>{t('queue.quCoTechCount', { p0: staffList.length })}</span>
              </span>
            </div>
          </div>
          <div className="text-right">
            <span className="block text-xs text-slate-500">{t('queue.quCoBaseSubtotal')}</span>
            <span className="font-mono text-base font-bold text-slate-900">${centsToDollars(baseCents)}</span>
          </div>
        </div>

        {/* 分阶段收款的口径说明。前台必须先知道这一笔收的是什么，再看金额。 */}
        {(isServiceStage || isTipStage) && (
          <p className="rounded-2xl border border-amber-200 bg-amber-50 p-2.5 text-xs font-medium text-amber-900">
            {t(isServiceStage ? 'queue.quCoStageServiceBanner' : 'queue.quCoStageTipBanner')}
            {isTipStage && <span className="mt-1 block">{t('queue.quCoStageTipNoStoredValue')}</span>}
          </p>
        )}

        {/* 组合套餐明细（U10）：原价 / 套餐优惠 / 套餐价 / 子项 */}
        <BundleCheckoutSummary
          bundles={item.rawTicket?.bundles}
          items={item.rawTicket?.items ?? []}
        />

        {/* 2. 项目明细与多技师执行归属 */}
        <section className="rounded-2xl border border-slate-200 bg-white p-3">
          <h4 className="flex items-center justify-between font-semibold text-slate-800">
            <span className="flex items-center gap-1.5">
              <Scissors className="h-4 w-4 text-slate-400" />
              <span>{t('queue.quCoExecTitle')}</span>
            </span>
            <span className="text-xs font-normal text-slate-500">
              {t('queue.quCoItemCount', { p0: staffList.reduce((sum, staffShare) => sum + staffShare.items.length, 0) })}
            </span>
          </h4>

          <div className="mt-2 space-y-2">
            {staffList.map((staffShare) => (
              <div key={staffShare.membershipId} className="rounded-xl border border-slate-100 bg-slate-50 p-2.5">
                <div className="flex items-center gap-1.5 border-b border-slate-200/70 pb-1">
                  <User className="h-3.5 w-3.5 text-slate-400" />
                  <span className="font-semibold text-slate-800">{staffShare.name}</span>
                </div>
                <div className="mt-1 space-y-1">
                  {staffShare.items.map((lineItem, index) => (
                    <div key={`${staffShare.membershipId}-${index}`} className="flex items-center justify-between">
                      <span className="text-slate-700">{lineItem.name}</span>
                      <span className="font-mono font-semibold text-slate-900">${centsToDollars(lineItem.priceCents)}</span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* 3. 小费分账。服务款阶段服务端要求小费为 0，此处不提供录入口。 */}
        {!isServiceStage && (
        <section className="rounded-2xl border border-slate-200 bg-white p-3">
          <div className="flex items-center justify-between">
            <h4 className="flex items-center gap-1.5 font-semibold text-slate-800">
              <Award className="h-4 w-4 text-slate-400" />
              <span>{t('queue.quCoTipTitle')}</span>
            </h4>
            {allowTipSplitOverride && (
              <div className="flex items-center gap-1 rounded-lg bg-slate-100 p-0.5 text-xs font-medium">
                <button
                  type="button"
                  aria-pressed={state.tipMode === 'total_split'}
                  onClick={() => onChange((prev) => ({ ...prev, tipMode: 'total_split' }))}
                  className={cn(
                    'rounded-lg px-2 py-1 transition-colors',
                    state.tipMode === 'total_split' ? 'bg-white font-semibold text-teal-800 shadow-sm' : 'text-slate-500',
                  )}
                >
                  {t('queue.quCoTipModeSmart')}
                </button>
                <button
                  type="button"
                  aria-pressed={state.tipMode === 'custom_per_staff'}
                  onClick={() => onChange((prev) => ({ ...prev, tipMode: 'custom_per_staff' }))}
                  className={cn(
                    'rounded-lg px-2 py-1 transition-colors',
                    state.tipMode === 'custom_per_staff' ? 'bg-white font-semibold text-teal-800 shadow-sm' : 'text-slate-500',
                  )}
                >
                  {t('queue.quCoTipModeManual')}
                </button>
              </div>
            )}
          </div>

          {!allowTipSplitOverride && (
            <p className="mt-1.5 rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-xs text-amber-900">
              {t('queue.quCoTipSplitLocked')}
            </p>
          )}

          {state.tipMode === 'total_split' ? (
            <div className="mt-2 space-y-2">
              <div className="grid grid-cols-5 gap-1.5">
                {tipPresets.map((percent) => {
                  /*
                   * 小费阶段的服务款已经收过，本次应收基数为 0；百分比必须按原服务
                   * 金额计算，否则每一档都会显示成 $0.00，前台只能改用手工输入。
                   */
                  const tipBase = isTipStage ? baseCents : totals.afterDiscountCents;
                  const tipAmount = centsToDollars(Math.round((tipBase * percent) / 100));
                  const isSelected = state.tipPercentage === percent && state.totalTipDollars === '';
                  return (
                    <button
                      key={percent}
                      type="button"
                      aria-pressed={isSelected}
                      onClick={() => onChange((prev) => ({ ...prev, tipPercentage: percent, totalTipDollars: '' }))}
                      className={cn(
                        'rounded-lg border p-2 text-center transition-colors',
                        isSelected
                          ? 'border-teal-500 bg-teal-50 text-teal-900'
                          : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50',
                      )}
                    >
                      <span className="block text-xs font-semibold">
                        {percent === 0 ? t('queue.quCoNoTip') : `${percent}%`}
                      </span>
                      <span className="block font-mono text-xs text-slate-500">${tipAmount}</span>
                    </button>
                  );
                })}
              </div>

              <div className="grid grid-cols-2 gap-3 pt-1">
                <div>
                  <label htmlFor="checkout-custom-tip" className="mb-1 block text-xs font-medium text-slate-600">
                    {t('queue.quCoCustomTip')}
                  </label>
                  <Input
                    id="checkout-custom-tip"
                    inputMode="decimal"
                    value={state.totalTipDollars}
                    onChange={(e) => onChange((prev) => ({ ...prev, totalTipDollars: e.target.value }))}
                    placeholder="0.00"
                    className="font-mono text-sm"
                  />
                </div>
                <div>
                  <label htmlFor="checkout-split-strategy" className="mb-1 block text-xs font-medium text-slate-600">
                    {t('queue.quCoSplitStrategy')}
                  </label>
                  <select
                    id="checkout-split-strategy"
                    value={state.splitStrategy}
                    onChange={(e) => onChange((prev) => ({ ...prev, splitStrategy: e.target.value as 'proportional' | 'equal' }))}
                    className="w-full rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-sm"
                  >
                    <option value="proportional">{t('queue.quCoSplitProportional')}</option>
                    <option value="equal">{t('queue.quCoSplitEqual')}</option>
                  </select>
                </div>
              </div>
            </div>
          ) : (
            <div className="mt-2 grid grid-cols-2 gap-2">
              {staffList.map((staffShare) => (
                <div key={staffShare.membershipId} className="space-y-1 rounded-lg border border-slate-200 bg-slate-50 p-2">
                  <label htmlFor={`tip-${staffShare.membershipId}`} className="block text-xs font-semibold text-slate-800">
                    {staffShare.name}
                  </label>
                  <Input
                    id={`tip-${staffShare.membershipId}`}
                    inputMode="decimal"
                    value={state.customStaffTips[staffShare.membershipId] || ''}
                    onChange={(e) => onChange((prev) => ({
                      ...prev,
                      customStaffTips: { ...prev.customStaffTips, [staffShare.membershipId]: e.target.value },
                    }))}
                    placeholder="0.00"
                    className="h-8 font-mono text-sm"
                  />
                </div>
              ))}
            </div>
          )}

          {/* 分账预览 —— 与提交内容完全一致 */}
          <div className="mt-2 space-y-1 rounded-xl border border-teal-100 bg-teal-50/60 p-2.5">
            <div className="flex items-center justify-between text-xs font-semibold text-teal-900">
              <span>{t('queue.quCoTipAllocation')}</span>
              <span className="font-mono">{t('queue.quCoTotalTips', { p0: centsToDollars(totals.totalTipCents) })}</span>
            </div>
            <div className="grid grid-cols-2 gap-2">
              {totals.tipAllocations.map((allocation) => (
                <div key={allocation.membershipId} className="flex items-center justify-between rounded-lg border border-teal-200 bg-white p-1.5 text-xs">
                  <span className="font-medium text-slate-800">{allocation.name}</span>
                  <span className="font-mono font-semibold text-teal-800">
                    +${centsToDollars(allocation.allocatedTipCents)} ({allocation.percent}%)
                  </span>
                </div>
              ))}
            </div>
          </div>
        </section>
        )}

        {/* 4. 税费与刷卡附加费。小费阶段这两项已锁定为 0，不再显示以免误导。 */}
        {!isTipStage && (
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5 rounded-2xl border border-slate-200 bg-white p-3">
            <div className="flex items-center justify-between">
              <label className="flex cursor-pointer items-center gap-1.5 font-medium text-slate-800">
                <input
                  type="checkbox"
                  checked={state.enableTax}
                  onChange={(e) => onChange((prev) => ({ ...prev, enableTax: e.target.checked }))}
                  className="h-4 w-4 rounded text-teal-600"
                />
                <span>{t('queue.quCoSalesTax')}</span>
              </label>
              <span className="font-mono font-semibold text-slate-700">+${centsToDollars(totals.taxCents)}</span>
            </div>
            {state.enableTax && (
              <div className="flex items-center gap-1.5 pt-1">
                <label htmlFor="checkout-tax-rate" className="text-xs text-slate-500">{t('queue.quCoTaxRate')}</label>
                <Input
                  id="checkout-tax-rate"
                  inputMode="decimal"
                  value={state.taxRatePercent}
                  onChange={(e) => onChange((prev) => ({ ...prev, taxRatePercent: e.target.value }))}
                  className="h-7 w-20 font-mono text-sm"
                />
              </div>
            )}
          </div>

          <div className="space-y-1.5 rounded-2xl border border-slate-200 bg-white p-3">
            <div className="flex items-center justify-between">
              <label className="flex cursor-pointer items-center gap-1.5 font-medium text-slate-800">
                <input
                  type="checkbox"
                  checked={state.enableCardSurcharge}
                  onChange={(e) => onChange((prev) => ({ ...prev, enableCardSurcharge: e.target.checked }))}
                  className="h-4 w-4 rounded text-teal-600"
                />
                <span>{t('queue.quCoCardSurcharge')}</span>
              </label>
              <span className="font-mono font-semibold text-slate-700">+${centsToDollars(totals.cardSurchargeCents)}</span>
            </div>
            {state.enableCardSurcharge && (
              <>
                <div className="flex items-center gap-1 pt-1">
                  {['3.0', '3.5', '4.0'].map((rate) => (
                    <button
                      key={rate}
                      type="button"
                      aria-pressed={state.cardSurchargePercent === rate}
                      onClick={() => onChange((prev) => ({ ...prev, cardSurchargePercent: rate }))}
                      className={cn(
                        'rounded-lg border px-2 py-0.5 text-xs font-medium transition-colors',
                        state.cardSurchargePercent === rate
                          ? 'border-teal-600 bg-teal-600 text-white'
                          : 'border-slate-200 bg-white text-slate-600',
                      )}
                    >
                      {rate}%
                    </button>
                  ))}
                </div>
                <p className="text-xs text-slate-400">{t('queue.quCoSurchargeTipNotice')}</p>
              </>
            )}
          </div>
        </div>
        )}

        {/* 5. 费用核算汇总 */}
        <div className="space-y-1.5 rounded-2xl border border-slate-200 bg-slate-50 p-3">
          <div className="flex justify-between text-slate-600">
            <span>{t('queue.quCoSubtotalLine')}</span>
            <span className="font-mono font-semibold text-slate-800">
              ${centsToDollars(totals.afterDiscountCents + totals.discountCents)}
            </span>
          </div>
          <div className="flex items-center justify-between text-slate-600">
            <label htmlFor="checkout-discount">{t('queue.quCoDiscountLine')}</label>
            <Input
              id="checkout-discount"
              inputMode="decimal"
              value={isTipStage ? '0' : state.discountDollars}
              disabled={isTipStage}
              onChange={(e) => onChange((prev) => ({ ...prev, discountDollars: e.target.value }))}
              className="h-7 w-24 text-right font-mono text-sm"
              placeholder="0"
            />
          </div>
          {state.enableTax && (
            <div className="flex justify-between text-slate-600">
              <span>{t('queue.quCoTaxLine', { p0: state.taxRatePercent })}</span>
              <span className="font-mono font-semibold text-slate-800">+${centsToDollars(totals.taxCents)}</span>
            </div>
          )}
          {state.enableCardSurcharge && hasCard && (
            <div className="flex justify-between text-slate-600">
              <span>{t('queue.quCoSurchargeLine', { p0: state.cardSurchargePercent })}</span>
              <span className="font-mono font-semibold text-slate-800">+${centsToDollars(totals.cardSurchargeCents)}</span>
            </div>
          )}
          <div className="flex items-end justify-between border-t border-slate-200 pt-1.5">
            <span className="font-semibold text-slate-800">{t('queue.quCoTotalDue')}</span>
            <span className="font-mono text-base font-bold text-slate-900">${centsToDollars(totals.totalDueCents)}</span>
          </div>
        </div>

        {/* 6. 收款方式 */}
        <div>
          <span className="mb-1.5 block font-medium text-slate-700">{t('queue.quCoPaymentMethod')}</span>
          <div className="grid grid-cols-4 gap-2">
            {([
              { id: 'card', labelKey: 'queue.quCoPayCard', icon: CreditCard },
              { id: 'cash', labelKey: 'queue.quCoPayCash', icon: Coins },
              { id: 'gift_card', labelKey: 'queue.quCoPayGiftCard', icon: Gift },
              { id: 'apple_pay', labelKey: 'queue.quCoPayApplePay', icon: Wallet },
            ] as const).map((method) => (
              <button
                key={method.id}
                type="button"
                aria-pressed={state.paymentMethod === method.id}
                /* 小费不能由礼品卡或客户储值支付，按钮直接禁用并在上方给出原因。 */
                disabled={isTipStage && method.id === 'gift_card'}
                onClick={() => onChange((prev) => ({ ...prev, paymentMethod: method.id }))}
                className={cn(
                  'flex flex-col items-center gap-1 rounded-lg border p-2 text-xs font-medium transition-colors',
                  state.paymentMethod === method.id
                    ? 'border-teal-500 bg-teal-50 font-semibold text-teal-900'
                    : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50',
                  isTipStage && method.id === 'gift_card' && 'cursor-not-allowed opacity-40 hover:bg-white',
                )}
              >
                <method.icon className="h-4 w-4" />
                <span>{t(method.labelKey)}</span>
              </button>
            ))}
          </div>
        </div>

        {/* 现金找零与「不用找了」 */}
        {state.paymentMethod === 'cash' && (
          <div className="space-y-2 rounded-2xl border border-slate-200 bg-white p-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label htmlFor="checkout-tendered" className="mb-1 block text-xs font-medium text-slate-600">
                  {t('queue.quCashReceived')}
                </label>
                <Input
                  id="checkout-tendered"
                  inputMode="decimal"
                  value={state.tenderedDollars}
                  onChange={(e) => onChange((prev) => ({ ...prev, tenderedDollars: e.target.value }))}
                  placeholder={t('queue.quAmountPlaceholder')}
                  className="font-mono text-sm"
                />
              </div>
              <div>
                <span className="mb-1 block text-xs font-medium text-slate-600">{t('queue.quCoChangeDue')}</span>
                <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5 font-mono text-sm font-semibold text-slate-900">
                  ${centsToDollars(state.keepChange ? 0 : rawChangeDue)}
                </div>
              </div>
            </div>
            {rawChangeDue > 0 && (
              <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 p-2">
                <input
                  type="checkbox"
                  checked={state.keepChange}
                  onChange={(e) => onChange((prev) => ({ ...prev, keepChange: e.target.checked }))}
                  className="h-4 w-4 rounded text-teal-600"
                />
                <span className="text-xs font-medium text-slate-800">
                  {t('queue.quCoKeepChange', { p0: centsToDollars(rawChangeDue) })}
                </span>
              </label>
            )}
          </div>
        )}

        {/* Gift Card 核验 */}
        {state.paymentMethod === 'gift_card' && (
          <div className="space-y-2 rounded-2xl border border-slate-200 bg-white p-3">
            <label htmlFor="checkout-gift-card" className="block text-xs font-medium text-slate-600">
              {t('queue.quEnterGiftCard')}
            </label>
            <div className="flex gap-2">
              <Input
                id="checkout-gift-card"
                value={state.giftCardCode}
                onChange={(e) => onChange((prev) => ({
                  ...prev,
                  giftCardCode: e.target.value,
                  giftCardId: '',
                  giftCardVerified: false,
                }))}
                placeholder="GF-GC-XXXX"
                className="font-mono text-sm"
              />
              <Button
                size="sm"
                variant="secondary"
                isDisabled={!state.giftCardCode.trim() || state.isVerifyingGiftCard}
                onPress={async () => {
                  onChange((prev) => ({ ...prev, isVerifyingGiftCard: true }));
                  try {
                    const res = await verifyGiftCard(state.giftCardCode.trim());
                    if (res.valid) {
                      onChange((prev) => ({
                        ...prev,
                        giftCardVerified: true,
                        giftCardId: res.giftCardId,
                        giftCardCode: res.code,
                        giftCardBalanceCents: res.balanceCents,
                      }));
                      toast.success(t('queue.quGiftCardValid', { p0: centsToDollars(res.balanceCents) }));
                    } else {
                      toast.danger(t('queue.quGiftCardInvalid'));
                    }
                  } catch (err: any) {
                    toast.danger(errorMessage(err));
                  } finally {
                    onChange((prev) => ({ ...prev, isVerifyingGiftCard: false }));
                  }
                }}
                className="shrink-0 text-sm font-semibold"
              >
                {state.isVerifyingGiftCard ? <RefreshCw className="h-4 w-4 animate-spin" /> : t('queue.quVerifyCard')}
              </Button>
            </div>
            {state.giftCardVerified && (
              <div className="flex justify-between rounded-lg border border-emerald-200 bg-emerald-50 p-2 text-xs font-medium text-emerald-800">
                <span>{t('queue.quGiftCardVerified')}</span>
                <span className="font-mono">{t('queue.quCoGiftCardBalance', { p0: centsToDollars(state.giftCardBalanceCents) })}</span>
              </div>
            )}
          </div>
        )}

        {/* 最终结算总额 */}
        <div className="flex items-center justify-between rounded-2xl bg-slate-900 p-3.5 text-white">
          <div>
            <span className="block text-xs text-slate-400">
              {t('queue.quCoChargedBreakdown', {
                p0: centsToDollars(totals.totalDueCents),
                p1: centsToDollars(totals.totalTipCents),
              })}
            </span>
            <span className="font-mono text-xl font-bold text-emerald-400">
              ${centsToDollars(totals.chargedTotalCents)}
            </span>
          </div>
          <Badge variant="secondary" className="bg-white/10 font-semibold text-emerald-300">
            {t(PAYMENT_METHOD_LABEL_KEYS[state.paymentMethod])}
          </Badge>
        </div>
      </div>
    </Modal>
  );
}
