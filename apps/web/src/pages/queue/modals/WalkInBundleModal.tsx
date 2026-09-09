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
import { AlertTriangle, Package } from 'lucide-react';
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

export interface WalkInBundleSubmit {
  walkInName: string;
  bundleId: string;
  expectedVersion: number;
  unitStaffIds: string[];
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
    setQuote({ status: 'idle', data: null });
    setFormError(null);
  }, [isOpen]);

  // 选中套餐（或版本变化）后取服务端权威报价。
  useEffect(() => {
    if (!isOpen) return;
    const tpl = templates.find((b) => b.id === selectedId);
    if (!tpl) {
      setQuote({ status: 'idle', data: null });
      return;
    }
    let cancelled = false;
    setQuote({ status: 'loading', data: null });
    quoteBundle({ bundleId: tpl.id, expectedVersion: tpl.version })
      .then((res) => {
        if (cancelled) return;
        setQuote({ status: 'ready', data: res });
        setUnitStaff(res.units.map(() => ''));
      })
      .catch(() => {
        if (!cancelled) setQuote({ status: 'error', data: null });
      });
    return () => { cancelled = true; };
  }, [isOpen, selectedId, templates]);

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
            <p className="text-xs text-slate-400">{t('bundle.pickerLoadingQuote')}</p>
          ) : templates.length === 0 ? (
            <p className="text-xs text-slate-500 p-3 bg-slate-50 border border-slate-200 rounded-xl">
              {t('bundle.pickerNoTemplates')}
            </p>
          ) : (
            <select
              value={selectedId}
              onChange={(e) => setSelectedId(e.target.value)}
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
          <p className="text-xs text-slate-400">{t('bundle.pickerLoadingQuote')}</p>
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
