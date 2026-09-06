import { useState } from 'react';
import { toast } from '@heroui/react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { useLanguage } from '@/LanguageContext';
import { useErrorMessage } from '@/lib/errorMessage';
import { useSaveDirectoryOption } from './api';
import type { DirectoryOption } from './types';

type Kind = 'job' | 'level' | 'skill';
export function DirectorySettings({ jobs, levels, skills }: { jobs: DirectoryOption[]; levels: DirectoryOption[]; skills: DirectoryOption[] }) {
  const { language } = useLanguage();
  const zh = language === 'zh-Hans';
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<Kind>('job');
  const [editing, setEditing] = useState<DirectoryOption | null>(null);
  const [name, setName] = useState('');
  const [sort, setSort] = useState('0');
  const mutation = useSaveDirectoryOption();
  const errorMessage = useErrorMessage();
  const options = { job: jobs, level: levels, skill: skills }[kind];
  const reset = () => { setEditing(null); setName(''); setSort('0'); };
  const save = async (option?: DirectoryOption) => {
    try {
      await mutation.mutateAsync(option
        ? { kind, ...option, active: !option.active }
        : { kind, ...(editing ? { id: editing.id } : {}), name: name.trim(), sort: Number(sort), active: editing?.active ?? true });
      reset();
      toast.success(zh ? '已保存' : 'Saved');
    } catch (error) { toast.danger(errorMessage(error)); }
  };
  return <>
    <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>{zh ? '岗位 / 职级 / 技能设置' : 'Roles / levels / skills'}</Button>
    <Modal isOpen={open} onOpenChange={setOpen} title={zh ? '员工基础设置' : 'Staff directory settings'} size="lg">
      <div className="space-y-4">
        <p className="text-sm text-slate-500">{zh ? '停用后不再提供给新员工选择，已有员工和项目关联保留。岗位不改变账号权限。' : 'Inactive options retain existing assignments. Job titles do not change account permissions.'}</p>
        <div className="flex gap-2">
          {(['job', 'level', 'skill'] as const).map((value, index) => <Button key={value} variant={kind === value ? undefined : 'secondary'} onClick={() => { setKind(value); reset(); }}>{(zh ? ['岗位', '职级', '技能'] : ['Job titles', 'Levels', 'Skills'])[index]}</Button>)}
        </div>
        <div className="max-h-72 overflow-auto divide-y">
          {options.map((option) => <div key={option.id} className="flex items-center gap-3 py-2">
            <span className="flex-1">{option.name}{!option.active && (zh ? '（已停用）' : ' (inactive)')}</span>
            <span className="text-xs text-slate-400">{option.sort}</span>
            <Button size="sm" variant="secondary" disabled={mutation.isPending} onClick={() => { setEditing(option); setName(option.name); setSort(String(option.sort)); }}>{zh ? '编辑' : 'Edit'}</Button>
            <Button size="sm" variant="secondary" disabled={mutation.isPending} onClick={() => void save(option)}>{option.active ? (zh ? '停用' : 'Disable') : (zh ? '启用' : 'Enable')}</Button>
          </div>)}
        </div>
        <form className="flex gap-2 items-end" onSubmit={(event) => { event.preventDefault(); void save(); }}>
          <label className="flex-1 text-sm">{zh ? '名称' : 'Name'}<Input required maxLength={50} value={name} onChange={(event) => setName(event.target.value)} /></label>
          <label className="w-20 text-sm">{zh ? '排序' : 'Order'}<Input type="number" min={0} max={9999} required value={sort} onChange={(event) => setSort(event.target.value)} /></label>
          <Button type="submit" disabled={mutation.isPending || !name.trim()}>{editing ? (zh ? '保存' : 'Save') : (zh ? '新增' : 'Add')}</Button>
          {editing && <Button variant="secondary" onClick={reset}>{zh ? '取消' : 'Cancel'}</Button>}
        </form>
      </div>
    </Modal>
  </>;
}
