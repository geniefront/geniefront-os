/**
 * 组合套餐目录管理面板（U10 / 计划 §7）。
 *
 * 挂在 pages/Marketing.tsx 的「组合套餐」标签页。自成一体：自己拉数据、
 * 自己管编辑器与确认弹窗的状态。写操作走命令总线（`bundle.saveTemplate` /
 * `bundle.archiveTemplate`），读走 `GET /v1/desk/bundles`。
 *
 * 组合套餐 = 一次买走固定组合价、当场展开成实际子项；与「次卡」（按次核销的
 * 预付资产）是两回事 —— 面板顶部有一句提示帮助店主区分。
 */
import { useMemo, useState } from 'react';
import { toast, Spinner } from '@heroui/react';
import { useFieldErrors } from '@/lib/formFeedback';
import { Plus, Trash2, Edit2, Copy, Package, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Modal, ConfirmDialog } from '@/components/ui/Modal';
import { EmptyState } from '@/components/ui/EmptyState';
import { SectionError } from '@/components/ui/QueryState';
import { useLanguage } from '@/LanguageContext';
import { useCan } from '@/lib/permissions';
import { useErrorMessage } from '@/lib/errorMessage';
import { centsToDollars, dollarsToCents } from '@/features/checkout/api';
import { parseMoney } from '@/lib/validation';
import { useValidationMessage } from '@/lib/validationMessage';
import {
  useBundleCatalogQuery,
  useSaveBundleTemplate,
  useArchiveBundleTemplate,
} from './api';
import type { BundleTemplateView } from './types';

interface Row { serviceId: string; qty: number }

const money = (cents: number) => `$${centsToDollars(cents)}`;

export function BundleManagerPanel() {
  const { t } = useLanguage();
  const canManage = useCan('catalog.manage');
  const errorMessage = useErrorMessage();

  const catalog = useBundleCatalogQuery();
  const saveMut = useSaveBundleTemplate();
  const archiveMut = useArchiveBundleTemplate();

  const services = catalog.data?.availableServices ?? [];
  const svcById = useMemo(() => new Map(services.map((s) => [s.id, s])), [services]);
  const templates = catalog.data?.templates ?? [];

  // ── 编辑器状态 ──────────────────────────────────────────────────────────
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<BundleTemplateView | null>(null);
  const [nameZh, setNameZh] = useState('');
  const [nameEn, setNameEn] = useState('');
  const [descZh, setDescZh] = useState('');
  const [rows, setRows] = useState<Row[]>([]);
  const [priceDollars, setPriceDollars] = useState('');
  const [onlineBookable, setOnlineBookable] = useState(false);
  const [extraNameI18n, setExtraNameI18n] = useState<Record<string, string>>({});

  const [archiveTarget, setArchiveTarget] = useState<BundleTemplateView | null>(null);

  const listTotalCents = rows.reduce(
    (n, r) => n + (svcById.get(r.serviceId)?.priceCents ?? 0) * Math.max(1, r.qty), 0);
  /*
   * ⚠️ 套餐售价不能交给 `dollarsToCents` —— 它会把非数字字符剔掉再算，
   * 把 `1o9` 算成 $1.90 卖出去，而这个数看起来毫无异常。
   */
  const priceParsed = parseMoney(priceDollars, { allowEmpty: true });
  const priceCents = priceParsed.ok ? priceParsed.value : 0;
  const savingsCents = Math.max(0, listTotalCents - priceCents);
  const unitCount = rows.reduce((n, r) => n + Math.max(1, r.qty), 0);

  function resetForm() {
    setEditing(null);
    setNameZh(''); setNameEn(''); setDescZh('');
    setRows([]); setPriceDollars(''); setOnlineBookable(false);
    setExtraNameI18n({});
  }

  function openNew() {
    resetForm();
    setEditorOpen(true);
  }

  function openEdit(b: BundleTemplateView, asCopy = false) {
    setEditing(asCopy ? null : b);
    setNameZh((b.nameI18n['zh-Hans'] ?? b.name) + (asCopy ? ' ×2' : ''));
    setNameEn(b.nameI18n['en'] ?? '');
    setDescZh(b.descriptionI18n?.['zh-Hans'] ?? b.description ?? '');
    setRows(b.components.map((c) => ({ serviceId: c.serviceId, qty: c.qty })));
    setPriceDollars(centsToDollars(b.priceCents));
    setOnlineBookable(b.onlineBookable);
    // 未展示的语言原样带回，避免整表替换时丢译文
    const extra: Record<string, string> = {};
    for (const [k, v] of Object.entries(b.nameI18n)) {
      if (k !== 'zh-Hans' && k !== 'en') extra[k] = v;
    }
    setExtraNameI18n(extra);
    setEditorOpen(true);
  }

  /** 组合套餐表单的字段级校验。 */
  const bundleForm = useFieldErrors<'name' | 'price'>();
  const invalid = useValidationMessage();

  async function handleSave() {
    bundleForm.clear();
    const primary = nameZh.trim() || nameEn.trim();
    if (!primary) { bundleForm.fail('name', t('bundle.errNameRequired')); return; }
    if (unitCount < 2) { toast.danger(t('bundle.errTwoUnits')); return; }
    if (!priceParsed.ok) { bundleForm.fail('price', invalid.money(priceParsed.reason)); return; }
    if (priceCents > listTotalCents) { toast.danger(t('bundle.errPriceAboveList')); return; }

    const name: Record<string, string> = { ...extraNameI18n };
    if (nameZh.trim()) name['zh-Hans'] = nameZh.trim();
    name['en'] = nameEn.trim() || nameZh.trim();

    try {
      await saveMut.mutateAsync({
        bundleId: editing?.id,
        name,
        description: descZh.trim() ? { 'zh-Hans': descZh.trim() } : null,
        priceCents,
        components: rows
          .filter((r) => r.serviceId)
          .map((r, i) => ({ serviceId: r.serviceId, qty: Math.max(1, r.qty), seq: i })),
        onlineBookable,
        ...(editing ? { expectedVersion: editing.version } : {}),
      });
      toast.success(t('bundle.saved'));
      setEditorOpen(false);
      resetForm();
    } catch (err: unknown) {
      const reason = (err as { details?: { reason?: string } })?.details?.reason;
      if (reason === 'bundle_version_conflict') toast.danger(t('bundle.errVersionConflict'));
      else if (reason === 'bundle_price_above_components') toast.danger(t('bundle.errPriceAboveList'));
      else if (reason === 'bundle_component_empty') toast.danger(t('bundle.errTwoUnits'));
      else if (reason === 'bundle_service_inactive') toast.danger(t('bundle.errInactiveService'));
      else toast.danger(errorMessage(err));
    }
  }

  async function handleArchive() {
    if (!archiveTarget) return;
    try {
      await archiveMut.mutateAsync(archiveTarget.id);
      toast.success(t('bundle.archived'));
      setArchiveTarget(null);
    } catch (err: unknown) {
      toast.danger(errorMessage(err));
    }
  }

  if (catalog.isLoading) {
    return <div className="py-12 grid place-items-center"><Spinner /></div>;
  }

  /*
   * 目录取不到时此前会落到「暂无组合套餐」的空状态上 —— 店主据此以为套餐被
   * 清空了，接着重新录一遍。加载失败必须自己说话。
   */
  if (catalog.isError) {
    return <SectionError error={catalog.error} onRetry={() => void catalog.refetch()} />;
  }

  return (
    <div className="space-y-4">
      <p className="text-xs text-slate-500 leading-relaxed">{t('bundle.vsPackageHint')}</p>

      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-bold text-slate-700">{t('bundle.tabTitle')} ({templates.length})</span>
        {canManage && (
          <Button onPress={openNew} data-testid="bundle-new" className="bg-teal-600 text-white font-bold" size="sm">
            <Plus className="w-4 h-4" />
            <span>{t('bundle.newButton')}</span>
          </Button>
        )}
      </div>

      {templates.length === 0 ? (
        <EmptyState
          icon={<Package className="w-10 h-10 text-slate-300" />}
          title={t('bundle.tabTitle')}
          description={t('bundle.empty')}
          {...(canManage ? {
            action: (
              <Button onPress={openNew} className="bg-teal-600 text-white font-bold">
                {t('bundle.newButton')}
              </Button>
            ),
          } : {})}
        />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {templates.map((b) => (
            <div key={b.id} data-testid="bundle-card" className="rounded-2xl border border-slate-200 bg-white p-4 space-y-3 shadow-xs">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="font-bold text-slate-800 truncate">{b.name}</div>
                  <div className="text-[11px] text-slate-500">
                    {b.components.map((c) => `${c.serviceName}${c.qty > 1 ? `×${c.qty}` : ''}`).join(' + ')}
                  </div>
                </div>
                <div className="flex flex-col items-end gap-1 shrink-0">
                  <Badge className={b.active ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-500'}>
                    {b.active ? t('bundle.statusActive') : t('bundle.statusArchived')}
                  </Badge>
                  {b.onlineBookable && (
                    <Badge className="bg-sky-100 text-sky-700">{t('bundle.statusOnline')}</Badge>
                  )}
                </div>
              </div>

              <div className="flex items-baseline gap-2 text-sm">
                <span className="line-through text-slate-400">{money(b.originalTotalCents)}</span>
                <span className="font-extrabold text-teal-700">{money(b.priceCents)}</span>
                {b.bundleDiscountCents > 0 && (
                  <span className="text-[11px] font-semibold text-emerald-600">
                    −{money(b.bundleDiscountCents)}
                  </span>
                )}
              </div>

              {!b.fulfillable && (
                <div className="flex items-center gap-1.5 text-[11px] font-semibold text-amber-600">
                  <AlertTriangle className="w-3.5 h-3.5" />
                  {t('bundle.needsFix')}
                </div>
              )}
              {b.instanceCount > 0 && (
                <div className="text-[11px] text-slate-400">
                  {t('bundle.instanceCount', { count: b.instanceCount })}
                </div>
              )}

              {canManage && (
                <div className="flex gap-1.5 pt-1">
                  <Button variant="outline" size="sm" onPress={() => openEdit(b)}>
                    <Edit2 className="w-3.5 h-3.5" />
                    <span>{t('edit')}</span>
                  </Button>
                  <Button variant="ghost" size="sm" onPress={() => openEdit(b, true)}>
                    <Copy className="w-3.5 h-3.5" />
                    <span>{t('bundle.duplicate')}</span>
                  </Button>
                  {b.active && (
                    <Button variant="ghost" size="sm" onPress={() => setArchiveTarget(b)}>
                      <Trash2 className="w-3.5 h-3.5" />
                      <span>{t('bundle.archive')}</span>
                    </Button>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* ── 编辑器 ── */}
      <Modal
        isOpen={editorOpen}
        onOpenChange={(o) => { setEditorOpen(o); if (!o) resetForm(); }}
        size="lg"
        title={editing ? t('bundle.editorEditTitle') : t('bundle.editorNewTitle')}
        footer={
          <div className="flex justify-end gap-2 w-full">
            <Button variant="ghost" onPress={() => { setEditorOpen(false); resetForm(); }}>
              {t('cancel')}
            </Button>
            <Button
              className="bg-teal-600 text-white font-bold"
              data-testid="bundle-save"
              isDisabled={saveMut.isPending}
              onPress={handleSave}
            >
              {saveMut.isPending ? t('bundle.saving') : t('bundle.save')}
            </Button>
          </div>
        }
      >
        <div className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="text-xs font-semibold text-slate-600 space-y-1 block">
              <span>{t('bundle.fieldName')} · 中文</span>
              <input
                data-testid="bundle-name-zh"
                ref={bundleForm.bind('name').ref}
                aria-invalid={bundleForm.errors.name ? true : undefined}
                value={nameZh}
                onChange={(e) => { setNameZh(e.target.value); bundleForm.clearField('name'); }}
                placeholder={t('bundle.fieldNamePlaceholder')}
                className={`w-full h-9 px-3 rounded-xl border text-sm focus:outline-none ${
                  bundleForm.errors.name
                    ? 'border-red-400 focus:border-red-500'
                    : 'border-slate-200 focus:border-teal-500'
                }`}
              />
              {bundleForm.errors.name && (
                <span role="alert" className="block text-xs font-medium text-red-600">
                  {bundleForm.errors.name}
                </span>
              )}
            </label>
            <label className="text-xs font-semibold text-slate-600 space-y-1 block">
              <span>{t('bundle.fieldName')} · English</span>
              <input
                data-testid="bundle-name-en"
                value={nameEn}
                onChange={(e) => setNameEn(e.target.value)}
                className="w-full h-9 px-3 rounded-xl border border-slate-200 text-sm focus:outline-none focus:border-teal-500"
              />
            </label>
          </div>

          <label className="text-xs font-semibold text-slate-600 space-y-1 block">
            <span>{t('bundle.fieldDescription')}</span>
            <input
              value={descZh}
              onChange={(e) => setDescZh(e.target.value)}
              className="w-full h-9 px-3 rounded-xl border border-slate-200 text-sm focus:outline-none focus:border-teal-500"
            />
          </label>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-slate-600">{t('bundle.fieldComponents')}</span>
              <Button
                variant="ghost" size="sm"
                data-testid="bundle-add-component"
                onPress={() => setRows((r) => [...r, { serviceId: services[0]?.id ?? '', qty: 1 }])}
              >
                <Plus className="w-3.5 h-3.5" />
                <span>{t('bundle.addComponent')}</span>
              </Button>
            </div>
            {rows.length === 0 && (
              <p className="text-[11px] text-slate-400">{t('bundle.errTwoUnits')}</p>
            )}
            {rows.map((row, i) => (
                <div key={i} className="flex items-center gap-2">
                  <select
                    data-testid="bundle-component-select"
                    value={row.serviceId}
                    onChange={(e) => setRows((rs) => rs.map((r, j) => j === i ? { ...r, serviceId: e.target.value } : r))}
                    className="flex-1 h-9 px-2 rounded-xl border border-slate-200 text-sm bg-white"
                  >
                    {services.map((s) => (
                      <option key={s.id} value={s.id}>{s.name} · {money(s.priceCents)}</option>
                    ))}
                  </select>
                  <input
                    type="number" min={1} max={20}
                    value={row.qty}
                    onChange={(e) => setRows((rs) => rs.map((r, j) => j === i ? { ...r, qty: Math.max(1, parseInt(e.target.value, 10) || 1) } : r))}
                    className="w-14 h-9 px-2 rounded-xl border border-slate-200 text-sm text-center"
                    aria-label={t('bundle.componentQty')}
                  />
                  <button
                    type="button"
                    onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}
                    className="text-slate-400 hover:text-rose-500 p-1"
                    aria-label={t('bundle.componentRemove')}
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
            ))}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 items-end">
            <label className="text-xs font-semibold text-slate-600 space-y-1 block">
              <span>{t('bundle.fieldPrice')}</span>
              <div className="relative">
                <span className="absolute left-3 top-2 text-slate-400 text-sm">$</span>
                <input
                  data-testid="bundle-price"
                  {...bundleForm.bind('price')}
                  value={priceDollars}
                  onChange={(e) => setPriceDollars(e.target.value)}
                  inputMode="decimal"
                  className="w-full h-9 pl-6 pr-3 rounded-xl border border-slate-200 text-sm focus:outline-none focus:border-teal-500"
                />
              </div>
            </label>
            <div className="text-[11px] text-slate-500 space-y-0.5 pb-1">
              <div>{t('bundle.priceHelpOriginal', { amount: money(listTotalCents) })}</div>
              <div className="text-emerald-600 font-semibold">
                {t('bundle.priceHelpSavings', { amount: money(savingsCents) })}
              </div>
            </div>
          </div>

          <label className="flex items-start gap-2 text-xs text-slate-600">
            <input
              type="checkbox"
              checked={onlineBookable}
              onChange={(e) => setOnlineBookable(e.target.checked)}
              className="mt-0.5"
            />
            <span>
              <span className="font-semibold">{t('bundle.fieldOnlineBookable')}</span>
              <span className="block text-slate-400">{t('bundle.fieldOnlineBookableHint')}</span>
            </span>
          </label>
        </div>
      </Modal>

      <ConfirmDialog
        isOpen={archiveTarget !== null}
        onOpenChange={(o) => { if (!o) setArchiveTarget(null); }}
        tone="danger"
        title={t('bundle.archiveConfirmTitle')}
        description={t('bundle.archiveConfirmBody')}
        confirmLabel={t('bundle.archive')}
        onConfirm={handleArchive}
      />
    </div>
  );
}
