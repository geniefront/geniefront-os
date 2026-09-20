import { formatPhoneDisplay } from '@gf/contracts';
import { useCan } from '@/lib/permissions';
import { useSetupSave } from './autosave';
import { useCallback, useEffect, useState, type ChangeEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from '@heroui/react';
import { Camera, Check, Globe2, Loader2, Search, ShieldCheck, Star, Upload } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { apiGet, apiPost, runCommand } from '@/lib/api';
import { useErrorMessage } from '@/lib/errorMessage';
import { useSession } from '@/lib/session';
import { useLanguage } from '@/LanguageContext';
import { settingsKeys } from '@/features/settings/api';
import { useSaveBundleTemplate } from '@/features/bundles/api';
import type { DeskSettings } from '@/features/settings/types';
import { cn } from '@/lib/utils';

/** 组合套餐 / 次卡分流启发式，与 packages/ai 的 classifyPackageKind 同口径（U10 决策 #3）。 */
function guessPackageKind(sessions: number, serviceNames: readonly string[]): 'bundle' | 'sessions' | 'ambiguous' {
  const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const distinct = new Set(serviceNames.map(norm).filter(Boolean)).size;
  if (distinct >= 2 && sessions <= 1) return 'bundle';
  if (sessions >= 2 && distinct <= 1) return 'sessions';
  return 'ambiguous';
}
const normName = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();


type Hours = Record<string, { open: string; close: string } | null>;
interface BusinessResult {
  googlePlaceId?: string;
  businessType?: 'nail' | 'massage' | 'foot_spa' | 'lash' | 'scalp' | 'hair' | 'mixed' | null;
  name: string;
  phoneE164: string | null;
  address: { line1: string | null; line2: string | null; city: string | null; state: string | null; zip: string | null; country: string | null; display: string[] };
  businessHours: Hours;
  timezone?: string;
  timezoneConfidence?: string;
  rating: number | null;
  reviewCount: number | null;
  isClosed: boolean;
}
interface BlueprintItem {
  itemId: string;
  displayName: string;
  displayLocale: string;
  name: Record<string, string>;
  category: string | null;
  durationMin: number | null;
  staffCount: number | null;
  priceCents: number | null;
  confidenceBp: number;
  lowConfidence: boolean;
  kind: string;
  packageSessions?: number;
  packageServiceNames?: string[];
  packageValidDays?: number | null;
}
interface StaffProposal { name: string; role: string }
interface LocationProposal {
  name?: string;
  phone?: string;
  email?: string;
  addressStreet?: string;
  addressCity?: string;
  addressState?: string;
  addressZip?: string;
  businessType?: string;
  businessHours?: Hours;
  socialLinks?: string[];
  staff?: StaffProposal[];
}
interface BlueprintView {
  blueprintId: string;
  label: string | null;
  locationProposal: LocationProposal;
  items: BlueprintItem[];
  unresolved: Array<{ field: string; question: string }>;
  /** 后台提取任务状态。价目表识别改成异步之后，前端轮询这个字段。 */
  extractionStatus?: 'idle' | 'running' | 'done' | 'failed';
  extractionError?: string | null;
}

/** 价目表识别的后台任务：提交之后进入这个状态，轮询到 done / failed 才退出。 */
interface ExtractingState {
  blueprintId: string;
  startedAt: number;
}

async function imagePayload(file: File, seq: number) {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = dataUrl;
  });
  const max = 2576;
  const scale = Math.min(1, max / Math.max(image.naturalWidth, image.naturalHeight));
  const width = Math.round(image.naturalWidth * scale);
  const height = Math.round(image.naturalHeight * scale);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d')!.drawImage(image, 0, 0, width, height);
  const mediaType = file.type === 'image/png' || file.type === 'image/webp' ? file.type : 'image/jpeg';
  const encoded = canvas.toDataURL(mediaType as 'image/png' | 'image/webp' | 'image/jpeg', 0.92);
  return { seq, base64: encoded.split(',')[1], mediaType, widthPx: width, heightPx: height };
}

function CheckBox({ checked }: { checked: boolean }) {
  return (
    <span className={cn('grid size-6 shrink-0 place-items-center rounded-md border', checked ? 'border-teal-600 bg-teal-600 text-white' : 'border-slate-300 bg-white')}>
      {checked && <Check className="size-3.5" aria-hidden />}
    </span>
  );
}

export function ImportWorkspace({
  mode,
  initialName = '',
  initialPlace = '',
}: {
  mode: 'store' | 'catalog';
  initialName?: string;
  initialPlace?: string;
}) {
  const { membershipId } = useSession();
  const { language, t } = useLanguage();
  const errorMessage = useErrorMessage();
  const queryClient = useQueryClient();
  const [source, setSource] = useState<'google' | 'website' | 'menu'>(mode === 'catalog' ? 'menu' : 'google');
  const [name, setName] = useState(initialName);
  const [place, setPlace] = useState(initialPlace);
  const [url, setUrl] = useState('');
  const [businesses, setBusinesses] = useState<BusinessResult[]>([]);
  const saveContext = useSetupSave();
  const canUseAi = useCan('ai.use');
  const [pendingBusiness, setPendingBusiness] = useState<BusinessResult | null>(null);
  const [businessFields, setBusinessFields] = useState<Set<string>>(new Set());
  const [blueprint, setBlueprint] = useState<BlueprintView | null>(null);
  const [accepted, setAccepted] = useState<Set<string>>(new Set());
  const [acceptedStaff, setAcceptedStaff] = useState<Set<number>>(new Set());
  const [editedItemIds, setEditedItemIds] = useState<Set<string>>(new Set());
  /** 店主对某个 package 行「是组合套餐还是次卡」的手动裁决（覆盖启发式）。 */
  const [bundleKindOverride, setBundleKindOverride] = useState<Map<string, 'bundle' | 'sessions'>>(new Map());
  const saveBundleMut = useSaveBundleTemplate();
  const effectivePkgKind = (item: BlueprintItem): 'bundle' | 'sessions' | 'ambiguous' =>
    bundleKindOverride.get(item.itemId)
      ?? guessPackageKind(item.packageSessions ?? 0, item.packageServiceNames ?? []);
  const [busy, setBusy] = useState(false);
  const [extracting, setExtracting] = useState<ExtractingState | null>(null);
  const [extractElapsed, setExtractElapsed] = useState(0);

  const toggle = <T,>(setter: (value: Set<T>) => void, current: Set<T>, key: T) => {
    const next = new Set(current);
    if (next.has(key)) next.delete(key); else next.add(key);
    setter(next);
  };
  const loadBlueprint = useCallback((view: BlueprintView) => {
    setBlueprint(view);
    setAccepted(new Set(view.items.filter((item) => !item.lowConfidence && ['service', 'addon', 'package'].includes(item.kind)).map((item) => item.itemId)));
    setAcceptedStaff(new Set());
    setEditedItemIds(new Set());
    setBundleKindOverride(new Map());
  }, []);
  const updateBlueprintItem = (itemId: string, patch: Partial<BlueprintItem>) => {
    setBlueprint((current) => current ? {
      ...current,
      items: current.items.map((item) => item.itemId === itemId ? { ...item, ...patch } : item),
    } : current);
    setEditedItemIds((current) => new Set(current).add(itemId));
  };

  // 价目表识别是后台任务：POST /extract 立刻返回 202，这里每 2.5s 轮询一次
  // 草案状态，直到 done（渲染确认页）或 failed（提示并让老板重试）。
  // 轮询本身出错不致命 —— 下一轮再试；进程重启导致的 running 卡死由服务端
  // 的 timeout 折算成 failed（见 loadBlueprint 查询）。
  useEffect(() => {
    if (!extracting) return undefined;
    let stopped = false;
    setExtractElapsed(Math.floor((Date.now() - extracting.startedAt) / 1000));
    const clock = window.setInterval(
      () => setExtractElapsed(Math.floor((Date.now() - extracting.startedAt) / 1000)),
      1000,
    );
    const poll = async () => {
      try {
        const view = await apiGet<BlueprintView>(`/v1/desk/blueprint/${extracting.blueprintId}`);
        if (stopped) return;
        if (view.extractionStatus === 'done') {
          setExtracting(null);
          loadBlueprint(view);
        } else if (view.extractionStatus === 'failed') {
          setExtracting(null);
          toast.danger(view.extractionError === 'timeout'
            ? t('setupImportMenuExtractTimeout')
            : t('setupImportMenuExtractFailed'));
        }
      } catch {
        // 轮询失败先忽略，下一轮再试
      }
    };
    void poll();
    const pollTimer = window.setInterval(() => void poll(), 2500);
    return () => {
      stopped = true;
      window.clearInterval(clock);
      window.clearInterval(pollTimer);
    };
  }, [extracting, loadBlueprint, t]);
  const search = async () => {
    if (name.trim().length < 2 || place.trim().length < 3) {
      toast.danger(t('setupImportNeedNamePlace'));
      return;
    }
    setBusy(true);
    try {
      const out = await apiGet<{ businesses: BusinessResult[] }>(`/v1/desk/${source}/search?term=${encodeURIComponent(name.trim())}&location=${encodeURIComponent(place.trim())}`);
      setBusinesses(out.businesses);
      if (!out.businesses.length) toast.warning(t('setupImportNoMatch'));
    } catch (error) {
      toast.danger(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };
  const chooseBusiness = async (item: BusinessResult) => {
    setBusy(true);
    try {
      const id = item.googlePlaceId!;
      const { business } = await apiGet<{ business: BusinessResult }>(`/v1/desk/google/search?id=${encodeURIComponent(id)}`);
      setPendingBusiness(business);
      setBusinessFields(new Set(['name', 'phone', 'address', 'businessHours', 'rating', 'businessType']));
    } catch (error) {
      toast.danger(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };
  const applyBusiness = async () => {
    if (!membershipId || !pendingBusiness) return;
    setBusy(true);
    try {
      if (saveContext && !await saveContext.flush()) return;
      const business = pendingBusiness;
      await runCommand('location.applyGoogle', {
        googlePlaceId: business.googlePlaceId,
        ...(businessFields.has('businessType') && business.businessType ? { businessType: business.businessType } : {}),
        ...(businessFields.has('name') ? { name: business.name } : {}),
        ...(businessFields.has('phone') && business.phoneE164 ? { phone: business.phoneE164 } : {}),
        ...(businessFields.has('address') ? { address: business.address } : {}),
        ...(businessFields.has('businessHours') ? { businessHours: business.businessHours } : {}),
        ...(businessFields.has('rating') ? { ratingBp: business.rating === null ? null : Math.round(business.rating * 10000), reviewCount: business.reviewCount } : {}),
      }, membershipId);
      await queryClient.invalidateQueries({ queryKey: settingsKeys.desk(membershipId) });
      toast.success(t('setupImportApplied'));
      setPendingBusiness(null);
    } catch (error) {
      toast.danger(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };
  const scanWebsite = async () => {
    if (!url.trim()) return;
    setBusy(true);
    try {
      loadBlueprint(await apiPost<BlueprintView>('/v1/onboarding/website/extract', { url: url.trim(), locale: language }));
    } catch (error) {
      toast.danger(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };
  const scanImages = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = [...(event.target.files ?? [])].slice(0, 6);
    if (!files.length || !membershipId) return;
    setBusy(true);
    try {
      const images = await Promise.all(files.map((file, index) => imagePayload(file, index)));
      const created = await runCommand<{ blueprintId: string }>('blueprint.createDraft', {
        label: t('setupImportDraftLabel', { p0: new Date().toLocaleDateString() }),
        sources: images.map((image) => ({ seq: image.seq, kind: 'price_list_image', storagePath: null, widthPx: image.widthPx, heightPx: image.heightPx })),
      }, membershipId);
      // 识别是后台任务：这个 POST 立刻返回 202，真正的模型调用在服务端进行。
      // 不在这里等结果 —— 交给 extracting 状态与轮询（见上面的 useEffect）。
      await apiPost(`/v1/blueprint/${created.result.blueprintId}/extract`, { images, locale: language });
      setExtracting({ blueprintId: created.result.blueprintId, startedAt: Date.now() });
    } catch (error) {
      toast.danger(errorMessage(error));
    } finally {
      setBusy(false);
      event.target.value = '';
    }
  };
  const applyBlueprint = async () => {
    if (!blueprint || !membershipId) return;
    setBusy(true);
    try {
      // 被判定为「组合套餐」的 package 行：不建 package_template（reviewItems 里标 rejected），
      // 等 blueprint.apply 建好组成服务之后，再用行数据 + 解析出的 serviceId 建 service_bundles。
      const bundleRows = blueprint.items.filter((item) =>
        accepted.has(item.itemId) && item.kind === 'package' && effectivePkgKind(item) === 'bundle');
      const bundleRowIds = new Set(bundleRows.map((r) => r.itemId));

      if (blueprint.items.length > 0) {
        await runCommand('blueprint.reviewItems', {
          blueprintId: blueprint.blueprintId,
          items: blueprint.items.map((item) => ({
            itemId: item.itemId,
            decision: (accepted.has(item.itemId) && !bundleRowIds.has(item.itemId)) ? 'accepted' : 'rejected',
            ...(editedItemIds.has(item.itemId) ? {
              name: item.name,
              category: item.category,
              durationMin: item.durationMin,
              staffCount: item.staffCount,
              priceCents: item.priceCents,
              packageSessions: item.packageSessions,
              packageServiceNames: item.packageServiceNames,
              packageValidDays: item.packageValidDays,
            } : {}),
          })),
        }, membershipId);
      }
      const proposal = blueprint.locationProposal ?? {};
      const applyLocationProposal = Boolean(
        [proposal.name, proposal.phone, proposal.email, proposal.addressStreet, proposal.addressCity,
          proposal.addressState, proposal.addressZip, proposal.businessType].some((value) => value?.trim())
        || Object.keys(proposal.businessHours ?? {}).length > 0,
      );
      await runCommand('blueprint.apply', {
        blueprintId: blueprint.blueprintId,
        fallbackDurationMin: 45,
        applyLocationProposal,
        staffProposalIndexes: [...acceptedStaff],
        allowNoServices: accepted.size === 0 || accepted.size === bundleRowIds.size,
      }, membershipId);
      await queryClient.invalidateQueries({ queryKey: settingsKeys.desk(membershipId) });

      // 组合套餐：blueprint.apply 之后组成服务已入库，按名称匹配后建 service_bundles。
      let bundlesCreated = 0;
      const bundlesSkipped: string[] = [];
      if (bundleRows.length > 0) {
        const settings = await apiGet<DeskSettings>('/v1/desk/settings');
        const svcByName = new Map<string, string>();
        for (const s of settings.services) {
          if (s.isAddon || !s.active) continue;
          for (const v of [s.displayName, ...Object.values(s.name)]) {
            if (v) svcByName.set(normName(v), s.id);
          }
        }
        for (const row of bundleRows) {
          const names = row.packageServiceNames ?? [];
          const ids = names.map((n) => svcByName.get(normName(n))).filter((x): x is string => Boolean(x));
          if (row.priceCents === null || ids.length < 2 || ids.length !== names.length) {
            bundlesSkipped.push(row.displayName);
            continue;
          }
          try {
            await saveBundleMut.mutateAsync({
              name: row.name,
              priceCents: row.priceCents,
              components: ids.map((serviceId, i) => ({ serviceId, qty: 1, seq: i })),
              onlineBookable: false,
            });
            bundlesCreated += 1;
          } catch {
            bundlesSkipped.push(row.displayName);
          }
        }
      }

      toast.success(t('setupImportDraftSaved', { services: accepted.size - bundleRowIds.size }));
      if (bundlesCreated > 0) toast.success(t('bundle.importCreated', { count: bundlesCreated }));
      if (bundlesSkipped.length > 0) {
        toast.danger(t('bundle.importSkipped', { names: bundlesSkipped.join('、') }));
      }
      setBlueprint(null);
    } catch (error) {
      toast.danger(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  if (pendingBusiness) {
    const fields = [
      { id: 'name', label: t('setupImportFieldName'), value: pendingBusiness.name },
      ...(pendingBusiness.businessType ? [{ id: 'businessType', label: t('setupFieldBusinessType'), value: t(({ nail: 'setupBizNail', massage: 'setupBizMassage', foot_spa: 'setupBizFootSpa', lash: 'setupBizLash', scalp: 'setupBizScalp', hair: 'setupBizHair', mixed: 'setupBizMixed' } as const)[pendingBusiness.businessType]) }] : []),
      { id: 'phone', label: t('setupImportFieldPhone'), value: formatPhoneDisplay(pendingBusiness.phoneE164) || t('setupImportMissing') },
      { id: 'address', label: t('setupImportFieldAddress'), value: pendingBusiness.address.display.join(', ') || t('setupImportMissing') },
      { id: 'businessHours', label: t('setupImportFieldHours'), value: t('setupImportOpenDays', { count: Object.values(pendingBusiness.businessHours).filter(Boolean).length }) },
      { id: 'rating', label: t('setupImportFieldRating'), value: pendingBusiness.rating === null ? t('setupImportMissing') : `${pendingBusiness.rating} ★ · ${pendingBusiness.reviewCount ?? 0}` },
    ];
    return (
      <div className="space-y-5 rounded-2xl border border-teal-100 bg-teal-50/40 p-5" aria-busy={busy}>
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.14em] text-teal-700">{t('setupImportStoreTitle')}</p>
          <h3 className="mt-1 text-lg font-extrabold text-slate-950">{t('setupImportPreviewTitle')}</h3>
          <p className="mt-2 text-sm leading-6 text-slate-600">{t('setupImportPreviewCopy')}</p>
        </div>
        <div className="divide-y divide-slate-100 overflow-hidden rounded-2xl border border-slate-200 bg-white">
          {fields.map((field) => (
            <button key={field.id} type="button" onClick={() => toggle(setBusinessFields, businessFields, field.id)} className="flex min-h-11 w-full items-center gap-3 p-4 text-left hover:bg-slate-50">
              <CheckBox checked={businessFields.has(field.id)} />
              <span className="w-24 shrink-0 text-sm font-semibold text-slate-800">{field.label}</span>
              <span className="min-w-0 flex-1 truncate text-sm text-slate-500">{field.value}</span>
            </button>
          ))}
        </div>
        {pendingBusiness.isClosed && <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">{t('setupImportClosedWarning')}</div>}
        <div className="flex flex-wrap justify-between gap-3">
          <Button variant="ghost" onClick={() => setPendingBusiness(null)}>{t('setupImportBack')}</Button>
          <Button
            isPending={busy} onClick={() => void applyBusiness()} isDisabled={busy || businessFields.size === 0}>
            {busy ? t('setupImportApplying') : t('setupImportApplyFields', { count: businessFields.size })}
          </Button>
        </div>
      </div>
    );
  }

  if (extracting) {
    return (
      <div className="space-y-5 rounded-2xl border border-teal-100 bg-teal-50/40 p-5" aria-busy>
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.14em] text-teal-700">{t('setupImportMenuTitle')}</p>
          <h3 className="mt-1 text-lg font-extrabold text-slate-950">{t('setupImportMenuExtracting')}</h3>
        </div>
        <div className="flex items-start gap-3 rounded-2xl border border-slate-200 bg-white p-5" role="status" aria-live="polite">
          <Loader2 className="mt-0.5 size-6 shrink-0 animate-spin text-teal-700" aria-hidden />
          <div className="min-w-0">
            <p className="font-semibold text-slate-900">{t('setupImportMenuExtractingHint')}</p>
            <p className="mt-1 text-sm text-slate-500">{t('setupImportMenuExtractingElapsed', { seconds: extractElapsed })}</p>
          </div>
        </div>
        <p className="text-xs leading-5 text-slate-500">{t('setupImportMenuExtractingKeepOpen')}</p>
      </div>
    );
  }

  if (blueprint) {
    const proposal = blueprint.locationProposal ?? {};
    const locationSummary = [proposal.name, proposal.phone, proposal.email, proposal.addressStreet, proposal.addressCity, proposal.addressState, proposal.addressZip].filter(Boolean).join(' · ');
    const hasLocation = Boolean(locationSummary || Object.keys(proposal.businessHours ?? {}).length);
    const canApply = accepted.size > 0 || acceptedStaff.size > 0 || hasLocation;
    return (
      <div className="space-y-5 rounded-2xl border border-teal-100 bg-teal-50/40 p-5" aria-busy={busy}>
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.14em] text-teal-700">{t('setupImportMenuTitle')}</p>
          <h3 className="mt-1 text-lg font-extrabold text-slate-950">{t('setupImportDraftTitle')}</h3>
          <p className="mt-2 text-sm leading-6 text-slate-600">{t('setupImportDraftCopy')}</p>
        </div>
        {hasLocation && (
          <div className="rounded-2xl border border-slate-200 bg-white p-4">
            <p className="font-semibold text-slate-900">{t('setupImportStoreTitle')}</p>
            <p className="mt-1 text-sm leading-6 text-slate-600">{locationSummary || t('setupImportFieldHours')}. {t('setupImportLocationFound')}</p>
          </div>
        )}
        {blueprint.items.length > 0 && (
          <div>
            <p className="mb-2 text-sm font-bold text-slate-800">{t('setupImportServices')}</p>
            <div className="max-h-[360px] divide-y divide-slate-100 overflow-auto rounded-2xl border border-slate-200 bg-white">
              {blueprint.items.map((item) => (
                <div key={item.itemId} className="flex items-start gap-3 p-4 hover:bg-slate-50">
                  <button type="button" onClick={() => toggle(setAccepted, accepted, item.itemId)} aria-label={item.displayName} className="mt-2"><CheckBox checked={accepted.has(item.itemId)} /></button>
                  <div className="grid min-w-0 flex-1 gap-2 sm:grid-cols-2">
                    <Input value={item.displayName} onChange={(event) => updateBlueprintItem(item.itemId, { displayName: event.target.value, name: { ...item.name, [item.displayLocale]: event.target.value } })} className="h-9 text-xs font-semibold" />
                    {item.kind === 'package' ? (
                      <div className="flex items-center gap-1.5">
                        <select
                          value={effectivePkgKind(item) === 'bundle' ? 'bundle' : 'sessions'}
                          onChange={(event) => setBundleKindOverride((prev) => {
                            const next = new Map(prev);
                            next.set(item.itemId, event.target.value as 'bundle' | 'sessions');
                            return next;
                          })}
                          className="h-9 rounded-md border border-slate-200 bg-white px-2 text-xs"
                          aria-label={t('bundle.importPickKind')}
                        >
                          <option value="bundle">{t('bundle.importKindBundle')}</option>
                          <option value="sessions">{t('bundle.importKindPackage')}</option>
                        </select>
                        {effectivePkgKind(item) !== 'bundle' && (
                          <Input type="number" min="0" value={item.packageSessions ?? 0} onChange={(event) => updateBlueprintItem(item.itemId, { packageSessions: Math.max(0, Number(event.target.value) || 0) })} className="h-9 w-16 text-xs" aria-label={t('setupImportPackageItemsPending')} />
                        )}
                      </div>
                    ) : (
                      <Input value={item.category ?? ''} onChange={(event) => updateBlueprintItem(item.itemId, { category: event.target.value || null })} placeholder={t('setupImportUncategorized')} className="h-9 text-xs" />
                    )}
                    {item.kind === 'package' ? (
                      <Input value={(item.packageServiceNames ?? []).join(', ')} onChange={(event) => updateBlueprintItem(item.itemId, { packageServiceNames: event.target.value.split(',').map((value) => value.trim()).filter(Boolean) })} placeholder={t('setupImportPackageItemsPending')} className="h-9 text-xs sm:col-span-2" />
                    ) : (
                      <Input type="number" min="1" value={item.durationMin ?? 45} onChange={(event) => updateBlueprintItem(item.itemId, { durationMin: Math.max(1, Number(event.target.value) || 45) })} className="h-9 text-xs" />
                    )}
                    <Input type="number" min="0" step="0.01" value={item.priceCents === null ? '' : item.priceCents / 100} onChange={(event) => updateBlueprintItem(item.itemId, { priceCents: event.target.value === '' ? null : Math.round(Number(event.target.value) * 100) })} placeholder={t('setupImportPricePending')} className="h-9 text-xs" />
                    {item.kind !== 'package' && (
                      <label className="flex items-center gap-1.5 text-[11px] text-slate-500">
                        <span className="shrink-0">{t('setupImportStaffCount')}</span>
                        <Input
                          type="number"
                          min="1"
                          max="5"
                          value={item.staffCount ?? 1}
                          onChange={(event) => updateBlueprintItem(item.itemId, {
                            staffCount: Math.min(5, Math.max(1, Number(event.target.value) || 1)),
                          })}
                          className="h-9 w-16 text-xs"
                        />
                      </label>
                    )}
                    {item.kind === 'package' && (
                      <p className="text-[10px] text-slate-400 sm:col-span-2">
                        {effectivePkgKind(item) === 'bundle'
                          ? t('bundle.vsPackageHint')
                          : t('bundle.importKindHint')}
                      </p>
                    )}
                  </div>
                  {item.lowConfidence && <Badge variant="warning">{t('setupImportReview')}</Badge>}
                </div>
              ))}
            </div>
          </div>
        )}
        {mode === 'store' && (proposal.staff?.length ?? 0) > 0 && (
          <div>
            <p className="mb-2 text-sm font-bold text-slate-800">{t('setupImportStaff')}</p>
            <div className="divide-y divide-slate-100 rounded-2xl border border-slate-200 bg-white">
              {proposal.staff!.map((staff, index) => (
                <button key={`${staff.name}-${index}`} type="button" onClick={() => toggle(setAcceptedStaff, acceptedStaff, index)} className="flex min-h-11 w-full items-center gap-3 p-4 text-left hover:bg-slate-50">
                  <CheckBox checked={acceptedStaff.has(index)} />
                  <div>
                    <p className="font-semibold text-slate-900">{staff.name}</p>
                    <p className="text-xs text-slate-500">{staff.role || t('setupImportRolePending')}</p>
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}
        {blueprint.unresolved.length > 0 && (
          <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
            {blueprint.unresolved.map((question) => <p key={question.question}>• {question.question}</p>)}
          </div>
        )}
        <div className="flex flex-wrap justify-between gap-3">
          <Button variant="ghost" onClick={() => setBlueprint(null)}>{t('setupImportBack')}</Button>
          <Button
            isPending={busy} onClick={() => void applyBlueprint()} isDisabled={busy || !canApply}>
            {busy ? t('setupImportBuilding') : t('setupImportConfirm', { services: accepted.size })}
          </Button>
        </div>
      </div>
    );
  }

  const storeTabs = [
    { id: 'google' as const, label: t('setupImportGoogle'), icon: Star },
    ...(canUseAi ? [{ id: 'website' as const, label: t('setupImportWebsite'), icon: Globe2 }] : []),
  ];

  return (
    <div className="space-y-4 rounded-2xl border border-teal-100 bg-teal-50/40 p-5" aria-busy={busy}>
      {mode === 'store' ? (
        <>
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.14em] text-teal-700">{t('setupImportStoreTitle')}</p>
            <p className="mt-2 text-sm leading-6 text-slate-600">{t(canUseAi ? 'setupImportStoreCopy' : 'setupImportGoogleCopy')}</p>
          </div>
          <div className="flex flex-wrap gap-2" role="tablist" aria-label={t('setupImportStoreTitle')}>
            {storeTabs.map((tab) => {
              const Icon = tab.icon;
              const active = source === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => { setSource(tab.id); setBusinesses([]); }}
                  className={cn('inline-flex min-h-11 items-center gap-2 rounded-xl border px-3 py-2 text-sm font-semibold', active ? 'border-teal-500 bg-white text-teal-800' : 'border-slate-200 bg-white/70 text-slate-600')}
                >
                  <Icon className="size-4" aria-hidden />
                  {tab.label}
                </button>
              );
            })}
          </div>
          {source === 'website' ? (
            <div className="flex flex-col gap-3 sm:flex-row">
              <Input className="h-11 flex-1 text-sm" value={url} onChange={(event) => setUrl(event.target.value)} placeholder={t('setupImportWebsiteUrl')} aria-label={t('setupImportWebsite')} />
              <Button onClick={() => void scanWebsite()} isDisabled={busy} className="min-h-11">
                <Globe2 className="size-4" aria-hidden />
                {busy ? t('setupImportScanning') : t('setupImportScanSite')}
              </Button>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="grid gap-3 sm:grid-cols-[1fr_160px_auto]">
                <Input className="h-11 text-sm" value={name} onChange={(event) => setName(event.target.value)} placeholder={t('setupImportShopName')} aria-label={t('setupImportShopName')} />
                <Input className="h-11 text-sm" value={place} onChange={(event) => setPlace(event.target.value)} placeholder={t('setupImportPlace')} aria-label={t('setupImportPlace')} />
                <Button onClick={() => void search()} isDisabled={busy} className="min-h-11">
                  <Search className="size-4" aria-hidden />
                  {busy ? t('setupImportSearching') : t('setupImportSearch')}
                </Button>
              </div>
              {businesses.map((business) => (
                <button key={business.googlePlaceId} type="button" onClick={() => void chooseBusiness(business)} className="flex min-h-11 w-full items-center justify-between rounded-xl border border-slate-200 bg-white p-4 text-left hover:border-teal-400">
                  <div className="min-w-0">
                    <p className="font-semibold text-slate-900">{business.name}</p>
                    <p className="text-xs text-slate-500">{business.address.display.join(', ')} · {business.rating ?? '—'} ★</p>
                  </div>
                  <Badge variant={business.isClosed ? 'error' : 'outline'}>{business.isClosed ? t('setupImportClosed') : t('setupImportSelect')}</Badge>
                </button>
              ))}
            </div>
          )}
        </>
      ) : (
        <>
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.14em] text-teal-700">{t('setupImportMenuTitle')}</p>
            <p className="mt-2 text-sm leading-6 text-slate-600">{t('setupImportMenuCopy')}</p>
          </div>
          <label className={cn('flex min-h-32 cursor-pointer flex-col items-center justify-center rounded-2xl border-2 border-dashed border-teal-200 bg-white p-8 text-center', busy && 'pointer-events-none opacity-70')}>
            {busy ? <Camera className="size-7 animate-pulse text-teal-700" aria-hidden /> : <Upload className="size-7 text-teal-700" aria-hidden />}
            <span className="mt-3 font-bold text-slate-900">{busy ? t('setupImportMenuReading') : t('setupImportMenuDrop')}</span>
            <span className="mt-1 text-xs text-slate-500">{t('setupImportMenuHint')}</span>
            <input className="sr-only" type="file" accept="image/jpeg,image/png,image/webp" multiple onChange={(event) => void scanImages(event)} disabled={busy} />
          </label>
        </>
      )}
      <p className="flex items-start gap-2 text-xs leading-5 text-slate-500">
        <ShieldCheck className="mt-0.5 size-4 shrink-0 text-teal-700" aria-hidden />
        {t('setupImportSafety')}
      </p>
    </div>
  );
}
