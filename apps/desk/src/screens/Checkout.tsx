/**
 * 结账。
 *
 * 决策 22：顾客付现金还是刷卡，往往要到这一刻才知道，所以流程必须完整走完。
 * 结账后两条出口：正常入账，或作废（必选原因，记录保留但不计营业额）。
 *
 * 决策 19：只区分现金与刷卡。Zelle 默认按现金记。
 *
 * Phase 1b 补了两件真店里天天发生、但 1a 表达不了的事：
 *
 *   ⭐ **现金实收与「不用找了」**：客人给 $100 做 $85 的活儿说不用找了，
 *      那 $15 必须记成小费。不记的话打烊点钞会平白多出 $15，
 *      而老板唯一能怀疑的对象是前台。
 *
 *   ⭐ **组单合并结账**：一起来的几位，一个人付全部。钱按各单金额摊回去，
 *      提成和小费照常各算各的 —— 合并的只是「谁掏的钱」。
 *
 * 小费分配【实时预览】而不是结完才看得到 —— 前台在按下结账之前
 * 就该知道每个人分多少（00 §1.6）。
 */

import { useMemo, useState } from 'react';
import { dollarsToCents } from '@gf/contracts';
import { ApiError, runCommand } from '../lib/api';

export interface OpenTicket {
  ticketId: string;
  customerName: string;
  groupId?: string | null;
  groupLabel?: string | null;
  items: Array<{
    ticketItemId: string; name: string; totalCents: number;
    durationMin: number; staffName: string; membershipId: string;
  }>;
  subtotalCents: number;
}

interface Allocation {
  membershipId: string; name: string; amountCents: number;
  source: 'cash' | 'card'; explain: string;
}

const money = (c: number) => `$${(c / 100).toFixed(2)}`;
const TIP_PRESETS = [0, 15, 18, 20, 25];
/** 客人最常掏的几张。$100 那个按钮一天要按几十次 */
const QUICK_TENDER = [2000, 4000, 5000, 6000, 10000];

export function Checkout({
  ticket, groupTickets, membershipId, onDone, onCancel,
}: {
  ticket: OpenTicket;
  /** 同组的其他单。传了就出现「一起付」开关 */
  groupTickets?: OpenTicket[] | undefined;
  membershipId: string;
  onDone: () => Promise<unknown>;
  onCancel: () => void;
}) {
  const [method, setMethod] = useState<'cash' | 'card'>('cash');
  const [tipPct, setTipPct] = useState<number | null>(18);
  const [tipCustom, setTipCustom] = useState('');
  const [tendered, setTendered] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [done, setDone] = useState<{ allocations: Allocation[]; tipCents: number } | null>(null);
  const [voiding, setVoiding] = useState(false);
  const [voidReason, setVoidReason] = useState('');
  const [copied, setCopied] = useState(false);
  const [payAll, setPayAll] = useState(false);

  const others = groupTickets?.filter((t) => t.ticketId !== ticket.ticketId) ?? [];
  const paying = payAll ? [ticket, ...others] : [ticket];
  const subtotal = paying.reduce((s, t) => s + t.subtotalCents, 0);

  const tipCents = useMemo(() => {
    if (tipPct === null) return dollarsToCents(tipCustom);
    return Math.round((subtotal * tipPct) / 100);
  }, [tipPct, tipCustom, subtotal]);

  const total = subtotal + tipCents;

  // ── 现金找零 ──────────────────────────────────────────────────────────────
  const tenderedCents = method === 'cash' ? dollarsToCents(tendered) : 0;
  const changeCents = tenderedCents > 0 ? tenderedCents - total : 0;
  const canKeepChange = method === 'cash' && changeCents > 0;

  /**
   * 「不用找了」：把找零直接加进小费。
   * 做成一个动作而不是让前台自己改小费金额 —— 后者要心算，
   * 而这一步是在客人站在柜台前等着的时候做的。
   */
  function keepTheChange() {
    setTipPct(null);
    setTipCustom(((tipCents + changeCents) / 100).toFixed(2));
  }

  const wechatText = useMemo(() => {
    if (!done) return '';
    const d = new Date();
    const when = `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    const head = `📋 ${paying.map((t) => t.customerName).join(' + ')} | ${when}`;
    const items = paying.flatMap((t) => t.items).map((i) =>
      `💇 ${i.staffName} - ${i.name} ${i.durationMin}min / ${money(i.totalCents)}`);
    const tips = done.allocations.map((a) =>
      `💰 ${a.name} 小费: ${money(a.amountCents)}${a.source === 'cash' ? '（现金）' : '（刷卡）'}`);
    return [head, ...items, ...tips, `合计: ${money(subtotal + done.tipCents)}`].join('\n');
  }, [done, paying, subtotal]);

  function paymentLine() {
    return {
      method,
      amountCents: total,
      tipCents,
      ...(method === 'cash' && tenderedCents > 0
        ? { tenderedCents, changeCents: Math.max(0, tenderedCents - total) }
        : {}),
    };
  }

  async function close() {
    setBusy(true); setErr('');
    try {
      const r = payAll && ticket.groupId
        ? await runCommand<{ tickets: Array<{ tipCents: number }>; allocations: Allocation[] }>(
            'ticket.closeGroup',
            {
              groupId: ticket.groupId,
              ticketIds: paying.map((t) => t.ticketId),
              payments: [paymentLine()],
              payerTicketId: ticket.ticketId,
            },
            membershipId,
          ).then((res) => ({
            result: {
              allocations: res.result.allocations,
              tipCents: res.result.tickets.reduce((s, t) => s + t.tipCents, 0),
            },
          }))
        : await runCommand<{ tipCents: number; allocations: Allocation[] }>(
            'ticket.close',
            { ticketId: ticket.ticketId, payments: [paymentLine()] },
            membershipId,
          );
      setDone({ allocations: r.result.allocations, tipCents: r.result.tipCents });
      await onDone();
    } catch (e) {
      setErr(e instanceof ApiError
        ? e.code === 'HOUSE_CUT_FORBIDDEN'
          ? '小费策略里有雇主抽成，联邦法禁止 —— 请先改策略'
          : e.code === 'PAYMENT_MISMATCH'
            ? '收款金额和单据对不上，请重新确认'
            : e.code === 'DAY_ALREADY_CLOSED'
              ? '这一天已经封账了，要改先在日结页重新打开'
              : `结账失败（${e.code}）`
        : '结账失败');
    } finally { setBusy(false); }
  }

  async function doVoid() {
    setBusy(true); setErr('');
    try {
      await runCommand('ticket.void',
        { ticketId: ticket.ticketId, reason: voidReason }, membershipId);
      await onDone();
      onCancel();
    } catch (e) {
      setErr(e instanceof ApiError ? `作废失败（${e.code}）` : '作废失败');
    } finally { setBusy(false); }
  }

  async function copyWechat() {
    try {
      await navigator.clipboard.writeText(wechatText);
      setCopied(true); setTimeout(() => setCopied(false), 2000);
    } catch { setErr('复制失败，请手动选中'); }
  }

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(20,18,16,.45)',
      display: 'grid', placeItems: 'end center', zIndex: 50,
    }} onClick={done ? undefined : onCancel}>
      <div className="card stack" onClick={(e) => e.stopPropagation()}
           style={{ width: 'min(660px,100%)', maxHeight: '94vh', overflow: 'auto',
                    padding: 24, gap: 16, borderRadius: '18px 18px 0 0' }}>

        <div className="row">
          <div className="grow stack" style={{ gap: 2 }}>
            <div style={{ fontSize: 'var(--text-2xl)', fontWeight: 800 }}>
              {done ? '已结账' : '结账'}
            </div>
            <div className="muted">
              {payAll ? paying.map((t) => t.customerName).join('、') : ticket.customerName}
            </div>
          </div>
          <div style={{ fontSize: 'var(--text-2xl)', fontWeight: 800,
                        fontVariantNumeric: 'tabular-nums' }}>
            {money(done ? subtotal + done.tipCents : total)}
          </div>
        </div>

        {/* ⭐ 一起付：同组还有别人没结时才出现 */}
        {!done && others.length > 0 && (
          <button className="card row" onClick={() => setPayAll(!payAll)}
                  style={{
                    padding: '14px 16px', gap: 12, cursor: 'pointer', textAlign: 'left',
                    borderWidth: 2,
                    borderColor: payAll ? 'var(--brand)' : 'var(--line)',
                    background: payAll ? 'var(--brand-soft)' : 'var(--surface)',
                  }}>
            <span style={{ fontSize: 'var(--text-xl)' }}>{payAll ? '☑' : '☐'}</span>
            <div className="grow stack" style={{ gap: 2 }}>
              <strong>这一位付全组（{others.length + 1} 人）</strong>
              <span className="tiny">
                不勾就是各付各的 · 同组还有 {others.map((t) => t.customerName).join('、')}
              </span>
            </div>
            <span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 700 }}>
              {money(others.reduce((s, t) => s + t.subtotalCents, 0) + ticket.subtotalCents)}
            </span>
          </button>
        )}

        {/* 项目明细 */}
        <div className="card stack" style={{ padding: 14, gap: 8, background: 'var(--bg)' }}>
          {paying.flatMap((t) =>
            t.items.map((i) => (
              <div key={i.ticketItemId} className="row" style={{ gap: 10 }}>
                <span className="badge badge-mute">{i.staffName}</span>
                <span className="grow truncate">
                  {i.name}
                  {payAll && <span className="tiny"> · {t.customerName}</span>}
                </span>
                <span className="tiny">{i.durationMin}min</span>
                <span style={{ fontVariantNumeric: 'tabular-nums' }}>{money(i.totalCents)}</span>
              </div>
            )))}
        </div>

        {!done && (
          <>
            {/* 支付方式：只有两种（决策 19） */}
            <div className="stack" style={{ gap: 8 }}>
              <div className="tiny">怎么付</div>
              <div className="row" style={{ gap: 10 }}>
                {([['cash', '💵 现金'], ['card', '💳 刷卡']] as const).map(([m, label]) => (
                  <button key={m} className="btn grow"
                          onClick={() => { setMethod(m); setTendered(''); }}
                          style={{
                            minHeight: 'var(--tap-lg)', borderWidth: 2,
                            borderColor: method === m ? 'var(--brand)' : 'var(--line)',
                            background: method === m ? 'var(--brand-soft)' : 'var(--surface)',
                          }}>{label}</button>
                ))}
              </div>
              <div className="tiny">Zelle、微信转账都按现金记</div>
            </div>

            {/* 小费 */}
            <div className="stack" style={{ gap: 8 }}>
              <div className="tiny">小费</div>
              <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                {TIP_PRESETS.map((p) => (
                  <button key={p} className="btn grow" onClick={() => { setTipPct(p); setTipCustom(''); }}
                          style={{
                            minHeight: 56, borderWidth: 2, flexDirection: 'column', gap: 0,
                            borderColor: tipPct === p ? 'var(--brand)' : 'var(--line)',
                            background: tipPct === p ? 'var(--brand-soft)' : 'var(--surface)',
                          }}>
                    <span>{p === 0 ? '无' : `${p}%`}</span>
                    {p > 0 && <span className="tiny">
                      {money(Math.round((subtotal * p) / 100))}</span>}
                  </button>
                ))}
                <input className="field field-mono" style={{ width: 120 }} inputMode="decimal"
                       placeholder="自定义" value={tipCustom}
                       onChange={(e) => { setTipCustom(e.target.value); setTipPct(null); }} />
              </div>
            </div>

            {/* ⭐ 现金实收与找零 */}
            {method === 'cash' && (
              <div className="stack" style={{ gap: 8 }}>
                <div className="tiny">客人给了多少（不填就是刚好付清）</div>
                <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                  {QUICK_TENDER.filter((q) => q >= total).slice(0, 3).map((q) => (
                    <button key={q} className="btn" onClick={() => setTendered((q / 100).toFixed(2))}
                            style={{
                              minHeight: 56, borderWidth: 2,
                              borderColor: tenderedCents === q ? 'var(--brand)' : 'var(--line)',
                              background: tenderedCents === q ? 'var(--brand-soft)' : 'var(--surface)',
                            }}>{money(q)}</button>
                  ))}
                  <button className="btn" onClick={() => setTendered((total / 100).toFixed(2))}
                          style={{ minHeight: 56 }}>刚好 {money(total)}</button>
                  <input className="field field-mono" style={{ width: 130 }} inputMode="decimal"
                         placeholder="实收金额" value={tendered}
                         onChange={(e) => setTendered(e.target.value)} />
                </div>

                {tenderedCents > 0 && changeCents < 0 && (
                  <div className="card" style={{
                    padding: 12, background: 'var(--warn-soft)', borderColor: 'var(--warn)' }}>
                    <span style={{ color: 'var(--warn)', fontWeight: 700 }}>
                      还差 {money(-changeCents)}
                    </span>
                  </div>
                )}

                {canKeepChange && (
                  <div className="card stack" style={{
                    padding: 14, gap: 10, background: 'var(--ok-soft)', borderColor: 'var(--ok)' }}>
                    <div className="row">
                      <strong className="grow" style={{ color: 'var(--ok)' }}>
                        要找 {money(changeCents)}
                      </strong>
                    </div>
                    {/* 「不用找了」必须是一次点击就完成的动作 ——
                        客人正站在柜台前等着，前台没工夫心算小费该改成多少 */}
                    <button className="btn btn-block" onClick={keepTheChange}
                            style={{ minHeight: 'var(--tap-lg)', borderWidth: 2,
                                     borderColor: 'var(--ok)' }}>
                      客人说不用找了 → 记成小费 {money(changeCents)}
                    </button>
                    <div className="tiny">
                      不记的话，晚上点钞会平白多出 {money(changeCents)}，账对不上
                    </div>
                  </div>
                )}
              </div>
            )}

            {err && (
              <div className="card" role="alert" style={{
                padding: 14, background: 'var(--danger-soft)', borderColor: 'var(--danger)' }}>
                <span style={{ color: 'var(--danger)', fontWeight: 700 }}>✕ {err}</span>
              </div>
            )}

            {voiding ? (
              <div className="card stack" style={{
                padding: 16, gap: 12, background: 'var(--warn-soft)', borderColor: 'var(--warn)' }}>
                <div style={{ fontWeight: 800, color: 'var(--warn)' }}>作废这一单</div>
                <div className="tiny" style={{ color: 'var(--warn)' }}>
                  记录会保留但不计入营业额。必须选原因。
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(150px,1fr))', gap: 8 }}>
                  {([['duplicate_booking', '重复开单'], ['walk_out', '客人走单'],
                    ['guest_changed_mind', '客人改主意'], ['input_error', '录入错误'],
                    ['paid_externally', '外部已结'], ['other', '其他']] as const).map(([v, l]) => (
                    <button key={v} className="btn" onClick={() => setVoidReason(v)}
                            style={{
                              minHeight: 52, borderWidth: 2,
                              borderColor: voidReason === v ? 'var(--warn)' : 'var(--line)',
                              background: voidReason === v ? '#fff' : 'transparent',
                            }}>{l}</button>
                  ))}
                </div>
                <div className="row" style={{ gap: 10 }}>
                  <button className="btn grow" onClick={() => setVoiding(false)}>返回</button>
                  <button className="btn btn-primary grow" disabled={!voidReason || busy}
                          onClick={() => void doVoid()}>
                    {busy ? <span className="spin" /> : '确认作废'}
                  </button>
                </div>
              </div>
            ) : (
              <div className="row" style={{ gap: 10 }}>
                <button className="btn" onClick={() => setVoiding(true)} disabled={busy}>作废</button>
                <button className="btn grow" onClick={onCancel} disabled={busy}>稍后</button>
                <button className="btn btn-primary grow"
                        disabled={busy || (tenderedCents > 0 && changeCents < 0)}
                        onClick={() => void close()}>
                  {busy ? <span className="spin" />
                    : changeCents > 0 ? `收 ${money(total)} · 找 ${money(changeCents)}`
                    : `收 ${money(total)}`}
                </button>
              </div>
            )}
          </>
        )}

        {/* 结完之后：分配明细 + 微信复制 */}
        {done && (
          <>
            <div className="card stack" style={{
              padding: 16, gap: 10, background: 'var(--ok-soft)', borderColor: 'var(--ok)' }}>
              <div className="row">
                <strong className="grow" style={{ color: 'var(--ok)' }}>小费分配</strong>
                <span className="badge badge-ok">共 {money(done.tipCents)}</span>
              </div>
              {done.allocations.length === 0 && <div className="tiny">这一单没有小费</div>}
              {done.allocations.map((a, i) => (
                <div key={i} className="stack" style={{ gap: 2 }}>
                  <div className="row">
                    <strong className="grow">{a.name}</strong>
                    <span className="badge badge-mute">
                      {a.source === 'cash' ? '现金·当天发' : '刷卡·进工资'}
                    </span>
                    <span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 700 }}>
                      {money(a.amountCents)}
                    </span>
                  </div>
                  {/* 技师下班能看懂自己为什么分这么多 */}
                  <div className="tiny">{a.explain}</div>
                </div>
              ))}
            </div>

            <button className="btn btn-primary btn-block" onClick={() => void copyWechat()}>
              {copied ? '✓ 已复制' : '📋 复制分配明细（微信格式）'}
            </button>
            <pre className="card tiny" style={{
              padding: 12, margin: 0, whiteSpace: 'pre-wrap', background: 'var(--bg)',
              fontFamily: 'inherit', lineHeight: 1.6,
            }}>{wechatText}</pre>

            <button className="btn btn-block" onClick={onCancel}>完成</button>
          </>
        )}
      </div>
    </div>
  );
}
