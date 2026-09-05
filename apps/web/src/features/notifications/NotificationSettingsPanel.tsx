/**
 * 外发通知的设置面板。
 *
 * ## 这一页最容易产生的误解
 *
 * 店主把一个开关打开，以为顾客就会收到。而实际上后面还有几道闸门 ——
 * 10DLC 未获批、发件域名未验证、顾客没订阅营销、不在静默时段之内 ——
 * 任何一道不通都一条也发不出去，**而且不会报错**。
 *
 * 因此每一个开关旁边直接写出它现在通不通。只给开关不给闸门状态的话，
 * 店主打开之后唯一能得到的反馈是「什么也没发生」。
 */

import { useState } from 'react';
import { toast } from '@heroui/react';
import { AlertTriangle, CheckCircle2, Trash2 } from 'lucide-react';
import { useErrorMessage } from '@/lib/errorMessage';
import { useLanguage } from '@/LanguageContext';
import type { TranslationKey } from '@/i18n';
import {
  useNotificationSettings,
  useToggleNotificationRule,
  useSaveNotificationTemplate,
  useSaveMarketingHoliday,
  useDeleteMarketingHoliday,
  type NotifyChannel,
  type NotificationSettings,
} from './settingsApi';

/**
 * 事件分三组显示。与 `packages/contracts/src/notification.ts` 的分组一致。
 * title/hint 只存词典键——这块面板以前完全没有接入 useLanguage，不跟界面语言走。
 */
const GROUPS: Array<{ titleKey: TranslationKey; hintKey: TranslationKey; events: string[] }> = [
  {
    titleKey: 'settings.notifGroupCustomerTitle',
    hintKey: 'settings.notifGroupCustomerHint',
    events: [
      'appointment_confirm', 'appointment_changed',
      'appointment_cancelled', 'appointment_reminder',
    ],
  },
  {
    titleKey: 'settings.notifGroupStaffTitle',
    hintKey: 'settings.notifGroupStaffHint',
    events: ['staff_pending_confirm', 'staff_assigned', 'staff_changed', 'staff_cancelled'],
  },
  {
    titleKey: 'settings.notifGroupMarketingTitle',
    hintKey: 'settings.notifGroupMarketingHint',
    events: ['birthday', 'holiday', 'winback', 'review_request'],
  },
];

const EVENT_LABEL_KEYS: Record<string, TranslationKey> = {
  appointment_confirm: 'settings.notifEventApptConfirm',
  appointment_changed: 'settings.notifEventApptChanged',
  appointment_cancelled: 'settings.notifEventApptCancelled',
  appointment_reminder: 'settings.notifEventApptReminder',
  staff_pending_confirm: 'settings.notifEventStaffPending',
  staff_assigned: 'settings.notifEventStaffAssigned',
  staff_changed: 'settings.notifEventStaffChanged',
  staff_cancelled: 'settings.notifEventStaffCancelled',
  birthday: 'settings.notifEventBirthday',
  holiday: 'settings.notifEventHoliday',
  winback: 'settings.notifEventWinback',
  review_request: 'settings.notifEventReviewRequest',
};

const CHANNEL_LABEL_KEYS: Record<NotifyChannel, TranslationKey> = {
  sms: 'settings.notifChannelSms',
  email: 'settings.notifChannelEmail',
};

export function NotificationSettingsPanel() {
  const errorMessage = useErrorMessage();
  const { t } = useLanguage();
  const q = useNotificationSettings();
  const toggle = useToggleNotificationRule();
  const saveTemplate = useSaveNotificationTemplate();
  const saveHoliday = useSaveMarketingHoliday();
  const deleteHoliday = useDeleteMarketingHoliday();

  const [editing, setEditing] = useState<{ eventKey: string; channel: NotifyChannel } | null>(null);
  const [draft, setDraft] = useState({ subject: '', body: '' });
  const [newHoliday, setNewHoliday] = useState({ name: '', sendOn: '' });

  if (q.isLoading) return <p className="text-sm text-slate-500">{t('loading')}</p>;
  const d = q.data;
  if (!d) return <p className="text-sm text-red-600">{t('settings.notifLoadFailed')}</p>;

  const smsOpen = d.gates.tenDlcStatus === 'approved';
  const emailOpen = Boolean(d.gates.marketingEmailFrom);
  const isMarketing = (e: string) => d.marketingEvents.includes(e);

  /** 这个事件的这个渠道现在通不通。返回 null = 通。 */
  function blockedReason(eventKey: string, channel: NotifyChannel): string | null {
    if (!isMarketing(eventKey)) return null;
    if (channel === 'sms' && !smsOpen) {
      return t('settings.notifSmsBlockedByTenDlc', { p0: d!.gates.tenDlcStatus });
    }
    if (channel === 'email' && !emailOpen) {
      return t('settings.notifEmailBlockedNoDomain');
    }
    return null;
  }

  function templateFor(eventKey: string, channel: NotifyChannel) {
    return d!.templates.find(
      (tpl) => tpl.eventKey === eventKey && tpl.channel === channel && tpl.locale === 'en');
  }

  async function onToggleChannel(
    rule: NotificationSettings['rules'][number], channel: NotifyChannel,
  ) {
    const next = rule.channels.includes(channel)
      ? rule.channels.filter((c) => c !== channel)
      : [...rule.channels, channel];
    try {
      await toggle.mutateAsync({
        eventKey: rule.eventKey,
        // 一个渠道都不留就等于关掉这条规则
        enabled: next.length > 0,
        channels: next,
        offsetMin: rule.offsetMin,
      });
    } catch (e) {
      toast.danger(errorMessage(e));
    }
  }

  return (
    <div className="space-y-6">
      <button type="button" className="min-h-14 rounded-xl border p-4" onClick={()=>toast.info(t('email.comingSoon'))}>{t('email.comingSoon')}</button>
      {/* ── 闸门状态：这一页最要紧的一半 ─────────────────────────── */}
      <div className="rounded-xl border border-slate-200 bg-white p-4 space-y-2">
        <h3 className="text-sm font-bold text-slate-900">{t('settings.notifGatesTitle')}</h3>
        <p className="text-xs text-slate-500">
          {t('settings.notifGatesDesc')}
        </p>
        <GateRow
          ok={smsOpen}
          label={t('settings.notifSmsGateLabel')}
          detail={smsOpen ? t('settings.notifSmsGateOpen') : t('settings.notifSmsGateClosed', { p0: d.gates.tenDlcStatus })}
        />
        <GateRow
          ok={emailOpen}
          label={t('settings.notifEmailGateLabel')}
          detail={emailOpen
            ? t('settings.notifEmailGateOpen', { p0: d.gates.marketingEmailFrom ?? '' })
            : t('settings.notifEmailGateClosed')}
        />
        <p className="text-xs text-slate-500 pt-1">
          {t('settings.notifAlwaysOnRule')}<strong>{t('settings.notifOptInEmphasis')}</strong>{t('settings.notifAlwaysOnRuleMid')}
          {' '}{d.gates.quietHours.start}:00–{d.gates.quietHours.end}:00{t('settings.notifQuietHoursSuffix')}
        </p>
      </div>

      {/* ── 12 个事件 ─────────────────────────────────────────────── */}
      {GROUPS.filter(group=>!group.events.includes('birthday')).map((group) => (
        <div key={group.titleKey} className="rounded-xl border border-slate-200 bg-white p-4">
          <h3 className="text-sm font-bold text-slate-900">{t(group.titleKey)}</h3>
          <p className="text-xs text-slate-500 mt-0.5 mb-3">{t(group.hintKey)}</p>

          <div className="space-y-2">
            {group.events.map((eventKey) => {
              const rule = d.rules.find((r) => r.eventKey === eventKey);
              if (!rule) return null;
              return (
                <div key={eventKey} className="border-t border-slate-100 pt-2">
                  <div className="flex flex-wrap items-center gap-3">
                    <span className="text-sm font-medium text-slate-900 w-32 shrink-0">
                      {EVENT_LABEL_KEYS[eventKey] ? t(EVENT_LABEL_KEYS[eventKey]!) : eventKey}
                    </span>
                    {(['sms', 'email'] as NotifyChannel[]).map((channel) => {
                      const on = rule.channels.includes(channel);
                      const blocked = blockedReason(eventKey, channel);
                      const tpl = templateFor(eventKey, channel);
                      return (
                        <div key={channel} className="flex items-center gap-1.5">
                          <label className="flex items-center gap-1.5 cursor-pointer text-sm text-slate-700">
                            <input
                              type="checkbox"
                              checked={on}
                              disabled={toggle.isPending}
                              onChange={() => void onToggleChannel(rule, channel)}
                              className="rounded border-slate-300 text-teal-600 focus:ring-teal-500 w-4 h-4"
                            />
                            {t(CHANNEL_LABEL_KEYS[channel])}
                          </label>
                          <button
                            type="button"
                            className="text-xs text-teal-700 hover:underline disabled:text-slate-300"
                            disabled={!tpl}
                            onClick={() => {
                              if (!tpl) return;
                              setEditing({ eventKey, channel });
                              setDraft({ subject: tpl.subject ?? '', body: tpl.body });
                            }}
                          >
                            {tpl ? t('settings.notifEditTemplate') : t('settings.notifNoTemplate')}
                          </button>
                          {on && blocked ? (
                            <span className="text-xs text-amber-700">⚠️ {blocked}</span>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>

                  {editing?.eventKey === eventKey && editing.channel ? (
                    <TemplateEditor
                      variables={d.variables[eventKey] ?? []}
                      channel={editing.channel}
                      draft={draft}
                      setDraft={setDraft}
                      pending={saveTemplate.isPending}
                      onCancel={() => setEditing(null)}
                      onSave={async () => {
                        try {
                          await saveTemplate.mutateAsync({
                            eventKey,
                            channel: editing.channel,
                            locale: 'en',
                            subject: editing.channel === 'email' ? draft.subject : null,
                            body: draft.body,
                            active: true,
                          });
                          setEditing(null);
                          toast.success(t('settings.notifTemplateSaved'));
                        } catch (e) {
                          toast.danger(errorMessage(e));
                        }
                      }}
                    />
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>
      ))}

      {/* ── 节日日程 ──────────────────────────────────────────────── */}
      <div className="rounded-xl border border-slate-200 bg-white p-4 space-y-3">
        <div>
          <h3 className="text-sm font-bold text-slate-900">{t('settings.notifHolidayScheduleTitle')}</h3>
          <p className="text-xs text-slate-500 mt-0.5">
            {t('settings.notifHolidayScheduleDesc')}
            {' '}<strong>{t('settings.notifHolidayOnePerDay')}</strong>
          </p>
        </div>

        {d.holidays.length === 0 ? (
          <p className="text-xs text-slate-400">{t('settings.notifNoHolidays')}</p>
        ) : (
          <div className="space-y-1">
            {d.holidays.map((h) => (
              <div key={h.id} className="flex items-center gap-3 text-sm py-1 border-b border-slate-100 last:border-b-0">
                <span className="font-mono text-slate-600 w-28 shrink-0">{h.sendOn}</span>
                <span className="text-slate-900 flex-1">{h.name}</span>
                <span className={`text-xs ${h.enabled ? 'text-teal-700' : 'text-slate-400'}`}>
                  {h.enabled ? t('settings.notifHolidayEnabled') : t('settings.notifHolidayDisabled')}
                </span>
                <button
                  type="button"
                  className="text-slate-400 hover:text-red-600"
                  aria-label={t('settings.notifDeleteHolidayAria', { p0: h.name })}
                  disabled={deleteHoliday.isPending}
                  onClick={async () => {
                    try {
                      await deleteHoliday.mutateAsync({ holidayId: h.id });
                    } catch (e) {
                      toast.danger(errorMessage(e));
                    }
                  }}
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2 pt-1">
          <input
            type="date"
            value={newHoliday.sendOn}
            onChange={(e) => setNewHoliday((v) => ({ ...v, sendOn: e.target.value }))}
            className="rounded-lg border border-slate-300 px-2 py-1 text-sm"
          />
          <input
            value={newHoliday.name}
            onChange={(e) => setNewHoliday((v) => ({ ...v, name: e.target.value }))}
            placeholder="Thanksgiving"
            className="rounded-lg border border-slate-300 px-2 py-1 text-sm w-56"
          />
          <button
            type="button"
            disabled={!newHoliday.name.trim() || !newHoliday.sendOn || saveHoliday.isPending}
            className="rounded-lg bg-slate-900 text-white px-3 py-1.5 text-sm disabled:opacity-50"
            onClick={async () => {
              try {
                await saveHoliday.mutateAsync({
                  name: newHoliday.name.trim(),
                  sendOn: newHoliday.sendOn,
                  enabled: true,
                });
                setNewHoliday({ name: '', sendOn: '' });
              } catch (e) {
                toast.danger(errorMessage(e));
              }
            }}
          >
            {t('settings.notifAddHoliday')}
          </button>
        </div>
      </div>
    </div>
  );
}

function GateRow({ ok, label, detail }: { ok: boolean; label: string; detail: string }) {
  return (
    <div className="flex items-start gap-2 text-sm">
      {ok
        ? <CheckCircle2 className="w-4 h-4 text-teal-600 shrink-0 mt-0.5" />
        : <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />}
      <div>
        <span className="font-medium text-slate-900">{label}</span>
        <span className="text-slate-500"> — {detail}</span>
      </div>
    </div>
  );
}

/**
 * 模板编辑器。
 *
 * ⚠️ 只编辑英语那一版：顾客侧的邮件与短信恒为英语
 * （`apps/api/src/email/render.ts` 的语言策略）。
 *
 * ⚠️ 保存是**新增一个版本**，不是原地改 —— 队列里可能还有引用旧版本的
 * 消息，那些必须按当初的措辞发出去。
 */
function TemplateEditor(props: {
  variables: string[];
  channel: NotifyChannel;
  draft: { subject: string; body: string };
  setDraft: (v: { subject: string; body: string }) => void;
  pending: boolean;
  onCancel: () => void;
  onSave: () => void | Promise<void>;
}) {
  const { t } = useLanguage();
  const { variables, channel, draft, setDraft, pending } = props;
  return (
    <div className="mt-2 rounded-lg border border-slate-200 bg-slate-50 p-3 space-y-2">
      {channel === 'email' ? (
        <input
          value={draft.subject}
          onChange={(e) => setDraft({ ...draft, subject: e.target.value })}
          placeholder={t('settings.notifEmailSubjectPlaceholder')}
          className="w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm"
        />
      ) : null}
      <textarea
        value={draft.body}
        onChange={(e) => setDraft({ ...draft, body: e.target.value })}
        rows={channel === 'sms' ? 3 : 8}
        className="w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm font-mono"
      />
      <p className="text-xs text-slate-500">
        {t('settings.notifAvailableVariables', { p0: variables.map((v) => `{{${v}}}`).join('  ') })}
        <br />
        {t('settings.notifUnknownVariableNote')}
      </p>
      {channel === 'sms' ? (
        <p className="text-xs text-slate-500">
          {t('settings.notifSmsTemplateWarning')}
        </p>
      ) : null}
      <div className="flex gap-2">
        <button
          type="button"
          disabled={pending || !draft.body.trim()}
          onClick={() => void props.onSave()}
          className="rounded-lg bg-teal-600 text-white px-3 py-1.5 text-sm disabled:opacity-50"
        >
          {pending ? t('settings.notifSaving') : t('settings.notifSaveNewVersion')}
        </button>
        <button
          type="button"
          onClick={props.onCancel}
          className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
        >
          {t('settings.notifCancel')}
        </button>
      </div>
    </div>
  );
}
