/**
 * 开工弹窗的健康表状态必须诚实：
 * 没配问卷 ≠ 已签署合规。未签署时画成绿色会让技师跳过口头确认。
 *
 * ⚠️ 这里曾经读的是 `healthConfirmed` 与 `completedForms` —— 两个
 * **没有任何生产调用方会提供**的字段（`healthConfirmed` 在 `KanbanItem` 上
 * 声明了但从不赋值，`completedForms` 压根不是它的字段）。于是本函数永远
 * 返回不了 `signed`：客人明明签过，弹窗上写的却是「本店未配置电子健康问卷」。
 * 单测当时是绿的，因为它直接喂了那两个字段。
 *
 * 现在只认服务端算好的 `intakeSigned`（`signed_form_count > 0 && pending === 0`）。
 */

export type HealthFormHonesty = 'pending' | 'signed' | 'none';

export interface HealthFormSignals {
  pendingForms?: number;
  intakeSigned?: boolean;
  rawQueue?: { pendingForms?: number; intakeSigned?: boolean } | null;
}

export function healthFormHonesty(item: HealthFormSignals): HealthFormHonesty {
  const pending = item.pendingForms ?? item.rawQueue?.pendingForms ?? 0;
  if (pending > 0) return 'pending';
  const signed = item.intakeSigned ?? item.rawQueue?.intakeSigned ?? false;
  return signed ? 'signed' : 'none';
}
