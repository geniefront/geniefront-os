/**
 * 打烊日结：点钞 → 现金进出 → 发现金小费 → 刷卡机对账 → 封账。
 *
 * 这一屏是老板每天最后一件事，也是他判断这套系统值不值月费的地方。
 * 三条设计立场：
 *
 *   1. **不追求「不许差」，追求「差额有出处」**。前台每天摸几千块现金，
 *      差几十块是常态。系统能说清差在哪一步就够了（04 §6）。
 *   2. **点钞是按面额点的**，不是拍脑袋填个总额。$20 那一行要输几张，
 *      老板照着数，数完总额自动出来。
 *   3. **发现金小费要能照着数钞票**。欠 $37.60 时给 $37 记着六毛 ——
 *      这一步以前记在本子上，现在记在系统里，明天自动加回去。
 *
 * 决策 19：现金进出条目全部可选，一条不填也能完成日结。
 */

import { useMemo, useState } from 'react';
import { dollarsToCents } from '@gf/contracts';
import { ApiError, runCommand } from '../lib/api';

const money = (c: number) => `$${(c / 100).toFixed(2)}`;
const signed = (c: number) => `${c < 0 ? '−' : '+'}${money(Math.abs(c))}`;

/** 与 @gf/payroll 的 DENOMINATIONS 一致，去掉了 $2（收藏品不是流通钞） */
const DENOMS = [10000, 5000, 2000, 1000, 500, 100, 25, 10, 5, 1] as const;
const denomLabel = (d: number) => (d >= 100 ? `$${d / 100}` : `${d}¢`);

export interface DayCloseData {
  businessDate: string;
  status: 'open' | 'counted' | 'closed';
  openingFloatCents: number;
  closingFloatCents: number;
  countBreakdown: Record<string, number>;
  countedCashCents: number | null;
  expectedCashCents: number;
  cashVarianceCents: number;
  cashVarianceReason: string | null;
  cardExpectedCents: number;
  cardTerminalCents: number | null;
  cardVarianceCents: number | null;
  cardVarianceReason: string | null;
  money: {
    grossCents: number; discountCents: number; netCents: number; taxCents: number;
    cashTakeCents: number; cardTakeCents: number;
    tipCashCents: number; tipCardCents: number;
    movementsCents: number; tipPaidOutCents: number;
  };
  openTicketCount: number;
  movements: Array<{ id: string; kind: string; amountCents: number; note: string | null; at: string }>;
  tipPayouts: Array<{
    membershipId: string; name: string;
    owedCents: number; payCents: number; carryOutCents: number;
    bills: Record<string, number>; alreadyPaidCents: number;
  }>;
  varianceThresholdCents: number;
}

const MOVEMENT_LABEL: Record<string, string> = {
  opening_float: '备用金',
  cash_drop: '取现存银行',
  supply_purchase: '买东西',
  payout_owner: '老板拿走',
  tip_payout: '发现金小费',
  other: '其他',
};

export function DayClose({
  data, membershipId, canPayTips, onChanged,
}: {
  data: DayCloseData;
  membershipId: string;
  canPayTips: boolean;
  onChanged: () => Promise<unknown>;
}) {
  const [bills, setBills] = useState<Record<number, string>>(() => {
    const init: Record<number, string> = {};
    for (const d of DENOMS) {
      const n = data.countBreakdown[String(d)];
      if (n) init[d] = String(n);
    }
    return init;
  });
  const [terminal, setTerminal] = useState(
    data.cardTerminalCents === null ? '' : (data.cardTerminalCents / 100).toFixed(2));
  const [cashReason, setCashReason] = useState(data.cashVarianceReason ?? '');
  const [cardReason, setCardReason] = useState(data.cardVarianceReason ?? '');
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');

  const [mvKind, setMvKind] = useState<'cash_drop' | 'supply_purchase' | 'payout_owner' | 'opening_float' | 'other'>('supply_purchase');
  const [mvAmount, setMvAmount] = useState('');
  const [mvNote, setMvNote] = useState('');

  const closed = data.status === 'closed';

  // 点钞合计【前端实时算】—— 老板一边数一边看总额跳，
  // 数完不用再点一次按钮才知道对不对
  const counted = useMemo(
    () => DENOMS.reduce((s, d) => s + d * (Number(bills[d] ?? 0) || 0), 0),
    [bills]);
  const hasBills = DENOMS.some((d) => (Number(bills[d] ?? 0) || 0) > 0);
  const liveCounted = hasBills ? counted : (data.countedCashCents ?? 0);
  const liveVariance = liveCounted - data.expectedCashCents;
  const needsCashReason = Math.abs(liveVariance) >= data.varianceThresholdCents;

  const terminalCents = dollarsToCents(terminal);
  const cardVariance = terminal ? terminalCents - data.cardExpectedCents : 0;

  const owedTotal = data.tipPayouts.reduce((s, p) => s + p.payCents, 0);

  async function run(name: string, input: unknown, tag: string) {
    setBusy(tag); setErr('');
    try {
      await runCommand(name, input, membershipId);
      await onChanged();
    } catch (e) {
      setErr(e instanceof ApiError
        ? e.code === 'VARIANCE_REASON_REQUIRED' ? '差异超过阈值，必须写清楚原因'
        : e.code === 'OPEN_TICKETS_REMAIN' ? '还有单没结完'
        : e.code === 'DAY_ALREADY_CLOSED' ? '这一天已经封账了'
        : `操作失败（${e.code}）`
        : '操作失败');
    } finally { setBusy(''); }
  }

  const saveCount = () => run('dayclose.saveCount', {
    businessDate: data.businessDate,
    breakdown: Object.fromEntries(
      DENOMS.filter((d) => (Number(bills[d] ?? 0) || 0) > 0)
        .map((d) => [String(d), Number(bills[d])])),
    ...(hasBills ? {} : { countedCashCents: liveCounted }),
    ...(terminal ? { cardTerminalCents: terminalCents } : {}),
    ...(cashReason ? { cashVarianceReason: cashReason } : {}),
    ...(cardReason ? { cardVarianceReason: cardReason } : {}),
  }, 'count');

  return (
    <div className="stack" style={{ padding: '0 16px 24px', gap: 14 }}>
      <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
        <strong style={{ fontSize: 'var(--text-xl)' }}>打烊日结 · {data.businessDate}</strong>
        <span className={`badge ${closed ? 'badge-ok' : data.status === 'counted' ? 'badge-warn' : 'badge-soft'}`}>
          {closed ? '已封账' : data.status === 'counted' ? '已点钞' : '未开始'}
        </span>
        {data.openTicketCount > 0 && (
          <span className="badge badge-warn">还有 {data.openTicketCount} 单没结</span>
        )}
      </div>

      {err && (
        <div className="card" role="alert" style={{
          padding: 14, background: 'var(--danger-soft)', borderColor: 'var(--danger)' }}>
          <span style={{ color: 'var(--danger)', fontWeight: 700 }}>✕ {err}</span>
        </div>
      )}

      {/* ── 今日营业 ─────────────────────────────────────────────────────── */}
      <div className="card stack" style={{ padding: 18, gap: 10 }}>
        <strong>今日营业</strong>
        <Line label="服务原价" value={data.money.grossCents} />
        <Line label="折扣" value={-data.money.discountCents} />
        <Line label="净额" value={data.money.netCents} bold />
        <div style={{ height: 1, background: 'var(--line)' }} />
        <Line label="现金收款（含小费）" value={data.money.cashTakeCents} />
        <Line label="刷卡收款（含小费）" value={data.money.cardTakeCents} />
        <Line label="其中现金小费" value={data.money.tipCashCents} muted />
        <Line label="其中刷卡小费" value={data.money.tipCardCents} muted />
      </div>

      {/* ── 现金进出 ─────────────────────────────────────────────────────── */}
      <div className="card stack" style={{ padding: 18, gap: 12 }}>
        <div className="row">
          <strong className="grow">现金进出</strong>
          <span className="tiny">可以一条都不填</span>
        </div>
        {data.movements.length === 0 && (
          <div className="tiny muted">今天没有记录任何现金进出</div>
        )}
        {data.movements.map((m) => (
          <div key={m.id} className="row" style={{ gap: 10 }}>
            <span className="badge badge-mute">{MOVEMENT_LABEL[m.kind] ?? m.kind}</span>
            <span className="grow truncate tiny">{m.note ?? ''}</span>
            <span style={{ fontVariantNumeric: 'tabular-nums',
                           color: m.amountCents < 0 ? 'var(--danger)' : 'var(--ok)' }}>
              {signed(m.amountCents)}
            </span>
          </div>
        ))}

        {!closed && (
          <div className="stack" style={{ gap: 8, paddingTop: 6, borderTop: '1px dashed var(--line)' }}>
            <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
              {(['supply_purchase', 'cash_drop', 'payout_owner', 'opening_float', 'other'] as const).map((k) => (
                <button key={k} className="btn" onClick={() => setMvKind(k)}
                        style={{
                          minHeight: 52, borderWidth: 2,
                          borderColor: mvKind === k ? 'var(--brand)' : 'var(--line)',
                          background: mvKind === k ? 'var(--brand-soft)' : 'var(--surface)',
                        }}>{MOVEMENT_LABEL[k]}</button>
              ))}
            </div>
            <div className="row" style={{ gap: 8 }}>
              <input className="field field-mono" style={{ width: 140 }} inputMode="decimal"
                     placeholder="金额" value={mvAmount}
                     onChange={(e) => setMvAmount(e.target.value)} />
              <input className="field grow" placeholder="备注（买了什么、谁拿的）"
                     value={mvNote} onChange={(e) => setMvNote(e.target.value)} />
              <button className="btn" disabled={!mvAmount || busy === 'mv'}
                      onClick={() => {
                        // 备用金是进抽屉，其余默认出抽屉 —— 前台不用记正负号
                        const abs = Math.abs(dollarsToCents(mvAmount));
                        void run('dayclose.recordCash', {
                          businessDate: data.businessDate,
                          kind: mvKind,
                          amountCents: mvKind === 'opening_float' ? abs : -abs,
                          ...(mvNote ? { note: mvNote } : {}),
                        }, 'mv').then(() => { setMvAmount(''); setMvNote(''); });
                      }}>
                {busy === 'mv' ? <span className="spin" /> : '记一笔'}
              </button>
            </div>
            <div className="tiny">
              买东西 / 取现存银行 / 老板拿走都记成出账，备用金记成进账
            </div>
          </div>
        )}
      </div>

      {/* ── 现金小费发放 ─────────────────────────────────────────────────── */}
      {data.tipPayouts.length > 0 && (
        <div className="card stack" style={{
          padding: 18, gap: 12, borderColor: 'var(--ok)', background: 'var(--ok-soft)' }}>
          <div className="row">
            <strong className="grow" style={{ color: 'var(--ok)' }}>今晚发现金小费</strong>
            <span className="badge badge-ok">共 {money(owedTotal)}</span>
          </div>

          {data.tipPayouts.map((p) => (
            <div key={p.membershipId} className="stack" style={{ gap: 4 }}>
              <div className="row">
                <strong className="grow">{p.name}</strong>
                {p.alreadyPaidCents > 0 && (
                  <span className="badge badge-mute">已发 {money(p.alreadyPaidCents)}</span>
                )}
                <span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 700 }}>
                  {money(p.payCents)}
                </span>
              </div>
              {/* 老板照着这一行数钞票 */}
              <div className="tiny">
                {Object.entries(p.bills).length > 0
                  ? Object.entries(p.bills)
                      .sort((a, b) => Number(b[0]) - Number(a[0]))
                      .map(([d, n]) => `${denomLabel(Number(d))} × ${n}`).join('  ')
                  : '不用给钞票'}
                {p.carryOutCents !== 0 && ` · 零头 ${money(p.carryOutCents)} 记到明天`}
              </div>
            </div>
          ))}

          {!closed && canPayTips && (
            <button className="btn btn-primary btn-block" disabled={busy === 'tips' || owedTotal === 0}
                    onClick={() => void run('dayclose.payTips',
                      { businessDate: data.businessDate, roundToCents: 100 }, 'tips')}>
              {busy === 'tips' ? <span className="spin" /> : `✓ 已数清并发放 ${money(owedTotal)}`}
            </button>
          )}
          {!closed && !canPayTips && (
            <div className="tiny">你没有发放现金小费的权限，让老板或店长来点这一步</div>
          )}
          <div className="tiny">
            发放会自动记一笔现金出账，点钞时就对得上了。零头自动结转到明天。
          </div>
        </div>
      )}

      {/* ── 点钞 ─────────────────────────────────────────────────────────── */}
      <div className="card stack" style={{ padding: 18, gap: 12 }}>
        <div className="row">
          <strong className="grow">点钞</strong>
          <span className="tiny">按面额填张数</span>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(120px,1fr))', gap: 8 }}>
          {DENOMS.map((d) => (
            <label key={d} className="row" style={{ gap: 8 }}>
              <span style={{ width: 44, fontWeight: 700 }}>{denomLabel(d)}</span>
              <input className="field field-mono grow" inputMode="numeric" disabled={closed}
                     style={{ minWidth: 0 }}
                     value={bills[d] ?? ''} placeholder="0"
                     onChange={(e) => setBills({ ...bills, [d]: e.target.value.replace(/\D/g, '') })} />
            </label>
          ))}
        </div>

        <div className="row" style={{ paddingTop: 8, borderTop: '1px solid var(--line)' }}>
          <span className="grow">点出来</span>
          <strong style={{ fontSize: 'var(--text-xl)', fontVariantNumeric: 'tabular-nums' }}>
            {money(liveCounted)}
          </strong>
        </div>
        <Line label="系统认为应该有" value={data.expectedCashCents} />
        <div className="row">
          <span className="grow">差异</span>
          <strong style={{
            fontSize: 'var(--text-xl)', fontVariantNumeric: 'tabular-nums',
            color: liveVariance === 0 ? 'var(--ok)'
              : needsCashReason ? 'var(--danger)' : 'var(--warn)',
          }}>
            {liveVariance === 0 ? '✓ 对上了' : signed(liveVariance)}
          </strong>
        </div>

        {needsCashReason && !closed && (
          <div className="stack" style={{ gap: 6 }}>
            <div className="tiny" style={{ color: 'var(--danger)' }}>
              差得比 {money(data.varianceThresholdCents)} 多，封账前必须写清楚原因
            </div>
            <input className="field" placeholder="例：中午找错钱给了客人 / 有一单收了现金忘了开单"
                   value={cashReason} onChange={(e) => setCashReason(e.target.value)} />
          </div>
        )}

        <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
          <label className="row tiny" style={{ gap: 6 }}>
            留给明天的备用金
            <span style={{ fontVariantNumeric: 'tabular-nums' }}>
              {money(data.closingFloatCents)}
            </span>
          </label>
          <span className="grow" />
          {!closed && (
            <button className="btn" disabled={busy === 'count'} onClick={() => void saveCount()}>
              {busy === 'count' ? <span className="spin" /> : '保存点钞'}
            </button>
          )}
        </div>
      </div>

      {/* ── 刷卡机物理对账 ───────────────────────────────────────────────── */}
      <div className="card stack" style={{ padding: 18, gap: 12 }}>
        <div className="row">
          <strong className="grow">刷卡机对账</strong>
          <span className="tiny">照着终端打出的小票敲</span>
        </div>
        <Line label="系统刷卡收款（含小费）" value={data.cardExpectedCents} />
        <div className="row" style={{ gap: 8 }}>
          <span className="grow">刷卡机 batch total</span>
          <input className="field field-mono" style={{ width: 160 }} inputMode="decimal"
                 disabled={closed} placeholder="0.00" value={terminal}
                 onChange={(e) => setTerminal(e.target.value)} />
        </div>
        {terminal !== '' && (
          <div className="row">
            <span className="grow">差异</span>
            <strong style={{
              fontVariantNumeric: 'tabular-nums',
              color: cardVariance === 0 ? 'var(--ok)' : 'var(--danger)',
            }}>
              {cardVariance === 0 ? '✓ 一分不差' : signed(cardVariance)}
            </strong>
          </div>
        )}
        {terminal !== '' && cardVariance !== 0 && !closed && (
          <div className="stack" style={{ gap: 6 }}>
            {/* 刷卡不该有磨损，差一分就是漏单或重复刷 */}
            <div className="tiny" style={{ color: 'var(--danger)' }}>
              刷卡不该有磨损。差了就是漏单、重复刷、或者有一笔退款没记 —— 必须写原因
            </div>
            <input className="field" placeholder="例：有一单刷了两次，已经找银行冲掉"
                   value={cardReason} onChange={(e) => setCardReason(e.target.value)} />
          </div>
        )}
      </div>

      {/* ── 封账 ─────────────────────────────────────────────────────────── */}
      {!closed ? (
        <button className="btn btn-primary btn-block" style={{ minHeight: 'var(--tap-lg)' }}
                disabled={busy === 'final' || data.countedCashCents === null}
                onClick={() => void run('dayclose.finalize', {
                  businessDate: data.businessDate,
                  force: data.openTicketCount > 0,
                }, 'final')}>
          {busy === 'final' ? <span className="spin" />
            : data.countedCashCents === null ? '先保存点钞才能封账'
            : data.openTicketCount > 0 ? `封账（${data.openTicketCount} 单未结会留到明天）`
            : '封账'}
        </button>
      ) : (
        <div className="card row" style={{
          padding: 18, gap: 10, background: 'var(--ok-soft)', borderColor: 'var(--ok)' }}>
          <strong className="grow" style={{ color: 'var(--ok)' }}>
            ✓ 这一天已封账，单据不能再改
          </strong>
          <button className="btn" disabled={busy === 'reopen'}
                  onClick={() => {
                    const reason = window.prompt('重新打开这一天的原因？（会记进流水）');
                    if (reason) void run('dayclose.reopen',
                      { businessDate: data.businessDate, reason }, 'reopen');
                  }}>
            重新打开
          </button>
        </div>
      )}
    </div>
  );
}

function Line({ label, value, bold, muted }: {
  label: string; value: number; bold?: boolean; muted?: boolean;
}) {
  return (
    <div className="row">
      <span className={`grow ${muted ? 'tiny' : ''}`}>{label}</span>
      <span style={{
        fontVariantNumeric: 'tabular-nums',
        fontWeight: bold ? 700 : 400,
        fontSize: muted ? 'var(--text-sm)' : undefined,
      }}>{money(value)}</span>
    </div>
  );
}
