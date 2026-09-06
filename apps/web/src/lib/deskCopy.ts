/**
 * 前台展示用的短格式化。金额/时间不走这里。
 */

export function formatValidityPeriod(
  validDays: number | null | undefined,
  foreverLabel: string,
  withDays: (days: number) => string,
): string {
  if (validDays == null || validDays <= 0) return foreverLabel;
  return withDays(validDays);
}

/**
 * 权限键 → 人话。有翻译函数时走 `perm.{key}` 词典；
 * 未知键才把点号/下划线拆开，避免整页 `ai.execute_without_confirm`。
 */
export function formatPermissionKey(key: string, translate?: (i18nKey: string) => string): string {
  const i18nKey = `perm.${key}`;
  if (translate) {
    const labeled = translate(i18nKey);
    if (labeled && labeled !== i18nKey && !labeled.includes('⟦')) return labeled;
  }
  return key.replace(/\./g, ' · ').replace(/_/g, ' ');
}

export function giftCardStatusKey(status: string): 'active' | 'void' | 'expired' | 'other' {
  const normalized = status.trim().toLowerCase();
  if (normalized === 'active') return 'active';
  if (normalized === 'void' || normalized === 'voided') return 'void';
  if (normalized === 'expired') return 'expired';
  return 'other';
}

/** 进度条 title：词条若已带冒号，不要再拼出一个变成「已完:: 0」。 */
export function progressCountTitle(label: string, count: number): string {
  return `${label.replace(/[:：]\s*$/, '')}: ${count}`;
}

export function checkInJoinInput(item: {
  appointmentId: string;
  customerName: string;
  serviceId?: string | null;
  membershipId?: string | null;
}): {
  appointmentId: string;
  walkInName: string;
  requestedServiceId: string | null;
  requestedStaffId: string | null;
} {
  return {
    appointmentId: item.appointmentId,
    walkInName: item.customerName,
    requestedServiceId: item.serviceId ?? null,
    requestedStaffId: item.membershipId ?? null,
  };
}

/** 副驾发送失败时，把已经加上的回合数退回。 */
export function copilotQueryCountAfterFailure(current: number): number {
  return Math.max(0, current - 1);
}
