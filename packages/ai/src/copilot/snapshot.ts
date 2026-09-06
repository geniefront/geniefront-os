/**
 * 现场快照 → 紧凑行式文本（05 §6.1）
 *
 * ⭐ **这一段要压在 2k token 以内**（预算见 CONTEXT_TOKEN_BUDGETS）。
 * 同样的信息，JSON 要 4k token，写成下面这样 400 token —— 而且实测
 * 模型读得更准：JSON 里 `"membershipId":"a3ce…"` 这种键值对会把注意力
 * 分散到一堆它根本不需要的 uuid 上。
 *
 * ```
 * 14:32 Sat | Lotus Nails | 6 tech on floor | 3 rooms free | queue: 2 waiting (~20m)
 * TURN: Amy(1.0) > Linh(1.0) > Kim(0.5) > Tran[skip:no-gelx] > Mai[break til 14:45]
 * NOW:  Amy→#1041 Gel Full Set (ends 15:05) | Linh→#1043 Pedi (ends 14:50) | Kim idle
 * NEXT: 15:00 Chen L. Deep Tissue 60m w/ Mai r3
 *       15:30 walk-in slot open
 * ```
 *
 * ## 这一段只讲「此刻」
 *
 * 1. **不给 uuid。** 服务、员工、房间的 ID 在 `storeContext.ts` 的门店档案里
 *    一次性下发（那一段进缓存前缀，按 0.1 倍计价）；预约的 appointmentId 在
 *    预约日历的明细窗口里。快照这一段只回答「现在场子什么样」，
 *    塞 uuid 进来既烧 token 又和另外两段重复。
 * 2. **快照不脱敏**（决策 23）。客人真实姓名和手机号照给 ——
 *    前台需要一眼认人，脱敏会拖慢高频操作。技师端那边的手机号脱敏
 *    （决策 16）是防挖客，两回事。
 *
 * 这个文件是**纯函数**：不认识数据库、不认识模型供应商，只做格式化。
 * 所以「快照长什么样」这件事可以被完整地测。
 */

/**
 * 服务端权威时间锚点 (29 §2, §5.3)
 * 冻结当前提问时刻的时间基准，杜绝“明天下午2点”推算错乱
 */
export interface TimeAnchor {
  /** 完整 UTC ISO 字符串，如 2026-09-06T19:30:00.000Z */
  iso: string;
  /** 门店本地公历日期 YYYY-MM-DD，如 2026-09-06 */
  localDate: string;
  /** 门店本地时间 HH:MM:SS 或 HH:MM，如 15:30:00 */
  localTime: string;
  /** 完整英文周几，如 Sunday */
  weekday: string;
  /** IANA 时区名称，如 America/New_York */
  timezone: string;
  /** UTC 偏移量，如 -04:00 */
  utcOffset: string;
  /** 门店当前所属营业日 YYYY-MM-DD (跨午夜在 cutoff 前算上一日) */
  businessDate: string;
  /** 营业日截点，如 04:00 */
  cutoff: string;
}

export function formatTimeAnchor(anchor: TimeAnchor): string {
  const offset = anchor.utcOffset.startsWith('-') || anchor.utcOffset.startsWith('+')
    ? anchor.utcOffset
    : `+${anchor.utcOffset}`;
  return [
    '<时间锚点>',
    `权威本地日期: ${anchor.localDate} (${anchor.weekday})`,
    `权威本地时间: ${anchor.localTime} (${anchor.timezone}, UTC${offset})`,
    `当前营业日: ${anchor.businessDate} (营业截点: ${anchor.cutoff})`,
    `基准时间戳: ${anchor.iso}`,
    '</时间锚点>',
  ].join('\n');
}

/** 门店此刻。分钟数是**门店墙上时间**，不是 UTC */
export interface FloorHeader {
  /** 门店本地的 HH:MM */
  clock: string;
  /** Mon…Sun */
  weekday: string;
  shopName: string;
  onFloor: number;
  roomsFree: number;
  roomsTotal: number;
  queueWaiting: number;
  /** 最长等待分钟数。0 = 没人等 */
  queueLongestWaitMin: number;
}

export interface TurnEntry {
  name: string;
  /** 已消耗轮次，1.0 = 一轮 */
  turns: number;
  /** available | working | break | skipped | off */
  state: string;
  /** 被跳过/休息的原因，一句短的。没有就不写 */
  note?: string;
  /** 欠他一轮（下次优先） */
  owed?: boolean;
}

export interface NowEntry {
  staffName: string;
  customerName: string;
  serviceName: string;
  /** 门店墙上时间 HH:MM */
  endsAt: string;
  overbooked?: boolean;
}

export interface NextEntry {
  /** 门店墙上时间 HH:MM */
  startsAt: string;
  customerName: string;
  serviceName: string;
  durationMin: number;
  staffName: string | null;
  /** 点钟单 */
  isRequest?: boolean;
  /** 落单要素：力度/部位/避开哪里。原样带过来，前台念得出来才有用 */
  details?: string;
}

export interface QueueEntry {
  ticketNumber: number;
  name: string;
  waitedMin: number;
  /** 等得比估的久 —— 这是要主动去说一声的那几位 */
  overdue?: boolean;
  wants?: string;
}

export interface FloorSnapshot {
  header: FloorHeader;
  turn: TurnEntry[];
  now: NowEntry[];
  /** 接下来的预约，已按时间排好 */
  next: NextEntry[];
  queue: QueueEntry[];
  /** 空着能接人的技师 */
  idle: string[];
}

/** 一行最多带几个 NEXT。再多前台自己也记不住，而模型会被它们带偏 */
const MAX_NEXT = 6;
const MAX_QUEUE = 6;

/**
 * 压成行式文本。
 *
 * 空的段**整段省掉**，不写 `NOW: (none)` —— 那是一行没有信息的 token，
 * 而模型看到 `NOW:` 后面是空的反而会去猜它是不是被截断了。
 */
export function formatFloorSnapshot(s: FloorSnapshot): string {
  const lines: string[] = [];
  const h = s.header;

  const queueBit = h.queueWaiting > 0
    ? `queue: ${h.queueWaiting} waiting${h.queueLongestWaitMin > 0
        ? ` (longest ~${h.queueLongestWaitMin}m)` : ''}`
    : 'queue: empty';

  lines.push([
    `${h.clock} ${h.weekday}`,
    h.shopName,
    `${h.onFloor} tech on floor`,
    `${h.roomsFree}/${h.roomsTotal} rooms free`,
    queueBit,
  ].join(' | '));

  if (s.turn.length > 0) {
    lines.push(`TURN: ${s.turn.map(turnBit).join(' > ')}`);
  }

  if (s.now.length > 0 || s.idle.length > 0) {
    const parts = s.now.map((n) =>
      `${n.staffName}→${n.customerName} ${n.serviceName} (ends ${n.endsAt})`
      + (n.overbooked ? ' [overbooked]' : ''));
    if (s.idle.length > 0) parts.push(`idle: ${s.idle.join(', ')}`);
    lines.push(`NOW:  ${parts.join(' | ')}`);
  }

  if (s.next.length > 0) {
    const rows = s.next.slice(0, MAX_NEXT).map((n) => [
      n.startsAt,
      n.customerName,
      `${n.serviceName} ${n.durationMin}m`,
      n.staffName ? `w/ ${n.staffName}${n.isRequest ? ' [request]' : ''}` : '[no staff yet]',
      n.details ?? '',
    ].filter(Boolean).join(' '));
    lines.push(`NEXT: ${rows[0]}`);
    for (const r of rows.slice(1)) lines.push(`      ${r}`);
    if (s.next.length > MAX_NEXT) {
      lines.push(`      (+${s.next.length - MAX_NEXT} more later today)`);
    }
  }

  if (s.queue.length > 0) {
    const rows = s.queue.slice(0, MAX_QUEUE).map((q) =>
      `#${q.ticketNumber} ${q.name} ${q.waitedMin}m${q.overdue ? '!' : ''}`
      + (q.wants ? ` (${q.wants})` : ''));
    lines.push(`WAIT: ${rows.join(' | ')}`);
    if (s.queue.length > MAX_QUEUE) {
      lines.push(`      (+${s.queue.length - MAX_QUEUE} more waiting)`);
    }
  }

  return lines.join('\n');
}

/**
 * 一个人在轮牌行里的样子。
 *
 * 状态用方括号带原因：`Tran[skip:no-gelx]` 比 `Tran(skipped)` 多两个 token，
 * 但它回答了前台真正会问的那个问题 —— 「为什么跳过她」。
 * 少了这个，模型会把「Tran 有空」当成可以派单，而她其实不会做这个项目。
 */
function turnBit(e: TurnEntry): string {
  const owed = e.owed ? '+owed' : '';
  switch (e.state) {
    case 'break':
      return `${e.name}[break${e.note ? ` ${e.note}` : ''}]`;
    case 'skipped':
      return `${e.name}[skip${e.note ? `:${e.note}` : ''}]${owed}`;
    case 'off':
      return `${e.name}[off]`;
    case 'working':
      return `${e.name}(${e.turns.toFixed(1)})[busy]${owed}`;
    default:
      return `${e.name}(${e.turns.toFixed(1)})${owed}`;
  }
}

/**
 * token 估算与各段预算统一放在 storeContext.ts，这里只做转发，
 * 避免两份实现随时间漂移。
 */
export { roughTokens, CONTEXT_TOKEN_BUDGETS } from './storeContext.js';
