import { useState } from 'react';
import { toast } from '@heroui/react';
import { useLanguage } from '@/LanguageContext';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { useSaveDirectoryOption } from '@/features/staff/api';
import type { DirectoryOption } from '@/features/staff/types';
import { SaveStatus, useSetupDraft, useSetupNewRecordGuard } from './autosave';
import { Toggle } from './primitives';
type Kind = 'job' | 'level' | 'skill';
export function DirectoryEditor({ jobs, levels, skills }: { jobs: DirectoryOption[]; levels: DirectoryOption[]; skills: DirectoryOption[] }) {
  const { t } = useLanguage();
  const groups = [{ kind: 'job' as const, options: jobs, label: t('setupDirectoryJobs') }, { kind: 'level' as const, options: levels, label: t('setupDirectoryLevels') }, { kind: 'skill' as const, options: skills, label: t('setupDirectorySkills') }];
  return <div className="space-y-5">{groups.map(g => <Group key={g.kind} {...g} />)}</div>;
}
function Group({ kind, options, label }: { kind: Kind; options: DirectoryOption[]; label: string }) {
  const { t } = useLanguage();
  const [name, setName] = useState('');
  useSetupNewRecordGuard(Boolean(name.trim()));
  const save = useSaveDirectoryOption();
  const add = async () => {
    if (!name.trim()) return;
    try { await save.mutateAsync({ kind, name: name.trim(), sort: options.length ? Math.max(...options.map(o => o.sort)) + 1 : 0, active: true }); setName(''); }
    catch (e) { toast.danger(e instanceof Error ? e.message : String(e)); }
  };
  return <section className="space-y-3"><h3 className="font-semibold">{label}</h3>
    <div className="flex gap-2"><Input aria-label={label} value={name} onChange={e => setName(e.target.value)} /><Button disabled={!name.trim() || save.isPending} onClick={() => void add()}>{t('setupAddOption')}</Button></div>
    {options.map(option => <Option key={option.id} kind={kind} option={option} label={label} />)}
  </section>;
}
function Option({ kind, option, label }: { kind: Kind; option: DirectoryOption; label: string }) {
  const { t } = useLanguage();
  const save = useSaveDirectoryOption();
  const draft = useSetupDraft({ name: option.name, active: option.active }, async v => {
    if (!v.name.trim()) throw new Error(t('setupStep3MissingName'));
    await save.mutateAsync({ kind, id: option.id, name: v.name.trim(), active: v.active, sort: option.sort });
  }, `setup-directory:${kind}:${option.id}`);
  if (!draft.value) return null;
  return <div className="space-y-2"><div className="grid gap-2 sm:grid-cols-2"><Input aria-label={label} value={draft.value.name} onChange={e => draft.set(old => ({ ...old, name: e.target.value }))} /><Toggle checked={draft.value.active} onChange={active => draft.set(old => ({ ...old, active }))} label={t('setupOptionEnabled')} /></div><SaveStatus {...draft} /></div>;
}
