/**
 * 预约领域只读工具 (29 §6.2)
 */

import type { CommandContext } from '@gf/contracts';
import { withTenant } from '@gf/db';
import { pickText } from '@gf/contracts';
import { loadSlotContext, summariseSlots } from '../../queries/slots.js';

function norm(s: string): string {
  return s.toLowerCase().replace(/[\s\-_.]/g, '');
}

async function resolveMembershipByName(ctx: CommandContext, name: string): Promise<string | null> {
  const rows = await withTenant(ctx, (tx) => tx<{
    membership_id: string; display_name: unknown;
  }[]>`
    select sp.membership_id, sp.display_name
    from staff_profiles sp
    join memberships m on m.id = sp.membership_id and m.status = 'active'
    where sp.location_id = ${ctx.locationId} and sp.is_bookable = true`);

  const want = norm(name);
  const hit = rows.find((r) => {
    const raw = r.display_name;
    if (typeof raw === 'string' && norm(raw) === want) return true;
    if (raw && typeof raw === 'object') {
      return Object.values(raw as Record<string, string>).some((v) => norm(v) === want);
    }
    return false;
  });
  return hit?.membership_id ?? null;
}

export async function planAppointmentSlots(
  ctx: CommandContext,
  input: Record<string, unknown>,
): Promise<unknown> {
  const durationMin = Number(input['durationMin']) || 45;
  const dateStr = String(input['date'] ?? input['around'] ?? '').trim();
  let around = new Date();
  if (dateStr) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      // 纯日期格式按当天 16:00 UTC（纽约本地时间中午 12:00 EDT）解析，避免 UTC 零点在西区（如 UTC-4）回退到前一天晚上
      const [y = 2026, m = 1, d = 1] = dateStr.split('-').map(Number);
      around = new Date(Date.UTC(y, m - 1, d, 16, 0, 0));
    } else if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(dateStr)) {
      around = new Date(dateStr.replace(' ', 'T'));
    } else {
      around = new Date(dateStr);
    }
  }
  if (Number.isNaN(around.getTime())) return { error: 'date/around 不是合法时间' };

  let preferredMembershipId = input['preferredMembershipId'] ? String(input['preferredMembershipId']) : null;
  const staffName = input['staffName'] ? String(input['staffName']) : null;
  if (!preferredMembershipId && staffName) {
    preferredMembershipId = await resolveMembershipByName(ctx, staffName);
    if (!preferredMembershipId) {
      return { error: `店里没有叫「${staffName}」的可排单技师`, slots: [] };
    }
  }

  const partySize = Math.max(1, Math.min(20, Number(input['partySize'] ?? 1)));
  const excludeAppointmentId = input['excludeAppointmentId'] ? String(input['excludeAppointmentId']) : null;
  const previousHolds = Array.isArray(input['previousHolds']) ? input['previousHolds'] : [];

  const { businessDate, timezone, slots } = await withTenant(ctx, (tx) =>
    loadSlotContext(tx, ctx.locationId, around, durationMin, preferredMembershipId, {
      partySize,
      excludeAppointmentId,
    }),
  );

  // 内存级过滤 previousHolds，防本轮多人排单自撞 (29 §6.2)
  const holds = previousHolds.map((h: any) => {
    const start = new Date(h.startsAt).getTime();
    const dur = Number(h.durationMin) || 45;
    return {
      staffId: String(h.staffId),
      start,
      end: start + dur * 60_000,
    };
  });

  const availableSlots = slots.filter((s) => {
    const slotStart = s.startsAt.getTime();
    const slotEnd = slotStart + durationMin * 60_000;
    return !holds.some(
      (h) => h.staffId === s.membershipId && slotStart < h.end && slotEnd > h.start,
    );
  });

  // 计算时间偏移分钟数
  const localTimeStr = around.toLocaleTimeString('en-US', {
    timeZone: timezone,
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
  });
  const [h = 0, m = 0] = localTimeStr.split(':').map(Number);
  const aroundMin = h * 60 + m;

  const top = summariseSlots(availableSlots, aroundMin, 8).filter(
    (g) => g.staff.length >= partySize,
  );
  return {
    businessDate,
    timezone,
    guidance:
      top.length === 0
        ? '所选时段暂未查到满足排班条件的空档（如该日期尚未发布技师排班，或技师已被约满）。若为外部导入或前台录单，可在 appointment.create 中将 membershipId 设为 null（无指定技师/待分配）以正常创建。'
        : '以下为系统根据班表与已占时段计算出的权威空档：',
    slots: top.map((s) => ({
      startsAt: s.startsAt.toISOString(),
      staff: s.staff,
    })),
  };
}

export async function searchAppointments(
  ctx: CommandContext,
  input: Record<string, unknown>,
): Promise<unknown> {
  const date = String(input['businessDate'] ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { error: 'businessDate 格式需为 YYYY-MM-DD' };

  const customerId = input['customerId'] ? String(input['customerId']) : null;
  const staffMembershipId = input['staffMembershipId'] ? String(input['staffMembershipId']) : null;
  const limit = Math.max(1, Math.min(100, Number(input['limit'] ?? 40)));

  const rows = await withTenant(ctx, (tx) => tx<{
    item_id: string;
    appointment_id: string;
    starts_at: string | Date;
    duration_min: number;
    customer_id: string | null;
    customer_name: string | null;
    walk_in_name: string | null;
    service_name: unknown;
    staff_name: unknown;
    staff_id: string | null;
    status: string;
    is_request: boolean;
  }[]>`
    select ai.id as item_id, ai.appointment_id, ai.starts_at, ai.duration_min,
           a.customer_id, c.display_name as customer_name, a.walk_in_name,
           s.name as service_name, sp.display_name as staff_name, ai.membership_id as staff_id,
           ai.status, ai.is_request
    from appointment_items ai
    join appointments a on a.id = ai.appointment_id
    join services s on s.id = ai.service_id
    left join staff_profiles sp on sp.membership_id = ai.membership_id
    left join customers c on c.id = a.customer_id
    where ai.location_id = ${ctx.locationId}
      and a.business_date = ${date}
      and ai.status <> 'cancelled'
      ${customerId ? tx`and a.customer_id = ${customerId}` : tx``}
      ${staffMembershipId ? tx`and ai.membership_id = ${staffMembershipId}` : tx``}
    order by ai.starts_at
    limit ${limit}`);

  return {
    businessDate: date,
    totalCount: rows.length,
    appointments: rows.map((r) => ({
      appointmentId: r.appointment_id,
      itemId: r.item_id,
      customerId: r.customer_id,
      customer: r.customer_name ?? r.walk_in_name ?? '散客',
      service: pickText(r.service_name, ctx.locale),
      staffId: r.staff_id,
      staff: r.staff_name ? pickText(r.staff_name, ctx.locale) : null,
      startsAt: new Date(r.starts_at).toISOString(),
      durationMin: r.duration_min,
      status: r.status,
      isRequest: r.is_request,
    })),
  };
}
