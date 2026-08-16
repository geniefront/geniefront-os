/**
 * 技师当日收入看板。
 *
 * 这一屏是给**技师本人**看的，即使它长在前台电脑上：
 * 下班前技师会围过来问「我今天多少」，前台把这一页转过去就行。
 *
 * 三条设计约束：
 *   1. 每个数字都能点开看依据 —— 技师质疑提成是常态，说不清就变成人事矛盾
 *   2. 现金小费单独标出来 —— 那是今晚就要拿到手的钱，和进工资的刷卡小费不是一回事
 *   3. 没有 payroll.view_all 的人只看得到自己那一行（后端已经过滤，这里不额外做）
 */

import { useState } from 'react';

const money = (c: number) => `$${(c / 100).toFixed(2)}`;
const hours = (min: number) => `${(min / 60).toFixed(1)}h`;

export interface StaffEarning {
  membershipId: string;
  name: string;
  serviceRevenueCents: number;
  commissionCents: number;
  tipCashCents: number;
  tipCardCents: number;
  hourlyCents: number;
  minutesWorked: number;
  payCents: number;
  paidBy: 'commission' | 'hourly' | 'none';
  note: string;
  ticketCount: number;
  cashTipOwedCents: number;
}

export interface EarningsBoard {
  businessDate: string;
  staff: StaffEarning[];
  totals: {
    serviceRevenueCents: number;
    commissionCents: number;
    tipCashCents: number;
    tipCardCents: number;
    payCents: number;
  };
}

export function Earnings({ data }: { data: EarningsBoard }) {
  const [open, setOpen] = useState<string | null>(null);

  if (data.staff.length === 0) {
    return (
      <div className="card" style={{ margin: 16, padding: 28, textAlign: 'center' }}>
        <div className="muted">今天还没有结账的单</div>
        <div className="tiny" style={{ marginTop: 6 }}>结完账就会出现在这里</div>
      </div>
    );
  }

  return (
    <div className="stack" style={{ padding: '0 16px 24px', gap: 12 }}>
      <div className="card row" style={{ padding: '14px 18px', gap: 16, flexWrap: 'wrap' }}>
        <div className="stack" style={{ gap: 2 }}>
          <span className="tiny">营业额</span>
          <strong style={{ fontSize: 'var(--text-xl)', fontVariantNumeric: 'tabular-nums' }}>
            {money(data.totals.serviceRevenueCents)}
          </strong>
        </div>
        <div className="stack" style={{ gap: 2 }}>
          <span className="tiny">提成合计</span>
          <strong style={{ fontSize: 'var(--text-xl)', fontVariantNumeric: 'tabular-nums' }}>
            {money(data.totals.commissionCents)}
          </strong>
        </div>
        <div className="stack" style={{ gap: 2 }}>
          <span className="tiny">现金小费（今晚发）</span>
          <strong style={{ fontSize: 'var(--text-xl)', color: 'var(--ok)',
                           fontVariantNumeric: 'tabular-nums' }}>
            {money(data.totals.tipCashCents)}
          </strong>
        </div>
        <div className="stack" style={{ gap: 2 }}>
          <span className="tiny">刷卡小费（进工资）</span>
          <strong style={{ fontSize: 'var(--text-xl)', fontVariantNumeric: 'tabular-nums' }}>
            {money(data.totals.tipCardCents)}
          </strong>
        </div>
        <span className="grow" />
        <span className="badge badge-soft">{data.businessDate}</span>
      </div>

      {data.staff.map((s) => (
        <div key={s.membershipId} className="card stack" style={{ padding: 0, gap: 0 }}>
          <button className="row" onClick={() => setOpen(open === s.membershipId ? null : s.membershipId)}
                  style={{ padding: '16px 18px', gap: 14, textAlign: 'left',
                           background: 'transparent', border: 0, cursor: 'pointer' }}>
            <div className="grow stack" style={{ gap: 4 }}>
              <strong style={{ fontSize: 'var(--text-xl)' }}>{s.name}</strong>
              <div className="tiny">
                {s.ticketCount} 单 · 营业额 {money(s.serviceRevenueCents)}
                {s.minutesWorked > 0 && ` · 在岗 ${hours(s.minutesWorked)}`}
              </div>
            </div>
            {s.cashTipOwedCents > 0 && (
              <span className="badge badge-ok">现金待发 {money(s.cashTipOwedCents)}</span>
            )}
            <div className="stack" style={{ gap: 2, alignItems: 'flex-end' }}>
              <strong style={{ fontSize: 'var(--text-xl)', fontVariantNumeric: 'tabular-nums' }}>
                {money(s.payCents)}
              </strong>
              <span className="tiny">{open === s.membershipId ? '收起 ▲' : '看明细 ▼'}</span>
            </div>
          </button>

          {open === s.membershipId && (
            <div className="stack" style={{
              padding: '0 18px 16px', gap: 8, borderTop: '1px solid var(--line)' }}>
              <Row label={s.paidBy === 'hourly' ? '时薪（保底）' : '提成'}
                   value={s.paidBy === 'hourly' ? s.hourlyCents : s.commissionCents} />
              {/* 保底方案要写清楚哪边赢了 —— 不写的话技师会以为提成被吞了 */}
              {s.note && <div className="tiny">{s.note}</div>}
              <Row label="现金小费（今晚拿）" value={s.tipCashCents} tone="ok" />
              <Row label="刷卡小费（进工资）" value={s.tipCardCents} />
              <div className="row" style={{ paddingTop: 8, borderTop: '1px dashed var(--line)' }}>
                <strong className="grow">今日合计</strong>
                <strong style={{ fontVariantNumeric: 'tabular-nums' }}>{money(s.payCents)}</strong>
              </div>
              {s.cashTipOwedCents !== s.tipCashCents && (
                <div className="tiny">
                  今晚实际要拿的现金是 {money(s.cashTipOwedCents)}
                  （含昨天没发净的零头，或已发过一部分）
                </div>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function Row({ label, value, tone }: { label: string; value: number; tone?: 'ok' }) {
  return (
    <div className="row">
      <span className="grow muted">{label}</span>
      <span style={{
        fontVariantNumeric: 'tabular-nums',
        color: tone === 'ok' ? 'var(--ok)' : undefined,
        fontWeight: tone === 'ok' ? 700 : 400,
      }}>{money(value)}</span>
    </div>
  );
}
