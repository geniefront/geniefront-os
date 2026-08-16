/**
 * 错误码：稳定的机器可读标识 + 五语言文案 key。
 *
 * 前台看到的永远是母语文案，日志里留的是 code。
 * 绝不把 Postgres 的原始报错抛给前台——她们看不懂 "23P01 conflicting key value
 * violates exclusion constraint"，而这正是超卖那类冲突最容易冒出来的东西。
 */

export const ERROR_CODES = {
  // 认证与授权
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  MEMBERSHIP_INACTIVE: 'MEMBERSHIP_INACTIVE',
  LOCATION_SUSPENDED: 'LOCATION_SUSPENDED',

  // 输入
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  NOT_FOUND: 'NOT_FOUND',
  IDEMPOTENCY_KEY_REUSED: 'IDEMPOTENCY_KEY_REUSED',

  // 排期与容量（01 §7.1 三层约束）
  RESOURCE_CONFLICT: 'RESOURCE_CONFLICT',           // 硬：房间/床/椅被占，不可覆盖
  STAFF_OVER_CAPACITY: 'STAFF_OVER_CAPACITY',       // 软：超技师并发上限，可带 reason 放行
  LOCATION_OVER_CAPACITY: 'LOCATION_OVER_CAPACITY', // 软：超门店时段上限，可带 reason 放行
  STAFF_LACKS_SKILL: 'STAFF_LACKS_SKILL',
  STAFF_NOT_BOOKABLE: 'STAFF_NOT_BOOKABLE',
  OUTSIDE_BUSINESS_HOURS: 'OUTSIDE_BUSINESS_HOURS',
  OVERBOOK_REASON_REQUIRED: 'OVERBOOK_REASON_REQUIRED',

  // 业务状态
  ALREADY_CANCELLED: 'ALREADY_CANCELLED',
  TICKET_ALREADY_CLOSED: 'TICKET_ALREADY_CLOSED',
  VOID_REASON_REQUIRED: 'VOID_REASON_REQUIRED',

  // 钱（Phase 1b）
  /** 收款金额和单据金额对不上 —— 组单合并结账时必须当场拦下 */
  PAYMENT_MISMATCH: 'PAYMENT_MISMATCH',
  /** 已封账的营业日不能再改 */
  DAY_ALREADY_CLOSED: 'DAY_ALREADY_CLOSED',
  /** 账实差异超阈值但没写原因 */
  VARIANCE_REASON_REQUIRED: 'VARIANCE_REASON_REQUIRED',
  /** 还有单没结完就要封账 */
  OPEN_TICKETS_REMAIN: 'OPEN_TICKETS_REMAIN',

  // 合规硬锁（05 §2.4）
  HOUSE_CUT_FORBIDDEN: 'HOUSE_CUT_FORBIDDEN',       // 雇主抽小费，FLSA 禁止
  PATCH_TEST_REQUIRED: 'PATCH_TEST_REQUIRED',       // 美睫胶水敏感未做斑贴测试

  // 系统
  INTERNAL: 'INTERNAL',
  UPSTREAM_UNAVAILABLE: 'UPSTREAM_UNAVAILABLE',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

/** 软约束错误：前台可以带 reason 重试并放行。 */
export const OVERRIDABLE_CODES: ReadonlySet<ErrorCode> = new Set([
  ERROR_CODES.STAFF_OVER_CAPACITY,
  ERROR_CODES.LOCATION_OVER_CAPACITY,
  ERROR_CODES.STAFF_LACKS_SKILL,
  ERROR_CODES.OUTSIDE_BUSINESS_HOURS,
]);

export interface AppErrorOptions {
  /** 给前台看的结构化上下文（哪个技师、哪个房间、几点到几点） */
  details?: Record<string, unknown>;
  /** i18n key，默认 `error.<code>` */
  messageKey?: string;
  cause?: unknown;
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly details: Record<string, unknown>;
  readonly messageKey: string;
  readonly overridable: boolean;

  constructor(code: ErrorCode, opts: AppErrorOptions = {}) {
    super(code, opts.cause ? { cause: opts.cause } : undefined);
    this.name = 'AppError';
    this.code = code;
    this.details = opts.details ?? {};
    this.messageKey = opts.messageKey ?? `error.${code}`;
    this.overridable = OVERRIDABLE_CODES.has(code);
  }

  toJSON() {
    return {
      code: this.code,
      messageKey: this.messageKey,
      details: this.details,
      overridable: this.overridable,
    };
  }
}

export const httpStatusFor: Record<ErrorCode, number> = {
  UNAUTHENTICATED: 401,
  PERMISSION_DENIED: 403,
  MEMBERSHIP_INACTIVE: 403,
  LOCATION_SUSPENDED: 403,
  VALIDATION_FAILED: 400,
  NOT_FOUND: 404,
  IDEMPOTENCY_KEY_REUSED: 409,
  RESOURCE_CONFLICT: 409,
  STAFF_OVER_CAPACITY: 409,
  LOCATION_OVER_CAPACITY: 409,
  STAFF_LACKS_SKILL: 409,
  STAFF_NOT_BOOKABLE: 409,
  OUTSIDE_BUSINESS_HOURS: 409,
  OVERBOOK_REASON_REQUIRED: 400,
  ALREADY_CANCELLED: 409,
  TICKET_ALREADY_CLOSED: 409,
  VOID_REASON_REQUIRED: 400,
  PAYMENT_MISMATCH: 400,
  DAY_ALREADY_CLOSED: 409,
  VARIANCE_REASON_REQUIRED: 400,
  OPEN_TICKETS_REMAIN: 409,
  HOUSE_CUT_FORBIDDEN: 422,
  PATCH_TEST_REQUIRED: 422,
  INTERNAL: 500,
  UPSTREAM_UNAVAILABLE: 503,
};
