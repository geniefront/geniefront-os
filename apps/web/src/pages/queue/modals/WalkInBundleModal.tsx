import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
/**
 * 看板 walk-in 直接开单（组合套餐）——U10 / 计划 §7。
 *
 * 无预约到店客：选一个在售组合套餐，逐子项指派技师，直接 `ticket.open`。
 * 展开、排程、分摊、计价一律由服务端 `quoteBundle` / handler 完成，前端只传
 * 「选了哪个套餐、每个执行单元派给谁」。带预约的套餐走既有预约继承路径（P3b），
 * 不经此弹窗。
 *
 * 首版限制：套餐组成服务的 staff_count 必须为 1（后端 P3d 校验）。UI 不预判，
 * 收到 `bundle_unit_multi_staff_unsupported` 时给出可读提示。
 */
import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Package, Trash2 } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { useLanguage } from '@/LanguageContext';
import { useErrorMessage } from '@/lib/errorMessage';
import { centsToDollars } from '@/features/checkout/api';
import { useBundleCatalogQuery, quoteBundle } from '@/features/bundles/api';
import type { BundleQuoteResult, BundleTemplateView } from '@/features/bundles/types';
import type { DayStaff } from '@/features/schedule/types';
import { UNASSIGNED_STAFF_ID } from '@/context/ScheduleContext';

export interface WalkInBundleExtraAddon {
  ref: string;
  attachToUnit: string;
  serviceId: string;
  qty: number;
}

export interface WalkInBundleSubmit {
  walkInName: string;
  bundleId: string;
  expectedVersion: number;
  unitStaffIds: string[];
  extraAddons: WalkInBundleExtraAddon[];
}

export interface WalkInBundleModalProps {
  isOpen: boolean;
  onClose: () => void;
  staff: DayStaff[];
  canWrite: boolean;
  isPending: boolean;
  /** 由 Queue 页负责真正发命令、刷新与成功提示；抛错则本弹窗展示。 */
  onSubmit: (input: WalkInBundleSubmit) => Promise<void>;
}

export function WalkInBundleModal({
  isOpen, onClose, staff, canWrite, isPending, onSubmit,
}: WalkInBundleModalProps) {
  const { t } = useLanguage();
  const errorMessage = useErrorMessage();

  const [walkInName, setWalkInName] = useState('');
  const [selectedId, setSelectedId] = useState('');
  const [unitStaff, setUnitStaff] = useState<string[]>([]);
  const [extraAddons, setExtraAddons] = useState<WalkInBundleExtraAddon[]>([]);
  const [quote, setQuote] = useState<{
    status: 'idle' | 'loading' | 'ready' | 'error';
    data: BundleQuoteResult | null;
  }>({ status: 'idle', data: null });
  const [formError, setFormError] = useState<string | null>(null);

  const catalog = useBundleCatalogQuery({ enabled: isOpen && canWrite });
  const templates = useMemo<BundleTemplateView[]>(
    () => (catalog.data?.templates ?? []).filter((b) => b.active),
    [catalog.data],
  );
  const selected = useMemo(
    () => templates.find((b) => b.id === selectedId) ?? null,
    [templates, selectedId],
  );
  const componentNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of selected?.components ?? []) m.set(c.componentId, c.serviceName);
    return m;
  }, [selected]);
  const availableAddons = useMemo(
    () => catalog.data?.availableAddons ?? [],
    [catalog.data],
  );
  const addonById = useMemo(
    () => new Map(availableAddons.map((a) => [a.id, a])),
    [availableAddons],
  );
  const extraAddonsKey = useMemo(
    () => JSON.stringify(extraAddons.map((a) => [a.attachToUnit, a.serviceId, a.qty])),
    [extraAddons],
  );

  const addExtraAddon = (unitKey: string, serviceId: string) => {
    if (!serviceId) return;
    setExtraAddons((prev) => [...prev, { ref: crypto.randomUUID(), attachToUnit: unitKey, serviceId, qty: 1 }]);
  };
  const removeExtraAddon = (ref: string) => setExtraAddons((prev) => prev.filter((a) => a.ref !== ref));
  const setExtraAddonQty = (ref: string, qty: number) => setExtraAddons((prev) => prev.map((a) => (
    a.ref === ref ? { ...a, qty: Math.min(20, Math.max(1, Number.isFinite(qty) ? qty : 1)) } : a
  )));

  const bookableStaff = useMemo(
    () => staff.filter((s) => s.membershipId !== UNASSIGNED_STAFF_ID && s.isBookable),
    [staff],
  );

  // 弹窗关闭时清空草稿，下次打开从零开始。
  useEffect(() => {
    if (isOpen) return;
    setWalkInName('');
    setSelectedId('');
    setUnitStaff([]);
    setExtraAddons([]);
    setQuote({ status: 'idle', data: null });
    setFormError(null);
  }, [isOpen]);

  // 选中套餐（或版本 / 加项变化）后取服务端权威报价。加项变化重新报价时
  // 保留已指派技师（单元数不变），只在首次或单元数变化时铺一遍空值。
  useEffect(() => {
    if (!isOpen) return;
    const tpl = templates.find((b) => b.id === selectedId);
    if (!tpl) {
      setQuote({ status: 'idle', data: null });
      return;
    }
    let cancelled = false;
    setQuote((prev) => ({ status: 'loading', data: prev.data }));
    quoteBundle({
      bundleId: tpl.id,
      expectedVersion: tpl.version,
      ...(extraAddons.length
        ? {
            extraAddons: extraAddons.map((a) => ({
              ref: a.ref, attachToUnit: a.attachToUnit, serviceId: a.serviceId, qty: a.qty,
            })),
          }
        : {}),
    })
      .then((res) => {
        if (cancelled) return;
        setQuote({ status: 'ready', data: res });
        setUnitStaff((prev) => (
          prev.length === res.units.length ? prev : res.units.map((_, i) => prev[i] ?? '')
        ));
      })
      .catch(() => {
        if (!cancelled) setQuote({ status: 'error', data: null });
      });
    return () => { cancelled = true; };
    // extraAddons 经 extraAddonsKey 参与依赖。
  }, [isOpen, selectedId, templates, extraAddonsKey, extraAddons]);

  const readyQuote = quote.status === 'ready' ? quote.data : null;
  const allUnitsAssigned = readyQuote != null
    && unitStaff.length === readyQuote.units.length
    && unitStaff.every((id) => id !== '');

  async function handleSubmit() {
    setFormError(null);
    if (!walkInName.trim()) {
      setFormError(t('bundle.walkInNameRequired'));
      return;
    }
    if (!selectedId || !readyQuote) {
      setFormError(t('bundle.pickerQuoteFailed'));
      return;
    }
    if (!allUnitsAssigned) {
      setFormError(t('bundle.pickerStaffRequired'));
      return;
    }
    try {
      await onSubmit({
        walkInName: walkInName.trim(),
        bundleId: selectedId,
        expectedVersion: readyQuote.version,
        unitStaffIds: unitStaff,
        extraAddons,
      });
    } catch (err: unknown) {
      const reason = (err as { details?: { reason?: string } })?.details?.reason;
      if (reason === 'bundle_version_conflict') setFormError(t('bundle.errVersionConflict'));
      else if (reason === 'bundle_service_inactive') setFormError(t('bundle.errInactiveService'));
      else if (reason === 'bundle_not_found') setFormError(t('bundle.errNotFound'));
      else if (reason === 'bundle_unit_multi_staff_unsupported') setFormError(t('bundle.errUnitMultiStaff'));
      else if (reason === 'bundle_unit_staff_required') setFormError(t('bundle.pickerStaffRequired'));
      else setFormError(errorMessage(err));
    }
  }

  return (
    <Modal
      isOpen={isOpen}
      onOpenChange={(o) => { if (!o) onClose(); }}
      isDismissDisabled={isPending}
      size="lg"
      title={
        <span className="flex items-center gap-2">
          <Package className="w-4 h-4 text-teal-600" />
          {t('bundle.walkInTitle')}
        </span>
      }
      footer={
        <div className="flex justify-end gap-2 w-full">
          <Button variant="ghost" onPress={onClose}>{t('cancel')}</Button>
          <Button
            className="bg-teal-600 text-white font-bold"
            isDisabled={isPending || !allUnitsAssigned || !walkInName.trim()}
            onPress={handleSubmit}
          >
            {isPending ? t('bundle.walkInSubmitting') : t('bundle.walkInSubmit')}
          </Button>
        </div>
      }
    >
      <div className="space-y-3.5 text-sm">
        <p className="text-[11px] text-slate-500 leading-relaxed">{t('bundle.walkInSubtitle')}</p>

        <div>
          <label className="block text-[10px] font-bold text-slate-500 mb-1">
            {t('bundle.walkInNameLabel')} *
          </label>
          <Input
            value={walkInName}
            onChange={(e) => setWalkInName(e.target.value)}
            placeholder={t('bundle.walkInNamePlaceholder')}
            autoFocus
          />
        </div>

        <div>
          <label className="block text-[10px] font-bold text-slate-500 mb-1">
            {t('bundle.pickerHeading')}
          </label>
          {catalog.isLoading ? (
            <p className="text-xs text-slate-400"><LoadingSpinner label={t('bundle.pickerLoadingQuote')} /></p>
          ) : catalog.isError ? (
            /*
              套餐目录取不到时，此前显示的是「本店暂无组合套餐」。前台据此
              改用普通开单，而门店其实是有套餐的 —— 只是这一次请求失败了。
            */
            <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-xs font-medium text-red-800">
              <p>{t('loadFailed')}</p>
              <button
                type="button"
                onClick={() => void catalog.refetch()}
                className="mt-1.5 font-bold underline underline-offset-2"
              >
                {t('retry')}
              </button>
            </div>
          ) : templates.length === 0 ? (
            <p className="text-xs text-slate-500 p-3 bg-slate-50 border border-slate-200 rounded-xl">
              {t('bundle.pickerNoTemplates')}
            </p>
          ) : (
            <select
              value={selectedId}
              onChange={(e) => { setSelectedId(e.target.value); setExtraAddons([]); setUnitStaff([]); }}
              className="w-full h-9 px-2.5 py-1 text-xs rounded-xl border border-slate-200 bg-white font-medium"
            >
              <option value="">{t('bundle.pickerPlaceholder')}</option>
              {templates.map((b) => (
                <option key={b.id} value={b.id} disabled={!b.fulfillable}>
                  {b.name}{b.fulfillable ? '' : ` — ${t('bundle.pickerUnfulfillable')}`}
                </option>
              ))}
            </select>
          )}
        </div>

        {selected && !selected.fulfillable && (
          <div className="flex items-center gap-1.5 text-[11px] font-semibold text-amber-600">
            <AlertTriangle className="w-3.5 h-3.5" />
            {t('bundle.pickerUnfulfillable')}
          </div>
        )}

        {quote.status === 'loading' && (
          <p className="text-xs text-slate-400"><LoadingSpinner label={t('bundle.pickerLoadingQuote')} /></p>
        )}
        {quote.status === 'error' && (
          <p className="text-xs text-rose-600 font-medium">{t('bundle.pickerQuoteFailed')}</p>
        )}

        {readyQuote && (
          <>
            <div className="space-y-2">
              <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">
                {t('bundle.pickerUnitsHeading')}
              </span>
              {readyQuote.units.map((u, i) => (
                <div key={u.unitKey} className="p-2.5 bg-white border border-slate-200 rounded-2xl space-y-2 shadow-2xs">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-bold text-xs text-slate-900 truncate">
                      {i + 1}. {componentNameById.get(u.componentId) ?? '—'}
                    </span>
                    <span className="text-[10px] font-mono text-slate-500 whitespace-nowrap">
                      {t('schedule.apptDurationMinutes', { p0: u.durationMin })}
                    </span>
                  </div>
                  <select
                    value={unitStaff[i] ?? ''}
                    onChange={(e) => setUnitStaff((prev) => prev.map((x, j) => (j === i ? e.target.value : x)))}
                    className="w-full h-8 px-2 text-xs rounded-xl border border-slate-200 bg-white font-medium truncate"
                    aria-label={t('schedule.adChooseStaff')}
                  >
                    <option value="">{t('bundle.walkInPickStaff')}</option>
                    {bookableStaff.map((s) => (
                      <option key={s.membershipId} value={s.membershipId}>{s.name}</option>
                    ))}
                  </select>

                  {/* 额外加项：归属这个执行单元，价 / 时长由服务端重新报价并入 */}
                  <div className="pt-1.5 border-t border-slate-100 space-y-1.5">
                    <span className="text-[10px] font-bold text-slate-400">{t('bundle.addonSectionLabel')}</span>
                    {extraAddons.filter((ad) => ad.attachToUnit === u.unitKey).map((ad) => (
                      <div key={ad.ref} className="flex items-center gap-1.5">
                        <span className="flex-1 truncate text-[11px] text-slate-700">
                          {addonById.get(ad.serviceId)?.name ?? '—'}
                        </span>
                        <input
                          type="number" min={1} max={20} value={ad.qty}
                          onChange={(e) => setExtraAddonQty(ad.ref, parseInt(e.target.value, 10))}
                          aria-label={t('bundle.addonQty')}
                          className="w-12 h-7 px-1.5 text-[11px] text-center rounded-lg border border-slate-200"
                        />
                        <button
                          type="button"
                          onClick={() => removeExtraAddon(ad.ref)}
                          aria-label={t('bundle.addonRemove')}
                          className="text-slate-400 hover:text-rose-500 p-1"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    ))}
                    {availableAddons.length === 0 ? (
                      <p className="text-[10px] text-slate-400">{t('bundle.addonNone')}</p>
                    ) : (
                      <select
                        value=""
                        onChange={(e) => { addExtraAddon(u.unitKey, e.target.value); e.target.value = ''; }}
                        className="w-full h-7 px-2 text-[11px] rounded-lg border border-slate-200 bg-white text-slate-600"
                      >
                        <option value="">{t('bundle.addonPick')}</option>
                        {availableAddons.map((ad) => (
                          <option key={ad.id} value={ad.id}>{ad.name} (+${centsToDollars(ad.priceCents)})</option>
                        ))}
                      </select>
                    )}
                  </div>
                </div>
              ))}
            </div>

            <div className="p-3 bg-teal-50/70 border border-teal-200 rounded-2xl space-y-1 text-xs">
              <div className="flex justify-between text-slate-500">
                <span>{t('bundle.pickerOriginalTotal')}</span>
                <span className="font-mono line-through">${centsToDollars(readyQuote.originalTotalCents)}</span>
              </div>
              {readyQuote.bundleDiscountCents > 0 && (
                <div className="flex justify-between text-emerald-600 font-semibold">
                  <span>{t('bundle.pickerSavings')}</span>
                  <span className="font-mono">−${centsToDollars(readyQuote.bundleDiscountCents)}</span>
                </div>
              )}
              <div className="flex justify-between font-bold text-teal-900 border-t border-teal-200 pt-1">
                <span>{t('bundle.pickerBundlePrice')}</span>
                <span className="font-mono">${centsToDollars(readyQuote.bundlePriceCents)}</span>
              </div>
              {readyQuote.extraAddonListTotalCents > 0 && (
                <>
                  <div className="flex justify-between text-slate-600">
                    <span>{t('bundle.addonExtraLine')}</span>
                    <span className="font-mono">+${centsToDollars(readyQuote.extraAddonListTotalCents)}</span>
                  </div>
                  <div className="flex justify-between font-bold text-teal-900 border-t border-teal-200 pt-1">
                    <span>{t('bundle.addonNetTotal')}</span>
                    <span className="font-mono">${centsToDollars(readyQuote.serviceNetTotalCents)}</span>
                  </div>
                </>
              )}
            </div>
          </>
        )}

        {formError && (
          <p className="rounded-xl bg-rose-50 border border-rose-200 p-2.5 text-[11px] font-medium text-rose-700">
            {formError}
          </p>
        )}
      </div>
    </Modal>
  );
}
