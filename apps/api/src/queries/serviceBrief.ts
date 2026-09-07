/**
 * 入座服务单一页纸的数据来源。
 *
 * ## 这张纸给谁看
 *
 * 技师。他站在床边，要在动手之前知道：客人是谁、今天做哪几项、由谁做、
 * 在哪个位子、力度与精油怎么给、哪里不能碰、身体有没有需要留意的情况。
 *
 * ## ⭐ 健康信息按方案 A 走：服务端读解密答案，权限校验 + 访问留痕
 *
 * 问卷答案存在 `form_submissions.answers_encrypted` 里。本查询通过
 * `readSubmission()` 读取 —— 那里会先校验 `customer.view_health_form`，
 * 再写一条 `form_access_log`，然后才解密。顺序不能反：一次解密到一半
 * 失败的读取恰恰是最该留痕的一次。
 *
 * 店主已明确技师可以看到全部健康信息，因此这里**不做脱敏**，问卷原文
 * 随一页纸一同返回。但「不脱敏」只改变印多少，不改变要不要记录 ——
 * 每打印一次仍然留一条访问日志，理由记为 `export`（这张纸会被带离系统）。
 *
 * 没有 `customer.view_health_form` 的人（多数技师账号）拿到的是降级结果：
 * 避开部位与「有无禁忌」这一层结论仍然给，问卷原文为 null。这样一张纸
 * 在任何账号下都印得出来，只是详略不同 —— 直接报权限错误会让前台在
 * 客人已经躺下的时候拿不出任何交接信息。
 */
import type postgres from 'postgres';
import { AppError, ERROR_CODES, pickText, type CommandContext } from '@gf/contracts';
import { readSubmission } from './forms';

/**
 * 由解密答案推导出的技师可执行建议。
 *
 * 只给**编码**，不给成句的文案 —— 一页纸要按当前打印语言整页重新生成，
 * 文案必须走前端词典才能五种语言齐备。服务端拼好中文字符串再翻译，
 * 等于把词典分散到两个仓库里。
 */
export interface ServiceBriefAdviceItem {
  /** 词典键的后缀，前端拼成 `print.adviceXxx`。取值见下方 CONDITION_ADVICE。 */
  code: string;
  /** `avoid` 是绝对禁止，`caution` 是需要留意。排版上前者更醒目。 */
  severity: 'avoid' | 'caution';
}

/**
 * 公共健康排查项 → 技师建议。
 *
 * 这些键由顾客端的健康排查区写入 `answers.conditions`，与门店自建的
 * 题库无关，因此可以在服务端稳定映射。逐条显式列出，不做运行期拼接：
 * 拼出来的编码对前端词典的静态分析不可见，会被瘦身脚本当作未引用删掉。
 */
const CONDITION_ADVICE: Record<string, ServiceBriefAdviceItem> = {
  pregnancy: { code: 'Pregnancy', severity: 'avoid' },
  blood_clots: { code: 'BloodClots', severity: 'avoid' },
  pacemaker: { code: 'Pacemaker', severity: 'avoid' },
  heart_condition: { code: 'HeartCondition', severity: 'caution' },
  high_low_bp: { code: 'BloodPressure', severity: 'caution' },
  diabetes: { code: 'Diabetes', severity: 'caution' },
  cancer_oncology: { code: 'Oncology', severity: 'caution' },
  spine_neck: { code: 'SpineNeck', severity: 'caution' },
  arthritis: { code: 'Arthritis', severity: 'caution' },
  fibromyalgia: { code: 'Fibromyalgia', severity: 'caution' },
};

export interface ServiceBriefItem {
  ticketItemId: string;
  name: string;
  durationMin: number;
  totalCents: number;
  staffNames: string[];
  roomName: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface ServiceBrief {
  ticketId: string;
  ticketNumber: number | null;
  businessDate: string;
  openedAt: string;
  locationName: Record<string, string> | string;
  timezone: string;
  customerName: string;
  customerPhone: string | null;
  /** 含本单在内的到店次数。1 表示首次。 */
  visitCount: number;
  isFirstVisit: boolean;
  items: ServiceBriefItem[];
  subtotalCents: number;
  preferences: {
    strength: string | null;
    oil: string | null;
    focusAreas: string[];
    avoidAreas: string[];
    quiet: boolean;
    freeNotes: string | null;
    allergies: string[];
  };
  /** 前台在入座弹窗里填的交接备注，存在 `appointments.notes`。 */
  handoffNote: string | null;
  health: {
    /** 是否存在「有禁忌」标记。无论有没有查看权限都给。 */
    hasFlag: boolean;
    advice: ServiceBriefAdviceItem[];
    /** 有 `customer.view_health_form` 时才非空。 */
    form: {
      submissionId: string;
      templateTitle: Record<string, string>;
      signedAt: string | null;
      signerName: string | null;
      questions: unknown[];
      answers: Record<string, unknown> | null;
    } | null;
    /** false 表示当前账号没有查看权限，纸上只印结论层。 */
    canViewForm: boolean;
  };
}

export async function loadServiceBrief(
  tx: postgres.TransactionSql,
  ctx: CommandContext,
  ticketId: string,
): Promise<ServiceBrief> {
  const [ticket] = await tx<{
    id: string; business_date: string; opened_at: string; customer_id: string | null;
    walk_in_name: string | null; appointment_id: string | null; subtotal_cents: number;
    customer_name: string | null; customer_phone: string | null;
    location_name: unknown; timezone: string; notes: string | null;
    ticket_number: number | null;
  }[]>`
    select t.id, t.business_date::text as business_date, t.opened_at::text as opened_at,
           t.customer_id, t.walk_in_name, t.appointment_id, t.subtotal_cents,
           c.display_name as customer_name, c.phone_e164 as customer_phone,
           l.name as location_name, l.timezone,
           a.notes, q.ticket_number
    from tickets t
    join locations l on l.id = t.location_id
    left join customers c on c.id = t.customer_id
    left join appointments a on a.id = t.appointment_id
    -- 排号来自现场队列。预约直接开单的没有排号，纸上就只印单号。
    left join walkin_queue q on q.appointment_id = t.appointment_id
      and q.business_date = t.business_date and q.status <> 'left'
    where t.id = ${ticketId} and t.location_id = ${ctx.locationId}`;
  if (!ticket) throw new AppError(ERROR_CODES.NOT_FOUND, { details: { entity: 'ticket' } });

  /*
   * 一个项目可能派给两位技师，因此按项目聚合姓名，不让同一项在纸上出现两行 ——
   * 技师看的是「这一项谁做」，不是「有几条派工记录」。
   */
  const itemRows = await tx<{
    id: string; name_snapshot: unknown; duration_min: number; total_cents: number;
    started_at: string | null; finished_at: string | null; seq: number;
    room_name: unknown | null; staff_name: unknown | null;
  }[]>`
    select ti.id, ti.name_snapshot, ti.duration_min, ti.total_cents,
           ti.started_at::text as started_at, ti.finished_at::text as finished_at, ti.seq,
           r.name as room_name, sp.display_name as staff_name
    from ticket_items ti
    left join resources r on r.id = ti.resource_id
    left join ticket_item_staff tis on tis.ticket_item_id = ti.id
    left join staff_profiles sp on sp.membership_id = tis.membership_id
    where ti.ticket_id = ${ticketId}
    order by ti.seq, ti.id`;

  const itemMap = new Map<string, ServiceBriefItem>();
  for (const row of itemRows) {
    const existing = itemMap.get(row.id);
    const staffName = row.staff_name ? pickText(row.staff_name, ctx.locale) : null;
    if (existing) {
      if (staffName && !existing.staffNames.includes(staffName)) existing.staffNames.push(staffName);
      continue;
    }
    itemMap.set(row.id, {
      ticketItemId: row.id,
      name: pickText(row.name_snapshot, ctx.locale) ?? '',
      durationMin: row.duration_min,
      totalCents: row.total_cents,
      staffNames: staffName ? [staffName] : [],
      roomName: row.room_name ? pickText(row.room_name, ctx.locale) : null,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
    });
  }

  /*
   * 到店次数含本单。技师问的是「他是第几次来」，不是「来过几次」——
   * 第一次来的客人纸上要写「首次到店」，那正是 count === 1 的情形。
   */
  let visitCount = 1;
  if (ticket.customer_id) {
    const [visits] = await tx<{ n: number }[]>`
      select count(*)::int as n from tickets
      where customer_id = ${ticket.customer_id} and location_id = ${ctx.locationId}
        and status <> 'voided'`;
    visitCount = Math.max(1, visits?.n ?? 1);
  }

  const [prefs] = ticket.customer_id
    ? await tx<{ profile: Record<string, unknown> | null; free_notes: string | null; allergies: Record<string, unknown> | null }[]>`
        select profile, free_notes, allergies from customer_preferences
        where customer_id = ${ticket.customer_id}`
    : [undefined];
  const profile = (prefs?.profile ?? {}) as Record<string, unknown>;
  const asStrings = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];

  const allergyValues = Object.values((prefs?.allergies ?? {}) as Record<string, unknown>)
    .flatMap((v) => asStrings(v));

  /*
   * 最近一份**有效**问卷：过期的不算。技师照着一份去年的问卷做，
   * 比没有问卷更危险 —— 他会以为自己已经确认过了。
   */
  const [submission] = ticket.customer_id
    ? await tx<{ id: string }[]>`
        select s.id from form_submissions s
        where s.customer_id = ${ticket.customer_id} and s.location_id = ${ctx.locationId}
          and s.anonymized_at is null
          and (s.expires_on is null or s.expires_on >= current_date)
        order by s.signed_at desc nulls last, s.created_at desc
        limit 1`
    : [undefined];

  const canViewForm = ctx.permissions.has('customer.view_health_form');
  let form: ServiceBrief['health']['form'] = null;
  const advice: ServiceBriefAdviceItem[] = [];

  if (submission && canViewForm) {
    /*
     * ⭐ 权限校验与访问留痕都在 readSubmission 里完成。
     * reason 记 `export`：这张纸会被打印出来带离系统，它比一次屏幕上的
     * 查看更需要说清楚是谁、什么时候、为什么把内容取走的。
     */
    const detail = await readSubmission(tx, ctx, submission.id, 'export');
    form = {
      submissionId: detail.submissionId,
      templateTitle: detail.templateTitle,
      signedAt: detail.signedAt,
      signerName: detail.signerName,
      questions: detail.questions,
      answers: detail.answers,
    };

    const conditions = detail.answers?.['conditions'];
    if (conditions && typeof conditions === 'object' && !Array.isArray(conditions)) {
      for (const [key, value] of Object.entries(conditions as Record<string, unknown>)) {
        const mapped = value === true ? CONDITION_ADVICE[key] : undefined;
        if (mapped) advice.push(mapped);
      }
    }
  }

  return {
    ticketId: ticket.id,
    ticketNumber: ticket.ticket_number,
    businessDate: ticket.business_date,
    openedAt: ticket.opened_at,
    locationName: (ticket.location_name ?? '') as Record<string, string> | string,
    timezone: ticket.timezone,
    customerName: ticket.customer_name ?? ticket.walk_in_name ?? '',
    customerPhone: ticket.customer_phone,
    visitCount,
    isFirstVisit: visitCount <= 1,
    items: [...itemMap.values()],
    subtotalCents: ticket.subtotal_cents,
    preferences: {
      strength: typeof profile['strength'] === 'string' ? profile['strength'] : null,
      oil: typeof profile['oil'] === 'string' ? profile['oil'] : null,
      focusAreas: asStrings(profile['focus_areas']),
      avoidAreas: asStrings(profile['avoid_areas']),
      quiet: profile['quiet'] === true,
      freeNotes: prefs?.free_notes ?? null,
      allergies: allergyValues,
    },
    handoffNote: ticket.notes,
    health: {
      hasFlag: profile['health_flag'] === true,
      advice,
      form,
      canViewForm,
    },
  };
}
