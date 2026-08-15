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
import { ApiError, runCommand } from '../lib/api';

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
  data, membershipId, canOverride, services, onChanged,
}: {
  data: RotationSnapshot;
  membershipId: string;
  canOverride: boolean;
  services: Array<{ id: string; name: string; durationMin: number; priceCents: number }>;
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

  return (
    <div className="stack" style={{ padding: '0 16px 24px', gap: 14 }}>
      {err && (
        <div className="badge badge-danger" style={{ padding: '10px 14px' }} role="alert">✕ {err}</div>
      )}

      {queue.length === 0 && (
        <div className="card" style={{ padding: 28, textAlign: 'center' }}>
          <div className="muted">今天还没有人在轮牌队列里</div>
          <div className="tiny" style={{ marginTop: 6 }}>
            接客的技师要打开「参与今天的轮牌」
          </div>
        </div>
      )}

      {queue.map((e) => {
        const isNext = e.membershipId === data.nextUpMembershipId;
        const open = expanded === e.membershipId;
        return (
          <div key={e.membershipId} className="card"
               style={{
                 // 「下一位」必须一眼认出来 —— 粗边框 + 底色 + 文字三重，不只靠颜色
                 borderWidth: isNext ? 3 : 1,
                 borderColor: isNext ? 'var(--ok)' : 'var(--line)',
                 background: isNext ? 'var(--ok-soft)' : 'var(--surface)',
                 padding: 0, overflow: 'hidden',
               }}>
            <div className="row" style={{ padding: '14px 16px', gap: 14 }}>
              <div style={{
                width: 52, height: 52, borderRadius: 14, flexShrink: 0,
                display: 'grid', placeItems: 'center',
                background: isNext ? 'var(--ok)' : '#efedea',
                color: isNext ? '#fff' : 'var(--ink-2)',
                fontSize: 'var(--text-xl)', fontWeight: 800,
              }}>{e.position! + 1}</div>

              <div className="grow stack" style={{ gap: 4, minWidth: 0 }}>
                <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                  <strong style={{ fontSize: 'var(--text-xl)' }}>{e.name}</strong>
                  {isNext && <span className="badge badge-ok">★ 下一位</span>}
                  {e.state === 'on_break' && <span className="badge badge-warn">☕ 休息中</span>}
                  {e.manualRank !== null && <span className="badge badge-soft">✋ 前台调序</span>}
                  {e.owed > 0 && <span className="badge badge-warn">欠 {e.owed} 轮</span>}
                </div>
                <div className="tiny truncate">
                  今天 {e.turns} 轮 · {e.why[e.why.length - 1] ?? ''}
                </div>
              </div>

              <button className="btn" style={{ minHeight: 44 }}
                      onClick={() => setExpanded(open ? null : e.membershipId)}
                      aria-expanded={open}>
                {open ? '收起' : '为什么'}
              </button>
            </div>

            {/* 可解释性：技师质疑时前台点开给他看 */}
            {open && (
              <div className="stack" style={{
                padding: '12px 16px 16px', gap: 10,
                borderTop: '1px solid var(--line)', background: 'var(--bg)',
              }}>
                <div className="stack" style={{ gap: 4 }}>
                  {e.why.map((w, i) => (
                    <div key={i} style={{ fontSize: 'var(--text-sm)' }}>· {w}</div>
                  ))}
                </div>
                {e.trail.length > 0 && (
                  <>
                    <div className="tiny" style={{ marginTop: 4 }}>今天的流水</div>
                    <div className="stack" style={{ gap: 2 }}>
                      {e.trail.map((tr, i) => (
                        <div key={i} className="row tiny" style={{ gap: 10 }}>
                          <span style={{ fontVariantNumeric: 'tabular-nums' }}>{clock(tr.at)}</span>
                          <span className="badge badge-mute">{REASON_CN[tr.reason] ?? tr.reason}</span>
                          {tr.turns > 0 && <span>{tr.turns} 轮</span>}
                          <span className="truncate grow">{tr.note ?? ''}</span>
                        </div>
                      ))}
                    </div>
                  </>
                )}

                {canOverride && (
                  <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginTop: 6 }}>
                    <button className="btn" disabled={busy !== null}
                            onClick={() => { setMoving(e); setExpanded(null); }}>
                      ✋ 调到第一位
                    </button>
                    <button className="btn" disabled={busy !== null}
                            onClick={() => void run('rotation.skip',
                              { membershipId: e.membershipId, kind: 'no_skill' },
                              `skip-${e.membershipId}`)}>
                      跳过（不会做）
                    </button>
                    <button className="btn" disabled={busy !== null}
                            onClick={() => void run('rotation.setBreak',
                              { membershipId: e.membershipId, onBreak: e.state !== 'on_break' },
                              `brk-${e.membershipId}`)}>
                      {e.state === 'on_break' ? '休息结束' : '☕ 去休息'}
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* 叫号：最高频的操作，放在最显眼处 */}
            {isNext && e.state === 'available' && (
              <div className="row" style={{ padding: '0 16px 14px', gap: 10 }}>
                <button className="btn btn-primary grow" disabled={busy !== null}
                        onClick={() => setAssigning(e)}>
                  派给他 · 开单
                </button>
                <button className="btn" style={{ minHeight: 'var(--tap-lg)' }} disabled={busy !== null}
                        onClick={() => void run('rotation.assign',
                          { membershipId: e.membershipId, isRequest: true },
                          `rq-${e.membershipId}`)}>
                  ★ 点钟（不消耗轮次）
                </button>
              </div>
            )}
          </div>
        );
      })}

      {bench.length > 0 && (
        <>
          <div className="tiny" style={{ marginTop: 6 }}>不在队列</div>
          {bench.map((e) => (
            <div key={e.membershipId} className="card row"
                 style={{ padding: '12px 16px', gap: 12, opacity: .75 }}>
              <strong className="grow">{e.name}</strong>
              <span className="badge badge-mute">
                {e.state === 'off' ? '只接点钟' : '休息中'}
              </span>
              <span className="tiny">今天 {e.turns} 轮</span>
            </div>
          ))}
        </>
      )}

      {/* 派单 = 记轮次 + 开单，一步完成。前台不该为同一件事点两次 */}
      {assigning && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(20,18,16,.45)',
          display: 'grid', placeItems: 'end center', zIndex: 50,
        }} onClick={() => setAssigning(null)}>
          <div className="card stack" onClick={(ev) => ev.stopPropagation()}
               style={{ width: 'min(600px,100%)', padding: 24, gap: 16,
                        borderRadius: '18px 18px 0 0' }}>
            <div style={{ fontSize: 'var(--text-xl)', fontWeight: 800 }}>
              派给 {assigning.name} —— 做什么项目
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(180px,1fr))', gap: 10 }}>
              {services.map((sv) => (
                <button key={sv.id} className="btn" disabled={busy !== null}
                        style={{ minHeight: 72, flexDirection: 'column', gap: 2 }}
                        onClick={async () => {
                          setBusy('assign'); setErr('');
                          try {
                            // 两条命令：记轮次（按金额折算半轮/整轮）+ 开单
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
                  <span>{sv.name}</span>
                  <span className="tiny">{sv.durationMin} 分钟 · ${(sv.priceCents / 100).toFixed(0)}</span>
                </button>
              ))}
            </div>
            <button className="btn btn-block" onClick={() => setAssigning(null)}>取消</button>
          </div>
        </div>
      )}

      {/* 调序：必须选原因才能提交（决策 12） */}
      {moving && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(20,18,16,.45)',
          display: 'grid', placeItems: 'end center', zIndex: 50,
        }} onClick={() => setMoving(null)}>
          <div className="card stack" onClick={(ev) => ev.stopPropagation()}
               style={{ width: 'min(560px,100%)', padding: 24, gap: 16,
                        borderRadius: '18px 18px 0 0' }}>
            <div className="stack" style={{ gap: 2 }}>
              <div style={{ fontSize: 'var(--text-xl)', fontWeight: 800 }}>
                把 {moving.name} 排到第一位
              </div>
              <div className="tiny">
                会记进流水：谁改的、几点改的、为什么 —— 技师问起来时给他看
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(150px,1fr))', gap: 8 }}>
              {REASONS.map((r) => (
                <button key={r.v} className="btn" onClick={() => setReason(r.v)}
                        style={{
                          minHeight: 56, borderWidth: 2,
                          borderColor: reason === r.v ? 'var(--brand)' : 'var(--line)',
                          background: reason === r.v ? 'var(--brand-soft)' : 'var(--surface)',
                        }}>{r.label}</button>
              ))}
            </div>

            {reason === 'other' && (
              <input className="field" placeholder="写清楚原因" value={note} autoFocus
                     onChange={(ev) => setNote(ev.target.value)} />
            )}

            <div className="row" style={{ gap: 10 }}>
              <button className="btn grow" onClick={() => setMoving(null)}>取消</button>
              <button className="btn btn-primary grow"
                      disabled={!reason || (reason === 'other' && !note.trim()) || busy !== null}
                      onClick={() => void run('rotation.reorder', {
                        membershipId: moving.membershipId, toPosition: 0,
                        reason, ...(note ? { note } : {}),
                      }, 'move')}>
                {busy === 'move' ? <span className="spin" /> : '确认调序'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
