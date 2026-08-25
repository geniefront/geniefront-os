/**
 * 基础报表 v1 + CSV 导出。
 *
 * 老板要报表通常只为两件事：**看今天/这周挣了多少**，和**给会计一个文件**。
 * 所以这一屏只有几个预设区间和一个导出按钮，不做自定义维度分析 ——
 * 那些是 Phase 3 老板端看板的事。
 *
 * CSV 由服务端生成（BOM、公式注入转义、列顺序只该有一份实现），
 * 这里只负责把它下载下来。
 */

import { useState } from 'react';
import { Download, CircleAlert, TriangleAlert } from 'lucide-react';
import { API_BASE } from '../lib/api';
import { supabase } from '../lib/supabase';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { Badge } from '../ui/Badge';
import { Table, Row } from '../ui/Table';
import { Page, PageHeader, Section, Label } from '../ui/Page';
import { Segmented } from '../ui/Segmented';
import { cn } from '../ui/cn';

const money = (c: number) => `$${(c / 100).toFixed(2)}`;

export interface ReportRow {
  key: string; label: string;
  grossCents: number; discountCents: number; netCents: number; taxCents: number;
  tipCents: number; totalCents: number; cashCents: number; cardCents: number;
  ticketCount: number;
}

/** 见 apps/api/src/queries/money.ts 的 DayStatus */
export type DayStatus =
  'ok' | 'unclosed' | 'summary_only' | 'no_business' | 'paper_only' | 'no_record';

export interface DayReportRow extends ReportRow {
  status: DayStatus;
  hasEarnings: boolean;
  note: string | null;
}

export interface ReportCoverage {
  daysInRange: number; daysComplete: number; daysSummaryOnly: number;
  daysMissing: number; daysUnhandled: number; complete: boolean;
}

export interface ReportData {
  fromDate: string;
  toDate: string;
  summary: ReportRow;
  coverage: ReportCoverage;
  byDay: DayReportRow[];
  byStaff: Array<{
    key: string; label: string;
    serviceRevenueCents: number; commissionCents: number;
    tipCashCents: number; tipCardCents: number; ticketCount: number;
  }>;
  byService: Array<{ key: string; label: string; count: number; grossCents: number }>;
  voidedCount: number;
}

const addDays = (date: string, n: number) => {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + n)).toISOString().slice(0, 10);
};

export function Reports({
  data, membershipId, onRange,
}: {
  data: ReportData;
  membershipId: string;
  onRange: (from: string, to: string) => void;
}) {
  const [downloading, setDownloading] = useState(false);
  const [err, setErr] = useState('');

  const preset = (days: number) => {
    const to = data.toDate;
    onRange(addDays(to, -(days - 1)), to);
  };

  /**
   * 现在选的是哪一档。
   *
   * ⚠️ 不能让这一组按钮「一个都没选中」—— 它在读屏软件里是一个
   * radiogroup，全空等于告诉使用者「当前没有时间范围」，
   * 而屏幕上明明正显示着某一段的数。日期是从服务端回来的，
   * 所以这里反推：区间跨了几天就是哪一档。
   */
  const spanDays = Math.round(
    (Date.parse(`${data.toDate}T00:00:00Z`) - Date.parse(`${data.fromDate}T00:00:00Z`))
    / 86_400_000) + 1;
  const activePreset = [1, 7, 30].includes(spanDays) ? String(spanDays) : 'custom';

  /**
   * 导出。带着 Authorization 头 fetch 再造 blob，而不是直接开一个链接 ——
   * 接口要令牌，`<a href>` 带不上头。
   */
  async function download() {
    setDownloading(true); setErr('');
    try {
      const { data: sess } = await supabase.auth.getSession();
      const res = await fetch(
        `${API_BASE}/v1/desk/reports?from=${data.fromDate}&to=${data.toDate}&format=csv`,
        { headers: {
            Authorization: `Bearer ${sess.session?.access_token ?? ''}`,
            'X-Membership-Id': membershipId,
        } });
      if (!res.ok) throw new Error(String(res.status));
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `geniefront-${data.fromDate}_${data.toDate}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      setErr('导出失败，请重试');
    } finally { setDownloading(false); }
  }

  const s = data.summary;

  return (
    <Page>
      <PageHeader
        title="营业报表"
        sub={<Badge tone="brand">{data.fromDate} ~ {data.toDate}</Badge>}
        actions={
          <>
            <Segmented
              ariaLabel="时间范围"
              value={activePreset}
              onChange={(v) => v !== 'custom' && preset(Number(v))}
              options={[
                { value: '1', label: '今天' },
                { value: '7', label: '最近 7 天' },
                { value: '30', label: '最近 30 天' },
                // 从「待补录」跳过来时区间是别处定的，那一档要有个落脚点
                ...(activePreset === 'custom'
                  ? [{ value: 'custom', label: `${spanDays} 天` }] : []),
              ]}
            />
            <Button variant="primary" disabled={downloading} onClick={() => void download()}>
              <Download size={17} />{downloading ? '导出中…' : '导出 CSV'}
            </Button>
          </>
        }
      />

      {err && (
        <div role="alert"
             className="mb-4 flex items-center gap-2 rounded bg-danger-soft px-4 py-3 text-danger">
          <CircleAlert size={17} /><span className="text-xs font-semibold">{err}</span>
        </div>
      )}

      {/*
        ⭐ 完整度必须在汇总**上面**，不能在下面。
        老板看这一屏的第一眼就是那几个大数字 —— 「这个数是残的」
        要是出现在下面，等于没说：他已经拿着那个数下判断了。
      */}
      {!data.coverage.complete && (
        <div role="status"
             className="mb-4 flex flex-col gap-1.5 rounded-lg border border-warn bg-warn-soft p-4">
          <strong className="flex items-center gap-2 text-sm text-warn">
            <TriangleAlert size={16} />这个数不是这段时间的全部
          </strong>
          <span className="text-xs leading-relaxed text-warn">
            {data.coverage.daysInRange} 天里，
            {data.coverage.daysMissing > 0 && (
              <> <b>{data.coverage.daysMissing} 天的数不在系统里</b>（下面标了「没有记录」的那几天，
                 合计不含它们）</>
            )}
            {data.coverage.daysMissing > 0 && data.coverage.daysSummaryOnly > 0 && '；'}
            {data.coverage.daysSummaryOnly > 0 && (
              <> {data.coverage.daysSummaryOnly} 天只补了总数，<b>没有技师提成明细</b></>
            )}
            。拿它跟别的时间段比会得出错的结论。
          </span>
        </div>
      )}

      <Card className="grid gap-4 p-5 [grid-template-columns:repeat(auto-fill,minmax(140px,1fr))]">
        <Stat label="原价 Gross" value={money(s.grossCents)} />
        <Stat label="折扣 Discount" value={money(s.discountCents)} />
        <Stat label="净额 Net" value={money(s.netCents)} big />
        <Stat label="税 Tax" value={money(s.taxCents)} />
        <Stat label="小费 Tips" value={money(s.tipCents)} />
        <Stat label="实收 Total" value={money(s.totalCents)} big />
        <Stat label="现金 Cash" value={money(s.cashCents)} />
        <Stat label="刷卡 Card" value={money(s.cardCents)} />
        <Stat label="单数" value={String(s.ticketCount)} />
        <Stat label="作废" value={String(data.voidedCount)} />
      </Card>

      <Section className="mt-5"><DayTable rows={data.byDay} /></Section>

      {data.byStaff.length > 0 && (
        <Section className="mt-5">
          <Table title="按技师" columns={STAFF_COLS}>
            {data.byStaff.map((x) => (
              <Row key={x.key} columns={STAFF_COLS} cells={[
                x.label, money(x.serviceRevenueCents), money(x.commissionCents),
                money(x.tipCashCents), money(x.tipCardCents), String(x.ticketCount),
              ]} />
            ))}
          </Table>
        </Section>
      )}

      {data.byService.length > 0 && (
        <Section className="mt-5">
          <Table title="按项目" columns={SERVICE_COLS}
                 extra={data.byService.length > 20 ? '只显示前 20 项' : undefined}>
            {data.byService.slice(0, 20).map((x) => (
              <Row key={x.key} columns={SERVICE_COLS}
                   cells={[x.label, String(x.count), money(x.grossCents)]} />
            ))}
          </Table>
        </Section>
      )}
    </Page>
  );
}

const STAFF_COLS = [
  { key: 'name', header: '技师' }, { key: 'rev', header: '认到营业额' },
  { key: 'comm', header: '提成' }, { key: 'cash', header: '现金小费' },
  { key: 'card', header: '刷卡小费' }, { key: 'n', header: '单数' },
];

const SERVICE_COLS = [
  { key: 'name', header: '项目' }, { key: 'n', header: '次数' }, { key: 'gross', header: '营业额' },
];

const DAY_COLS = [
  { key: 'date', header: '日期' }, { key: 'net', header: '净额' },
  { key: 'tip', header: '小费' }, { key: 'total', header: '实收' },
  { key: 'cash', header: '现金' }, { key: 'card', header: '刷卡' },
  { key: 'n', header: '单数' },
  { key: 'tag', header: '', align: 'left' as const },
];

function Stat({ label, value, big }: { label: string; value: string; big?: boolean }) {
  return (
    <div className="flex flex-col gap-0.5">
      <Label>{label}</Label>
      <strong className={cn('tnum tracking-[-0.02em]', big ? 'text-xl font-bold' : 'text-lg font-semibold')}>
        {value}
      </strong>
    </div>
  );
}

/**
 * 按天 —— 断档的那几天在这里必须**长得跟 0 不一样**（0032）。
 *
 * 改这一块之前，没记的那天压根不出现在 byDay 里。老板翻这张表
 * 只会觉得「那周好像少了一天」，而不会意识到系统在瞒着他一段空白。
 *
 * 现在每一天都有一行，空白那几行不写 $0.00 而是写「—」：
 * **$0.00 是一句关于生意的陈述，「—」是一句关于记录的陈述**，两者不能互换。
 */
const DAY_LABEL: Record<DayStatus, { text: string; tone: 'warn' | 'mute' } | null> = {
  ok: null,
  unclosed: { text: '有单未封账', tone: 'warn' },
  summary_only: { text: '只补了总数', tone: 'warn' },
  no_business: { text: '没营业', tone: 'mute' },
  paper_only: { text: '用纸记的', tone: 'mute' },
  no_record: { text: '没有记录', tone: 'mute' },
};

function DayTable({ rows }: { rows: DayReportRow[] }) {
  if (rows.length === 0) return null;
  return (
    <Table title="按天" columns={DAY_COLS}>
      {rows.map((d) => {
        // 空白 ≠ 零。这两种在同一张表里必须一眼分得出来
        const blank = d.status === 'no_record' || d.status === 'paper_only';
        const tag = DAY_LABEL[d.status];
        const cell = (v: string) => (blank ? '—' : v);
        return (
          <Row key={d.key} columns={DAY_COLS} muted={blank} cells={[
            d.key,
            cell(money(d.netCents)), cell(money(d.tipCents)), cell(money(d.totalCents)),
            cell(money(d.cashCents)), cell(money(d.cardCents)), cell(String(d.ticketCount)),
            <span key="tag" className="flex items-center gap-2">
              {tag && <Badge tone={tag.tone}>{tag.text}</Badge>}
              {d.note && <span className="text-2xs text-ink-3">{d.note}</span>}
            </span>,
          ]} />
        );
      })}
    </Table>
  );
}
