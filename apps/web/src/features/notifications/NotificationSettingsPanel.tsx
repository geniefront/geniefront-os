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
import {
  useNotificationSettings,
  useToggleNotificationRule,
  useSaveNotificationTemplate,
  useSaveMarketingHoliday,
  useDeleteMarketingHoliday,
  type NotifyChannel,
  type NotificationSettings,
} from './settingsApi';

/** 事件分三组显示。与 `packages/contracts/src/notification.ts` 的分组一致。 */
const GROUPS: Array<{ title: string; hint: string; events: string[] }> = [
  {
    title: '顾客 · 预约',
    hint: '走平台品牌，不受门店 10DLC 状态影响 —— 任何时候都发得出去。',
    events: [
      'appointment_confirm', 'appointment_changed',
      'appointment_cancelled', 'appointment_reminder',
    ],
  },
  {
    title: '技师',
    hint: '同属事务性通知，也走平台品牌。收件人是员工不改变这一点。',
    events: ['staff_pending_confirm', 'staff_assigned', 'staff_changed', 'staff_cancelled'],
  },
  {
    title: '营销',
    hint: '商业信息。要门店自己的 10DLC 获批（短信）与专属发件域名（邮件），且顾客必须明示订阅过。',
    events: ['birthday', 'holiday', 'winback', 'review_request'],
  },
];

const EVENT_LABEL: Record<string, string> = {
  appointment_confirm: '预约确认',
  appointment_changed: '预约修改',
  appointment_cancelled: '预约取消',
  appointment_reminder: '次日提醒',
  staff_pending_confirm: '待技师确认',
  staff_assigned: '派单给技师',
  staff_changed: '技师班次变动',
  staff_cancelled: '技师单被取消',
  birthday: '生日祝福',
  holiday: '节日问候',
  winback: '老顾客唤回',
  review_request: '邀请评价',
};

const CHANNEL_LABEL: Record<NotifyChannel, string> = { sms: '短信', email: '邮件' };

export function NotificationSettingsPanel() {
  const errorMessage = useErrorMessage();
  const q = useNotificationSettings();
  const toggle = useToggleNotificationRule();
  const saveTemplate = useSaveNotificationTemplate();
  const saveHoliday = useSaveMarketingHoliday();
  const deleteHoliday = useDeleteMarketingHoliday();

  const [editing, setEditing] = useState<{ eventKey: string; channel: NotifyChannel } | null>(null);
  const [draft, setDraft] = useState({ subject: '', body: '' });
  const [newHoliday, setNewHoliday] = useState({ name: '', sendOn: '' });

  if (q.isLoading) return <p className="text-sm text-slate-500">Loading…</p>;
  const d = q.data;
  if (!d) return <p className="text-sm text-red-600">读取失败。</p>;

  const smsOpen = d.gates.tenDlcStatus === 'approved';
  const emailOpen = Boolean(d.gates.marketingEmailFrom);
  const isMarketing = (e: string) => d.marketingEvents.includes(e);

  /** 这个事件的这个渠道现在通不通。返回 null = 通。 */
  function blockedReason(eventKey: string, channel: NotifyChannel): string | null {
    if (!isMarketing(eventKey)) return null;
    if (channel === 'sms' && !smsOpen) {
      return `门店 10DLC 还是「${d!.gates.tenDlcStatus}」，营销短信一条都不会发出去`;
    }
    if (channel === 'email' && !emailOpen) {
      return '还没配专属发件域名，营销邮件一封都不会发出去';
    }
    return null;
  }

  function templateFor(eventKey: string, channel: NotifyChannel) {
    return d!.templates.find(
      (t) => t.eventKey === eventKey && t.channel === channel && t.locale === 'en');
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
      {/* ── 闸门状态：这一页最要紧的一半 ─────────────────────────── */}
      <div className="rounded-xl border border-slate-200 bg-white p-4 space-y-2">
        <h3 className="text-sm font-bold text-slate-900">营销消息的两道闸门</h3>
        <p className="text-xs text-slate-500">
          预约类与技师类不受这两道限制，任何时候都在发。下面这两道只管营销。
        </p>
        <GateRow
          ok={smsOpen}
          label="营销短信 · 门店 10DLC"
          detail={smsOpen ? '已获批，营销短信可发' : `当前状态：${d.gates.tenDlcStatus} —— 未获批之前一条都不发`}
        />
        <GateRow
          ok={emailOpen}
          label="营销邮件 · 专属发件域名"
          detail={emailOpen
            ? `已就绪：${d.gates.marketingEmailFrom}`
            : '还没配 —— 未配之前一封都不发'}
        />
        <p className="text-xs text-slate-500 pt-1">
          另外两条恒定生效：顾客必须<strong>明示订阅</strong>过营销；营销短信只在门店本地
          {' '}{d.gates.quietHours.start}:00–{d.gates.quietHours.end}:00 之间投递。
        </p>
      </div>

      {/* ── 12 个事件 ─────────────────────────────────────────────── */}
      {GROUPS.map((group) => (
        <div key={group.title} className="rounded-xl border border-slate-200 bg-white p-4">
          <h3 className="text-sm font-bold text-slate-900">{group.title}</h3>
          <p className="text-xs text-slate-500 mt-0.5 mb-3">{group.hint}</p>

          <div className="space-y-2">
            {group.events.map((eventKey) => {
              const rule = d.rules.find((r) => r.eventKey === eventKey);
              if (!rule) return null;
              return (
                <div key={eventKey} className="border-t border-slate-100 pt-2">
                  <div className="flex flex-wrap items-center gap-3">
                    <span className="text-sm font-medium text-slate-900 w-32 shrink-0">
                      {EVENT_LABEL[eventKey] ?? eventKey}
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
                            {CHANNEL_LABEL[channel]}
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
                            {tpl ? '改文案' : '无模板'}
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
                          toast.success('已保存新版本');
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
          <h3 className="text-sm font-bold text-slate-900">节日日程</h3>
          <p className="text-xs text-slate-500 mt-0.5">
            生日、唤回、求评的时机系统能自己推出来；节日不能 —— 哪一天、叫什么，
            要在这里定。名字会直接出现在顾客收到的文案里，所以用英文。
            <strong>同一天只能有一个。</strong>
          </p>
        </div>

        {d.holidays.length === 0 ? (
          <p className="text-xs text-slate-400">还没有节日日程。</p>
        ) : (
          <div className="space-y-1">
            {d.holidays.map((h) => (
              <div key={h.id} className="flex items-center gap-3 text-sm py-1 border-b border-slate-100 last:border-b-0">
                <span className="font-mono text-slate-600 w-28 shrink-0">{h.sendOn}</span>
                <span className="text-slate-900 flex-1">{h.name}</span>
                <span className={`text-xs ${h.enabled ? 'text-teal-700' : 'text-slate-400'}`}>
                  {h.enabled ? '启用' : '停用'}
                </span>
                <button
                  type="button"
                  className="text-slate-400 hover:text-red-600"
                  aria-label={`删除 ${h.name}`}
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
            添加
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
  const { variables, channel, draft, setDraft, pending } = props;
  return (
    <div className="mt-2 rounded-lg border border-slate-200 bg-slate-50 p-3 space-y-2">
      {channel === 'email' ? (
        <input
          value={draft.subject}
          onChange={(e) => setDraft({ ...draft, subject: e.target.value })}
          placeholder="邮件标题"
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
        可用变量：{variables.map((v) => `{{${v}}}`).join('  ')}
        <br />
        不认识的变量会渲染成空字符串，不会把花括号发给顾客。
      </p>
      {channel === 'sms' ? (
        <p className="text-xs text-slate-500">
          ⚠️ 品牌署名与退订说明由系统自动补，不用写进模板 —— 那两项是合规要求，
          不能被编辑掉。正文请只用英文：一个中文字符就会让整条短信的容量从 160
          掉到 70，费用翻倍而顾客看到的完全一样。
        </p>
      ) : null}
      <div className="flex gap-2">
        <button
          type="button"
          disabled={pending || !draft.body.trim()}
          onClick={() => void props.onSave()}
          className="rounded-lg bg-teal-600 text-white px-3 py-1.5 text-sm disabled:opacity-50"
        >
          {pending ? '保存中…' : '保存为新版本'}
        </button>
        <button
          type="button"
          onClick={props.onCancel}
          className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
        >
          取消
        </button>
      </div>
    </div>
  );
}
