import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { PageError } from '@/components/ui/QueryState';
import { SaveStatus, useSetupDraft, useSetupNewRecordGuard } from './autosave';
import { useEntitlements } from '@/features/billing/useEntitlements';
import { useEffect, useState } from 'react';
import { toast } from '@heroui/react';
import { DoorOpen, Plus } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { GuardedButton } from '@/components/ui/GuardedButton';
import { Input } from '@/components/ui/Input';
import { cn } from '@/lib/utils';
import { useLanguage } from '@/LanguageContext';
import { useSetupReadinessQuery, useSaveSetupFeatures } from '@/features/settings/api';
import { useStaffListQuery } from '@/features/staff/api';
import { DirectoryEditor } from './DirectoryEditor';
import { useRoomsQuery, useSaveResource } from '@/features/rooms/api';
import { Field, SaveBar, StepHeading, Toggle, fieldClass, selectClass } from '@/features/setup/primitives';
import type { TranslationKey } from '@/i18n';

/* ─────────────────────────────────────────── 第 2 步 · 员工基础设置 ── */

/**
 * 岗位 / 职级 / 技能选项。非开店门槛 —— 不设置也能继续，添加员工时能直接
 * 输入岗位名。复用后台的 `DirectorySettings` 弹窗，向导只加一层引导。
 */
export function DirectoryStepForm({ stepNumber = 2 }: { stepNumber?: number }) {
  const { t } = useLanguage();
  const query = useStaffListQuery();
  const { data } = query;
  if (query.isError) return <PageError title={t('genericFailure')} error={query.error} onRetry={() => query.refetch()} />;
  if (!data) return <p><LoadingSpinner label={t('setupReadinessLoading')} /></p>;
  const jobs = data?.jobs ?? [];
  const levels = data?.levels ?? [];
  const skills = data?.skills ?? [];

  return (
    <div className="space-y-6">
      <p className="text-sm leading-6 text-slate-600">{t('setupDirectoryHint')}</p>
      <div className="rounded-2xl border border-slate-200 bg-slate-50/60 p-5">
        <DirectoryEditor jobs={jobs} levels={levels} skills={skills} />
        <p className="mt-3 text-sm text-slate-600">
          {t('setupDirectoryCounts', { jobs: jobs.length, levels: levels.length, skills: skills.length })}
        </p>
      </div>
      <div className="rounded-xl border border-teal-100 bg-teal-50/60 p-4 text-sm leading-6 text-teal-900">
        {t('setupDirectorySkipNote')}
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────── 第 3 步 · 房间 ── */

const ROOM_TYPE_OPTIONS: ReadonlyArray<readonly [value: string, labelKey: TranslationKey]> = [
  ['room', 'setupRoomTypeRoom'],
  ['vip', 'setupRoomTypeVip'],
  ['couples_room', 'setupRoomTypeCouples'],
  ['chair', 'setupRoomTypeChair'],
  ['bed', 'setupRoomTypeTable'],
];

/** 至少一个可用房间 / 工位才能开店。开放式店面可建一个叫「大厅」的 room。 */
export function RoomsStepForm({ onSaved, stepNumber = 3 }: { onSaved: () => void; stepNumber?: number }) {
  const { t } = useLanguage();
  const { data } = useRoomsQuery();
  const saveResource = useSaveResource();
  const [name, setName] = useState('');
  useSetupNewRecordGuard(Boolean(name.trim()));
  const [type, setType] = useState('room');
  const [capacity, setCapacity] = useState('1');

  const rooms = data?.rooms ?? [];
  const usable = rooms.filter((room) => room.status !== 'maintenance');

  const add = async () => {
    const capacityValue = Math.max(1, Number.parseInt(capacity, 10) || 1);
    if (!name.trim()) { toast.danger(t('setupFieldRoomName')); return; }
    try {
      await saveResource.mutateAsync({ name: name.trim(), type, capacity: capacityValue, active: true });
      setName('');
      toast.success(t('setupRoomAdded'));
      onSaved();
    } catch (error) {
      toast.danger(t('setupRoomAddFailed', { p0: error instanceof Error ? error.message : 'UNKNOWN' }));
    }
  };

  return (
    <div className="space-y-6">
      <div className="grid gap-4 rounded-2xl border border-slate-200 bg-slate-50/60 p-5 md:grid-cols-[1.3fr_.9fr_.5fr_auto]">
        <Field label={t('setupFieldRoomName')}>
          <Input className={fieldClass} value={name} onChange={(e) => setName(e.target.value)} placeholder={t('setupRoomTypeRoom')} />
        </Field>
        <Field label={t('setupFieldRoomType')}>
          <select className={selectClass} value={type} onChange={(e) => setType(e.target.value)}>
            {ROOM_TYPE_OPTIONS.map(([value, key]) => <option key={value} value={value}>{t(key)}</option>)}
          </select>
        </Field>
        <Field label={t('setupFieldRoomCapacity')}>
          <Input className={fieldClass} type="number" min="1" step="1" value={capacity} onChange={(e) => setCapacity(e.target.value)} />
        </Field>
        <GuardedButton
          isPending={saveResource.isPending} permission="settings.manage" onClick={add} isDisabled={saveResource.isPending} className="h-11 self-end gap-2">
          <Plus className="size-4" />{t('setupAddRoom')}
        </GuardedButton>
      </div>

      <div>
        <div className="mb-3 flex items-center justify-between">
          <h3 className="font-bold text-slate-900">{t('setupCurrentRooms')}</h3>
          <Badge variant={usable.length ? 'success' : 'warning'}>{t('setupRoomsActiveCount', { count: usable.length })}</Badge>
        </div>
        {rooms.length ? (
          <div className="grid gap-3 sm:grid-cols-2">
            {rooms.map((room) => (
              <div key={room.id} className="flex items-center gap-3 rounded-xl border border-slate-200 p-4">
                <span className="grid size-9 place-items-center rounded-lg bg-teal-50 text-teal-700"><DoorOpen className="size-4" /></span>
                <div className="min-w-0 flex-1">
                  <p className="truncate font-semibold text-slate-900">{room.name}</p>
                  <p className="text-xs text-slate-500">{room.type} · {t('setupFieldRoomCapacity')} {room.capacity}</p>
                </div>
                {room.status === 'maintenance' && <Badge variant="secondary">{t('setupRoomInMaintenance')}</Badge>}
              </div>
            ))}
          </div>
        ) : (
          <div className="rounded-2xl border border-dashed border-amber-300 bg-amber-50 p-6 text-center text-sm text-amber-900">
            {t('setupNoRoomsHint')}
          </div>
        )}
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────── 第 6 步 · 功能设置 ── */

/** 健康表 + AI 电话意愿。两者关着都能开店；确认这一步 = 保存并写 confirmedAt。 */
export function FeaturesStepForm({ onSaved, stepNumber = 6 }: { onSaved: () => void; stepNumber?: number }) {
  const { t } = useLanguage();
  const { data: readiness } = useSetupReadinessQuery();
  const saveFeatures = useSaveSetupFeatures();
  const voiceOnly = useEntitlements().data?.plan === 'voice_booking';
  const draft = useSetupDraft(readiness ? { healthForms: readiness.features.healthFormsEnabled ?? false, aiVoice: readiness.aiVoice.intent ?? false } : null, async value => {
    await saveFeatures.mutateAsync({ healthFormsEnabled: voiceOnly ? false : value.healthForms, aiVoiceRequested: value.aiVoice, confirmSetup: true });
  });
  const healthForms = draft.value?.healthForms ?? false;
  const aiVoice = draft.value?.aiVoice ?? false;
  const setHealthForms = (healthForms: boolean) => draft.set(old => ({ ...old, healthForms }));
  const setAiVoice = (aiVoice: boolean) => draft.set(old => ({ ...old, aiVoice }));

  const confirmedAt = readiness?.features.confirmedAt ?? null;
  const aiState = readiness?.aiVoice.state ?? 'unconfigured';
  const AI_STATE_KEY = {
    unconfigured: 'setupAiVoiceStateUnconfigured',
    requested: 'setupAiVoiceStateRequested',
    ready_off: 'setupAiVoiceStateReadyOff',
    on: 'setupAiVoiceStateOn',
    suspended: 'setupAiVoiceStateSuspended',
  } as const;

  return (
    <div className="space-y-6">
      {!voiceOnly && <p className="text-sm leading-6 text-slate-600">{t('setupFeaturesIntro')}</p>}

      <div className="space-y-3">
        {!voiceOnly && <Toggle
          checked={healthForms}
          onChange={setHealthForms}
          label={t('setupFeatureHealthFormsLabel')}
          description={t('setupFeatureHealthFormsDesc')}
        />}
        <div className="space-y-2">
          <Toggle
            checked={aiVoice}
            onChange={setAiVoice}
            label={t('setupFeatureAiVoiceLabel')}
            description={t('setupFeatureAiVoiceDesc')}
          />
          <div className="flex items-center gap-2 px-1 text-xs text-slate-500">
            <span className={cn('inline-block size-2 rounded-full', aiState === 'on' ? 'bg-emerald-500' : aiState === 'suspended' ? 'bg-red-500' : 'bg-slate-300')} />
            {t(AI_STATE_KEY[aiState])}
          </div>
        </div>
      </div>

      {confirmedAt && (
        <p className="text-xs leading-5 text-slate-500">{t('setupFeaturesConfirmedNote')}</p>
      )}
      <SaveStatus {...draft} />
    </div>
  );
}
