import {BookingImagePicker} from '@/components/ui/BookingImagePicker';
import { useState } from 'react';
import { toast } from '@heroui/react';
import { useLanguage } from '@/LanguageContext';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { useSaveService, useSaveServiceCategory } from '@/features/settings/api';
import type { ServiceItem, ServiceCategoryItem } from '@/features/settings/types';
import { parseMoney, parseDurationMinutes } from '@/lib/validation';
import { Field, selectClass, Toggle } from './primitives';
import { SaveStatus, useSetupDraft, useSetupNewRecordGuard } from './autosave';

export function CategoryPicker({ value, onChange, categories }: { value: string; onChange: (id: string) => void; categories: ServiceCategoryItem[] }) {
  const { t } = useLanguage();
  return <Field label={t('settings.stServiceCategoryLabel')}><select className={selectClass} value={value} onChange={e => onChange(e.target.value)}>
    <option value="">{t('settings.stUncategorized')}</option>{categories.map(c => <option key={c.id} value={c.id}>{c.displayName}</option>)}
  </select></Field>;
}
export function CategoryManager({ categories }: { categories: ServiceCategoryItem[] }) {
  const { t, language } = useLanguage();
  const [name, setName] = useState('');
  useSetupNewRecordGuard(Boolean(name.trim()));
  const save = useSaveServiceCategory();
  const add = async () => {
    if (!name.trim()) return;
    try { await save.mutateAsync({ name: { [language]: name.trim() }, sort: categories.length }); setName(''); }
    catch (e) { toast.danger(e instanceof Error ? e.message : String(e)); }
  };
  return <section className="space-y-3 rounded-xl border p-4"><h3 className="font-semibold">{t('settings.stServiceCategoryLabel')}</h3>
    <div className="flex gap-2"><Input aria-label={t('settings.stServiceCategoryLabel')} value={name} onChange={e => setName(e.target.value)} /><Button onClick={() => void add()} disabled={!name.trim() || save.isPending}>{t('settings.stAddCategory')}</Button></div>
    <div className="grid gap-2 sm:grid-cols-2">{categories.map(c => <CategoryName key={c.id} category={c} />)}</div>
  </section>;
}
function CategoryName({ category }: { category: ServiceCategoryItem }) {
  const { language, t } = useLanguage();
  const save = useSaveServiceCategory();
  const draft = useSetupDraft(category.displayName, async name => {
    if (!name.trim()) throw new Error(t('settings.stCategoryNameRequired'));
    await save.mutateAsync({ categoryId: category.id, name: { ...category.name, [language]: name.trim() }, sort: category.sort });
  });
  return <div><Input aria-label={t('settings.stServiceCategoryLabel')} value={draft.value ?? ''} onChange={e => draft.set(e.target.value)} /><SaveStatus {...draft} /></div>;
}
export function ServiceEditor({ service, categories }: { service: ServiceItem; categories: ServiceCategoryItem[] }) {
  const { t, language } = useLanguage();
  const save = useSaveService();
  const draft = useSetupDraft({ name: service.displayName, price: (service.basePriceCents / 100).toFixed(2), duration: String(service.durationMin),
    presentation: service.presentation??{imageUrl:'',description:''}, categoryId: service.categoryId ?? '', isAddon: service.isAddon, onlineBookable: service.onlineBookable, active: service.active, staffCount: service.staffCount }, async value => {
    const price = parseMoney(value.price); const duration = parseDurationMinutes(value.duration, { min: 5, max: 600 });
    if (!value.name.trim() || !price.ok || !duration.ok) throw new Error(t('setupStep2MissingFields'));
    await save.mutateAsync({ presentation:value.presentation, serviceId: service.id, name: { ...service.name, [language]: value.name.trim() }, basePriceCents: price.value, durationMin: duration.value,
      categoryId: value.categoryId || null, isAddon: value.isAddon, onlineBookable: value.isAddon ? false : value.onlineBookable, active: value.active, staffCount: value.staffCount });
  });
  if (!draft.value) return null;
  const v = draft.value;
  const change = (patch: Partial<typeof v>) => draft.set(old => ({ ...old, ...patch }));
  return <details className="space-y-3 rounded-xl border p-4">
    <summary className="cursor-pointer font-semibold focus-visible:outline-2 focus-visible:outline-teal-600">{v.name} · ${v.price} · {v.duration} min</summary>
    <div className="grid gap-3 sm:grid-cols-3">
      <Field label={t('setupFieldServiceName')}><Input value={v.name} onChange={e => change({ name: e.target.value })} /></Field>
      <Field label={t('setupFieldPriceUsd')}><Input type="number" min="0" step="0.01" value={v.price} onChange={e => change({ price: e.target.value })} /></Field>
      <Field label={t('setupFieldDurationMin')}><Input type="number" min="5" max="600" value={v.duration} onChange={e => change({ duration: e.target.value })} /></Field>
      <CategoryPicker categories={categories} value={v.categoryId} onChange={categoryId => change({ categoryId })} />
      <Field label={t('settings.stBulkStaffCount')}><Input type="number" min="1" max="5" value={v.staffCount} onChange={e => change({ staffCount: Number(e.target.value) })} /></Field>
    </div>
    <div className="grid gap-3 sm:grid-cols-3">
      <Toggle checked={v.isAddon} onChange={isAddon => change({ isAddon, onlineBookable: isAddon ? false : v.onlineBookable })} label={t('settings.stAddOnTag')} description={t('setupAddonHint')} />
      {!v.isAddon && <Toggle checked={v.onlineBookable} onChange={onlineBookable => change({ onlineBookable })} label={t('setupOnlineBookable')} description="" />}
      <Toggle checked={v.active} onChange={active => change({ active })} label={t('setupServiceActive')} description="" />
    </div>
    <details><summary className="cursor-pointer text-sm font-semibold">{language.startsWith('zh')?'图片与简介':'Photo and description'}</summary><div className="mt-3 max-w-lg space-y-3"><BookingImagePicker value={v.presentation.imageUrl} serviceName={v.name} onChange={imageUrl=>change({presentation:{...v.presentation,imageUrl}})}/>
    <Field label={language.startsWith('zh')?'项目简介':'Service description'}><textarea className="w-full rounded-xl border p-3" maxLength={5000} value={v.presentation.description} onChange={e=>change({presentation:{...v.presentation,description:e.target.value}})}/></Field>
    </div></details><SaveStatus {...draft} />
  </details>;
}
