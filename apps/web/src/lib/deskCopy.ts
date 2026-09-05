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

export function formatPermissionKey(key: string): string {
  return key.replace(/\./g, ' · ').replace(/_/g, ' ');
}

export function giftCardStatusKey(status: string): 'active' | 'void' | 'expired' | 'other' {
  const normalized = status.trim().toLowerCase();
  if (normalized === 'active') return 'active';
  if (normalized === 'void' || normalized === 'voided') return 'void';
  if (normalized === 'expired') return 'expired';
  return 'other';
}
