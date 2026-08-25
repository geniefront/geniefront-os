/**
 * 开单 —— 选项目 → 确认 → 走 appointment.create 命令。
 *
 * 这一屏最要紧的是【超卖放行的交互】（决策 17）：
 *   软约束撞上时后端返回 STAFF_OVER_CAPACITY / LOCATION_OVER_CAPACITY，
 *   前台不是被拦住，而是被要求**说明原因**然后放行。
 *   资源硬冲突（房间被占）则没有放行入口 —— 那是物理上不可能的事。
 *
 * 原因不是走过场：决策 12 要求轮牌与排期的每一次人工干预都留可解释的流水，
 * 这是杜绝技师之间"前台偏心"猜忌的唯一办法。
 */

import { useState } from 'react';
import { ApiError, runCommand } from '../lib/api';
import type { makeT } from '../i18n';
import type { DaySnapshot } from './DaySchedule';
import { Button } from '../ui/Button';
import { Field } from '../ui/Field';
import { Card } from '../ui/Card';
import { Spinner } from '../ui/Spinner';

/** 与后端 overrideReason 枚举一一对应 */
const REASONS: Array<{ v: string; label: string; hint: string }> = [
  { v: 'walk_in_stacking',  label: '堆叠等位', hint: '客人到店泡脚等着，这是常态' },
  { v: 'guest_requested',   label: '客人指定', hint: '点名要这位技师，愿意等' },
  { v: 'staff_on_break',    label: '技师暂休', hint: '短暂离开，回来接得上' },
  { v: 'desk_coordination', label: '前台协调', hint: '我已经和技师说好了' },
  { v: 'other',             label: '其他',     hint: '需要写清楚' },
];

const money = (c: number) => `$${(c / 100).toFixed(0)}`;
const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

export function BookSheet({
  day, membershipId, staffId, startMin, customer, t, onDone, onCancel,
  fromCallDraft,
}: {
  day: DaySnapshot;
  membershipId: string;
  staffId: string;
  startMin: number;
  customer: { id: string; displayName: string } | null;
  t: ReturnType<typeof makeT>;
  onDone: () => void | Promise<void>;
  onCancel: () => void;
  /**
   * 从来电复核队列过来的（09 §4.2）。
   *
   * 建单这一步**故意**没有走捷径：AI 的草案只是把项目预选上、
   * 把客人原话摆在眼前，最后落的还是同一条 `appointment.create`，
   * 容量检查、超卖放行、审计一样不少。
   */
  fromCallDraft?: {
    draftId: string;
    serviceId: string | null;
    serviceHeard: string | null;
    timeHeard: string | null;
  } | undefined;
}) {
  const staff = day.staff.find((s) => s.membershipId === staffId);
  const [serviceId, setServiceId] = useState<string>(
    fromCallDraft?.serviceId ?? day.services[0]?.id ?? '');
  const [busy, setBusy] = useState(false);
  const [issue, setIssue] = useState<ApiError | null>(null);
  const [reason, setReason] = useState<string>('');
  const [note, setNote] = useState('');
  const [hardError, setHardError] = useState<string>('');

  const service = day.services.find((s) => s.id === serviceId);

  // 门店本地墙上时间 → UTC 时刻
  function startsAtIso(): string {
    const [y, mo, d] = day.businessDate.split('-').map(Number);
    // 先按 UTC 猜，再用该时区的实际偏移修正（DST 当天也成立）
    let guess = Date.UTC(y!, mo! - 1, d!, Math.floor(startMin / 60), startMin % 60);
    for (let i = 0; i < 2; i++) {
      const p = new Intl.DateTimeFormat('en-US', {
        timeZone: day.timezone, year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
      }).formatToParts(new Date(guess));
      const g = (k: string) => Number(p.find((x) => x.type === k)?.value);
      const actual = Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'));
      guess += Date.UTC(y!, mo! - 1, d!, Math.floor(startMin / 60), startMin % 60) - actual;
    }
    return new Date(guess).toISOString();
  }

  async function submit(withOverride: boolean) {
    setBusy(true); setHardError('');
    try {
      await runCommand('appointment.create', {
        customerId: customer?.id ?? null,
        ...(customer ? {} : { walkInName: '临时客人' }),
        items: [{ serviceId, membershipId: staffId, startsAt: startsAtIso() }],
        source: 'desk',
        ...(withOverride ? { override: { reason, ...(note ? { note } : {}) } } : {}),
      }, membershipId);
      // 等父级刷完日程表再解除 busy —— 中间这段时间按钮保持转圈，
      // 不给前台留下"点了没反应"的空档
      await onDone();
    } catch (e) {
      if (e instanceof ApiError && e.overridable) {
        setIssue(e);                 // 软约束：让前台说明原因后放行
      } else if (e instanceof ApiError && e.code === 'RESOURCE_CONFLICT') {
        setHardError('这个房间/座位在该时段已被占用，换一个或改时间');
      } else if (e instanceof ApiError && e.code === 'STAFF_NOT_BOOKABLE') {
        setHardError('这位不接客（前台/老板），换一位技师');
      } else {
        setHardError(t('common.error'));
      }
    } finally { setBusy(false); }
  }

  const overCap = issue?.code === 'STAFF_OVER_CAPACITY';

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(20,18,16,.45)',
      display: 'grid', placeItems: 'end center', zIndex: 50,
    }} onClick={onCancel}>
      <Card className="flex flex-col gap-3" onClick={(e) => e.stopPropagation()}
           style={{ width: 'min(620px, 100%)', maxHeight: '92vh', overflow: 'auto',
                    padding: 24, gap: 18, borderRadius: '18px 18px 0 0' }}>

        <div className="flex flex-col gap-0.5">
          <div className="text-2xl font-extrabold">
            {customer?.displayName ?? '临时客人'}
          </div>
          <div className="text-ink-2">
            {staff?.name} · {hhmm(startMin)}
            {service ? ` · ${service.durationMin} 分钟` : ''}
          </div>
        </div>

        {/* 从来电草案过来时，把客人的原话摆在眼前 ——
            AI 匹配的项目可能是对的，也可能把 "gel removal" 听成了 "gel manicure"。
            原话在这里，前台选项目时一眼能对上 */}
        {fromCallDraft && (fromCallDraft.serviceHeard || fromCallDraft.timeHeard) && (
          <Card className="flex flex-col gap-1" style={{ padding: 12,  background: 'var(--brand-soft)', borderColor: 'var(--brand)' }}>
            <span className="text-xs text-ink-3"><strong>☎️ 电话里客人说的：</strong></span>
            {fromCallDraft.serviceHeard && (
              <span className="text-xs text-ink-3">项目：「{fromCallDraft.serviceHeard}」</span>
            )}
            {fromCallDraft.timeHeard && (
              <span className="text-xs text-ink-3">时间：「{fromCallDraft.timeHeard}」</span>
            )}
          </Card>
        )}

        {/* 项目：大按钮网格，不用下拉框 */}
        <div className="flex flex-col gap-2">
          <div className="text-xs text-ink-3">选项目</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 10 }}>
            {day.services.map((s) => (
              <button key={s.id} onClick={() => setServiceId(s.id)}
                      className="min-h-tap rounded border border-line-2 bg-surface px-5 text-base font-semibold cursor-pointer hoverable:hover:bg-sunken gap-0.5" style={{ minHeight: 68, flexDirection: 'column',  padding: '10px 14px',
                        borderWidth: 2,
                        borderColor: s.id === serviceId ? 'var(--brand)' : 'var(--line)',
                        background: s.id === serviceId ? 'var(--brand-soft)' : 'var(--surface)' }}>
                <span className="truncate text-base">{s.name}</span>
                <span className="text-xs text-ink-3">{s.durationMin} 分钟 · {money(s.priceCents)}</span>
              </button>
            ))}
          </div>
        </div>

        {hardError && (
          <Card role="alert"
               style={{ padding: 14, background: 'var(--danger-soft)', borderColor: 'var(--danger)' }}>
            <span className="text-danger font-bold">✕ {hardError}</span>
          </Card>
        )}

        {/* ── 软约束：不拦，但要说明原因 ─────────────────────────────────── */}
        {issue && (
          <Card className="flex flex-col gap-3" role="alert" style={{ padding: 16, gap: 12, background: 'var(--warn-soft)', borderColor: 'var(--warn)' }}>
            <div className="flex items-center gap-2.5 items-start">
              <span aria-hidden style={{ fontSize: 24 }}>⚠️</span>
              <div className="min-w-0 flex-1">
                <div className="font-extrabold text-warn text-lg">
                  {overCap
                    ? `${staff?.name} 这个时段已经排满了`
                    : '这个时段全店已经排满了'}
                </div>
                <div className="text-xs text-ink-3 text-warn">
                  可以继续排 —— 选个原因，会记进流水（谁排的、几点、为什么）
                </div>
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px,1fr))', gap: 8 }}>
              {REASONS.map((r) => (
                <Button key={r.v} onClick={() => setReason(r.v)}
                        style={{
                          minHeight: 60, flexDirection: 'column', gap: 1, borderWidth: 2,
                          borderColor: reason === r.v ? 'var(--warn)' : 'var(--line)',
                          background: reason === r.v ? '#fff' : 'transparent',
                        }}>
                  <span>{r.label}</span>
                  <span className="text-xs text-ink-3">{r.hint}</span>
                </Button>
              ))}
            </div>

            {reason === 'other' && (
              <Field  placeholder="写清楚原因" value={note}
                     onChange={(e) => setNote(e.target.value)} autoFocus />
            )}

            <Button variant="primary" block disabled={busy || !reason || (reason === 'other' && !note.trim())} onClick={() => void submit(true)}>
              {busy ? <Spinner /> : '仍然排这一单'}
            </Button>
          </Card>
        )}

        {!issue && (
          <div className="flex items-center gap-3">
            <Button className="min-w-0 flex-1" onClick={onCancel} disabled={busy}>{t('common.cancel')}</Button>
            <Button variant="primary" className="min-w-0 flex-1" disabled={busy || !serviceId} onClick={() => void submit(false)}>
              {busy ? <Spinner /> : '开单'}
            </Button>
          </div>
        )}
      </Card>
    </div>
  );
}
