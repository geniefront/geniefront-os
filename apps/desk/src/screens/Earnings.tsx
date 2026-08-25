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
import { ChevronDown, ChevronUp, Wallet } from 'lucide-react';
import { Card } from '../ui/Card';
import { Badge } from '../ui/Badge';
import { Page, PageHeader, Empty, Label } from '../ui/Page';
import { cn } from '../ui/cn';

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
      <Page>
        <PageHeader title="今日营收" sub={data.businessDate} />
        <Empty icon={<Wallet size={34} />} title="今天还没有结账的单"
               hint="结完账就会出现在这里。技师下班前围过来问「我今天多少」，把这一页转过去就行。" />
      </Page>
    );
  }

  return (
    <Page>
      <PageHeader title="今日营收"
                  sub={<span className="tnum">{data.businessDate}</span>}
                  actions={<Badge tone="brand">{data.staff.length} 位技师</Badge>} />

      {/* 四个总数。⚠️ 现金和刷卡小费**分开**：一个今晚就要拿现钞，一个进工资 */}
      <Card className="mb-3 flex flex-wrap items-center gap-x-8 gap-y-4 px-5 py-4">
        <Total label="营业额" value={data.totals.serviceRevenueCents} />
        <Total label="提成合计" value={data.totals.commissionCents} />
        <Total label="现金小费（今晚发）" value={data.totals.tipCashCents} tone="ok" />
        <Total label="刷卡小费（进工资）" value={data.totals.tipCardCents} />
      </Card>

      <div className="flex flex-col gap-2.5">
        {data.staff.map((s) => {
          const on = open === s.membershipId;
          return (
            <Card key={s.membershipId} className="overflow-hidden">
              <button type="button"
                      onClick={() => setOpen(on ? null : s.membershipId)}
                      aria-expanded={on}
                      className="flex w-full min-h-tap cursor-pointer items-center gap-3.5 px-5 py-4 text-left hoverable:hover:bg-sunken">
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <strong className="text-xl font-bold tracking-[-0.02em]">{s.name}</strong>
                  <div className="text-xs text-ink-3">
                    {s.ticketCount} 单 · 营业额 {money(s.serviceRevenueCents)}
                    {s.minutesWorked > 0 && ` · 在岗 ${hours(s.minutesWorked)}`}
                  </div>
                </div>
                {s.cashTipOwedCents > 0 && (
                  <Badge tone="ok">现金待发 {money(s.cashTipOwedCents)}</Badge>
                )}
                <div className="flex shrink-0 flex-col items-end gap-0.5">
                  <strong className="tnum text-xl font-bold">{money(s.payCents)}</strong>
                  <span className="flex items-center gap-1 text-2xs text-ink-3">
                    {on ? <>收起<ChevronUp size={12} /></> : <>看明细<ChevronDown size={12} /></>}
                  </span>
                </div>
              </button>

              {/*
                ⭐ 每个数字都要能点开看依据 —— 技师质疑提成是常态，
                说不清就从「算错了」变成人事矛盾
              */}
              {on && (
                <div className="flex flex-col gap-2 border-t border-line bg-ground px-5 py-4">
                  <Line label={s.paidBy === 'hourly' ? '时薪（保底）' : '提成'}
                        value={s.paidBy === 'hourly' ? s.hourlyCents : s.commissionCents} />
                  {/* 保底方案要写清楚哪边赢了 —— 不写的话技师会以为提成被吞了 */}
                  {s.note && <div className="text-xs text-ink-3">{s.note}</div>}
                  <Line label="现金小费（今晚拿）" value={s.tipCashCents} tone="ok" />
                  <Line label="刷卡小费（进工资）" value={s.tipCardCents} />
                  <div className="mt-1 flex items-center border-t border-dashed border-line pt-2.5">
                    <strong className="flex-1 text-sm">今日合计</strong>
                    <strong className="tnum text-sm">{money(s.payCents)}</strong>
                  </div>
                  {s.cashTipOwedCents !== s.tipCashCents && (
                    <div className="text-xs text-ink-3">
                      今晚实际要拿的现金是 {money(s.cashTipOwedCents)}
                      （含昨天没发净的零头，或已发过一部分）
                    </div>
                  )}
                </div>
              )}
            </Card>
          );
        })}
      </div>
    </Page>
  );
}

function Total({ label, value, tone }: { label: string; value: number; tone?: 'ok' }) {
  return (
    <div className="flex flex-col gap-0.5">
      <Label>{label}</Label>
      <strong className={cn('tnum text-xl font-bold tracking-[-0.02em]', tone === 'ok' && 'text-ok')}>
        {money(value)}
      </strong>
    </div>
  );
}

function Line({ label, value, tone }: { label: string; value: number; tone?: 'ok' }) {
  return (
    <div className="flex items-center">
      <span className="flex-1 text-xs text-ink-2">{label}</span>
      <span className={cn('tnum text-sm', tone === 'ok' && 'font-bold text-ok')}>{money(value)}</span>
    </div>
  );
}
