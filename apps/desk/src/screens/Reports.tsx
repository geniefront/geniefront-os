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
import { API_BASE } from '../lib/api';
import { supabase } from '../lib/supabase';

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
    <div className="stack" style={{ padding: '0 16px 24px', gap: 14 }}>
      <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
        <strong style={{ fontSize: 'var(--text-xl)' }}>营业报表</strong>
        <span className="badge badge-soft">{data.fromDate} ~ {data.toDate}</span>
        <span className="grow" />
        {([['今天', 1], ['最近 7 天', 7], ['最近 30 天', 30]] as const).map(([l, d]) => (
          <button key={d} className="btn" onClick={() => preset(d)}>{l}</button>
        ))}
        <button className="btn btn-primary" disabled={downloading} onClick={() => void download()}>
          {downloading ? <span className="spin" /> : '⬇ 导出 CSV'}
        </button>
      </div>

      {err && (
        <div className="card" role="alert" style={{
          padding: 14, background: 'var(--danger-soft)', borderColor: 'var(--danger)' }}>
          <span style={{ color: 'var(--danger)', fontWeight: 700 }}>✕ {err}</span>
        </div>
      )}

      {/*
        ⭐ 完整度必须在汇总**上面**，不能在下面。
        老板看这一屏的第一眼就是那几个大数字 —— 「这个数是残的」
        要是出现在下面，等于没说：他已经拿着那个数下判断了。
      */}
      {!data.coverage.complete && (
        <div className="card stack" role="status" style={{
          padding: 16, gap: 6,
          background: 'var(--warn-soft)', borderColor: 'var(--warn)' }}>
          <strong style={{ color: 'var(--warn)' }}>
            ⚠️ 这个数不是这段时间的全部
          </strong>
          <span className="tiny" style={{ color: 'var(--warn)' }}>
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

      <div className="card" style={{ padding: 18 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(140px,1fr))', gap: 14 }}>
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
        </div>
      </div>

      <DayTable rows={data.byDay} />

      <Table title="按技师"
             head={['技师', '认到营业额', '提成', '现金小费', '刷卡小费', '单数']}
             rows={data.byStaff.map((x) => [
               x.label, money(x.serviceRevenueCents), money(x.commissionCents),
               money(x.tipCashCents), money(x.tipCardCents), String(x.ticketCount),
             ])} />

      <Table title="按项目"
             head={['项目', '次数', '营业额']}
             rows={data.byService.slice(0, 20).map((x) => [
               x.label, String(x.count), money(x.grossCents),
             ])} />
    </div>
  );
}

function Stat({ label, value, big }: { label: string; value: string; big?: boolean }) {
  return (
    <div className="stack" style={{ gap: 2 }}>
      <span className="tiny">{label}</span>
      <strong style={{
        fontSize: big ? 'var(--text-xl)' : 'var(--text-lg)',
        fontVariantNumeric: 'tabular-nums',
      }}>{value}</strong>
    </div>
  );
}

function Table({ title, head, rows }: { title: string; head: string[]; rows: string[][] }) {
  if (rows.length === 0) return null;
  return (
    <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
      <div style={{ padding: '14px 18px 0' }}><strong>{title}</strong></div>
      <table style={{ borderCollapse: 'collapse', width: '100%', marginTop: 10 }}>
        <thead>
          <tr>{head.map((h, i) => (
            <th key={h} style={{
              padding: '8px 14px', borderBottom: '2px solid var(--line)',
              textAlign: i === 0 ? 'left' : 'right', fontSize: 'var(--text-sm)',
            }}>{h}</th>
          ))}</tr>
        </thead>
        <tbody>
          {rows.map((r, ri) => (
            <tr key={ri}>{r.map((c, ci) => (
              <td key={ci} style={{
                padding: '8px 14px', borderBottom: '1px solid var(--line)',
                textAlign: ci === 0 ? 'left' : 'right',
                fontVariantNumeric: ci === 0 ? undefined : 'tabular-nums',
              }}>{c}</td>
            ))}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * 按天 —— 断档的那几天在这里必须**长得跟 0 不一样**（0032）。
 *
 * 改这一块之前，没记的那天压根不出现在 byDay 里。老板翻这张表
 * 只会觉得「那周好像少了一天」，而不会意识到系统在瞒着他一段空白。
 *
 * 现在每一天都有一行，空白那几行不写 $0.00 而是写「没有记录」：
 * **$0.00 是一句关于生意的陈述，空白是一句关于记录的陈述**，两者不能互换。
 */
const DAY_LABEL: Record<DayStatus, { text: string; cls: string } | null> = {
  ok: null,
  unclosed: { text: '有单未封账', cls: 'badge-warn' },
  summary_only: { text: '只补了总数', cls: 'badge-warn' },
  no_business: { text: '没营业', cls: 'badge-mute' },
  paper_only: { text: '用纸记的', cls: 'badge-mute' },
  no_record: { text: '没有记录', cls: 'badge-mute' },
};

function DayTable({ rows }: { rows: DayReportRow[] }) {
  if (rows.length === 0) return null;
  const head = ['日期', '净额', '小费', '实收', '现金', '刷卡', '单数', ''];
  return (
    <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
      <div style={{ padding: '14px 18px 0' }}><strong>按天</strong></div>
      <table style={{ borderCollapse: 'collapse', width: '100%', marginTop: 10 }}>
        <thead>
          <tr>{head.map((h, i) => (
            <th key={i} style={{
              padding: '8px 14px', borderBottom: '2px solid var(--line)',
              textAlign: i === 0 || i === head.length - 1 ? 'left' : 'right',
              fontSize: 'var(--text-sm)',
            }}>{h}</th>
          ))}</tr>
        </thead>
        <tbody>
          {rows.map((d) => {
            // 空白 ≠ 零。这两种在同一张表里必须一眼分得出来
            const blank = d.status === 'no_record' || d.status === 'paper_only';
            const tag = DAY_LABEL[d.status];
            const cell = (v: string) => (blank ? '—' : v);
            return (
              <tr key={d.key} style={blank ? { background: '#faf9f7' } : undefined}>
                <td style={{
                  padding: '8px 14px', borderBottom: '1px solid var(--line)',
                  color: blank ? 'var(--ink-3)' : undefined,
                }}>{d.key}</td>
                {[money(d.netCents), money(d.tipCents), money(d.totalCents),
                  money(d.cashCents), money(d.cardCents), String(d.ticketCount),
                ].map((v, ci) => (
                  <td key={ci} style={{
                    padding: '8px 14px', borderBottom: '1px solid var(--line)',
                    textAlign: 'right', fontVariantNumeric: 'tabular-nums',
                    color: blank ? 'var(--ink-3)' : undefined,
                  }}>{cell(v)}</td>
                ))}
                <td style={{ padding: '8px 14px', borderBottom: '1px solid var(--line)' }}>
                  {tag && <span className={`badge ${tag.cls}`}>{tag.text}</span>}
                  {d.note && (
                    <span className="tiny" style={{ marginLeft: 8 }}>{d.note}</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
