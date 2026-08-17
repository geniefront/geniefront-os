/**
 * 前台 AI 副驾（05 §6.3）
 *
 * 一条口语 → 一张**人话卡片** → 前台点确认 → 执行 → 60 秒撤销窗口。
 *
 * ## 三条不能破的
 *
 * 1. **提案不是执行。** 模型给的是一个待确认的对象，
 *    真正的写入是前台点确认时走 `/v1/commands/:name` ——
 *    用**她自己的身份**，权限、容量检查、审计一样不少。
 * 2. **卡片上那句话必须能独立判断对错。** 前台不会点开详情。
 *    「把王太太 17:00 的单挪到 18:00」是好的，「重新安排预约」不是。
 * 3. **只读的回答直接给，不要卡片。**「几个人在等」弹一张确认卡
 *    是在给一个不需要决策的问题制造决策。
 *
 * ## 为什么是抽屉不是页签
 *
 * 副驾是**在别的屏上顺手问一句**的东西 —— 前台正看着日程表说
 * 「把 Lisa 五点那单挪到六点」。做成页签的话她要先离开日程表，
 * 而离开的那一刻她就看不到自己在说哪一单了。
 */

import { useEffect, useRef, useState } from 'react';
import { API_BASE, ApiError, runCommand } from '../lib/api';
import { supabase } from '../lib/supabase';

interface Proposal {
  command: string;
  input: Record<string, unknown>;
  summary: string;
  confirm?: string;
}

interface CopilotReply {
  answer: string;
  proposal: Proposal | null;
  /** local = 没走模型（关键词直接答的），model = 走了模型 */
  source: 'local' | 'model';
  costCents: number;
  rounds?: number;
  toolsUsed?: string[];
  stopped?: string | null;
  snapshot: string;
}

interface Turn {
  role: 'user' | 'assistant';
  text: string;
  // ⚠️ 这几个都显式带上 `| undefined`：tsconfig 开了
  // `exactOptionalPropertyTypes`，`?:` 不等于「可以赋 undefined」
  proposal?: Proposal | null | undefined;
  source?: 'local' | 'model' | undefined;
  toolsUsed?: string[] | undefined;
  /** 执行结果：等确认 / 已执行 / 已撤销 / 出错 */
  state?: 'pending' | 'done' | 'undone' | 'failed' | undefined;
  error?: string | undefined;
  /** 执行之后可以撤销到什么时候（毫秒时间戳）。null = 这条撤不了 */
  undoUntil?: number | null | undefined;
  undo?: { command: string; input: Record<string, unknown> } | null | undefined;
}

/** 撤销窗口。60 秒 —— 前台反应过来「点错了」大概就这么久 */
const UNDO_MS = 60_000;

export function Copilot({ membershipId, onExecuted, onClose }: {
  membershipId: string;
  /** 执行成功后让外面把相关看板刷一遍 */
  onExecuted: () => Promise<unknown>;
  onClose: () => void;
}) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);

  // 撤销倒计时要跳。只在有待撤销的条目时才开定时器 ——
  // 开着不动的前台电脑没必要每秒重渲染
  const hasUndo = turns.some((t) => t.undoUntil && t.undoUntil > Date.now());
  useEffect(() => {
    if (!hasUndo) return;
    const h = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(h);
  }, [hasUndo]);

  useEffect(() => {
    boxRef.current?.scrollTo({ top: boxRef.current.scrollHeight, behavior: 'smooth' });
  }, [turns.length, tick]);

  async function ask(question: string) {
    setBusy(true);
    setTurns((t) => [...t, { role: 'user', text: question }]);
    setText('');
    try {
      const { data: s } = await supabase.auth.getSession();
      const res = await fetch(`${API_BASE}/v1/ai/copilot`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${s.session?.access_token ?? ''}`,
          'Content-Type': 'application/json',
          'X-Membership-Id': membershipId,
        },
        body: JSON.stringify({
          question,
          // 只带最近三轮的文本。带全了既烧 token 又让模型抓不住重点
          history: turns.slice(-3).map((t) => ({ role: t.role, text: t.text })),
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new ApiError(json.code ?? 'INTERNAL', json.details ?? {}, false, res.status);
      }
      const reply = json as CopilotReply;
      setTurns((t) => [...t, {
        role: 'assistant',
        text: reply.answer,
        proposal: reply.proposal,
        source: reply.source,
        toolsUsed: reply.toolsUsed ?? [],
        state: reply.proposal ? 'pending' : undefined,
      }]);
    } catch (e) {
      setTurns((t) => [...t, {
        role: 'assistant',
        text: e instanceof ApiError && e.code === 'PERMISSION_DENIED'
          ? '你没有使用副驾的权限，找老板开一下。'
          : e instanceof ApiError && e.code === 'UPSTREAM_UNAVAILABLE'
          ? '副驾暂时连不上，直接在界面上操作吧。'
          : '出错了，再说一遍试试。',
        state: 'failed',
      }]);
    } finally { setBusy(false); }
  }

  /** 前台点了确认 —— 这一下才真的写库，走她自己的身份 */
  async function confirm(index: number, p: Proposal) {
    setBusy(true);
    try {
      const out = await runCommand<Record<string, unknown>>(p.command, p.input, membershipId);
      const undo = inverseOf(p, out.result);
      setTurns((t) => t.map((turn, i) => i !== index ? turn : {
        ...turn,
        state: 'done',
        undo,
        undoUntil: undo ? Date.now() + UNDO_MS : null,
      }));
      await onExecuted();
    } catch (e) {
      setTurns((t) => t.map((turn, i) => i !== index ? turn : {
        ...turn, state: 'failed', error: describe(e),
      }));
    } finally { setBusy(false); }
  }

  async function undo(index: number, turn: Turn) {
    if (!turn.undo) return;
    setBusy(true);
    try {
      await runCommand(turn.undo.command, turn.undo.input, membershipId);
      setTurns((t) => t.map((x, i) => i !== index ? x
        : { ...x, state: 'undone', undoUntil: null, undo: null }));
      await onExecuted();
    } catch (e) {
      setTurns((t) => t.map((x, i) => i !== index ? x
        : { ...x, error: `撤销失败：${describe(e)}` }));
    } finally { setBusy(false); }
  }

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,.35)',
      display: 'flex', justifyContent: 'flex-end', zIndex: 40,
    }} onClick={onClose}>
      <div className="stack" onClick={(e) => e.stopPropagation()}
           style={{
             width: 'min(520px, 100%)', height: '100%', background: 'var(--surface)',
             borderLeft: '1px solid var(--line)', gap: 0,
           }}>
        <div className="row" style={{
          padding: '12px 16px', borderBottom: '1px solid var(--line)', gap: 10 }}>
          <strong className="grow" style={{ fontSize: 'var(--text-lg)' }}>🤖 副驾</strong>
          <button className="btn btn-ghost" style={{ minHeight: 44 }} onClick={onClose}>关闭</button>
        </div>

        <div ref={boxRef} className="stack grow"
             style={{ padding: 16, gap: 12, overflowY: 'auto' }}>
          {turns.length === 0 && (
            <div className="stack" style={{ gap: 10 }}>
              <div className="muted">用平常说话的方式问就行。比如：</div>
              {[
                '几个人在等？',
                '谁有空？',
                '把王太太五点那单挪到六点',
                '明天下午有没有一个小时的空档',
              ].map((s) => (
                <button key={s} className="btn" style={{ minHeight: 56, textAlign: 'left' }}
                        onClick={() => void ask(s)}>{s}</button>
              ))}
            </div>
          )}

          {turns.map((t, i) => t.role === 'user' ? (
            <div key={i} className="card" style={{
              padding: '12px 16px', alignSelf: 'flex-end', maxWidth: '85%',
              background: 'var(--brand-soft)', borderColor: 'var(--brand)' }}>
              {t.text}
            </div>
          ) : (
            <div key={i} className="stack" style={{ gap: 8, maxWidth: '92%' }}>
              <div className="card" style={{ padding: '12px 16px', whiteSpace: 'pre-wrap' }}>
                {t.text}
              </div>

              {/*
                ⭐ 「这句话是查库直接答的」要标出来。
                前台不需要懂技术，但她需要知道**哪些回答是模型说的**——
                模型说的那些，她会多看一眼，而这正是我们要的。
              */}
              {t.source === 'local' && (
                <span className="tiny muted">· 直接查的，没过 AI</span>
              )}
              {t.source === 'model' && (t.toolsUsed?.length ?? 0) > 0 && (
                <span className="tiny muted">· 查了：{t.toolsUsed!.join('、')}</span>
              )}

              {t.proposal && (
                <ProposalCard
                  p={t.proposal}
                  state={t.state ?? 'pending'}
                  error={t.error}
                  busy={busy}
                  undoLeftMs={t.undoUntil ? t.undoUntil - Date.now() : 0}
                  canUndo={Boolean(t.undo)}
                  onConfirm={() => void confirm(i, t.proposal!)}
                  onUndo={() => void undo(i, t)}
                  onDismiss={() => setTurns((all) => all.map((x, j) =>
                    j === i ? { ...x, proposal: null, state: undefined } : x))}
                />
              )}
            </div>
          ))}

          {busy && <div className="row" style={{ gap: 8 }}><span className="spin" /> 想一下…</div>}
        </div>

        <div className="row" style={{
          padding: 12, gap: 10, borderTop: '1px solid var(--line)' }}>
          <input
            className="btn grow" style={{ minHeight: 56, textAlign: 'left', padding: '0 14px' }}
            placeholder="说一句话…"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && text.trim() && !busy) void ask(text.trim());
            }}
            disabled={busy}
          />
          <button className="btn btn-primary" style={{ minHeight: 56, minWidth: 80 }}
                  disabled={busy || !text.trim()}
                  onClick={() => void ask(text.trim())}>问</button>
        </div>
      </div>
    </div>
  );
}

/**
 * 提案卡片。
 *
 * ⚠️ **`summary` 是前台唯一会读的东西**，所以它排在最上面、字最大。
 * 命令名和参数折在下面 —— 有人要查的时候能查到，但它不该抢走注意力。
 */
function ProposalCard({
  p, state, error, busy, undoLeftMs, canUndo, onConfirm, onUndo, onDismiss,
}: {
  p: Proposal;
  state: 'pending' | 'done' | 'undone' | 'failed';
  error?: string | undefined;
  busy: boolean;
  undoLeftMs: number;
  canUndo: boolean;
  onConfirm: () => void;
  onUndo: () => void;
  onDismiss: () => void;
}) {
  const [open, setOpen] = useState(false);
  const undoLeft = Math.max(0, Math.ceil(undoLeftMs / 1000));

  return (
    <div className="card stack" style={{
      padding: '16px 18px', gap: 12,
      borderWidth: 2,
      borderColor: state === 'failed' ? 'var(--danger)'
        : state === 'done' ? 'var(--brand)' : 'var(--line)',
    }}>
      <div style={{ fontSize: 'var(--text-lg)', fontWeight: 600 }}>{p.summary}</div>

      {state === 'pending' && (
        <>
          <div className="row" style={{ gap: 10 }}>
            <button className="btn btn-primary grow" style={{ minHeight: 56 }}
                    disabled={busy} onClick={onConfirm}>确认执行</button>
            <button className="btn" style={{ minHeight: 56 }}
                    disabled={busy} onClick={onDismiss}>不用了</button>
          </div>
          <button className="tiny muted" onClick={() => setOpen(!open)}
                  style={{ background: 'none', border: 0, cursor: 'pointer',
                           textAlign: 'left', padding: 0 }}>
            {open ? '收起' : '看看它具体要做什么 ›'}
          </button>
          {open && (
            <pre className="tiny" style={{
              margin: 0, padding: 10, overflowX: 'auto',
              background: 'var(--bg, #f6f6f6)', borderRadius: 6 }}>
{p.command}
{JSON.stringify(p.input, null, 2)}
            </pre>
          )}
        </>
      )}

      {state === 'done' && (
        <div className="row" style={{ gap: 10 }}>
          <span className="badge badge-ok grow">✓ 已执行</span>
          {canUndo && undoLeft > 0 ? (
            <button className="btn" style={{ minHeight: 56 }} disabled={busy} onClick={onUndo}>
              撤销（{undoLeft}s）
            </button>
          ) : (
            /*
              ⚠️ 撤不了的要**明说撤不了**，而不是不显示按钮让人以为
              自己没找到。「去日程表上改」是一句她能照着做的话
            */
            <span className="tiny muted">
              {canUndo ? '撤销时间已过' : '这一条撤不了，要改请到对应页面上改'}
            </span>
          )}
        </div>
      )}

      {state === 'undone' && <span className="badge badge-soft">↩ 已撤销</span>}

      {state === 'failed' && (
        <div className="badge badge-danger" style={{ padding: '10px 14px' }}>
          ✕ {error ?? '执行失败'}
        </div>
      )}
      {state !== 'failed' && error && (
        <div className="badge badge-danger" style={{ padding: '10px 14px' }}>✕ {error}</div>
      )}
    </div>
  );
}

/**
 * 撤销用的反向命令。**只处理反向操作完全确定的那几条。**
 *
 * ⚠️ 这是一张**白名单，不是一个通用撤销引擎**。判断标准只有一条：
 * 「反向命令能不能只由提案的入参和执行结果推出来」。
 *
 * 推不出来的一律不给撤销按钮，比如：
 *   · `appointment.reschedule` —— 要撤销得知道**原来**是几点，
 *     而那个值在提案里没有。给一个猜出来的时间比不给按钮危险得多。
 *   · `queue.update` —— 同理，不知道之前是什么状态。
 *   · `ticket.close` —— 结完账的单要作废走 `ticket.void`，
 *     那是一个要填原因的正式动作，不该藏在一个 60 秒的小按钮后面。
 *
 * 通用撤销（拿 `audit_log` 的 before 回放）是 Phase 3 的事，
 * 见 10-HANDOFF。在那之前，**说清楚哪些撤不了**比假装都能撤要好。
 */
function inverseOf(
  p: Proposal, result: Record<string, unknown>,
): { command: string; input: Record<string, unknown> } | null {
  switch (p.command) {
    case 'appointment.create': {
      const id = result['appointmentId'];
      if (typeof id !== 'string') return null;
      return {
        command: 'appointment.cancel',
        input: {
          appointmentId: id,
          reason: 'input_error',
          // 撤销一个刚建错的单，技师根本没开始做 —— 不该给他留轮次
          keepStaffTurn: false,
        },
      };
    }

    case 'rotation.setBreak': {
      const m = p.input['membershipId'];
      if (typeof m !== 'string') return null;
      return {
        command: 'rotation.setBreak',
        input: { membershipId: m, onBreak: !p.input['onBreak'], note: '撤销' },
      };
    }

    case 'staff.setRotation': {
      const m = p.input['membershipId'];
      if (typeof m !== 'string') return null;
      return {
        command: 'staff.setRotation',
        input: {
          membershipId: m,
          inRotation: !p.input['inRotation'],
          ...(typeof p.input['businessDate'] === 'string'
            ? { businessDate: p.input['businessDate'] } : {}),
        },
      };
    }

    case 'ticket.ungroup':
    case 'ticket.group':
      // 归组/拆组要撤销得知道原来的组，多条命令才能还原 —— 不做
      return null;

    default:
      return null;
  }
}

function describe(e: unknown): string {
  if (!(e instanceof ApiError)) return '执行失败';
  if (e.code === 'PERMISSION_DENIED') {
    return `你没有做这件事的权限（${String(e.details['need'] ?? '')}）`;
  }
  if (e.code === 'VALIDATION_FAILED') return '副驾给的参数不对，请手动操作';
  if (e.overridable) return '撞上了容量上限，请到对应页面上确认放行';
  return `执行失败（${e.code}）`;
}
