import { missingServiceShortNames, serviceShortNamesSchema, type ServiceShortNames } from '@gf/contracts';
import { ShortNameFields, useShortNameCopy } from './ServiceShortNames';
import { useRef, useState } from 'react';
import { Plus, Search, Pencil, Trash2, RotateCcw, Scissors } from 'lucide-react';
import { toast } from '@heroui/react';
import { useLanguage } from '@/LanguageContext';
import { useCan } from '@/lib/permissions';
import { useErrorMessage } from '@/lib/errorMessage';
import { parseMoney, parseDurationMinutes } from '@/lib/validation';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Modal, ConfirmDialog } from '@/components/ui/Modal';
import { PageError, PageLoading } from '@/components/ui/QueryState';
import { EmptyState } from '@/components/ui/EmptyState';
import { BookingImagePicker } from '@/components/ui/BookingImagePicker';
import { useDeskSettingsQuery, useSaveService, useArchiveService, useBulkUpdateServices, useGenerateServiceShortNames } from './api';
import type { ServiceItem, ServiceCategoryItem } from './types';
import { CategoryManager, CategoryPicker } from '@/features/setup/CatalogFields';
import { CatalogPresetPicker } from '@/features/setup/CatalogPresetPicker';
import { ImportWorkspace } from '@/features/setup/ImportWorkspace';
import { Field, Toggle } from '@/features/setup/primitives';
import { useSetupNewRecordGuard } from '@/features/setup/autosave';

export function ServiceCatalog() {
  const { t, language } = useLanguage();
  const shortCopy=useShortNameCopy();
  const generate=useGenerateServiceShortNames();
  const [generating,setGenerating]=useState(false);
  const query = useDeskSettingsQuery();
  const archive = useArchiveService(), restore = useSaveService(), bulk = useBulkUpdateServices();
  const canManage = useCan('catalog.manage'), canImport = useCan('ai.use');
  const errorMessage = useErrorMessage();
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const [deleted, setDeleted] = useState(false);
  const [editor, setEditor] = useState<ServiceItem | 'new' | null>(null);
  const [deleting, setDeleting] = useState<ServiceItem | null>(null);
  const [enablingAll, setEnablingAll] = useState(false);
  const lock = useRef(false);
  const busy = archive.isPending || restore.isPending || bulk.isPending || generating;
  if (query.isError) return <PageError error={query.error} onRetry={() => query.refetch()} />;
  if (!query.data) return <PageLoading title={t('setupReadinessLoading')} />;
  const data = query.data;
  const services = data.services ?? [], categories = data.serviceCategories ?? [];
  const active = services.filter(s => s.active);
  const offline = active.filter(s => !s.isAddon && !s.onlineBookable);
  const shown = services.filter(s => s.active !== deleted && (!category || s.categoryId === category)
    && `${s.displayName} ${categories.find(c => c.id === s.categoryId)?.displayName ?? ''}`.toLowerCase().includes(search.trim().toLowerCase()));

  async function act(work: () => Promise<unknown>, rethrow = false) {
    if (lock.current || !canManage) return;
    lock.current = true;
    try { await work(); }
    catch (error) { toast.danger(errorMessage(error)); void query.refetch(); if (rethrow) throw error; }
    finally { lock.current = false; }
  }
  function toggleOnline(service: ServiceItem) {
    return act(() => bulk.mutateAsync({ serviceIds: [service.id], expectedVersions: { [service.id]: service.updatedAt }, set: { onlineBookable: !service.onlineBookable } }));
  }
  async function enableAll() {
    const targets = [...offline];
    await act(async () => {
      let count = 0;
      try {
        for (let i = 0; i < targets.length; i += 200) {
          const batch = targets.slice(i, i + 200);
          await bulk.mutateAsync({ serviceIds: batch.map(s => s.id), expectedVersions: Object.fromEntries(batch.map(s => [s.id, s.updatedAt])), set: { onlineBookable: true } });
          count += batch.length;
        }
        setEnablingAll(false); toast.success(t('catalogOnlineDone'));
      } catch (error) {
        if (count) toast.warning(t('catalogPartial', { count }));
        throw error;
      } finally { void query.refetch(); }
    }, true);
  }
  async function fillShortNames() {
    const targets=active.filter(s=>missingServiceShortNames(s.shortNames??{}).length);
    await act(async()=>{
      setGenerating(true);let updated=0,skipped=0;
      try {
        for(let i=0;i<targets.length;i+=25){
          const result=await generate.mutateAsync({serviceIds:targets.slice(i,i+25).map(s=>s.id)});
          updated+=result.updated??0;skipped+=result.skipped??0;
        }
        toast.success(`${shortCopy.done}: ${updated}`);
        if(skipped)toast.warning(shortCopy.changed);
      } catch(error) { if(updated)toast.warning(`${shortCopy.done}: ${updated}`);throw error; }
      finally {setGenerating(false);void query.refetch();}
    });
  }
  return <div className="space-y-5">
    <section className="rounded-2xl border border-slate-200 bg-white p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div><h3 className="font-semibold text-slate-900">{t('setupCurrentServices')} <span className="ml-2 text-sm font-normal text-slate-500">{active.length}</span></h3><p className="mt-1 text-sm text-slate-500">{t('catalogDefaults')}</p></div>
        <div className="flex flex-wrap gap-2"><Button variant="secondary" disabled={!canManage||!canImport||busy||!!editor||!active.some(s=>missingServiceShortNames(s.shortNames??{}).length)} isPending={generating} onClick={()=>void fillShortNames()}>{shortCopy.bulk}</Button>{offline.length > 0 && <Button variant="secondary" disabled={!canManage || busy} onClick={() => setEnablingAll(true)}>{t('catalogEnableAll')}</Button>}<Button disabled={!canManage || busy} onClick={() => setEditor('new')}><Plus className="size-4" />{t('setupAddService')}</Button></div>
      </div>
      <div className="mt-5 grid gap-3 sm:grid-cols-[minmax(0,1fr)_200px]">
        <div className="relative"><Search className="absolute left-3 top-3 size-4 text-slate-400" /><Input className="pl-9" aria-label={t('settings.stServiceSearch')} placeholder={t('settings.stServiceSearch')} value={search} onChange={e => setSearch(e.target.value)} /></div>
        <select aria-label={t('settings.stServiceCategoryLabel')} className="min-w-0 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm" value={category} onChange={e => setCategory(e.target.value)}><option value="">{t('catalogAllCategories')}</option>{categories.map(c => <option key={c.id} value={c.id}>{c.displayName}</option>)}</select>
      </div>
      <div className="mt-4 flex gap-2" role="group" aria-label={t('catalogStatus')}>
        {[false, true].map(value => <button key={String(value)} type="button" aria-pressed={deleted === value} onClick={() => setDeleted(value)} className={`rounded-lg px-3 py-2 text-sm font-medium ${deleted === value ? 'bg-teal-50 text-teal-800' : 'text-slate-500 hover:bg-slate-50'}`}>{t(value ? 'catalogDeleted' : 'catalogActive')} · {services.filter(s => s.active !== value).length}</button>)}
      </div>
    </section>
    <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white" aria-label={t('setupCurrentServices')}>
      {!shown.length ? <EmptyState icon={<Scissors className="size-8" />} title={t('catalogNoMatch')} description={t('catalogNoMatchHint')} /> : <ul className="divide-y divide-slate-100">{shown.map(service => <li key={service.id} className="grid gap-3 p-4 sm:p-5 xl:grid-cols-[minmax(0,1fr)_auto] xl:items-center">
        <div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><h4 className="min-w-0 break-words font-semibold text-slate-900">{service.displayName}</h4>{service.shortNames?.[language] && <span className="rounded bg-slate-100 px-2 py-0.5 text-xs">{shortCopy.label}: {service.shortNames[language]}</span>}{service.isAddon && <span className="rounded-md bg-amber-50 px-2 py-0.5 text-xs text-amber-800">{t('settings.stAddOnTag')}</span>}</div><p className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-sm text-slate-500"><span className="font-semibold tabular-nums text-slate-800">${(service.basePriceCents / 100).toFixed(2)}</span><span>{t('catalogMinutes', { count: service.durationMin })}</span><span>{categories.find(c => c.id === service.categoryId)?.displayName || t('settings.stUncategorized')}</span></p></div>
        <div className="flex flex-wrap items-center gap-2">
          {!deleted && !service.isAddon && <label className="mr-2 flex items-center gap-2 text-sm text-slate-600"><input type="checkbox" aria-label={`${t('catalogOnline')}: ${service.displayName}`} checked={service.onlineBookable} disabled={!canManage || busy} onChange={() => void toggleOnline(service)} className="size-4 accent-teal-600" />{t('catalogOnline')}</label>}
          {deleted ? <Button size="sm" variant="secondary" disabled={!canManage || busy} onClick={() => void act(async () => { await restore.mutateAsync({ serviceId: service.id, name: service.name, durationMin: service.durationMin, basePriceCents: service.basePriceCents, active: true }); toast.success(t('catalogRestored')); })}><RotateCcw className="size-4" />{t('catalogRestore')}</Button> : <><Button size="sm" variant="secondary" disabled={!canManage || busy} aria-label={`${t('edit')}: ${service.displayName}`} onClick={() => setEditor(service)}><Pencil className="size-4" />{t('edit')}</Button><Button size="sm" variant="ghost" disabled={!canManage || busy} className="text-red-700" aria-label={`${t('catalogDelete')}: ${service.displayName}`} onClick={() => setDeleting(service)}><Trash2 className="size-4" />{t('catalogDelete')}</Button></>}
        </div>
      </li>)}</ul>}
    </section>
    {canManage && <>
    <details className="rounded-2xl border border-slate-200 bg-white p-4 sm:p-5"><summary className="cursor-pointer font-semibold">{t('voiceImportTools')}</summary><div className="mt-4 space-y-4"><CatalogPresetPicker businessType={data.location.businessType} existingNames={services.map(s => s.displayName)} onAdded={() => void query.refetch()} />{canImport && <ImportWorkspace mode="catalog" />}</div></details>
    <details className="rounded-2xl border border-slate-200 bg-white p-4 sm:p-5"><summary className="cursor-pointer font-semibold">{t('settings.stServiceCategoryLabel')}</summary><div className="mt-4"><CategoryManager categories={categories} /></div></details>
    </>}
    {editor && <ServiceForm service={editor === 'new' ? null : editor} categories={categories} onClose={() => setEditor(null)} />}
    <ConfirmDialog isOpen={deleting !== null} onOpenChange={open => { if (!open && !busy) setDeleting(null); }} title={t('catalogDeleteTitle', { name: deleting?.displayName ?? '' })} description={t('catalogDeleteHint')} confirmLabel={t('catalogDelete')} tone="danger" onConfirm={async () => { if (deleting) await act(async () => { await archive.mutateAsync({ serviceId: deleting.id }); setDeleting(null); toast.success(t('catalogDeletedDone')); }, true); }} />
    <ConfirmDialog isOpen={enablingAll} onOpenChange={open => { if (!busy) setEnablingAll(open); }} title={t('catalogEnableAll')} description={t('catalogEnableAllHint', { count: offline.length })} confirmLabel={t('catalogEnableAll')} onConfirm={enableAll} />
  </div>;
}

function ServiceForm({ service, categories, onClose }: { service: ServiceItem | null; categories: ServiceCategoryItem[]; onClose: () => void }) {
  const { t, language } = useLanguage();
  const canManage = useCan('catalog.manage');
  const errorMessage = useErrorMessage();
  const save = useSaveService();
  const generate=useGenerateServiceShortNames();
  const canGenerate=useCan("ai.use");
  const [initial] = useState(() => ({ name: service?.displayName ?? '', shortNames: (service?.shortNames ?? {}) as ServiceShortNames, price: service ? (service.basePriceCents / 100).toFixed(2) : '', duration: String(service?.durationMin ?? 60), categoryId: service?.categoryId ?? '', isAddon: service?.isAddon ?? false, onlineBookable: service?.onlineBookable ?? true, staffCount: String(service?.staffCount ?? 1), presentation: service?.presentation ?? { imageUrl: '', description: '' } }));
  const [form, setForm] = useState(initial);
  const [error, setError] = useState('');
  const lock = useRef(false);
  useSetupNewRecordGuard(JSON.stringify(form) !== JSON.stringify(initial));
  const change = (patch: Partial<typeof form>) => { setForm(old => ({ ...old, ...patch })); setError(''); };
  async function submit() {
    if (lock.current || !canManage) return;
    const price = parseMoney(form.price), duration = parseDurationMinutes(form.duration, { min: 5, max: 600 });
    const staffCount = Number(form.staffCount);
    if (!serviceShortNamesSchema.safeParse(form.shortNames).success || !form.name.trim() || !price.ok || !duration.ok || !Number.isInteger(staffCount) || staffCount < 1 || staffCount > 5) { setError(t('catalogInvalid')); return; }
    lock.current = true;
    try {
      await save.mutateAsync({ ...(service ? { serviceId: service.id } : {}), name: service ? { ...service.name, [language]: form.name.trim() } : { [language]: form.name.trim(), en: form.name.trim() }, shortNames: form.shortNames, basePriceCents: price.value, durationMin: duration.value, categoryId: form.categoryId || null, isAddon: form.isAddon, onlineBookable: !form.isAddon && form.onlineBookable, staffCount, presentation: form.presentation, active: true });
      toast.success(t('catalogSaved')); onClose();
    } catch (err) { setError(errorMessage(err)); }
    finally { lock.current = false; }
  }
  async function fillLanguages() {
    if(lock.current||!canManage||!canGenerate||!form.name.trim())return;
    lock.current=true;
    try {
      const result=await generate.mutateAsync({name:{...service?.name,[language]:form.name.trim()},shortNames:form.shortNames});
      if(result.shortNames)change({shortNames:result.shortNames});
    }catch(err){setError(errorMessage(err));}finally{lock.current=false;}
  }
  return <Modal isOpen onOpenChange={open => { if (!open) onClose(); }} isDismissDisabled={save.isPending||generate.isPending} title={t(service ? 'catalogEdit' : 'setupAddService')} description={t('catalogFormHint')} size="lg" footer={<><Button variant="secondary" disabled={save.isPending||generate.isPending} onClick={onClose}>{t('cancel')}</Button><Button disabled={save.isPending || generate.isPending || !canManage} isPending={save.isPending} onClick={() => void submit()}>{t('save')}</Button></>}>
    <fieldset disabled={save.isPending || generate.isPending || !canManage} className="space-y-5">
      <Field label={t('setupFieldServiceName')}><Input value={form.name} maxLength={200} onChange={e => change({ name: e.target.value })} /></Field>
      <div className="grid gap-4 sm:grid-cols-2"><Field label={t('setupFieldPriceUsd')}><Input type="number" min="0" step="0.01" value={form.price} onChange={e => change({ price: e.target.value })} /></Field><Field label={t('setupFieldDurationMin')}><Input type="number" min="5" max="600" value={form.duration} onChange={e => change({ duration: e.target.value })} /></Field></div>
      <ShortNameFields value={form.shortNames} onChange={shortNames=>change({shortNames})} onGenerate={()=>void fillLanguages()} busy={generate.isPending} canGenerate={canGenerate&&canManage&&!!form.name.trim()} />
      <CategoryPicker categories={categories} value={form.categoryId} onChange={categoryId => change({ categoryId })} />
      {!form.isAddon && <Toggle checked={form.onlineBookable} onChange={onlineBookable => change({ onlineBookable })} label={t('catalogOnline')} description={t('catalogDefaults')} />}
      <details><summary className="cursor-pointer text-sm font-medium">{t('catalogAdvanced')}</summary><div className="mt-4 space-y-4"><Toggle checked={form.isAddon} onChange={isAddon => change({ isAddon, onlineBookable: !isAddon })} label={t('settings.stAddOnTag')} description={t('setupAddonHint')} /><Field label={t('settings.stBulkStaffCount')}><Input type="number" min="1" max="5" value={form.staffCount} onChange={e => change({ staffCount: e.target.value })} /></Field></div></details>
      <details><summary className="cursor-pointer text-sm font-medium">{t('catalogPresentation')}</summary><div className="mt-4 space-y-4"><BookingImagePicker value={form.presentation.imageUrl} serviceName={form.name} onChange={imageUrl => change({ presentation: { ...form.presentation, imageUrl } })} /><Field label={t('catalogDescription')}><textarea className="w-full rounded-xl border border-slate-200 p-3" rows={3} maxLength={5000} value={form.presentation.description} onChange={e => change({ presentation: { ...form.presentation, description: e.target.value } })} /></Field></div></details>
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
    </fieldset>
  </Modal>;
}
