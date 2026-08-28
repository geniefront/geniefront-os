/**
 * 候客队列的类型定义，与服务端 `GET /v1/desk/queue` 的返回一一对应。
 *
 * ⚠️ 队列与预约是两条独立的线：预约描述「几点做什么」，队列描述「现在谁在等」。
 * 有预约的客人到店签到后同样进入队列（`appointmentId` 非空），前台只需看一处。
 */

export interface QueueEntry {
  queueId: string;
  /** 号码按营业日从 1 重新计数，与前一日不冲突。 */
  ticketNumber: number;
  status: string;
  displayName: string;
  /**
   * ⚠️ 服务端按权限脱敏：不具备 `customer.view_contact` 的操作者只会拿到尾号。
   * 前端不得尝试还原完整号码，也不应据此判断权限。
   */
  phoneDisplay: string | null;
  customerId: string | null;
  serviceName: string | null;
  staffName: string | null;
  partySize: number;
  /** 非空表示这位是有预约的客人到店签到，而非临时到店。 */
  appointmentId: string | null;
  /** 已等待分钟数。比时间戳更贴近前台的判断方式。 */
  waitedMin: number;
  quotedWaitMin: number | null;
  /** 实际等待已超出承诺时长 —— 这几位需要主动去说明情况。 */
  overdue: boolean;
  source: string;
  joinedAt: string;
  /** 尚未签署的健康表数量。叫号前就应知道，避免客人上床后才发现缺表。 */
  pendingForms: number;
}

export interface QueueSummary {
  waiting: number;
  called: number;
  longestWaitMin: number;
  leftToday: number;
}

export interface QueueView {
  businessDate: string;
  waiting: QueueEntry[];
  called: QueueEntry[];
  seated: QueueEntry[];
  summary: QueueSummary;
}

/** 队列状态流转的目标值。取值与服务端 `queue.update` 的枚举一致。 */
export const QUEUE_STATUSES = ['waiting', 'called', 'seated', 'left'] as const;
export type QueueStatus = (typeof QUEUE_STATUSES)[number];

/**
 * 离场原因。`status = 'left'` 时**必填** ——
 * 「等太久走了」与「说了一声改天再来」对门店是完全不同的信号，
 * 前者需要复盘排班，后者不需要。
 */
export const QUEUE_LEFT_REASONS = [
  'waited_too_long',   // 直接对应客户流失，需可统计
  'told_us',           // 主动说明后先去别处
  'seated_elsewhere',  // 前台改用其他方式安排
  'no_response',       // 叫号无人应答
  'other',
] as const;
export type QueueLeftReason = (typeof QUEUE_LEFT_REASONS)[number];
