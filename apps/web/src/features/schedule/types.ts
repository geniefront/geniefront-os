/**
 * 当日快照的类型定义，与服务端 `GET /v1/desk/day` 的返回一一对应。
 *
 * ⚠️ 服务端的模型是 **item 级**而非 appointment 级：一个 appointment 可包含多条
 * item（一单多服务、一家四口各做一项），每条 item 独立绑定技师、房间与时段，
 * 冲突检测也在 item 级进行。界面渲染的最小单位是 item，不是 appointment。
 */

export interface DayStaff {
  membershipId: string;
  name: string;
  isBookable: boolean;
  inRotation: boolean;
  /** 该技师可同时服务的客人数。足疗店常见一人看两床。 */
  maxConcurrent: number;
  color: string | null;
  levelName: string | null;
  skills: Array<{ id: string; key: string; name: string }>;
}

export interface DayService {
  id: string;
  name: string;
  categoryId?: string | null;
  categoryName?: string | null;
  durationMin: number;
  priceCents: number;
  /** 该项目同时需要的技师人数。 */
  staffCount: number;
  /** 为空表示没有技能硬门槛。 */
  requiredSkills: Array<{ id: string; key: string; name: string }>;
}

export interface DayResource {
  id: string;
  name: string;
  /**
   * 座位数，不是房间数。足疗房排 6 张躺椅即为 6。
   * 房态看板须显示「3/6 位」而非「占用」—— 后者会让前台不敢再往里排人。
   */
  capacity: number;
  maxStaff: number | null;
}

export interface DayItem {
  itemId: string;
  appointmentId: string;
  /** null = 未指派技师，等待前台派单或轮牌决定。 */
  membershipId: string | null;
  /** 服务端已兜底：客户名 → walk_in_name → 占位文案，不会为空。 */
  customerName: string;
  /** 客户档案电话。纯 walk-in 未留号时为 null。看板签到不能因此谎称「散客无电话」。 */
  customerPhone?: string | null;
  /**
   * ⚠️ 可能不在同一份快照的 `services[]` 中：`services` 只含 `active = true`，
   * 而已下架项目的历史单仍会出现在 `items` 里。回查不到时应使用 item 自带的
   * `serviceName` / `durationMin` —— 它们是下单那一刻的快照，比当前项目表更准。
   */
  serviceId: string;
  serviceName: string;
  /** 带偏移量的 ISO 时刻。渲染前必须按门店时区换算，不得使用浏览器时区。 */
  startsAt: string;
  endsAt: string;
  /** 实际完工（ticket_items.finished_at）。没有开工记录时为 null。 */
  completedAt?: string | null;
  durationMin: number;
  /**
   * ⚠️ 服务端已在 SQL 层过滤掉 `cancelled`，实际取值只有
   * `booked` / `in_service` / `done`。
   */
  status: string;
  /** 点钟单（客人指名）。多数门店规定指名单不消耗轮次。 */
  isRequest: boolean;
  /** 超出软容量后经前台确认放行的 item，看板需高亮。 */
  overbooked: boolean;
  overbookReason: string | null;
  resourceId: string | null;
}

export interface DaySnapshot {
  businessDate: string;
  timezone: string;
  /** 当日营业起止，以门店墙上时间的分钟数表示。可超过 1440（营业至次日）。 */
  openMin: number;
  closeMin: number;
  staff: DayStaff[];
  services: DayService[];
  resources: DayResource[];
  items: DayItem[];
}

/** 取消原因。取值与服务端 `cancelReason` 枚举一致，不得自行扩展。 */
export const CANCEL_REASONS = [
  'duplicate_booking',
  'walk_out',
  'guest_changed_mind',
  'input_error',
  'no_show',
  'other',
] as const;

export type CancelReason = (typeof CANCEL_REASONS)[number];

/**
 * 月视图的按日聚合，对应 `GET /v1/desk/days`。
 *
 * ⚠️ 刻意不是「31 份 DaySnapshot」：那意味着上百次查询，且每天都会把全店的
 * 员工、项目、房间原样带一遍，而日历格子上一个字都用不到。
 * 点进某一天时再调 `GET /v1/desk/day` 取完整快照。
 */
export interface DaySummary {
  businessDate: string;
  /**
   * ⚠️ 反直觉之处：`business_hours` 一个键都没配的新店，每天都是 `true`，
   * 而 `openMin` / `closeMin` 为 `null`。「尚未配置」不等于「不营业」，
   * 与建单闸门保持同一口径。
   */
  isOpen: boolean;
  openMin: number | null;
  closeMin: number | null;
  /** 预约条数（父行）。 */
  appointments: number;
  /** 项目条数。一单两项即为 2 —— 画密度用它比用 appointments 准。 */
  items: number;
  staffOnDuty: number;
  /** null 表示当日尚未日结。 */
  daycloseStatus: string | null;
}

export interface DaysRange {
  from: string;
  to: string;
  timezone: string;
  days: DaySummary[];
}
