/**
 * 通知事件与模板渲染（批 7）。
 *
 * ⭐ **事件键在这里定死，两端都从这里读。** 竞品有 12 条，我们对齐了
 * 那 12 条并且补了它没有的：AI 改期/取消之后的客人通知（docs/09 批 3
 * 那一段留的口子 —— 在这一批之前，AI 改期是**不通知客人**的）。
 */

/** 客户侧 */
export const CUSTOMER_EVENTS = [
  'appointment_confirm',      // 订上了
  'appointment_changed',      // 改期了（含 AI 改的）
  'appointment_cancelled',    // 取消了（含 AI 取消的）
  'appointment_reminder',     // 快到了
] as const;

/**
 * 技师侧。
 *
 * ⭐ `staff_pending_confirm` 是这一组里最重要的一条：在线预约和
 * AI 电话来的单**先发给技师确认，确认前不占日程**。这和
 * `call_drafts` 复核队列是同一个思路的两条路 —— 一条走前台，一条走技师。
 */
export const STAFF_EVENTS = [
  'staff_pending_confirm',
  'staff_assigned',
  'staff_changed',
  'staff_cancelled',
] as const;

/** 营销侧 */
export const MARKETING_EVENTS = [
  'birthday',
  'holiday',
  'winback',
  'review_request',
] as const;

export const NOTIFICATION_EVENTS = [
  ...CUSTOMER_EVENTS, ...STAFF_EVENTS, ...MARKETING_EVENTS,
] as const;

export type NotificationEvent = (typeof NOTIFICATION_EVENTS)[number];

export function isNotificationEvent(v: string): v is NotificationEvent {
  return (NOTIFICATION_EVENTS as readonly string[]).includes(v);
}

/**
 * 每个事件认得哪些变量。
 *
 * ⭐ 这张表的用处是**界面上告诉老板他能用什么** —— 让他对着一个
 * 空文本框猜变量名，猜错了也不会报错（未知变量渲染成空串），
 * 于是他会以为功能坏了。
 */
export const EVENT_VARIABLES: Record<NotificationEvent, readonly string[]> = {
  appointment_confirm: ['customer_name', 'shop_name', 'service_name', 'when', 'staff_name', 'shop_phone', 'manage_url'],
  appointment_changed: ['customer_name', 'shop_name', 'service_name', 'when', 'old_when', 'staff_name', 'shop_phone', 'manage_url'],
  appointment_cancelled: ['customer_name', 'shop_name', 'service_name', 'when', 'shop_phone', 'manage_url'],
  appointment_reminder: ['customer_name', 'shop_name', 'service_name', 'when', 'staff_name', 'shop_phone', 'manage_url'],
  staff_pending_confirm: ['staff_name', 'customer_name', 'service_name', 'when', 'confirm_url'],
  staff_assigned: ['staff_name', 'customer_name', 'service_name', 'when'],
  staff_changed: ['staff_name', 'customer_name', 'service_name', 'when', 'old_when'],
  staff_cancelled: ['staff_name', 'customer_name', 'service_name', 'when'],
  birthday: ['customer_name', 'shop_name', 'shop_phone'],
  holiday: ['customer_name', 'shop_name', 'holiday_name', 'shop_phone'],
  winback: ['customer_name', 'shop_name', 'days_since', 'shop_phone'],
  review_request: ['customer_name', 'shop_name', 'review_url'],
};

/**
 * 模板渲染。**纯函数** —— 不查库、不看时钟。
 *
 * ⚠️ **未知变量渲染成空字符串，不是原样留着。**
 * 把 `{{typo_name}}` 原样发给客人是最糟的结果 —— 他看到一串花括号，
 * 而店家永远不知道自己发出去的是什么样。空着至少读起来像一句话。
 *
 * ⚠️ **不做任何转义。** 这个函数同时给短信和邮件用，而两者的转义规则
 * 相反（邮件要 HTML 转义，短信不能）。转义是调用方的事 ——
 * 在这里做的话，短信里会出现 `&amp;`。
 */
export function renderTemplate(
  body: string, vars: Readonly<Record<string, string | null | undefined>>,
): string {
  return body.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (_, key: string) => vars[key] ?? '');
}

/**
 * 模板里用到了哪些变量。用来在保存时提示老板「这个变量这个事件没有」。
 *
 * ⚠️ 只**提示**不拦截：老板可能是为了以后加的变量先写上，
 * 而为一个多余的占位符拒绝保存，他会觉得这个编辑器很难用。
 */
export function templateVariables(body: string): string[] {
  const found = new Set<string>();
  for (const m of body.matchAll(/\{\{\s*([a-z_]+)\s*\}\}/g)) found.add(m[1]!);
  return [...found].sort();
}
