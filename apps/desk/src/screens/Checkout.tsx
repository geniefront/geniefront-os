/**
 * 结账 —— Phase 1a 的最后一环。
 *
 * 决策 22：顾客付现金还是刷卡，往往要到这一刻才知道，所以流程必须完整走完。
 * 结账后两条出口：正常入账，或作废（必选原因，记录保留但不计营业额）。
 *
 * 决策 19：只区分现金与刷卡。Zelle 按现金记，不记店内零钱流水。
 *
 * 小费分配【实时预览】而不是结完才看得到 —— 前台在按下结账之前
 * 就该知道每个人分多少，这也是「外部结算辅助」那个场景的入口（00 §1.6）。
 */

import { useMemo, useState } from 'react';
import { dollarsToCents } from '@gf/contracts';
import { ApiError, runCommand } from '../lib/api';

export interface OpenTicket {
  ticketId: string;
  customerName: string;
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

export function Checkout({
  ticket, membershipId, onDone, onCancel,
}: {
  ticket: OpenTicket;
  membershipId: string;
  onDone: () => Promise<unknown>;
  onCancel: () => void;
}) {
  const [method, setMethod] = useState<'cash' | 'card'>('cash');
  const [tipPct, setTipPct] = useState<number | null>(18);
  const [tipCustom, setTipCustom] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [done, setDone] = useState<{ allocations: Allocation[]; tipCents: number } | null>(null);
  const [voiding, setVoiding] = useState(false);
  const [voidReason, setVoidReason] = useState('');
  const [copied, setCopied] = useState(false);

  const tipCents = useMemo(() => {
    if (tipPct === null) return dollarsToCents(tipCustom);
    return Math.round((ticket.subtotalCents * tipPct) / 100);
  }, [tipPct, tipCustom, ticket.subtotalCents]);

  const total = ticket.subtotalCents + tipCents;

  /**
   * 微信格式明细（00 §1.6）。
   * 用 emoji 分隔不用 HTML —— 微信/iMessage 里粘过去要显示整齐。
   */
  const wechatText = useMemo(() => {
    if (!done) return '';
    const d = new Date();
    const when = `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    const head = `📋 ${ticket.customerName} | ${when}`;
    const items = ticket.items.map((i) =>
      `💇 ${i.staffName} - ${i.name} ${i.durationMin}min / ${money(i.totalCents)}`);
    const tips = done.allocations.map((a) =>
      `💰 ${a.name} 小费: ${money(a.amountCents)}${a.source === 'cash' ? '（现金）' : '（刷卡）'}`);
    return [head, ...items, ...tips, `合计: ${money(ticket.subtotalCents + done.tipCents)}`].join('\n');
  }, [done, ticket]);

  async function close() {
    setBusy(true); setErr('');
    try {
      const r = await runCommand<{ tipCents: number; allocations: Allocation[] }>(
        'ticket.close',
        {
          ticketId: ticket.ticketId,
          payments: [{ method, amountCents: total, tipCents }],
        },
        membershipId,
      );
      setDone({ allocations: r.result.allocations, tipCents: r.result.tipCents });
      await onDone();
    } catch (e) {
      setErr(e instanceof ApiError
        ? (e.code === 'HOUSE_CUT_FORBIDDEN'
            ? '小费策略里有雇主抽成，联邦法禁止 —— 请先改策略'
            : `结账失败（${e.code}）`)
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
            <div className="muted">{ticket.customerName}</div>
          </div>
          <div style={{ fontSize: 'var(--text-2xl)', fontWeight: 800,
                        fontVariantNumeric: 'tabular-nums' }}>
            {money(done ? ticket.subtotalCents + done.tipCents : total)}
          </div>
        </div>

        {/* 项目明细 */}
        <div className="card stack" style={{ padding: 14, gap: 8, background: 'var(--bg)' }}>
          {ticket.items.map((i) => (
            <div key={i.ticketItemId} className="row" style={{ gap: 10 }}>
              <span className="badge badge-mute">{i.staffName}</span>
              <span className="grow truncate">{i.name}</span>
              <span className="tiny">{i.durationMin}min</span>
              <span style={{ fontVariantNumeric: 'tabular-nums' }}>{money(i.totalCents)}</span>
            </div>
          ))}
        </div>

        {!done && (
          <>
            {/* 支付方式：只有两种（决策 19） */}
            <div className="stack" style={{ gap: 8 }}>
              <div className="tiny">怎么付</div>
              <div className="row" style={{ gap: 10 }}>
                {([['cash', '💵 现金'], ['card', '💳 刷卡']] as const).map(([m, label]) => (
                  <button key={m} className="btn grow" onClick={() => setMethod(m)}
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
                      {money(Math.round((ticket.subtotalCents * p) / 100))}</span>}
                  </button>
                ))}
                <input className="field field-mono" style={{ width: 120 }} inputMode="decimal"
                       placeholder="自定义" value={tipCustom}
                       onChange={(e) => { setTipCustom(e.target.value); setTipPct(null); }} />
              </div>
            </div>

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
                <button className="btn btn-primary grow" disabled={busy} onClick={() => void close()}>
                  {busy ? <span className="spin" /> : `收 ${money(total)}`}
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
