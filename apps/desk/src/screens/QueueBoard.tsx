/**
 * 走单队列 —— 前台叫号那一屏。
 *
 * ⚠️ **宪法第 14 条**：没有 iPad 的店，这一屏就是全部 ——
 * 前台自己在这里帮客人取号、叫号、标记入座。Kiosk 只是让客人自己动手。
 * 所以「＋ 手工加一位」这个按钮不是补充功能，它是 Desk-Only 模式的主路径。
 *
 * ⚠️ **不做叫号短信**（宪法第 13 条）。门店数 ≥ 10 且 10DLC 批准之前，
 * 叫号只有门口大屏和前台口头喊两条路。
 */

import { useState } from 'react';
import { ApiError, runCommand } from '../lib/api';

export interface QueueEntry {
  queueId: string;
  ticketNumber: number;
  status: string;
  displayName: string;
  phoneDisplay: string | null;
  customerId: string | null;
  serviceName: string | null;
  staffName: string | null;
  partySize: number;
  appointmentId: string | null;
  waitedMin: number;
  quotedWaitMin: number | null;
  overdue: boolean;
  source: string;
  joinedAt: string;
  pendingForms: number;
}

export interface QueueData {
  businessDate: string;
  waiting: QueueEntry[];
  called: QueueEntry[];
  seated: QueueEntry[];
  summary: { waiting: number; called: number; longestWaitMin: number; leftToday: number };
}

const LEFT_REASONS: Array<[string, string]> = [
  ['waited_too_long', '等太久，走了'],
  ['told_us', '说了一声，先去别处'],
  ['seated_elsewhere', '前台另作安排'],
  ['no_response', '叫了没人应'],
  ['other', '其他'],
];

export function QueueBoard({
  data, membershipId, onChanged,
}: {
  data: QueueData;
  membershipId: string;
  onChanged: () => Promise<unknown>;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [leaving, setLeaving] = useState<QueueEntry | null>(null);
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState('');

  async function run(name: string, input: unknown) {
    setBusy(true); setErr('');
    try {
      await runCommand(name, input, membershipId);
      await onChanged();
    } catch (e) {
      setErr(e instanceof ApiError ? `操作失败（${e.code}）` : '操作失败');
    } finally { setBusy(false); }
  }

  return (
    <div className="stack" style={{ padding: '0 16px 24px', gap: 12 }}>
      {/* 汇总条 */}
      <div className="card row" style={{ padding: '14px 18px', gap: 14, flexWrap: 'wrap' }}>
        <strong style={{ fontSize: 'var(--text-lg)' }}>🎫 等位 {data.summary.waiting}</strong>
        {data.summary.called > 0 && (
          <span className="badge badge-soft">已叫号 {data.summary.called}</span>
        )}
        {data.summary.longestWaitMin > 0 && (
          <span className={`badge ${data.summary.longestWaitMin > 40 ? 'badge-warn' : 'badge-soft'}`}>
            最久等了 {data.summary.longestWaitMin} 分钟
          </span>
        )}
        {/* 今天走掉几个 —— 这是老板最该看到的数，它直接对应流失 */}
        {data.summary.leftToday > 0 && (
          <span className="badge badge-mute">今天走了 {data.summary.leftToday} 位</span>
        )}
        <span className="grow" />
        <button className="btn btn-primary" style={{ minHeight: 48 }} disabled={busy}
                onClick={() => setAdding(true)}>
          ＋ 手工加一位
        </button>
      </div>

      {err && <div className="badge badge-danger" style={{ padding: '10px 14px' }}>✕ {err}</div>}

      {data.waiting.length === 0 && data.called.length === 0 && (
        <div className="card" style={{ padding: 28, textAlign: 'center' }}>
          <div className="muted">现在没有人在等</div>
          <div className="tiny" style={{ marginTop: 6 }}>
            客人在门口 iPad 上签到会自动出现在这里；没有 iPad 就点上面「手工加一位」
          </div>
        </div>
      )}

      {data.called.length > 0 && (
        <>
          <div className="tiny">已叫号 —— 等他坐下就点「入座」</div>
          {data.called.map((e) => (
            <Row key={e.queueId} e={e} busy={busy}
                 onSeat={() => void run('queue.update', { queueId: e.queueId, status: 'seated' })}
                 onLeft={() => setLeaving(e)} />
          ))}
        </>
      )}

      {data.waiting.length > 0 && <div className="tiny">等位中</div>}
      {data.waiting.map((e) => (
        <Row key={e.queueId} e={e} busy={busy}
             onCall={() => void run('queue.update', { queueId: e.queueId, status: 'called' })}
             onLeft={() => setLeaving(e)} />
      ))}

      {/* 走了必须给原因 —— 「等太久走的」和「说了一声」是两回事，
          而前者直接对应流失，不强制就没人会填 */}
      {leaving && (
        <Sheet title={`${leaving.ticketNumber} 号 · ${leaving.displayName} 为什么走了？`}
               onClose={() => setLeaving(null)}>
          {LEFT_REASONS.map(([key, label]) => (
            <button key={key} className="btn btn-block" disabled={busy}
                    style={{ minHeight: 'var(--tap)', justifyContent: 'flex-start' }}
                    onClick={async () => {
                      await run('queue.update',
                        { queueId: leaving.queueId, status: 'left', leftReason: key });
                      setLeaving(null);
                    }}>
              {label}
            </button>
          ))}
        </Sheet>
      )}

      {adding && (
        <Sheet title="手工加一位" onClose={() => { setAdding(false); setNewName(''); }}>
          <div className="tiny">
            没有 iPad 的店就用这个。取的号和客人自己在门口取的是同一套。
          </div>
          <input className="field" value={newName} autoFocus placeholder="客人称呼，例：陈女士"
                 onChange={(e) => setNewName(e.target.value)} />
          <button className="btn btn-primary btn-block" disabled={busy || !newName.trim()}
                  style={{ minHeight: 'var(--tap)' }}
                  onClick={async () => {
                    await run('queue.join', {
                      walkInName: newName.trim(), source: 'desk',
                    });
                    setAdding(false); setNewName('');
                  }}>
            {busy ? <span className="spin" /> : '取号'}
          </button>
        </Sheet>
      )}
    </div>
  );
}

function Row({ e, busy, onCall, onSeat, onLeft }: {
  e: QueueEntry; busy: boolean;
  onCall?: () => void; onSeat?: () => void; onLeft: () => void;
}) {
  return (
    <div className="card row"
         style={{
           padding: '14px 16px', gap: 14,
           borderWidth: 2,
           borderColor: e.overdue ? 'var(--warn)' : 'var(--line)',
           background: e.overdue ? 'var(--warn-soft)' : 'var(--surface)',
         }}>
      <div style={{ fontSize: 'var(--text-2xl)', fontWeight: 800, minWidth: 64,
                    textAlign: 'center', fontVariantNumeric: 'tabular-nums' }}>
        {e.ticketNumber}
      </div>

      <div className="grow stack" style={{ gap: 3, minWidth: 0 }}>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <strong style={{ fontSize: 'var(--text-lg)' }}>{e.displayName}</strong>
          {e.partySize > 1 && <span className="badge badge-soft">{e.partySize} 位</span>}
          {e.appointmentId && <span className="badge badge-ok">有预约</span>}
          {e.source === 'kiosk' && <span className="badge badge-soft">自助</span>}
          {/* 前台在叫号【之前】就该知道还差表没签 */}
          {e.pendingForms > 0 && (
            <span className="badge badge-warn">⚠ 还差 {e.pendingForms} 份表没签</span>
          )}
        </div>
        <div className="tiny">
          等了 {e.waitedMin} 分钟
          {e.quotedWaitMin !== null && ` · 估的是 ${e.quotedWaitMin} 分钟`}
          {e.serviceName && ` · ${e.serviceName}`}
          {e.staffName && ` · 指定 ${e.staffName}`}
          {e.phoneDisplay && ` · ${e.phoneDisplay}`}
        </div>
      </div>

      {onCall && (
        <button className="btn btn-primary" style={{ minHeight: 'var(--tap)', minWidth: 120 }}
                disabled={busy} onClick={onCall}>叫号</button>
      )}
      {onSeat && (
        <button className="btn btn-primary" style={{ minHeight: 'var(--tap)', minWidth: 120 }}
                disabled={busy} onClick={onSeat}>入座</button>
      )}
      <button className="btn" style={{ minHeight: 'var(--tap)' }} disabled={busy}
              onClick={onLeft}>走了</button>
    </div>
  );
}

function Sheet({ title, children, onClose }: {
  title: string; children: React.ReactNode; onClose: () => void;
}) {
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(20,18,16,.45)',
                  display: 'grid', placeItems: 'end center', zIndex: 60 }}
         onClick={onClose}>
      <div className="card stack" onClick={(e) => e.stopPropagation()}
           style={{ width: 'min(560px,100%)', padding: 24, gap: 12,
                    borderRadius: '18px 18px 0 0' }}>
        <div style={{ fontSize: 'var(--text-xl)', fontWeight: 800 }}>{title}</div>
        {children}
        <button className="btn btn-ghost" onClick={onClose}>取消</button>
      </div>
    </div>
  );
}
