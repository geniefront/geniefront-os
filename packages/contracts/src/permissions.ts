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
    'payroll.view_own', 'payroll.view_all',
    'customer.read', 'customer.write', 'customer.view_contact', 'customer.merge',
    'schedule.read', 'schedule.write',
    'timeclock.punch_self', 'timeclock.punch_others',
    'settings.manage', 'staff.manage', 'catalog.manage',
    'ai.use',
  ],

  front_desk: [
    'appointment.read', 'appointment.write', 'appointment.cancel', 'appointment.overbook',
    'ticket.read', 'ticket.write', 'ticket.discount',
    'rotation.read', 'rotation.override',
    'payroll.view_own',
    'customer.read', 'customer.write', 'customer.view_contact', 'customer.merge',
    'schedule.read',
    'timeclock.punch_self', 'timeclock.punch_others', // Desk-Only 模式要能代技师打卡
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
