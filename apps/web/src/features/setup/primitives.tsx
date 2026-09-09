import type { ReactNode } from 'react';
import { Save } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { GuardedButton } from '@/components/ui/GuardedButton';
import { cn } from '@/lib/utils';
import { useLanguage } from '@/LanguageContext';

/**
 * 开店向导各步骤共用的小组件。
 *
 * 从 `StepForms.tsx` 抽出来 —— 七步之后新增的房间 / 员工基础 / 功能设置
 * 三个步骤组件都要用，不能继续把它们锁在单文件里，也不该把整页后台
 * 组件塞进向导（U01 / S5）。
 */

export const fieldClass = 'h-11 text-sm';
export const selectClass =
  'h-11 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm text-slate-900 outline-none focus:border-teal-500 focus:ring-2 focus:ring-teal-500/20';

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="space-y-1.5">
      <span className="text-sm font-semibold text-slate-800">{label}</span>
      {children}
      {hint && <span className="block text-xs leading-5 text-slate-500">{hint}</span>}
    </label>
  );
}

export function Toggle({ checked, onChange, label, description }: {
  checked: boolean; onChange: (checked: boolean) => void; label: string; description?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="flex w-full items-center justify-between gap-4 rounded-xl border border-slate-200 bg-white p-4 text-left"
    >
      <span>
        <span className="block text-sm font-semibold text-slate-900">{label}</span>
        {description && <span className="mt-1 block text-xs leading-5 text-slate-500">{description}</span>}
      </span>
      <span className={cn('relative h-6 w-11 shrink-0 rounded-full transition-colors', checked ? 'bg-teal-600' : 'bg-slate-300')}>
        <span className={cn('absolute top-1 size-4 rounded-full bg-white shadow-sm transition-transform', checked ? 'translate-x-6' : 'translate-x-1')} />
      </span>
    </button>
  );
}

/**
 * ⚠️ `label` 不给中文默认值 —— 漏传就会在任意语言下显示中文。
 * 缺省用当前语言的词典默认值。
 */
export function SaveBar({ saving, onSave, permission, label }: {
  saving: boolean; onSave: () => void; permission: string; label?: string;
}) {
  const { t } = useLanguage();
  return (
    <div className="flex justify-end border-t border-slate-100 pt-5">
      <GuardedButton permission={permission} onClick={onSave} isDisabled={saving} className="gap-2">
        <Save className="size-4" />
        {saving ? t('setupSaving') : (label ?? t('setupSaveContinue'))}
      </GuardedButton>
    </div>
  );
}

export function StepHeading({ eyebrow, title, description, badge }: {
  eyebrow: string; title: string; description: string; badge?: string;
}) {
  const { t } = useLanguage();
  const resolvedBadge = badge ?? t('setupRequiredBadge');
  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-sm font-semibold text-teal-700">{eyebrow}</p>
        <Badge variant={resolvedBadge === t('setupRequiredBadge') ? 'default' : 'secondary'}>{resolvedBadge}</Badge>
      </div>
      <h2 className="mt-1 text-2xl font-bold tracking-tight text-slate-950">{title}</h2>
      <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">{description}</p>
    </div>
  );
}
