import { StaffBookingSchedule } from './StaffBookingSchedule';
import { useLanguage } from '@/LanguageContext';
import { Input } from '@/components/ui/Input';
import { useSaveStaffProfile, useStaffListQuery } from '@/features/staff/api';
import type { StaffItem } from '@/features/settings/types';
import { Field, Toggle, selectClass } from './primitives';
import { SaveStatus, useSetupDraft } from './autosave';
export function StaffEditor({ staff, voiceOnly }: { staff: StaffItem; voiceOnly: boolean }) {
  const { t } = useLanguage();
  const save = useSaveStaffProfile();
  const directory = useStaffListQuery();
  const detail = directory.data?.staff.find(member => member.membershipId === staff.membershipId);
  const draft = useSetupDraft(detail ? { name: detail.name, isBookable: detail.isBookable, maxConcurrentAppointments: detail.maxConcurrentAppointments, inRotation: staff.inRotation, jobTitleId: detail.jobTitleId, levelId: detail.levelId, skillIds: detail.skillIds, phone: detail.phone ?? '' } : null, async v => {
    if (!v.name.trim()) throw new Error(t('setupStep3MissingName'));
    await save.mutateAsync({ ...v, membershipId: staff.membershipId, name: v.name.trim(), phone: v.phone.trim() || null, inRotation: !voiceOnly && v.inRotation });
  });
  if (!draft.value) return null;
  const v = draft.value;
  return <div className="space-y-3 rounded-xl border p-4">
    <Field label={t('setupFieldStaffName')}><Input value={v.name} onChange={e => draft.set(old => ({ ...old, name: e.target.value }))} /></Field>
    <Field label={t('setupFieldPhone')}><Input type="tel" value={v.phone} onChange={e => draft.set(old => ({ ...old, phone: e.target.value }))} /></Field>
    {!voiceOnly && <Field label={t('setupStaffCapacity')}><Input type="number" min="1" max="5" value={v.maxConcurrentAppointments} onChange={e => draft.set(old => ({ ...old, maxConcurrentAppointments: Number(e.target.value) }))} /></Field>}
    <div className="grid gap-3 sm:grid-cols-2">
      <Field label={t('setupDirectoryJobs')}><select className={selectClass} value={v.jobTitleId ?? ''} onChange={e => draft.set(old => ({ ...old, jobTitleId: e.target.value || null }))}><option value="">—</option>{directory.data?.jobs.filter(j => j.active || j.id === v.jobTitleId).map(j => <option key={j.id} value={j.id}>{j.name}</option>)}</select></Field>
      <Field label={t('setupDirectoryLevels')}><select className={selectClass} value={v.levelId ?? ''} onChange={e => draft.set(old => ({ ...old, levelId: e.target.value || null }))}><option value="">—</option>{directory.data?.levels.filter(j => j.active || j.id === v.levelId).map(j => <option key={j.id} value={j.id}>{j.name}</option>)}</select></Field>
    </div>
    {!!directory.data?.skills.length && <fieldset className="flex flex-wrap gap-3"><legend className="text-sm font-semibold">{t('setupDirectorySkills')}</legend>{directory.data.skills.filter(j => j.active || v.skillIds.includes(j.id)).map(skill => <label key={skill.id} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={v.skillIds.includes(skill.id)} onChange={e => { const checked = e.target.checked; draft.set(old => ({ ...old, skillIds: checked ? [...old.skillIds, skill.id] : old.skillIds.filter(id => id !== skill.id) })); }} />{skill.name}</label>)}</fieldset>}
    <Toggle checked={v.isBookable} onChange={isBookable => draft.set(old => ({ ...old, isBookable }))} label={t('setupToggleBookableLabel')} description={t('setupToggleBookableDesc')} />
    {!voiceOnly && <Toggle checked={v.inRotation} onChange={inRotation => draft.set(old => ({ ...old, inRotation }))} label={t('setupToggleRotationLabel')} description={t('setupToggleRotationDesc')} />}
    <SaveStatus {...draft} />
    {voiceOnly && <StaffBookingSchedule id={staff.membershipId}/> }
  </div>;
}
