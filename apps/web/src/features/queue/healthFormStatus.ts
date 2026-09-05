/**
 * 开工弹窗的健康表状态必须诚实：
 * 没配问卷 ≠ 已签署合规。未签署时画成绿色会让技师跳过口头确认。
 */

export type HealthFormHonesty = 'pending' | 'signed' | 'none';

export function healthFormHonesty(item: {
  pendingForms?: number;
  completedForms?: number;
  healthConfirmed?: boolean;
  rawQueue?: { pendingForms?: number } | null;
}): HealthFormHonesty {
  const pending = item.pendingForms ?? item.rawQueue?.pendingForms ?? 0;
  if (pending > 0) return 'pending';
  if (item.healthConfirmed || (item.completedForms ?? 0) > 0) return 'signed';
  return 'none';
}
