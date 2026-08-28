/**
 * 走单队列的前台视图 —— 叫号那一屏。
 *
 * 和 Kiosk 那一侧看到的是同一份数据，但**给的信息完全不同**：
 * 客人只看得到自己的号和「前面还有几位」；前台看得到每个人是谁、
 * 等了多久、要做什么、有没有签过健康表。
 */

import type postgres from 'postgres';
import { parseTs } from '@gf/db';
import { pickText, type CommandContext } from '@gf/contracts';

export interface QueueEntryView {
  queueId: string;
  ticketNumber: number;
  status: string;
  displayName: string;
  /** 决策 16 的口径：没有 customer.view_contact 的人只看得到尾号 */
  phoneDisplay: string | null;
  customerId: string | null;
  vipLevel: number;
  serviceName: string | null;
  staffName: string | null;
  roomName: string | null;
  partySize: number;
  appointmentId: string | null;
  /** 已经等了几分钟。前台一眼看到「等了 45 分钟」比看到时间戳有用得多 */
  waitedMin: number;
  quotedWaitMin: number | null;
  /** 等得比估的久 —— 这是要主动去说一声的那几位 */
  overdue: boolean;
  source: string;
  joinedAt: string;
  /** 还差哪几份健康表没签。前台在叫号前就该知道 */
  pendingForms: number;
  intakeSigned: boolean;
  contraindications: string[];
  items?: Array<{
    serviceId: string;
    serviceName: string;
    staffName: string | null;
    durationMin: number;
    addonIds: string[];
  }>;
}

export interface QueueView {
  businessDate: string;
  waiting: QueueEntryView[];
  called: QueueEntryView[];
  seated: QueueEntryView[];
  summary: { waiting: number; called: number; longestWaitMin: number; leftToday: number };
}

export async function loadQueue(
  tx: postgres.TransactionSql,
  ctx: CommandContext,
  businessDate: string,
): Promise<QueueView> {
  const canSeeContact = ctx.permissions.has('customer.view_contact');

  const rows = await tx<{
    id: string; ticket_number: number; status: string;
    customer_id: string | null; customer_name: string | null; phone: string | null;
    vip_level: number | null;
    walk_in_name: string | null; service_name: unknown; staff_name: unknown;
    room_name: string | null;
    party_size: number; appointment_id: string | null;
    joined_at: string | Date; quoted_wait_min: number | null; source: string;
    pending_forms: string;
    signed_form_count: string;
    allergies: unknown;
  }[]>`
    select q.id, q.ticket_number, q.status,
           q.customer_id, c.display_name as customer_name, c.phone_e164 as phone,
           coalesce(c.vip_level, 0) as vip_level,
           q.walk_in_name, s.name as service_name, sp.display_name as staff_name,
           r.name as room_name,
           q.party_size, q.appointment_id, q.joined_at, q.quoted_wait_min, q.source,
           (
             select count(*) from form_templates ft
             where ft.location_id = q.location_id and ft.active = true
               and ft.published_at is not null
               and jsonb_array_length(ft.service_ids) = 0
               and not exists (
                 select 1 from form_submissions fs
                 where fs.template_id = ft.id and fs.customer_id = q.customer_id
                   and fs.anonymized_at is null
                   and (fs.expires_on is null or fs.expires_on >= current_date))
           ) as pending_forms,
           (
             select count(*) from form_submissions fs
             where fs.customer_id = q.customer_id and fs.location_id = q.location_id
               and fs.anonymized_at is null
           ) as signed_form_count,
           cp.allergies
    from walkin_queue q
    left join customers c on c.id = q.customer_id
    left join customer_preferences cp on cp.customer_id = q.customer_id
    left join services s on s.id = q.requested_service_id
    left join staff_profiles sp on sp.membership_id = q.requested_staff_id
    left join appointment_items ai on ai.appointment_id = q.appointment_id
    left join resources r on r.id = ai.resource_id
    where q.location_id = ${ctx.locationId} and q.business_date = ${businessDate}
    order by q.ticket_number`;

  const now = Date.now();

  const toView = (r: typeof rows[number]): QueueEntryView => {
    const joinedAt = parseTs(r.joined_at);
    const waitedMin = Math.max(0, Math.round((now - joinedAt.getTime()) / 60_000));
    const signedCount = Number(r.signed_form_count ?? 0);
    const pendingForms = r.customer_id ? Number(r.pending_forms) : 0;
    const intakeSigned = signedCount > 0 && pendingForms === 0;

    let contraindications: string[] = [];
    if (r.allergies && typeof r.allergies === 'object') {
      const all = r.allergies as Record<string, unknown>;
      if (Array.isArray(all['skinAllergies'])) {
        contraindications = all['skinAllergies'].map(String);
      }
    }

    return {
      queueId: r.id,
      ticketNumber: r.ticket_number,
      status: r.status,
      displayName: r.customer_name ?? r.walk_in_name ?? '临时客人',
      phoneDisplay: r.phone
        ? (canSeeContact ? r.phone : `***${r.phone.slice(-4)}`)
        : null,
      customerId: r.customer_id,
      vipLevel: r.vip_level ?? 0,
      serviceName: r.service_name ? pickText(r.service_name, ctx.locale) : null,
      staffName: r.staff_name ? pickText(r.staff_name, ctx.locale) : null,
      roomName: r.room_name ?? null,
      partySize: r.party_size,
      appointmentId: r.appointment_id,
      waitedMin,
      quotedWaitMin: r.quoted_wait_min,
      overdue: r.quoted_wait_min !== null && waitedMin > r.quoted_wait_min + 10,
      source: r.source,
      joinedAt: joinedAt.toISOString(),
      pendingForms,
      intakeSigned,
      contraindications,
    };
  };

  const all = rows.map(toView);
  const waiting = all.filter((e) => e.status === 'waiting');

  return {
    businessDate,
    waiting,
    called: all.filter((e) => e.status === 'called'),
    seated: all.filter((e) => e.status === 'seated'),
    summary: {
      waiting: waiting.length,
      called: all.filter((e) => e.status === 'called').length,
      longestWaitMin: waiting.reduce((m, e) => Math.max(m, e.waitedMin), 0),
      // 今天走掉几个 —— 这是老板最该看到的数，它直接对应流失
      leftToday: all.filter((e) => e.status === 'left').length,
    },
  };
}
