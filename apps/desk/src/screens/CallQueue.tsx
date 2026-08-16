/**
 * 来电待复核队列 —— 决策 6 的「直推前台 1 秒复核队列」。
 *
 * ⭐ 这一屏的设计只有一条原则：**把 AI「听到的」和「猜到的」并排摆出来**。
 *
 * 只显示匹配结果（「Gel Manicure · Amy · 明天 16:00」）的话，前台没法核对 ——
 * 那一行字看起来永远是对的。而客人说的可能是 "gel removal"，
 * 一个价格差一倍的完全不同的活儿。
 *
 * 所以每一项都是两行：上面是听到的原话，下面是匹配到的东西。
 * 对不上的时候前台一眼就看见了。
 */

import { useState } from 'react';
import { ApiError, runCommand } from '../lib/api';

export interface CallDraft {
  draftId: string;
  status: string;
  fromE164: string | null;
  fromDisplay: string | null;
  createdAt: string;
  service: { heard: string | null; matchedId: string | null; matchedName: string | null };
  staff: { heard: string | null; matchedId: string | null; matchedName: string | null };
  time: { heard: string | null; slotStartsAt: string | null; durationMin: number | null };
  customer: { id: string | null; displayName: string | null } | null;
  candidates: Array<{ customerId: string; displayName: string; lastVisitOn: string | null }>;
  callerNameHeard: string | null;
  confidenceBp: number;
  lowConfidence: boolean;
  notes: string | null;
  readyToBook: boolean;
  missing: string[];
}

export interface CallQueueData {
  drafts: CallDraft[];
  pendingCount: number;
}

const DISMISS_REASONS: Array<[string, string]> = [
  ['not_a_booking', '只是问价格 / 问营业时间'],
  ['wrong_service', '项目听错了'],
  ['wrong_time', '时间听错了'],
  ['wrong_staff', '技师听错了'],
  ['duplicate', '已经用别的方式约过了'],
  ['customer_cancelled', '客人又说不用了'],
  ['spam', '骚扰电话'],
  ['other', '其他'],
];

function clockOf(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('zh-CN', {
    month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
  });
}

function agoOf(iso: string): string {
  const sec = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (sec < 60) return '刚刚';
  if (sec < 3600) return `${Math.floor(sec / 60)} 分钟前`;
  if (sec < 86400) return `${Math.floor(sec / 3600)} 小时前`;
  return `${Math.floor(sec / 86400)} 天前`;
}

export function CallQueue({
  data, membershipId, onChanged, onBook,
}: {
  data: CallQueueData;
  membershipId: string;
  onChanged: () => Promise<unknown>;
  /**
   * 去建单。**不在这一屏建** —— 建预约要走前台自己身份下的
   * `appointment.create`，容量检查、软约束放行一样不少（09 §4.2）。
   * 这一屏只负责把三要素摆清楚。
   */
  onBook: (draft: CallDraft) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [dismissing, setDismissing] = useState<CallDraft | null>(null);

  async function dismiss(draft: CallDraft, reason: string) {
    setBusy(true); setErr('');
    try {
      await runCommand('call.reviewDraft',
        { draftId: draft.draftId, decision: 'dismissed', dismissReason: reason },
        membershipId);
      setDismissing(null);
      await onChanged();
    } catch (e) {
      setErr(e instanceof ApiError ? `操作失败（${e.code}）` : '操作失败');
    } finally { setBusy(false); }
  }

  if (data.drafts.length === 0) {
    return (
      <div className="card stack" style={{ margin: 16, padding: 32, textAlign: 'center', gap: 8 }}>
        <div style={{ fontSize: 40 }}>☎️</div>
        <div style={{ fontSize: 'var(--text-lg)', fontWeight: 700 }}>没有待复核的来电</div>
        <div className="tiny">
          AI 接到电话、听清了客人要什么之后，会把结果放到这里等你确认。
        </div>
      </div>
    );
  }

  return (
    <div className="stack" style={{ padding: '0 16px 24px', gap: 12 }}>
      <div className="card row" style={{ padding: '12px 16px', gap: 12 }}>
        <strong style={{ fontSize: 'var(--text-lg)' }}>
          ☎️ 待复核 {data.pendingCount}
        </strong>
        <span className="tiny grow">
          AI 只是记下来了，<strong>还没有建任何预约</strong> —— 你确认之后才算数
        </span>
      </div>

      {err && <div className="badge badge-danger" style={{ padding: '10px 14px' }}>✕ {err}</div>}

      {data.drafts.map((d) => (
        <div key={d.draftId} className="card stack"
             style={{
               padding: 18, gap: 14,
               borderWidth: 2,
               borderColor: d.lowConfidence ? 'var(--warn)' : 'var(--line)',
               background: d.lowConfidence ? 'var(--warn-soft)' : 'var(--surface)',
             }}>
          {/* 谁打来的 */}
          <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
            <strong style={{ fontSize: 'var(--text-xl)' }}>
              {d.customer?.displayName ?? d.callerNameHeard ?? '未知来电'}
            </strong>
            {d.fromDisplay && (
              <span className="badge badge-soft" style={{ fontVariantNumeric: 'tabular-nums' }}>
                {d.fromDisplay}
              </span>
            )}
            {d.lowConfidence && <span className="badge badge-warn">⚠ AI 没太听清</span>}
            <span className="grow" />
            <span className="tiny">{agoOf(d.createdAt)}</span>
          </div>

          {/* ⭐ 三要素：听到的 vs 匹配到的，并排摆 */}
          <div className="stack" style={{ gap: 8 }}>
            <Element label="项目" heard={d.service.heard} matched={d.service.matchedName} />
            <Element label="时间" heard={d.time.heard}
                     matched={d.time.slotStartsAt
                       ? `${clockOf(d.time.slotStartsAt)}${d.time.durationMin ? ` · ${d.time.durationMin} 分钟` : ''}`
                       : null} />
            <Element label="技师" heard={d.staff.heard} matched={d.staff.matchedName}
                     optional />
          </div>

          {/* 同号多客户：决策 21，绝不替前台挑一个 */}
          {d.candidates.length > 1 && (
            <div className="card stack" style={{ padding: 12, gap: 6, background: 'var(--bg)' }}>
              <span className="tiny">
                <strong>这个号码下有 {d.candidates.length} 位客人</strong> ——
                系统不会替你挑，建单时选一位：
              </span>
              <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                {d.candidates.map((c) => (
                  <span key={c.customerId} className="badge badge-soft">
                    {c.displayName}
                    {c.lastVisitOn && ` · 上次 ${c.lastVisitOn}`}
                  </span>
                ))}
              </div>
            </div>
          )}

          {d.notes && (
            <div className="tiny" style={{ whiteSpace: 'pre-wrap', lineHeight: 1.6 }}>
              {d.notes}
            </div>
          )}

          {/* 缺什么就说什么 —— 灰掉按钮不给理由，前台只会以为系统坏了 */}
          {!d.readyToBook && (
            <div className="tiny">
              还差 <strong>{d.missing.join('、')}</strong>，建单时补上就行。
            </div>
          )}

          <div className="row" style={{ gap: 10 }}>
            <button className="btn" style={{ minHeight: 'var(--tap)' }} disabled={busy}
                    onClick={() => setDismissing(d)}>
              忽略
            </button>
            <span className="grow" />
            <button className="btn btn-primary" disabled={busy}
                    style={{ minHeight: 'var(--tap-lg)', fontSize: 'var(--text-lg)', minWidth: 200 }}
                    onClick={() => onBook(d)}>
              {d.readyToBook ? '✓ 照这个建单' : '去建单（补齐缺的）'}
            </button>
          </div>
        </div>
      ))}

      {/* 忽略必须给原因 —— 这是「AI 到底准不准」唯一诚实的度量（05 §9） */}
      {dismissing && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(20,18,16,.45)',
                      display: 'grid', placeItems: 'end center', zIndex: 60 }}
             onClick={() => setDismissing(null)}>
          <div className="card stack" onClick={(e) => e.stopPropagation()}
               style={{ width: 'min(560px,100%)', padding: 24, gap: 12,
                        borderRadius: '18px 18px 0 0' }}>
            <div style={{ fontSize: 'var(--text-xl)', fontWeight: 800 }}>为什么忽略？</div>
            <div className="tiny">
              选一个就好。这是我们判断「AI 电话到底值不值」的唯一依据。
            </div>
            {DISMISS_REASONS.map(([key, label]) => (
              <button key={key} className="btn btn-block" disabled={busy}
                      style={{ minHeight: 'var(--tap)', justifyContent: 'flex-start' }}
                      onClick={() => void dismiss(dismissing, key)}>
                {label}
              </button>
            ))}
            <button className="btn btn-ghost" onClick={() => setDismissing(null)}>取消</button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * 一个要素两行：听到的 / 匹配到的。
 *
 * 匹配不上时**不留空**，明说「没对上，建单时选」—— 空白会被读成
 * 「客人没说」，而实际上客人说了、只是我们没听懂，那是两件完全不同的事。
 */
function Element({ label, heard, matched, optional }: {
  label: string; heard: string | null; matched: string | null; optional?: boolean;
}) {
  if (!heard && !matched) {
    return (
      <div className="row" style={{ gap: 10, alignItems: 'baseline' }}>
        <span className="tiny" style={{ width: 42 }}>{label}</span>
        <span className="tiny">{optional ? '客人没提（不指定）' : '客人没说'}</span>
      </div>
    );
  }

  return (
    <div className="row" style={{ gap: 10, alignItems: 'baseline' }}>
      <span className="tiny" style={{ width: 42 }}>{label}</span>
      <div className="stack grow" style={{ gap: 2, minWidth: 0 }}>
        {matched ? (
          <strong style={{ fontSize: 'var(--text-lg)' }}>{matched}</strong>
        ) : (
          <span className="badge badge-warn" style={{ alignSelf: 'flex-start' }}>
            没对上，建单时选
          </span>
        )}
        {heard && (
          <span className="tiny">
            客人说的是：「{heard}」
          </span>
        )}
      </div>
    </div>
  );
}
