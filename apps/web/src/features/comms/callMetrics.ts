/**
 * AI 电话页的运营数字必须来自查询结果。
 * 用 `calls.length * 12` 或写死 99.8% / 14 单会在 0 通来电时画出假繁荣。
 */
import type { CallsQueryResponse } from './types';

export interface CallDeskMetrics {
  inboundCount: number;
  bookedCount: number;
  conversionPercent: number;
  hoursSaved: number;
}

export function callDeskMetrics(data: Pick<CallsQueryResponse, 'calls' | 'bookedCount' | 'totalMinutes'>): CallDeskMetrics {
  const inboundCount = data.calls.length;
  const bookedCount = data.bookedCount;
  const conversionPercent = inboundCount > 0
    ? Math.round((bookedCount * 1000) / inboundCount) / 10
    : 0;
  const hoursSaved = Math.round((data.totalMinutes / 60) * 10) / 10;
  return { inboundCount, bookedCount, conversionPercent, hoursSaved };
}
