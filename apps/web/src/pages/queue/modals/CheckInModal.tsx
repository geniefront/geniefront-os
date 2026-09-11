/**
 * 顾客到店签到：健康问卷排查、身体禁忌标记、按摩偏好、到店现场加项。
 *
 * 这一步采集的偏好会一路带到技师端与服务单，因此选项一律以 id 持久化、
 * 以词典键渲染 —— 增加界面语言不会影响既有记录。
 * 从 `pages/Queue.tsx` 原样搬出，状态仍留在页面。
 */
import {
  AlertTriangle, Check, CheckCircle2, ExternalLink, Languages, Plus,
  QrCode, ShieldAlert, Sparkles, Tablet, UserCheck,
} from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { Spinner } from '@heroui/react';
import { useLanguage } from '@/LanguageContext';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Badge } from '@/components/ui/Badge';
import { cn } from '@/lib/utils';
import { useOpenInternalRoute } from '@/lib/navigation';
import { centsToDollars } from '@/features/checkout/api';
import { customerInitials, walkInShowsNoPhone } from '@/lib/displayName';
import { formatPhoneDisplay } from '@/lib/utils';
import { inferHealthFormCategory } from '@/features/forms/formExperience';
import { UNASSIGNED_STAFF_ID } from '@/context/ScheduleContext';
import {
  PRIMARY_ACTION_CLASS, CONTRAINDICATION_NONE, CONTRAINDICATION_TAGS,
  FOCUS_AREA_TAGS, AVOID_AREA_NONE, AVOID_AREA_TAGS,
  AROMA_OIL_OPTIONS, STRENGTH_OPTIONS,
} from '../model';
import type { KanbanItem } from '../model';
import type { DayService, DayStaff } from '@/features/schedule/types';
import type { AppointmentHealthForm } from '@/features/schedule/appointmentDetail';
import type { Language } from '@/i18n';
import type { HealthAiSummary } from '@/features/forms/mockData';

export interface CheckInModalState {
  isOpen: boolean;
  item: KanbanItem | null;
  qrScanned: boolean;
  contraindications: string[];
  massageStrength: string;
  aromaOil: string;
  focusAreas: string[];
  avoidAreas: string[];
  selectedAddOnId: string;
  addOnStaffId: string;
  notes: string;
  /** 本次尝试的幂等键前缀，由页面在打开弹窗时生成。 */
  attemptKey: string;
}

export interface CheckInModalProps {
  state: CheckInModalState;
  services: DayService[];
  staff: DayStaff[];
  /** 该客人最新一份健康问卷（按 isLatest 过滤后的结果）。 */
  completedForms: AppointmentHealthForm[];
  /** 已展开的问卷摘要。为 null 表示尚未选中或还在加载。 */
  aiSummary: HealthAiSummary | null;
  aiSummarySubmissionId: string | null;
  isSummaryLoading: boolean;
  isSummaryFailed: boolean;
  /** 当前界面语言。摘要与问卷标题都是多语字段，需按它取值。 */
  language: Language;
  /** 该卡片已生成的问卷分享链接与二维码。 */
  formShare: { url: string; expiresAt?: string } | undefined;
  errorText: string | null;
  isPending: boolean;
  onChange: React.Dispatch<React.SetStateAction<CheckInModalState>>;
  onConfirm: () => void | Promise<void>;
  onOpenFormQr: (item: KanbanItem) => void | Promise<void>;
  onCopyFormLink: (item: KanbanItem) => void | Promise<void>;
  onPickSummary: (submissionId: string | null) => void;
  onClearError: () => void;
}

export function CheckInModal(props: CheckInModalProps) {
  const {
    state, services, staff, completedForms, aiSummary, aiSummarySubmissionId,
    isSummaryLoading, isSummaryFailed, language, formShare, errorText, isPending,
    onChange, onConfirm, onOpenFormQr, onCopyFormLink, onPickSummary, onClearError,
  } = props;
  const { t } = useLanguage();
  const openInternalRoute = useOpenInternalRoute();
  if (!state.isOpen || !state.item) return null;

  const item = state.item;
  const addOnService = services.find((s) => s.id === state.selectedAddOnId);
  const addOnPriceCents = addOnService ? addOnService.priceCents : 0;
  const totalEstCents = (item.priceCents || 0) + addOnPriceCents;
  const usesMassageIntake = !completedForms[0]
    || inferHealthFormCategory(completedForms[0].templateKey) === 'massage';

  return (
    <Modal
      isOpen={state.isOpen}
      onOpenChange={(open) => {
        if (!open) {
          onChange((prev) => ({ ...prev, isOpen: false, item: null }));
          onPickSummary(null);
          onClearError();
        }
      }}
      isDismissDisabled={isPending}
      title={
        <div className="flex items-center gap-2 text-amber-800 font-bold">
          <UserCheck className="w-5 h-5 text-amber-600" />
          <span>{t('queue.quCheckInTitle')}</span>
        </div>
      }
      size="lg"
      footer={
        <div className="flex justify-end gap-2 w-full">
          <Button
            variant="secondary"
            isDisabled={isPending}
            onClick={() => {
              onChange((prev) => ({ ...prev, isOpen: false, item: null }));
              onPickSummary(null);
              onClearError();
            }}
          >
            {t('queue.quCheckInCancel')}
          </Button>
          <Button
            className={PRIMARY_ACTION_CLASS}
            isDisabled={isPending}
            onPress={onConfirm}
          >
            {isPending
              ? <><Spinner size="sm" />{t('queue.quProcessing')}</>
              : <><Check className="h-4 w-4" />{t('queue.quCheckInConfirmAmount', { p0: centsToDollars(totalEstCents) })}</>}
          </Button>
        </div>
      }
    >
      {/* 高度与滚动交给 Modal.Body 统一管理；此处再套一层会出现双滚动条。 */}
      <div className="space-y-3 py-1 text-sm text-slate-700">
        {/* 1. 顾客基本信息与预约项目概览 */}
        <div className="p-3 bg-amber-50/70 rounded-2xl border border-amber-200 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-amber-600 text-white flex items-center justify-center font-bold text-base shadow-sm">
              {customerInitials(item.customerName)}
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="font-bold text-slate-900 text-sm">{item.customerName}</span>
                {item.phone ? (
                  <Badge variant="warning" className="text-xs font-bold px-1.5 py-0">
                    {formatPhoneDisplay(item.phone)}
                  </Badge>
                ) : walkInShowsNoPhone({ phone: item.phone, customerName: item.customerName }) ? (
                  <Badge variant="warning" className="text-xs font-bold px-1.5 py-0">
                    {t('queue.quWalkInNoPhone')}
                  </Badge>
                ) : null}
                <Badge variant="secondary" className="text-xs font-bold px-1.5 py-0 bg-amber-100 text-amber-900 border-amber-300">
                  {t('queue.quWaitingArea')}
                </Badge>
              </div>
              <span className="text-xs text-slate-600 flex items-center gap-1.5 mt-0.5">
                <span>{t('queue.quCheckInBookedLine', {
                  p0: item.serviceName,
                  p1: item.durationMin,
                  p2: item.staffName || t('queue.quUnspecified'),
                })}</span>
              </span>
            </div>
          </div>
          <div className="text-right">
            <span className="text-xs font-medium text-slate-400 block">{t('queue.quEstimatedAmount')}</span>
            <span className="font-mono font-bold text-amber-900 text-base">
              ${centsToDollars(item.priceCents)}
            </span>
          </div>
        </div>

        {/* 2. 电子健康问卷与身体禁忌排查 */}
        <div className="bg-white p-3.5 rounded-2xl border border-slate-200 space-y-3 shadow-sm">
          <div className="flex items-center justify-between">
            <h4 className="font-bold text-slate-800 uppercase tracking-wider flex items-center gap-1.5">
              <ShieldAlert className="w-3.5 h-3.5 text-sky-600" />
              <span>{t('queue.quIntakeFormTitle')}</span>
            </h4>
            <Badge variant="secondary" className="text-xs bg-sky-50 text-sky-800 border-sky-200">
              {t('queue.quComplianceWaiver')}
            </Badge>
          </div>

          {completedForms.length > 0 && (
            <div className="space-y-3 rounded-2xl border border-emerald-200 bg-emerald-50 p-3">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-start gap-2">
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
                  <div>
                    <p className="text-xs font-bold text-emerald-950">{t('queue.quHealthFormReceived')}</p>
                    <p className="text-xs text-emerald-700">
                      {completedForms.map((form) => form.templateTitle[language] ?? form.templateTitle.en ?? t('queue.quHealthForm')).join(', ')}
                    </p>
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    className="h-8 bg-teal-900 px-3 text-xs font-bold text-white"
                    onPress={() => onPickSummary(
                      aiSummarySubmissionId === completedForms[0]?.submissionId
                        ? null
                        : completedForms[0]?.submissionId ?? null,
                    )}
                  >
                    <Sparkles className="h-3.5 w-3.5" />
                    {t('queue.quAiHealthSummary')}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8 border-emerald-300 bg-white px-3 text-xs font-bold text-emerald-800"
                    onPress={() => {
                      const submissionId = completedForms[0]?.submissionId;
                      if (submissionId) openInternalRoute(`/forms/submissions/${encodeURIComponent(submissionId)}`);
                    }}
                  >
                    <ExternalLink className="h-3.5 w-3.5" />
                    {t('queue.quViewCompletedForm')}
                  </Button>
                </div>
              </div>
              {aiSummarySubmissionId && (
                <div className="rounded-xl border border-teal-700 bg-teal-950 p-3 text-white">
                  <div className="flex items-center gap-2 text-xs font-bold text-teal-100">
                    <Sparkles className="h-3.5 w-3.5 text-teal-300" />
                    {t('schedule.adAiHealthSummary')}
                    <Languages className="ml-auto h-3.5 w-3.5 text-teal-300" />
                  </div>
                  {isSummaryLoading && <div className="mt-3 flex items-center gap-2 text-xs text-teal-100"><Spinner size="sm" />{t('queue.quAiSummaryLoading')}</div>}
                  {isSummaryFailed && <p className="mt-3 text-xs text-rose-200">{t('queue.quAiSummaryFailed')}</p>}
                  {aiSummary && (
                    <div className="mt-3 space-y-2">
                      <p className="text-sm font-semibold text-teal-50">{aiSummary.headline[language] ?? aiSummary.headline.en}</p>
                      {(aiSummary.keyAlerts[language] ?? aiSummary.keyAlerts.en ?? []).length > 0 && (
                        <ul className="list-disc space-y-1 pl-5 text-xs text-teal-100">
                          {(aiSummary.keyAlerts[language] ?? aiSummary.keyAlerts.en).map((alert) => <li key={alert}>{alert}</li>)}
                        </ul>
                      )}
                      <p className="text-xs leading-relaxed text-teal-100">{aiSummary.technicianAdvice[language] ?? aiSummary.technicianAdvice.en}</p>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {completedForms.length === 0 && <div className="p-3.5 bg-sky-50/70 border border-sky-200 rounded-2xl flex flex-col sm:flex-row items-center gap-3.5">
            {/* 可点击放大的真实二维码卡片 */}
            {(() => {
              const intakeUrl = formShare?.url;
              return (
                <>
                  {/* 原为 div + onClick：键盘用户完全够不到，改成真正的按钮。 */}
                  <button
                    type="button"
                    onClick={() => void onOpenFormQr(item)}
                    className="group flex h-20 w-20 shrink-0 flex-col items-center justify-center rounded-2xl border border-sky-300 bg-white p-1.5 transition-colors hover:border-sky-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-600"
                    title={t('queue.quZoomQr')}
                    aria-label={t('queue.quZoomQr')}
                  >
                    {intakeUrl ? <QRCodeSVG value={intakeUrl} size={52} level="M" /> : <QrCode className="h-10 w-10 text-sky-600" />}
                    <span className="mt-0.5 text-xs font-medium text-sky-800 transition-colors group-hover:text-sky-600">
                      {t('queue.quZoomQrHint')}
                    </span>
                  </button>

                  <div className="text-xs space-y-1.5 flex-1 w-full">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-1.5 font-bold text-sky-950">
                        <Tablet className="w-3.5 h-3.5 text-sky-600" />
                        <span>{t('queue.quSignOnDevice')}</span>
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                        void onCopyFormLink(item);
                        }}
                        className="text-xs text-sky-700 hover:text-sky-900 font-bold underline cursor-pointer"
                      >
                        {t('queue.quCopyLink')}
                      </button>
                    </div>
                    <p className="text-slate-600 text-xs leading-relaxed">
                      {t('queue.quIntakeGuide')}
                    </p>
                    <div className="flex items-center justify-between pt-0.5">
                      <label className="flex items-center gap-2 cursor-pointer font-bold text-sky-950 text-xs">
                        <input
                          type="checkbox"
                          checked={state.qrScanned}
                          onChange={(e) => onChange((prev) => ({ ...prev, qrScanned: e.target.checked }))}
                          className="w-3.5 h-3.5 rounded text-sky-600 focus:ring-sky-500/20"
                        />
                        <span>{t('queue.quPaperFormChecked')}</span>
                      </label>
                      <button
                        type="button"
                          onClick={() => void onOpenFormQr(item)}
                        className="text-xs text-sky-700 bg-white hover:bg-sky-50 px-2 py-0.5 border border-sky-300 rounded-lg font-bold shadow-xs"
                      >
                        {t('queue.quFullScreenQr')}
                      </button>
                    </div>
                  </div>
                </>
              );
            })()}
          </div>}

          {/* 禁忌快速排查标签 */}
          <div className={cn(!usesMassageIntake && 'hidden')}>
            <label className="block text-xs font-bold text-slate-700 mb-1.5">
              {t('queue.quContraindicationsHint')}
            </label>
            <div className="flex flex-wrap gap-1.5">
              {CONTRAINDICATION_TAGS.map((option) => {
                const isSelected = state.contraindications.includes(option.id);
                const isSafe = option.id === CONTRAINDICATION_NONE;
                return (
                  <button
                    key={option.id}
                    type="button"
                    aria-pressed={isSelected}
                    onClick={() => {
                      onChange((prev) => {
                        if (isSafe) {
                          return { ...prev, contraindications: [CONTRAINDICATION_NONE] };
                        }
                        const listWithoutSafe = prev.contraindications.filter((c) => c !== CONTRAINDICATION_NONE);
                        const next = listWithoutSafe.includes(option.id)
                          ? listWithoutSafe.filter((c) => c !== option.id)
                          : [...listWithoutSafe, option.id];
                        return {
                          ...prev,
                          contraindications: next.length === 0 ? [CONTRAINDICATION_NONE] : next,
                        };
                      });
                    }}
                    className={cn(
                      'rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors',
                      isSelected
                        ? isSafe
                          ? 'border-emerald-500 bg-emerald-50 font-semibold text-emerald-900'
                          : 'border-rose-500 bg-rose-50 font-semibold text-rose-900'
                        : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50',
                    )}
                  >
                    {isSelected && !isSafe && '⚠️ '}
                    {t(option.labelKey)}
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        {/* 3. 护理偏好与身体部位偏好 */}
        <div className={cn('bg-white p-3.5 rounded-2xl border border-slate-200 space-y-3 shadow-sm', !usesMassageIntake && 'hidden')}>
          <h4 className="font-bold text-slate-800 uppercase tracking-wider flex items-center gap-1.5">
            <Sparkles className="w-3.5 h-3.5 text-teal-600" />
            <span>{t('queue.quPreferencesTitle')}</span>
          </h4>

          {/* 力度选择 */}
          <div>
            <label className="block text-xs font-bold text-slate-700 mb-1">
              {t('queue.quPressurePref')}
            </label>
            <div className="grid grid-cols-5 gap-1.5">
              {STRENGTH_OPTIONS.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  aria-pressed={state.massageStrength === option.id}
                  onClick={() => onChange((prev) => ({ ...prev, massageStrength: option.id }))}
                  className={cn(
                    'rounded-lg border py-1.5 text-center text-xs font-medium transition-colors',
                    state.massageStrength === option.id
                      ? 'border-teal-500 bg-teal-50 font-semibold text-teal-900'
                      : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50',
                  )}
                >
                  {t(option.labelKey)}
                </button>
              ))}
            </div>
          </div>

          {/* 芳香精油 */}
          <div>
            <label className="block text-xs font-bold text-slate-700 mb-1">
              {t('queue.quOilPref')}
            </label>
            <div className="grid grid-cols-3 gap-1.5">
              {AROMA_OIL_OPTIONS.map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => onChange((prev) => ({ ...prev, aromaOil: opt.id }))}
                  aria-pressed={state.aromaOil === opt.id}
                  className={cn(
                    'rounded-lg border p-2 text-left transition-colors',
                    state.aromaOil === opt.id
                      ? 'border-teal-500 bg-teal-50 text-teal-900'
                      : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50',
                  )}
                >
                  <span className="block text-xs font-semibold">{t(opt.labelKey)}</span>
                  <span className="block text-xs text-slate-500">{t(opt.descKey)}</span>
                </button>
              ))}
            </div>
          </div>

          {/* 重点部位 (分左右，可多选) */}
          <div>
            <label className="block text-xs font-bold text-slate-700 mb-1">
              {t('queue.quFocusAreas')}
            </label>
            <div className="flex flex-wrap gap-1.5">
              {FOCUS_AREA_TAGS.map((option) => {
                const isSelected = state.focusAreas.includes(option.id);
                return (
                  <button
                    key={option.id}
                    type="button"
                    aria-pressed={isSelected}
                    onClick={() => {
                      onChange((prev) => ({
                        ...prev,
                        focusAreas: isSelected
                          ? prev.focusAreas.filter((f) => f !== option.id)
                          : [...prev.focusAreas, option.id],
                      }));
                    }}
                    className={cn(
                      'rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors',
                      isSelected
                        ? 'border-teal-500 bg-teal-50 font-semibold text-teal-900'
                        : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50',
                    )}
                  >
                    {isSelected ? '✓ ' : '+ '}
                    {t(option.labelKey)}
                  </button>
                );
              })}
            </div>
          </div>

          {/* 避免触碰敏感部位 */}
          <div>
            <label className="block text-xs font-bold text-rose-900 mb-1 flex items-center gap-1">
              <AlertTriangle className="w-3.5 h-3.5 text-rose-500" />
              <span>{t('queue.quAvoidAreas')}</span>
            </label>
            <div className="flex flex-wrap gap-1.5">
              {AVOID_AREA_TAGS.map((option) => {
                const isSelected = state.avoidAreas.includes(option.id);
                const isNone = option.id === AVOID_AREA_NONE;
                return (
                  <button
                    key={option.id}
                    type="button"
                    aria-pressed={isSelected}
                    onClick={() => {
                      onChange((prev) => {
                        if (isNone) {
                          return { ...prev, avoidAreas: [AVOID_AREA_NONE] };
                        }
                        const listWithoutNone = prev.avoidAreas.filter((a) => a !== AVOID_AREA_NONE);
                        const next = listWithoutNone.includes(option.id)
                          ? listWithoutNone.filter((a) => a !== option.id)
                          : [...listWithoutNone, option.id];
                        return {
                          ...prev,
                          avoidAreas: next.length === 0 ? [AVOID_AREA_NONE] : next,
                        };
                      });
                    }}
                    className={cn(
                      'rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors',
                      isSelected
                        ? isNone
                          ? 'border-slate-400 bg-slate-100 font-semibold text-slate-800'
                          : 'border-rose-500 bg-rose-50 font-semibold text-rose-900'
                        : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50',
                    )}
                  >
                    {isSelected && !isNone && '⛔ '}
                    {t(option.labelKey)}
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        {/* 4. 现场附加加项与指定技师 */}
        <div className="bg-white p-3.5 rounded-2xl border border-slate-200 space-y-2.5 shadow-sm">
          <h4 className="font-bold text-slate-800 uppercase tracking-wider flex items-center gap-1.5">
            <Plus className="w-3.5 h-3.5 text-teal-600" />
            <span>{t('queue.quAddOnTitle')}</span>
          </h4>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">{t('queue.quSelectAddOn')}</label>
              <select
                value={state.selectedAddOnId}
                onChange={(e) => onChange((prev) => ({ ...prev, selectedAddOnId: e.target.value }))}
                className="w-full px-2.5 py-1.5 text-xs rounded-xl border border-slate-200 bg-white font-medium text-slate-900"
              >
                <option value="">{t('queue.quNoAddOn')}</option>
                {services.map((s) => (
                  <option key={s.id} value={s.id}>
                    + {s.categoryName ? `${s.categoryName} · ` : ''}{s.name} (${centsToDollars(s.priceCents)} · {s.durationMin}m)
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">{t('queue.quAddOnStaff')}</label>
              <select
                value={state.addOnStaffId}
                onChange={(e) => onChange((prev) => ({ ...prev, addOnStaffId: e.target.value }))}
                className="w-full px-2.5 py-1.5 text-xs rounded-xl border border-slate-200 bg-white font-medium text-slate-900"
              >
                <option value="">{t('queue.quFollowLeadStaffOf', { p0: item.staffName || t('queue.quStaffUnassignedShort') })}</option>
                {staff
                  .filter((s) => s.membershipId !== UNASSIGNED_STAFF_ID && s.isBookable)
                  .map((s) => (
                    <option key={s.membershipId} value={s.membershipId}>
                      {s.name}
                    </option>
                  ))}
              </select>
            </div>
          </div>
        </div>

        {/* 5. 前台特别叮嘱备注 */}
        <div>
          <label className="block text-xs font-bold text-slate-700 mb-1">
            {t('queue.quGuestNotes')}
          </label>
          <Input
            value={state.notes}
            onChange={(e) => onChange((prev) => ({ ...prev, notes: e.target.value }))}
            placeholder={t('queue.quGuestNotePlaceholder')}
            className="text-xs"
          />
        </div>

        {errorText && (
          <div role="alert" className="sticky bottom-0 rounded-xl border border-rose-300 bg-rose-50 px-3 py-2.5 text-xs font-semibold leading-relaxed text-rose-800 shadow-sm">
            <div className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{errorText}</span>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
