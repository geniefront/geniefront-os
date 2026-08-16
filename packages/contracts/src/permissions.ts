/**
 * 细粒度权限 + 角色预设（01-ARCHITECTURE §5）
 *
 * 规则：AI 的权限 ⊆ 当前操作人的权限，绝不提权。
 */

export const PERMISSIONS = [
  // 预约
  'appointment.read',
  'appointment.write',
  'appointment.cancel',
  'appointment.overbook', // 突破技师/门店软容量上限

  // 工单与收款
  'ticket.read',
  'ticket.write',
  'ticket.discount',
  'ticket.void',
  'ticket.refund',

  // 轮牌
  'rotation.read',
  'rotation.override', // 手动拖拽调序 / 强行改派

  // 薪酬
  'payroll.view_own',
  'payroll.view_all',
  'payroll.configure',

  // 钱柜与日结（Phase 1b）
  /** 点钞、录现金进出、刷卡机对账、封账 */
  'dayclose.manage',
  /**
   * 发现金小费。和 dayclose.manage 分开：有的店老板亲自发钱，
   * 前台只负责数抽屉。但 Desk-Only 的店两个都给前台（宪法第 14 条）。
   */
  'tip.payout',
  /** 历史营业报表与 CSV 导出。当日数字不需要这个权限 */
  'report.view',

  // 顾客
  'customer.read',
  'customer.write',
  'customer.view_contact', // 看完整手机号（技师默认没有 → 防挖客）
  'customer.view_health_form',
  'customer.merge',

  // 排班考勤
  'schedule.read',
  'schedule.write',
  'timeclock.punch_self',
  'timeclock.punch_others',

  // 配置
  'settings.manage',
  'staff.manage',
  'billing.manage',
  'catalog.manage',

  // AI
  'ai.use',
  'ai.execute_without_confirm',
  /**
   * ⭐ AI 电话唯一拿到的写权限：只能往前台复核队列里放草案。
   *
   * 刻意**不给** appointment.write —— webhook 是没有 Bearer token 的入口，
   * 身份全靠一个签名。给它排期表的写权限，等于把日程表挂在一个环境变量上。
   * 前台点确认时走的是前台自己身份下的 appointment.create（09 §4.2）。
   */
  'call.draft',

  // Kiosk 门口端（Phase 2）
  /** 排队取号。**Kiosk 那台 iPad 拿到的两条权限之一** */
  'queue.join',
  /** 叫号 / 安排入座 / 标记离开 —— 前台的动作，客人不能把自己叫号 */
  'queue.manage',
  /** 交一份自己刚签的健康表。Kiosk 的另一条权限 */
  'form.submit',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export const PERMISSION_SET: ReadonlySet<string> = new Set(PERMISSIONS);

export function isPermission(v: string): v is Permission {
  return PERMISSION_SET.has(v);
}

/** 角色预设。店主可在此基础上勾选调整，存成 location 级自定义角色。 */
export const ROLE_PRESETS = {
  owner: PERMISSIONS,

  manager: [
    'appointment.read', 'appointment.write', 'appointment.cancel', 'appointment.overbook',
    'ticket.read', 'ticket.write', 'ticket.discount', 'ticket.void',
    'rotation.read', 'rotation.override',
    'payroll.view_own', 'payroll.view_all', 'payroll.configure',
    'dayclose.manage', 'tip.payout', 'report.view',
    'customer.read', 'customer.write', 'customer.view_contact', 'customer.merge',
    'schedule.read', 'schedule.write',
    'timeclock.punch_self', 'timeclock.punch_others',
    'settings.manage', 'staff.manage', 'catalog.manage',
    'queue.join', 'queue.manage', 'form.submit',
    'ai.use',
  ],

  front_desk: [
    'appointment.read', 'appointment.write', 'appointment.cancel', 'appointment.overbook',
    'ticket.read', 'ticket.write', 'ticket.discount',
    'rotation.read', 'rotation.override',
    'payroll.view_own',
    // Desk-Only 的店，打烊数钱和发现金小费都是前台干的（宪法第 14 条）。
    // 但历史营业报表不给 —— 那是老板的账（决策 19 极致隐私）。
    'dayclose.manage', 'tip.payout',
    'customer.read', 'customer.write', 'customer.view_contact', 'customer.merge',
    'schedule.read',
    'timeclock.punch_self', 'timeclock.punch_others', // Desk-Only 模式要能代技师打卡
    // 没有 iPad 的店，前台代客人取号、代签免责书（宪法第 14 条）
    'queue.join', 'queue.manage', 'form.submit',
    'ai.use',
  ],

  senior_tech: [
    'appointment.read',
    'ticket.read', 'ticket.write',
    'rotation.read',
    'payroll.view_own',
    'customer.read',
    'schedule.read',
    'timeclock.punch_self',
  ],

  // 技师默认看不到完整手机号（决策 16 防挖客）
  tech: [
    'appointment.read',
    'ticket.read', 'ticket.write',
    'rotation.read',
    'payroll.view_own',
    'customer.read',
    'schedule.read',
    'timeclock.punch_self',
  ],
} as const satisfies Record<string, readonly Permission[]>;

export type RolePreset = keyof typeof ROLE_PRESETS;
