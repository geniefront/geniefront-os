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
import { Button } from '../ui/Button';
import { Field } from '../ui/Field';
import { Badge } from '../ui/Badge';
import { Card } from '../ui/Card';
import { Spinner } from '../ui/Spinner';

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
  /** 这张单是哪个营业日开的（0032） */
  businessDate: string;
  /** 距今几天。0 = 今天开的。>0 的是隔夜单，要单独成组 */
  daysAgo: number;
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
      <Card className="flex flex-col gap-3" onClick={(e) => e.stopPropagation()}
           style={{ width: 'min(660px,100%)', maxHeight: '94vh', overflow: 'auto',
                    padding: 24, gap: 16, borderRadius: '18px 18px 0 0' }}>

        <div className="flex items-center gap-3">
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <div className="text-2xl font-extrabold">
              {done ? '已结账' : '结账'}
            </div>
            <div className="text-ink-2">
              {payAll ? paying.map((t) => t.customerName).join('、') : ticket.customerName}
            </div>
          </div>
          <div className="text-2xl font-extrabold tnum">
            {money(done ? subtotal + done.tipCents : total)}
          </div>
        </div>

        {/* ⭐ 一起付：同组还有别人没结时才出现 */}
        {!done && others.length > 0 && (
          <Card asChild>
            <button
              type="button"
              onClick={() => setPayAll(!payAll)}
              aria-pressed={payAll}
              className="flex w-full cursor-pointer items-center gap-3 border-2 px-4 py-3.5 text-left"
              style={{
                borderColor: payAll ? 'var(--brand)' : 'var(--line)',
                background: payAll ? 'var(--brand-soft)' : 'var(--surface)',
              }}>
            <span className="text-xl">{payAll ? '☑' : '☐'}</span>
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <strong>这一位付全组（{others.length + 1} 人）</strong>
              <span className="text-xs text-ink-3">
                不勾就是各付各的 · 同组还有 {others.map((t) => t.customerName).join('、')}
              </span>
            </div>
            <span className="tnum font-bold">
              {money(others.reduce((s, t) => s + t.subtotalCents, 0) + ticket.subtotalCents)}
            </span>
            </button>
          </Card>
        )}

        {/* 项目明细 */}
        <Card className="flex flex-col gap-2 bg-ground p-3.5">
          {paying.flatMap((t) =>
            t.items.map((i) => (
              <div key={i.ticketItemId} className="flex items-center gap-2.5">
                <Badge tone="mute" >{i.staffName}</Badge>
                <span className="min-w-0 flex-1 truncate">
                  {i.name}
                  {payAll && <span className="text-xs text-ink-3"> · {t.customerName}</span>}
                </span>
                <span className="text-xs text-ink-3">{i.durationMin}min</span>
                <span className="tnum">{money(i.totalCents)}</span>
              </div>
            )))}
        </Card>

        {!done && (
          <>
            {/* 支付方式：只有两种（决策 19） */}
            <div className="flex flex-col gap-2">
              <div className="text-xs text-ink-3">怎么付</div>
              <div className="flex items-center gap-2.5">
                {([['cash', '💵 现金'], ['card', '💳 刷卡']] as const).map(([m, label]) => (
                  <Button className="min-w-0 flex-1" key={m} onClick={() => { setMethod(m); setTendered(''); }}
                          style={{
                            minHeight: 'var(--tap-lg)', borderWidth: 2,
                            borderColor: method === m ? 'var(--brand)' : 'var(--line)',
                            background: method === m ? 'var(--brand-soft)' : 'var(--surface)',
                          }}>{label}</Button>
                ))}
              </div>
              <div className="text-xs text-ink-3">Zelle、微信转账都按现金记</div>
            </div>

            {/* 小费 */}
            <div className="flex flex-col gap-2">
              <div className="text-xs text-ink-3">小费</div>
              <div className="flex items-center gap-2 flex-wrap">
                {TIP_PRESETS.map((p) => (
                  <Button className="min-w-0 flex-1" key={p} onClick={() => { setTipPct(p); setTipCustom(''); }}
                          style={{
                            minHeight: 56, borderWidth: 2, flexDirection: 'column', gap: 0,
                            borderColor: tipPct === p ? 'var(--brand)' : 'var(--line)',
                            background: tipPct === p ? 'var(--brand-soft)' : 'var(--surface)',
                          }}>
                    <span>{p === 0 ? '无' : `${p}%`}</span>
                    {p > 0 && <span className="text-xs text-ink-3">
                      {money(Math.round((subtotal * p) / 100))}</span>}
                  </Button>
                ))}
                <Field mono  style={{ width: 120 }} inputMode="decimal"
                       placeholder="自定义" value={tipCustom}
                       onChange={(e) => { setTipCustom(e.target.value); setTipPct(null); }} />
              </div>
            </div>

            {/* ⭐ 现金实收与找零 */}
            {method === 'cash' && (
              <div className="flex flex-col gap-2">
                <div className="text-xs text-ink-3">客人给了多少（不填就是刚好付清）</div>
                <div className="flex items-center gap-2 flex-wrap">
                  {QUICK_TENDER.filter((q) => q >= total).slice(0, 3).map((q) => (
                    <Button key={q} onClick={() => setTendered((q / 100).toFixed(2))}
                            style={{
                              minHeight: 56, borderWidth: 2,
                              borderColor: tenderedCents === q ? 'var(--brand)' : 'var(--line)',
                              background: tenderedCents === q ? 'var(--brand-soft)' : 'var(--surface)',
                            }}>{money(q)}</Button>
                  ))}
                  <Button onClick={() => setTendered((total / 100).toFixed(2))}
                          style={{ minHeight: 56 }}>刚好 {money(total)}</Button>
                  <Field mono  style={{ width: 130 }} inputMode="decimal"
                         placeholder="实收金额" value={tendered}
                         onChange={(e) => setTendered(e.target.value)} />
                </div>

                {tenderedCents > 0 && changeCents < 0 && (
                  <Card style={{
                    padding: 12, background: 'var(--warn-soft)', borderColor: 'var(--warn)' }}>
                    <span className="text-warn font-bold">
                      还差 {money(-changeCents)}
                    </span>
                  </Card>
                )}

                {canKeepChange && (
                  <Card className="flex flex-col gap-2.5" style={{ padding: 14,  background: 'var(--ok-soft)', borderColor: 'var(--ok)' }}>
                    <div className="flex items-center gap-3">
                      <strong className="min-w-0 flex-1 text-ok">
                        要找 {money(changeCents)}
                      </strong>
                    </div>
                    {/* 「不用找了」必须是一次点击就完成的动作 ——
                        客人正站在柜台前等着，前台没工夫心算小费该改成多少 */}
                    <Button block onClick={keepTheChange} style={{ minHeight: 'var(--tap-lg)', borderWidth: 2, borderColor: 'var(--ok)' }}>
                      客人说不用找了 → 记成小费 {money(changeCents)}
                    </Button>
                    <div className="text-xs text-ink-3">
                      不记的话，晚上点钞会平白多出 {money(changeCents)}，账对不上
                    </div>
                  </Card>
                )}
              </div>
            )}

            {err && (
              <Card role="alert" style={{
                padding: 14, background: 'var(--danger-soft)', borderColor: 'var(--danger)' }}>
                <span className="text-danger font-bold">✕ {err}</span>
              </Card>
            )}

            {voiding ? (
              <Card className="flex flex-col gap-3" style={{ padding: 16,  background: 'var(--warn-soft)', borderColor: 'var(--warn)' }}>
                <div className="font-extrabold text-warn">作废这一单</div>
                <div className="text-xs text-ink-3 text-warn">
                  记录会保留但不计入营业额。必须选原因。
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(150px,1fr))', gap: 8 }}>
                  {([['duplicate_booking', '重复开单'], ['walk_out', '客人走单'],
                    ['guest_changed_mind', '客人改主意'], ['input_error', '录入错误'],
                    ['paid_externally', '外部已结'], ['other', '其他']] as const).map(([v, l]) => (
                    <Button key={v} onClick={() => setVoidReason(v)}
                            style={{
                              minHeight: 52, borderWidth: 2,
                              borderColor: voidReason === v ? 'var(--warn)' : 'var(--line)',
                              background: voidReason === v ? '#fff' : 'transparent',
                            }}>{l}</Button>
                  ))}
                </div>
                <div className="flex items-center gap-2.5">
                  <Button className="min-w-0 flex-1" onClick={() => setVoiding(false)}>返回</Button>
                  <Button variant="primary" className="min-w-0 flex-1" disabled={!voidReason || busy} onClick={() => void doVoid()}>
                    {busy ? <Spinner /> : '确认作废'}
                  </Button>
                </div>
              </Card>
            ) : (
              <div className="flex items-center gap-2.5">
                <Button onClick={() => setVoiding(true)} disabled={busy}>作废</Button>
                <Button className="min-w-0 flex-1" onClick={onCancel} disabled={busy}>稍后</Button>
                <Button variant="primary" className="min-w-0 flex-1" disabled={busy || (tenderedCents > 0 && changeCents < 0)}
                        onClick={() => void close()}>
                  {busy ? <Spinner />
                    : changeCents > 0 ? `收 ${money(total)} · 找 ${money(changeCents)}`
                    : `收 ${money(total)}`}
                </Button>
              </div>
            )}
          </>
        )}

        {/* 结完之后：分配明细 + 微信复制 */}
        {done && (
          <>
            <Card className="flex flex-col gap-2.5" style={{ padding: 16,  background: 'var(--ok-soft)', borderColor: 'var(--ok)' }}>
              <div className="flex items-center gap-3">
                <strong className="min-w-0 flex-1 text-ok">小费分配</strong>
                <Badge tone="ok" >共 {money(done.tipCents)}</Badge>
              </div>
              {done.allocations.length === 0 && <div className="text-xs text-ink-3">这一单没有小费</div>}
              {done.allocations.map((a, i) => (
                <div key={i} className="flex flex-col gap-0.5">
                  <div className="flex items-center gap-3">
                    <strong className="min-w-0 flex-1">{a.name}</strong>
                    <Badge tone="mute" >
                      {a.source === 'cash' ? '现金·当天发' : '刷卡·进工资'}
                    </Badge>
                    <span className="tnum font-bold">
                      {money(a.amountCents)}
                    </span>
                  </div>
                  {/* 技师下班能看懂自己为什么分这么多 */}
                  <div className="text-xs text-ink-3">{a.explain}</div>
                </div>
              ))}
            </Card>

            <Button variant="primary" block onClick={() => void copyWechat()}>
              {copied ? '✓ 已复制' : '📋 复制分配明细（微信格式）'}
            </Button>
            <pre className="rounded border border-line bg-sunken text-xs text-ink-3" style={{
              padding: 12, margin: 0, whiteSpace: 'pre-wrap', background: 'var(--bg)',
              fontFamily: 'inherit', lineHeight: 1.6,
            }}>{wechatText}</pre>

            <Button block onClick={onCancel}>完成</Button>
          </>
        )}
      </Card>
    </div>
  );
}
