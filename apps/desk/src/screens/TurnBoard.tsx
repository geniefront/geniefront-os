/**
 * 轮牌板 —— 这个产品最核心、也是竞品完全没有的一屏。
 *
 * 它要同时服务两类人：
 *   前台 —— 一眼看出该叫谁，能在两秒内改派并留下原因
 *   技师 —— 抬头看墙上就知道轮到谁了，被跳过时能问清楚为什么
 *
 * 所以每个人都带「为什么排在这里」的解释和事件流水（决策 12）。
 * 门店里的矛盾大多不是算错了，是没人能说清算法为什么这么排。
 */

import { useState } from 'react';
import {
  Star, Coffee, Hand, ChevronDown, ChevronUp, CircleAlert, Wifi, WifiOff, Users,
} from 'lucide-react';
import { ApiError, runCommand } from '../lib/api';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { Badge, Dot } from '../ui/Badge';
import { Page, PageHeader, Empty } from '../ui/Page';
import { Field } from '../ui/Field';
import { Sheet } from '../ui/Overlay';
import { cn } from '../ui/cn';

export interface TurnEntry {
  membershipId: string;
  name: string;
  turns: number;
  owed: number;
  state: 'available' | 'on_break' | 'off';
  position: number | null;
  manualRank: number | null;
  why: string[];
  trail: Array<{ at: string; reason: string; turns: number; note: string | null }>;
}
export interface RotationSnapshot {
  businessDate: string;
  nextUpMembershipId: string | null;
  entries: TurnEntry[];
}

const REASONS = [
  { v: 'guest_requested',   label: '客人指定' },
  { v: 'desk_coordination', label: '前台协调' },
  { v: 'owed_makeup',       label: '补欠轮' },
  { v: 'staff_on_break',    label: '技师暂休' },
  { v: 'skill_mismatch',    label: '不会这个项目' },
  { v: 'other',             label: '其他' },
];

const REASON_CN: Record<string, string> = {
  served: '接单', request_not_counted: '点钟单', skipped_no_skill: '跳过·不会做',
  skipped_off: '跳过·不在', break: '休息', back: '回来',
  manual_override: '前台调序', offline_service: '店外单', reset_daily: '每日重置',
};

const clock = (iso: string) =>
  new Date(iso.replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00'))
    .toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });

export function TurnBoard({
  data, membershipId, canOverride, services, onChanged, readOnly = false,
  onlineStaff,
}: {
  data: RotationSnapshot;
  membershipId: string;
  canOverride: boolean;
  /** 断网时只读：看得到，但按不动（宪法第 18 条） */
  readOnly?: boolean;
  services: Array<{ id: string; name: string; durationMin: number; priceCents: number }>;
  /** ⭐ 技师端在线的人（Realtime presence）。undefined = 还没连上，不显示点 */
  onlineStaff?: Set<string> | undefined;
  onChanged: () => Promise<unknown>;
}) {
  const [assigning, setAssigning] = useState<TurnEntry | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [moving, setMoving] = useState<TurnEntry | null>(null);
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [err, setErr] = useState('');

  const queue = data.entries.filter((e) => e.position !== null);
  const bench = data.entries.filter((e) => e.position === null);

  async function run(name: string, input: unknown, key: string) {
    setBusy(key); setErr('');
    try {
      await runCommand(name, input, membershipId);
      await onChanged();
      setMoving(null); setReason(''); setNote('');
    } catch (e) {
      setErr(e instanceof ApiError ? `操作失败（${e.code}）` : '操作失败');
    } finally { setBusy(null); }
  }

  const money = (c: number) => `$${(c / 100).toFixed(0)}`;

  return (
    <Page>
      <PageHeader
        title="轮牌"
        sub={
          <span className="flex items-center gap-1.5">
            队列 <span className="tnum">{queue.length}</span> 人
            {bench.length > 0 && <> · 不在队列 <span className="tnum">{bench.length}</span></>}
            {readOnly && <Badge tone="warn" className="ml-1">断网 · 只读</Badge>}
          </span>
        }
      />

      {err && (
        <div role="alert"
             className="mb-4 flex items-center gap-2 rounded bg-danger-soft px-4 py-3 text-danger">
          <CircleAlert size={17} /><span className="text-xs font-semibold">{err}</span>
        </div>
      )}

      {queue.length === 0 ? (
        <Empty
          icon={<Users size={34} />}
          title="今天还没有人在轮牌队列里"
          hint="接客的技师需要在排班里打开「参与今天的轮牌」。"
        />
      ) : (
        <div className="flex flex-col gap-3">
          {queue.map((e) => {
            const isNext = e.membershipId === data.nextUpMembershipId;
            const open = expanded === e.membershipId;
            const online = onlineStaff?.has(e.membershipId);

            return (
              <Card
                key={e.membershipId}
                className={cn(
                  'overflow-hidden p-0 transition-shadow',
                  // 「下一位」必须一眼认出来 —— 环 + 底色 + 文字三重，不只靠颜色
                  isNext && 'ring-2 ring-ok/50 bg-ok-soft/40',
                )}
              >
                <div className="flex items-center gap-4 p-4">
                  {/* 位次。下一位用实心，其余用浅底 —— 层级靠对比而非描边 */}
                  <div className={cn(
                    'grid size-12 shrink-0 place-items-center rounded-sm text-lg font-bold tnum',
                    isNext ? 'bg-ok text-white' : 'bg-sunken text-ink-2',
                  )}>
                    {e.position! + 1}
                  </div>

                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <strong className="text-lg font-bold tracking-tight">{e.name}</strong>

                      {/* ⭐ 在线点回答的是「派给她，她手机会响吗」，不是「人在不在店里」*/}
                      {onlineStaff && (
                        <span
                          title={online
                            ? '技师端在线，派单会响铃'
                            : '技师端不在线，派单不会响 —— 需口头叫号'}
                          className={cn('shrink-0', online ? 'text-ok' : 'text-ink-3')}
                        >
                          {online ? <Wifi size={14} /> : <WifiOff size={14} />}
                        </span>
                      )}

                      {isNext && <Badge tone="ok"><Star size={12} />下一位</Badge>}
                      {e.state === 'on_break' && <Badge tone="warn"><Coffee size={12} />休息中</Badge>}
                      {e.manualRank !== null && <Badge tone="line"><Hand size={12} />前台调序</Badge>}
                      {e.owed > 0 && <Badge tone="warn">欠 {e.owed} 轮</Badge>}
                    </div>
                    <div className="mt-0.5 truncate text-xs text-ink-3">
                      今日 <span className="tnum">{e.turns}</span> 轮
                      {e.why.length > 0 && <> · {e.why[e.why.length - 1]}</>}
                    </div>
                  </div>

                  <Button size="sm" variant="ghost"
                          onClick={() => setExpanded(open ? null : e.membershipId)}
                          aria-expanded={open}>
                    为什么 {open ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
                  </Button>
                </div>

                {/* 可解释性：技师质疑时前台点开给他看（决策 12） */}
                {open && (
                  <div className="flex flex-col gap-3 border-t border-line bg-sunken px-4 py-4">
                    <div className="flex flex-col gap-1">
                      {e.why.map((w, i) => (
                        <div key={i} className="text-xs text-ink-2">· {w}</div>
                      ))}
                    </div>

                    {e.trail.length > 0 && (
                      <div className="flex flex-col gap-1.5">
                        <span className="text-2xs font-bold uppercase tracking-wider text-ink-3">
                          今日流水
                        </span>
                        {e.trail.map((tr, i) => (
                          <div key={i} className="flex items-center gap-2.5 text-xs">
                            <span className="tnum text-ink-3">{clock(tr.at)}</span>
                            <Badge tone="mute">{REASON_CN[tr.reason] ?? tr.reason}</Badge>
                            {tr.turns > 0 && <span className="tnum text-ink-2">{tr.turns} 轮</span>}
                            <span className="min-w-0 flex-1 truncate text-ink-3">{tr.note ?? ''}</span>
                          </div>
                        ))}
                      </div>
                    )}

                    {canOverride && (
                      <div className="mt-1 flex flex-wrap gap-2">
                        <Button size="sm" disabled={busy !== null || readOnly}
                                onClick={() => { setMoving(e); setExpanded(null); }}>
                          <Hand size={15} />调到第一位
                        </Button>
                        <Button size="sm" disabled={busy !== null || readOnly}
                                onClick={() => void run('rotation.skip',
                                  { membershipId: e.membershipId, kind: 'no_skill' },
                                  `skip-${e.membershipId}`)}>
                          跳过（不会做）
                        </Button>
                        <Button size="sm" disabled={busy !== null || readOnly}
                                onClick={() => void run('rotation.setBreak',
                                  { membershipId: e.membershipId, onBreak: e.state !== 'on_break' },
                                  `brk-${e.membershipId}`)}>
                          <Coffee size={15} />{e.state === 'on_break' ? '结束休息' : '去休息'}
                        </Button>
                      </div>
                    )}
                  </div>
                )}

                {/* 派单是最高频的操作，只在「下一位」那张卡上出现 —— 一屏一个主按钮 */}
                {isNext && e.state === 'available' && (
                  <div className="flex gap-2.5 border-t border-line px-4 py-3.5">
                    <Button variant="primary" size="lg" block
                            disabled={busy !== null || readOnly}
                            title={readOnly ? '网络恢复后可操作' : undefined}
                            onClick={() => setAssigning(e)}>
                      {readOnly ? '断网中 · 仅可查看' : '派单 · 开工单'}
                    </Button>
                    <Button size="lg" disabled={busy !== null || readOnly}
                            title="客人指定技师，不消耗轮次"
                            onClick={() => void run('rotation.assign',
                              { membershipId: e.membershipId, isRequest: true },
                              `rq-${e.membershipId}`)}>
                      <Star size={17} />点钟
                    </Button>
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      )}

      {bench.length > 0 && (
        <div className="mt-8">
          <div className="mb-2.5 text-2xs font-bold uppercase tracking-wider text-ink-3">
            不在队列
          </div>
          <div className="flex flex-col gap-2">
            {bench.map((e) => (
              <Card key={e.membershipId} className="flex items-center gap-3 px-4 py-3">
                <strong className="min-w-0 flex-1 truncate font-semibold">{e.name}</strong>
                <Badge tone="mute">{e.state === 'off' ? '只接点钟' : '休息中'}</Badge>
                <span className="tnum text-xs text-ink-3">今日 {e.turns} 轮</span>
              </Card>
            ))}
          </div>
        </div>
      )}

      {/* 派单 = 记轮次 + 开工单，一步完成。前台不该为同一件事点两次 */}
      <Sheet
        open={assigning !== null}
        onOpenChange={(v) => !v && setAssigning(null)}
        title={assigning ? `派给 ${assigning.name}` : ''}
        description="选择服务项目，系统会同时记轮次并开出工单。"
      >
        <div className="grid gap-2.5 [grid-template-columns:repeat(auto-fill,minmax(176px,1fr))]">
          {services.map((sv) => (
            <Button key={sv.id} disabled={busy !== null || readOnly}
                    className="h-auto min-h-[4.5rem] flex-col gap-0.5 py-3"
                    onClick={async () => {
                      if (!assigning) return;
                      setBusy('assign'); setErr('');
                      try {
                        // 两条命令：记轮次（按金额折算半轮/整轮）+ 开工单
                        await runCommand('rotation.assign', {
                          membershipId: assigning.membershipId,
                          isRequest: false, amountCents: sv.priceCents,
                          customerName: '临时客人',
                        }, membershipId);
                        await runCommand('ticket.open', {
                          customerId: null, walkInName: '临时客人',
                          items: [{ serviceId: sv.id, membershipId: assigning.membershipId }],
                        }, membershipId);
                        await onChanged();
                        setAssigning(null);
                      } catch (ex) {
                        setErr(ex instanceof ApiError ? `派单失败（${ex.code}）` : '派单失败');
                      } finally { setBusy(null); }
                    }}>
              <span className="font-semibold">{sv.name}</span>
              <span className="text-xs font-normal text-ink-3 tnum">
                {sv.durationMin} 分钟 · {money(sv.priceCents)}
              </span>
            </Button>
          ))}
        </div>
      </Sheet>

      {/* 调序必须选原因才能提交（决策 12：可解释的流水，杜绝技师猜忌） */}
      <Sheet
        open={moving !== null}
        onOpenChange={(v) => { if (!v) { setMoving(null); setReason(''); setNote(''); } }}
        title={moving ? `将 ${moving.name} 调至第一位` : ''}
        description="调序会记入流水：操作人、时间、原因。技师可在自己的端上看到。"
        footer={
          <>
            <Button block onClick={() => setMoving(null)}>取消</Button>
            <Button variant="primary" block
                    disabled={!reason || (reason === 'other' && !note.trim()) || busy !== null}
                    onClick={() => moving && void run('rotation.reorder', {
                      membershipId: moving.membershipId, toPosition: 0,
                      reason, ...(note ? { note } : {}),
                    }, 'move')}>
              {busy === 'move'
                ? <span className="size-5 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                : '确认调序'}
            </Button>
          </>
        }
      >
        <div className="grid gap-2 [grid-template-columns:repeat(auto-fill,minmax(148px,1fr))]">
          {REASONS.map((r) => (
            <Button key={r.v} onClick={() => setReason(r.v)}
                    className={cn(reason === r.v && 'ring-2 ring-ink bg-sunken')}>
              {r.label}
            </Button>
          ))}
        </div>
        {reason === 'other' && (
          <Field className="mt-3" placeholder="请写清楚原因" value={note} autoFocus
                 onChange={(ev) => setNote(ev.target.value)} />
        )}
      </Sheet>
    </Page>
  );
}
