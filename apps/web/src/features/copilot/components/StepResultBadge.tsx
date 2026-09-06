/**
 * 单个步骤的执行结果徽标。
 *
 * 执行完之后，前台真正要知道的不是「这批跑完了」，而是**哪几条成了、
 * 哪一条没成、为什么**。以前卡片只在底部写一行「✓ 方案已确认并成功执行」——
 * 八条里挂了一条也照样是这行字，前台以为全进去了，直到客人到店才发现没单。
 */

import React from 'react';
import { CheckCircle2, XCircle, MinusCircle, Ban } from 'lucide-react';

export interface StepExecutionResult {
  stepIndex: number;
  command: string;
  status: 'succeeded' | 'failed' | 'skipped' | 'blocked';
  error?: string | undefined;
}

const LOOK = {
  succeeded: { Icon: CheckCircle2, cls: 'text-emerald-700 bg-emerald-50 border-emerald-200', label: '已创建' },
  failed: { Icon: XCircle, cls: 'text-rose-700 bg-rose-50 border-rose-200', label: '失败' },
  skipped: { Icon: MinusCircle, cls: 'text-zinc-500 bg-zinc-50 border-zinc-200', label: '已跳过' },
  blocked: { Icon: Ban, cls: 'text-amber-700 bg-amber-50 border-amber-200', label: '未执行' },
} as const;

export const StepResultBadge: React.FC<{ result: StepExecutionResult }> = ({ result }) => {
  const { Icon, cls, label } = LOOK[result.status];
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold ${cls}`}>
      <Icon className="w-3 h-3" />
      {label}
    </span>
  );
};

/** 失败原因单独一行 —— 徽标里塞不下，而这句话正是前台要拿去补救的依据 */
export const StepResultError: React.FC<{ result: StepExecutionResult }> = ({ result }) => {
  if (result.status !== 'failed' || !result.error) return null;
  return (
    <div className="mt-1.5 rounded-lg border border-rose-200 bg-rose-50/70 px-2 py-1 text-[11px] leading-relaxed text-rose-900">
      {friendlyError(result.error)}
    </div>
  );
};

/**
 * 命令总线的错误是 JSON，直接印给前台等于没说。
 * 认得出来的翻成人话，认不出来的原样带上 —— 至少能拿去问技术支持。
 */
function friendlyError(raw: string): string {
  let details: Record<string, unknown> = {};
  let code = raw;
  try {
    const parsed = JSON.parse(raw) as { code?: string; details?: Record<string, unknown> };
    code = parsed.code ?? raw;
    details = parsed.details ?? {};
  } catch {
    // 不是 JSON，就当成一句话
  }

  switch (code) {
    case 'STAFF_OVER_CAPACITY':
      return '这个时段该技师已经排满了，换个时间或换个人。';
    case 'LOCATION_OVER_CAPACITY':
      return '这个时段全店已经排满了，换个时间。';
    case 'RESOURCE_CONFLICT':
      return '房间/工位在这个时段已被占用。';
    case 'VALIDATION_FAILED':
      return `参数没通过校验${details['reason'] ? `（${String(details['reason'])}）` : ''}，请人工建这一单。`;
    case 'BUSINESS_DAY_CLOSED':
      return '这一天已经日结，不能再改动。';
    default:
      return code;
  }
}
