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

/**
 * 轮牌事件的机器码 → 文案 key。
 *
 * ⚠️ 显式 Record，不做运行期拼接（`` `rotation.evt${code}` ``）：拼出来的 key
 * 对字典瘦身脚本不可见，会被判定为未引用词条删掉，而删除后**没有编译期错误**，
 * 故障要到前台打开历史抽屉时才暴露。同 `lib/validationMessage.ts` 的做法。
 *
 * 未知码返回 null，由调用方决定兜底 —— 不要在这里悄悄返回原始码，
 * 那正是本函数要消灭的东西。
 */
const ROTATION_EVENT_KEYS: Record<string, string> = {
  served: 'rotation.evtServed',
  request_not_counted: 'rotation.evtRequestNotCounted',
  manual_override: 'rotation.evtManualOverride',
  skipped_no_skill: 'rotation.evtSkippedNoSkill',
  skipped_off: 'rotation.evtSkippedOff',
  break: 'rotation.evtBreak',
  back: 'rotation.evtBack',
  check_in: 'rotation.evtCheckIn',
  check_out: 'rotation.evtCheckOut',
};

/** 退款原因的机器码 → 文案 key。取值见 `ticket.refund` 的 `reason` 枚举。 */
const REFUND_REASON_KEYS: Record<string, string> = {
  customer_dissatisfied: 'finance.refundReasonCustomerDissatisfied',
  wrong_charge: 'finance.refundReasonWrongCharge',
  accidental_duplicate: 'finance.refundReasonAccidentalDuplicate',
  other: 'finance.refundReasonOther',
};

function labelFrom(
  map: Record<string, string>, code: string, translate: (key: string) => string,
): string {
  const key = map[code];
  /*
   * 未知码（服务端加了新取值而前端还没跟上）拆开点号与下划线再显示：
   * `some_new_code` → `some new code`。比原样显示好一点，但仍然是个提示 ——
   * 出现这种文案说明这张表该补了。
   */
  return key ? translate(key) : code.replace(/_/g, ' ');
}

export function rotationEventLabel(code: string, translate: (key: string) => string): string {
  return labelFrom(ROTATION_EVENT_KEYS, code, translate);
}

export function refundReasonLabel(code: string, translate: (key: string) => string): string {
  return labelFrom(REFUND_REASON_KEYS, code, translate);
}
