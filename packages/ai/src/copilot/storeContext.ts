/**
 * 门店全量上下文 → 紧凑行式文本
 *
 * ## 为什么改成一次性下发，而不是让模型自己调工具查
 *
 * 上一版把「服务目录、员工名册、房态、营业时间、排班、预约日历」全部做成
 * 只读工具，模型要用什么自己去查。实测下来三个问题：
 *
 * 1. **延迟**。每次工具往返 = 一次完整的模型调用 + 一次数据库查询。
 *    前台问「明天下午谁能给王太太做 Gel-X」要查技师、查技能、查排班、
 *    查空档四轮，光模型往返就是十几秒。
 * 2. **token 并没有省**。工具定义本身要占位（十七个工具约 2.5k token），
 *    工具返回的 JSON 比行式文本啰嗦一倍，而且每一轮的历史都要重发。
 * 3. **提示词开始打补丁对抗架构**。上一版系统提示里出现了六七处
 *    「严禁调用 XX 工具」——那是在用自然语言修一个结构问题。
 *
 * 现在改成：**能一次性装下的都装进上下文，装不下的才留工具**。
 *
 * ## 两段式切分（这是省钱的关键）
 *
 * - `StoreProfile` → 拼进 instructions，**逐字节稳定**，命中 OpenAI 前缀缓存
 *   按 0.1 倍计价。它只在店主改了服务项目/员工/房间时才变一次。
 * - `LiveContext`（现场态 + 预约日历）→ 放 user turn，每次重建。
 *   预约日历必须每轮重建：差一轮就可能撞单。
 *
 * ⚠️ 注意：把门店数据放进缓存前缀是**故意的**，和 Anthropic 那套显式断点
 * 的直觉相反。OpenAI 是自动前缀匹配，每个门店命中自己那一份变体，
 * 同一个前台连续提问全部命中。放在 user turn 里反而永远命中不了。
 *
 * ## 为什么每一行都带完整 appointmentId
 *
 * 一个 UUID 约 17 token，37 天一千多单就是近 2 万 token —— 看着吓人，
 * 但实测账单里 **input 便宜、output 贵**，这点 input 的钱远不如省下一次
 * 工具往返划算。所以不做「近几天才给 ID、远的要另外查」的窗口切分：
 * 窗口里的每一条预约都能被直接改期、取消、签到，0 往返。
 *
 * 真正要卡的是**输出**，那在提示词里管（summary 一句话、别写小作文）。
 */

// ─────────────────────────────────────────────────────────────────────────────
// 稳定段：门店档案
// ─────────────────────────────────────────────────────────────────────────────

export interface StoreProfileService {
  id: string;
  name: string;
  englishName?: string | null | undefined;
  category?: string | null | undefined;
  durationMin: number;
  priceDollars: string;
}

export interface StoreProfileStaff {
  membershipId: string;
  name: string;
  jobTitle?: string | null | undefined;
  level?: string | null | undefined;
  isBookable: boolean;
  maxConcurrent: number;
  /** active | on_leave | resigned */
  status: string;
  skills: string[];
}

export interface StoreProfileRoom {
  resourceId: string;
  name: string;
  type: string;
  capacity: number;
  maxStaff?: number | null | undefined;
}

export interface StoreProfilePackage {
  id: string;
  name: string;
  priceDollars: string;
  sessions: number;
}

export interface StoreProfile {
  location: {
    name: string;
    timezone: string;
    cutoff: string;
    address?: string | null | undefined;
    phone?: string | null | undefined;
    /** 周一到周日的营业时段，index 0 = 周日。null 表示当天不营业 */
    hours: Array<{ weekday: string; open: string; close: string } | null>;
    taxPercent?: string | null | undefined;
  };
  services: StoreProfileService[];
  staff: StoreProfileStaff[];
  rooms: StoreProfileRoom[];
  packages: StoreProfilePackage[];
}

/**
 * 门店档案压成行式文本。
 *
 * ⚠️ **输出必须是纯函数且顺序确定**：同样的门店数据必须逐字节一致，
 * 否则前缀缓存永远命中不了。调用方负责把各个数组按稳定的键排好序。
 */
export function formatStoreProfile(p: StoreProfile): string {
  const lines: string[] = ['<门店档案>'];

  const loc = p.location;
  lines.push(`LOCATION: ${loc.name} | ${loc.timezone} | 营业日截点 ${loc.cutoff}`);
  if (loc.address) lines.push(`ADDRESS: ${loc.address}`);
  if (loc.phone) lines.push(`PHONE: ${loc.phone}`);
  if (loc.taxPercent) lines.push(`TAX: ${loc.taxPercent}%`);

  const hourBits = loc.hours
    .map((h) => (h ? `${h.weekday} ${h.open}-${h.close}` : null))
    .filter((x): x is string => Boolean(x));
  const closedBits = loc.hours
    .map((h, i) => (h ? null : (WEEKDAY_LABELS[i] as string | undefined)))
    .filter((x): x is string => Boolean(x));
  if (hourBits.length > 0) {
    lines.push(`HOURS: ${hourBits.join(' | ')}${closedBits.length > 0 ? ` | 休息: ${closedBits.join(',')}` : ''}`);
  }

  if (p.services.length > 0) {
    lines.push('');
    lines.push('SERVICES (serviceId | 名称 | 英文名 | 分类 | 时长 | 标准价):');
    for (const s of p.services) {
      lines.push(
        `  ${s.id} | ${s.name} | ${s.englishName || '-'} | ${s.category || '未分类'} | ${s.durationMin}m | $${s.priceDollars}`,
      );
    }
  }

  if (p.staff.length > 0) {
    lines.push('');
    lines.push('STAFF (membershipId | 姓名 | 职位 | 可排单 | 并发上限 | 技能):');
    for (const st of p.staff) {
      const bookable = st.isBookable ? 'Y' : 'N';
      const statusBit = st.status === 'active' ? '' : ` [${st.status}]`;
      lines.push(
        `  ${st.membershipId} | ${st.name}${statusBit} | ${st.jobTitle || '-'} | ${bookable} | ${st.maxConcurrent} | ${st.skills.length > 0 ? st.skills.join(',') : '-'}`,
      );
    }
  }

  if (p.rooms.length > 0) {
    lines.push('');
    lines.push('ROOMS (resourceId | 名称 | 类型 | 容量 | 最多技师):');
    for (const r of p.rooms) {
      lines.push(`  ${r.resourceId} | ${r.name} | ${r.type} | ${r.capacity} | ${r.maxStaff ?? '-'}`);
    }
  }

  if (p.packages.length > 0) {
    lines.push('');
    lines.push('PACKAGES (次卡与套餐):');
    for (const pk of p.packages) {
      lines.push(`  ${pk.name} $${pk.priceDollars} (${pk.sessions} 次)`);
    }
  }

  lines.push('</门店档案>');
  return lines.join('\n');
}

const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

// ─────────────────────────────────────────────────────────────────────────────
// 易变段：预约日历与排班
// ─────────────────────────────────────────────────────────────────────────────

export interface CalendarItem {
  /** 窗口内每一条都有，可直接用于改期 / 取消 / 签到 */
  appointmentId: string;
  /** 门店墙上时间 HH:MM */
  startsAt: string;
  customerName: string;
  serviceName: string;
  durationMin: number;
  staffName: string | null;
  status: string;
  isRequest?: boolean | undefined;
  roomName?: string | null | undefined;
}

export interface CalendarDay {
  /** 营业日 YYYY-MM-DD */
  businessDate: string;
  /** Mon…Sun */
  weekday: string;
  items: CalendarItem[];
  /** 当日在班技师，格式 `Amy 09:00-18:00` */
  shifts: string[];
  /** 当日休息/请假的技师名 */
  off: string[];
}

export interface BookingCalendar {
  fromDate: string;
  toDate: string;
  todayDate: string;
  days: CalendarDay[];
}

/**
 * 预约日历压成行式文本。
 *
 * 完全空的日子压成一行 `(空)`，不逐条列 —— 未来一个月里大半天没单是常态，
 * 每天铺三行会把日历撑到没法读。但**空的日子必须出现**：模型要能区分
 * 「这天没人约」和「这天不在窗口里」。
 */
export function formatBookingCalendar(c: BookingCalendar): string {
  const lines: string[] = [
    `<预约日历 ${c.fromDate} ~ ${c.toDate}>`,
    '每条预约方括号里就是 appointmentId，改期 / 取消 / 签到直接拿去用，不需要再查。',
  ];

  for (const d of c.days) {
    const todayBit = d.businessDate === c.todayDate ? ' ← 今天' : '';
    const shiftBit = d.shifts.length > 0 ? ` | 在班: ${d.shifts.join(', ')}` : ' | 在班: 尚未排班';
    const offBit = d.off.length > 0 ? ` | 休: ${d.off.join(',')}` : '';
    lines.push(`== ${d.businessDate} ${d.weekday}${todayBit}${shiftBit}${offBit}`);

    if (d.items.length === 0) {
      lines.push('   (空)');
      continue;
    }
    for (const it of d.items) {
      const parts = [
        `   ${it.startsAt}`,
        `[${it.appointmentId}]`,
        it.customerName,
        `${it.serviceName} ${it.durationMin}m`,
        it.staffName ? `@${it.staffName}${it.isRequest ? '*' : ''}` : '@待分配',
        it.roomName ? `(${it.roomName})` : '',
        it.status === 'booked' ? '' : `<${it.status}>`,
      ].filter(Boolean);
      lines.push(parts.join(' '));
    }
  }

  lines.push('</预约日历>');
  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// 预算与告警
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 粗略估 token 数。中英混排按 2.5 字符 ≈ 1 token 估，偏保守 ——
 * 宁可虚报也别让上下文默默涨到没人发现。
 */
export function roughTokens(text: string): number {
  return Math.ceil(text.length / 2.5);
}

/**
 * 各段的预算。
 *
 * ⚠️ 这**不是**省钱阈值 —— 实测 input 极便宜，output 才是账单主体，
 * 为省几万 input token 去砍上下文是亏的。这几个数字只回答一个问题：
 * 「某一段有没有异常膨胀到不像话」（比如一条 SQL 忘了加 location 过滤，
 * 把整个 org 的预约都捞进来了）。超了就在日志里告警，不截断。
 *
 * 真正要盯的上限是模型的**上下文窗口**，不是钱。
 */
export const CONTEXT_TOKEN_BUDGETS = {
  /** 门店档案（进缓存前缀，0.1 倍计价，给得很宽） */
  STORE_PROFILE: 20_000,
  /** 预约日历（过去 7 天 + 未来 30 天，每行带 appointmentId） */
  BOOKING_CALENDAR: 60_000,
  /** 现场快照 */
  FLOOR_SNAPSHOT: 3_000,
} as const;
