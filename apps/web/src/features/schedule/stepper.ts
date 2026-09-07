/**
 * 预约抽屉生命周期步进器。
 *
 * 日历色块看的是 item.status（booked / in_service / done），
 * 抽屉若把不认识的 appointment.status 回落到上一次打开留下的 initialStatus，
 * 就会把一张预约卡画成四步全勾。未知状态一律按已预约。
 */

export type AppointmentStepperRank = 1 | 2 | 3 | 4;

/** 抽屉顶部四步进度条认得的 appointment.status —— 其余一律回落 initialStatus */
const KNOWN_DRAWER_STATUS = ['booked', 'checked_in', 'waiting', 'in_service', 'done', 'completed'];

export type DrawerTerminal = 'cancelled' | 'no_show' | null;

/**
 * 抽屉顶部那条进度用的「当前阶段」。三处历史坑：
 *
 *  1. `activeTicket.items.every(finishedAt)` 对**空数组返回 true** —— 一张
 *     工单已开、服务项全被移除 / 作废的预约会显示成「已结束」并给出结账入口。
 *  2. 取消 / 爽约的预约 `appointment.status` 不在 KNOWN 列表里，会回落到上次
 *     打开留下的 `initialStatus`（默认 booked），把终态画成「已预约」。
 *  3. `completed` 是合法的第 4 阶段，保留。
 *
 * 返回 `stage` 交给 `appointmentStepperRank`，`terminal` 非空时调用方应改画
 * 一个终态标签而不是四步进度。
 */
export function deriveDrawerStage(input: {
  appointmentStatus: string | null | undefined;
  /** 有活动工单时传其 items；没有工单传 null */
  activeTicketItems: Array<{ finishedAt?: string | null }> | null;
  initialStatus: string;
}): { stage: string; terminal: DrawerTerminal } {
  const status = input.appointmentStatus ?? '';
  if (status === 'cancelled') return { stage: 'cancelled', terminal: 'cancelled' };
  if (status === 'no_show') return { stage: 'no_show', terminal: 'no_show' };

  const items = input.activeTicketItems;
  if (items) {
    if (items.length === 0) return { stage: 'checked_in', terminal: null };
    return {
      stage: items.every((item) => item.finishedAt) ? 'done' : 'in_service',
      terminal: null,
    };
  }
  return {
    stage: KNOWN_DRAWER_STATUS.includes(status) ? status : input.initialStatus,
    terminal: null,
  };
}

export function appointmentStepperRank(
  status: string | null | undefined,
  items?: Array<{ status?: string | null }>,
): AppointmentStepperRank {
  const itemStatuses = (items ?? []).map((item) => item.status).filter((s): s is string => Boolean(s));
  if (itemStatuses.some((s) => s === 'in_service')) return 3;
  if (itemStatuses.length > 0 && itemStatuses.every((s) => s === 'done' || s === 'completed')) return 4;
  if (itemStatuses.some((s) => s === 'booked' || s === 'checked_in')
    && (status === 'completed' || status === 'done')) {
    return itemStatuses.some((s) => s === 'checked_in') ? 2 : 1;
  }
  switch (status) {
    case 'done':
    case 'completed':
      return 4;
    case 'in_service':
      return 3;
    case 'checked_in':
    case 'waiting':
      return 2;
    case 'booked':
    default:
      return 1;
  }
}
