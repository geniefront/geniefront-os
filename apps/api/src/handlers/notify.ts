/**
 * 折扣明细 + 通知模板（批 7，sql/0044）。
 *
 * ## 折扣：为什么要明细表
 *
 * 在此之前只有 `day_closes.discount_cents` 一个汇总数。华人店的折扣是
 * **前台口头给的、现场给的** —— 老熟客说一句「今天给我便宜十块」，
 * 前台就按了。月底老板看到一个总数，但不知道那是二十个十块还是
 * 两个一百块，也不知道是谁批的。
 *
 * ## 通知：为什么要版本化
 *
 * 改了模板之后，队列里已经入队但还没发出去的消息必须用**旧版本**渲染。
 * outbox 那一行本来就该是「那封信本身」（email/render.ts 文件头）——
 * 内容事后漂移的话，客服照着日志念给客人听的和他收到的对不上。
 */

import {
  SaveDiscountReason, ApplyDiscount, VoidDiscount,
  SaveNotificationTemplate, ToggleNotificationRule,
  SaveMarketingHoliday, DeleteMarketingHoliday,
  templateVariables, EVENT_VARIABLES, MARKETING_EVENTS,
  AppError, ERROR_CODES,
} from '@gf/contracts';
import { jsonb } from '@gf/db';
import { registerHandler, type HandlerArgs } from '../bus';

// ─────────────────────────────────────────────────────────────── 折扣原因

registerHandler(SaveDiscountReason, async ({ input, ctx, tx, audit }: HandlerArgs<
  typeof SaveDiscountReason.input._type>) => {
  const [row] = input.id
    ? await tx<{ id: string }[]>`
        update discount_reasons set
          label = ${jsonb(input.label)}::jsonb,
          max_self_approve_cents = ${input.maxSelfApproveCents ?? null},
          active = ${input.active}
        where id = ${input.id} and location_id = ${ctx.locationId}
        returning id`
    : await tx<{ id: string }[]>`
        insert into discount_reasons
          (org_id, location_id, label, max_self_approve_cents, active)
        values (${ctx.orgId}, ${ctx.locationId}, ${jsonb(input.label)}::jsonb,
                ${input.maxSelfApproveCents ?? null}, ${input.active})
        returning id`;

  if (!row) throw new AppError(ERROR_CODES.NOT_FOUND, { details: { entity: 'discount_reason' } });

  audit({
    entityType: 'discount_reason', entityId: row.id,
    after: { maxSelfApproveCents: input.maxSelfApproveCents ?? null, active: input.active },
  });
  return { reasonId: row.id };
});

// ─────────────────────────────────────────────────────────────── 打折

registerHandler(ApplyDiscount, async ({ input, ctx, tx, audit }: HandlerArgs<
  typeof ApplyDiscount.input._type>) => {
  const [ticket] = await tx<{ id: string; status: string; subtotal: number }[]>`
    select id, status, subtotal_cents as subtotal from tickets
    where id = ${input.ticketId} and location_id = ${ctx.locationId} for update`;
  if (!ticket) throw new AppError(ERROR_CODES.NOT_FOUND, { details: { entity: 'ticket' } });
  /*
   * ⚠️ 开单之后的状态是 `in_service`，**不是 `open`** ——
   * 这个模型里没有 `open` 这个状态（ticket.open 那条命令的名字
   * 指的是「开一张单」这个动作，不是它落地成什么状态）。
   * 按 `!== 'open'` 判的话，每一笔折扣都会被当成「单已经结了」拒掉。
   */
  if (ticket.status !== 'in_service') {
    throw new AppError(ERROR_CODES.TICKET_ALREADY_CLOSED, {
      details: { ticketId: ticket.id, status: ticket.status },
    });
  }

  /*
   * 折算成实际金额。
   *
   * ⭐ 百分比的基数是**这一项**（挂在 item 上）或**整单小计**（整单折扣），
   * 不是「减完别的折扣之后的余额」—— 两笔八折叠加应该是 0.8+0.8 而不是
   * 0.8×0.8。后者在真店里会算出一个谁也说不清的数，而客人是拿计算器的。
   */
  let base = ticket.subtotal;
  if (input.ticketItemId) {
    const [item] = await tx<{ total: number }[]>`
      select total_cents as total from ticket_items
      where id = ${input.ticketItemId} and ticket_id = ${ticket.id}`;
    if (!item) throw new AppError(ERROR_CODES.NOT_FOUND, { details: { entity: 'ticket_item' } });
    base = item.total;
  }

  const amount = input.kind === 'percent'
    ? Math.floor((base * (input.percentBp ?? 0)) / 10000)
    : (input.amountCents ?? 0);

  if (amount <= 0) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, { details: { reason: 'zero_discount' } });
  }

  /*
   * ⚠️ 折扣总额不能超过小计。
   *
   * 超了的话这一单变成负数，而负数会一路流进日结、提成、报表 ——
   * 每一处都要单独判负，漏一处就是一个查不出来的差额。在入口挡死。
   */
  const [existing] = await tx<{ n: number }[]>`
    select coalesce(sum(amount_cents), 0)::int as n from ticket_discounts
    where ticket_id = ${ticket.id} and reversed_at is null`;
  if ((existing?.n ?? 0) + amount > ticket.subtotal) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
      details: {
        reason: 'discount_exceeds_subtotal',
        subtotalCents: ticket.subtotal, alreadyCents: existing?.n ?? 0, requestedCents: amount,
      },
    });
  }

  if (!input.reasonId && !input.reasonText?.trim()) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
      details: { reason: 'discount_reason_required' },
    });
  }

  /*
   * ⭐ 自助额度。超了必须有人批。
   *
   * ⚠️ **不能自己批自己。** 前台在自己的屏幕上选一个「老板」当授权人
   * 是这道闸最容易被绕过的方式 —— 界面上要做成「请老板过来点一下」，
   * 而这里至少挡住「授权人 = 操作人」这种最直白的情况。
   */
  if (input.reasonId) {
    const [r] = await tx<{ cap: number | null }[]>`
      select max_self_approve_cents as cap from discount_reasons
      where id = ${input.reasonId} and location_id = ${ctx.locationId}`;
    if (r?.cap !== null && r?.cap !== undefined && amount > r.cap) {
      if (!input.approvedBy) {
        throw new AppError(ERROR_CODES.PERMISSION_DENIED, {
          details: { reason: 'discount_needs_approval', capCents: r.cap, requestedCents: amount },
        });
      }
      if (input.approvedBy === ctx.membershipId) {
        throw new AppError(ERROR_CODES.PERMISSION_DENIED, {
          details: { reason: 'discount_self_approval' },
        });
      }
    }
  }

  const [row] = await tx<{ id: string }[]>`
    insert into ticket_discounts
      (org_id, location_id, ticket_id, ticket_item_id, reason_id, reason_text,
       kind, amount_cents, percent_bp, granted_by, approved_by)
    values (${ctx.orgId}, ${ctx.locationId}, ${ticket.id}, ${input.ticketItemId ?? null},
            ${input.reasonId ?? null}, ${input.reasonText ?? null},
            ${input.kind}, ${amount}, ${input.percentBp ?? null},
            ${ctx.membershipId}, ${input.approvedBy ?? null})
    returning id`;

  const subtotal = await syncTicketDiscount(tx, ticket.id);

  audit({
    entityType: 'ticket', entityId: ticket.id,
    after: {
      discountId: row!.id, kind: input.kind, percentBp: input.percentBp ?? null,
      reasonId: input.reasonId ?? null,
      approvedBy: input.approvedBy ?? null,
    },
  });

  return { discountId: row!.id, amountCents: amount, ticketSubtotalCents: subtotal };
});

registerHandler(VoidDiscount, async ({ input, ctx, tx, audit }: HandlerArgs<
  typeof VoidDiscount.input._type>) => {
  // ⚠️ 只冲销不删除（宪法第 9 条）。删掉的话「这一单当初打过折」这件事
  // 就消失了，而漏损率正是靠这些行算的
  const [row] = await tx<{ id: string; ticket_id: string }[]>`
    update ticket_discounts set reversed_at = now(), reversed_by = ${ctx.membershipId}
    where id = ${input.discountId} and location_id = ${ctx.locationId}
      and reversed_at is null
    returning id, ticket_id`;
  if (!row) {
    throw new AppError(ERROR_CODES.NOT_FOUND, {
      details: { entity: 'ticket_discount', reason: 'already_reversed_or_missing' },
    });
  }

  const subtotal = await syncTicketDiscount(tx, row.ticket_id);
  audit({
    entityType: 'ticket', entityId: row.ticket_id,
    after: { voidedDiscountId: row.id, reason: input.reason },
  });
  return { discountId: row.id, ticketSubtotalCents: subtotal };
});

/**
 * 把明细的合计同步回 `tickets.discount_cents`。
 *
 * ⭐ 那一列变成**明细的缓存**，不再是事实源 —— 和礼品卡余额同一个套路。
 * 保留它是因为结账、日结、报表全都在读它，改成每次 join 明细表
 * 会让每一条查询都多一次聚合。
 */
async function syncTicketDiscount(
  tx: HandlerArgs<unknown>['tx'], ticketId: string,
): Promise<number> {
  const [d] = await tx<{ n: number }[]>`
    select coalesce(sum(amount_cents), 0)::int as n from ticket_discounts
    where ticket_id = ${ticketId} and reversed_at is null`;
  const [t] = await tx<{ subtotal: number }[]>`
    update tickets set discount_cents = ${d?.n ?? 0}
    where id = ${ticketId}
    returning subtotal_cents as subtotal`;
  return t?.subtotal ?? 0;
}

// ─────────────────────────────────────────────────────────── 通知模板

registerHandler(SaveNotificationTemplate, async ({ input, ctx, tx, audit }: HandlerArgs<
  typeof SaveNotificationTemplate.input._type>) => {
  /*
   * ⭐ 每次保存都是**新版本**，不是原地改。
   *
   * 队列里可能还有引用旧版本的消息 —— 那些必须按当初的措辞发出去。
   * 原地改的话，一条昨天生成的确认信会带上今天改的话，
   * 而客服照着日志念给客人听的和他收到的对不上。
   */
  const [cur] = await tx<{ v: number }[]>`
    select coalesce(max(version), 0) as v from notification_templates
    where location_id = ${ctx.locationId} and event_key = ${input.eventKey}
      and channel = ${input.channel} and locale = ${input.locale}`;
  const version = (cur?.v ?? 0) + 1;

  const [row] = await tx<{ id: string }[]>`
    insert into notification_templates
      (org_id, location_id, event_key, channel, locale, version,
       subject, body, active, updated_by)
    values (${ctx.orgId}, ${ctx.locationId}, ${input.eventKey}, ${input.channel},
            ${input.locale}, ${version}, ${input.subject ?? null}, ${input.body},
            ${input.active}, ${ctx.membershipId})
    returning id`;

  // 旧版本一律停用 —— 留着行是为了历史消息，不是为了还在用
  await tx`
    update notification_templates set active = false, updated_at = now()
    where location_id = ${ctx.locationId} and event_key = ${input.eventKey}
      and channel = ${input.channel} and locale = ${input.locale}
      and version < ${version}`;

  /*
   * ⚠️ 用了这个事件没有的变量只**记进审计**，不拦。
   *
   * 老板可能是为了以后加的变量先写上；而为一个多余的占位符拒绝保存，
   * 他会觉得这个编辑器很难用。未知变量渲染成空串，不会发出花括号。
   */
  const used = templateVariables(input.body);
  const known = new Set(EVENT_VARIABLES[input.eventKey]);
  const unknown = used.filter((v) => !known.has(v));

  audit({
    entityType: 'notification_template', entityId: row!.id,
    after: {
      eventKey: input.eventKey, channel: input.channel, locale: input.locale,
      version, active: input.active,
      ...(unknown.length > 0 ? { unknownVariables: unknown } : {}),
    },
  });
  return { templateId: row!.id, version };
});

registerHandler(ToggleNotificationRule, async ({ input, ctx, tx, audit }: HandlerArgs<
  typeof ToggleNotificationRule.input._type>) => {
  if (input.enabled && (MARKETING_EVENTS as readonly string[]).includes(input.eventKey)) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, { details: { reason: 'marketing_coming_soon' } });
  }
  const [before] = await tx<{ enabled: boolean; channels: string[] }[]>`
    select enabled, channels from notification_rules
    where location_id = ${ctx.locationId} and event_key = ${input.eventKey}`;

  await tx`
    insert into notification_rules
      (org_id, location_id, event_key, enabled, channels, offset_min, updated_by)
    values (${ctx.orgId}, ${ctx.locationId}, ${input.eventKey}, ${input.enabled},
            ${input.channels}, ${input.offsetMin}, ${ctx.membershipId})
    on conflict (location_id, event_key) do update set
      enabled = excluded.enabled,
      channels = excluded.channels,
      offset_min = excluded.offset_min,
      updated_by = excluded.updated_by,
      updated_at = now()`;

  audit({
    entityType: 'notification_rule', entityId: ctx.locationId,
    before: { enabled: before?.enabled ?? null, channels: before?.channels ?? null },
    after: { eventKey: input.eventKey, enabled: input.enabled,
             channels: input.channels, offsetMin: input.offsetMin },
  });
  return { eventKey: input.eventKey, enabled: input.enabled };
});

// ─────────────────────────────────────────────────────── 节日营销日程

/**
 * 新增或修改一个节日。
 *
 * ⚠️ 同一家店同一天只留一条（`marketing_holidays_uidx`）：两条一起发，
 * 顾客一天收两封。撞车时按 `send_on` 覆盖，而不是报错 —— 店主改名字
 * （「Thanksgiving」→「Thanksgiving Sale」）走的正是这条路。
 */
registerHandler(SaveMarketingHoliday, async ({ input, ctx, tx, audit }: HandlerArgs<
  typeof SaveMarketingHoliday.input._type>) => {
  const [row] = input.holidayId
    ? await tx<{ id: string }[]>`
        update marketing_holidays set
          name = ${input.name}, send_on = ${input.sendOn}::date,
          enabled = ${input.enabled}, updated_at = now()
        where id = ${input.holidayId} and location_id = ${ctx.locationId}
        returning id`
    : await tx<{ id: string }[]>`
        insert into marketing_holidays (org_id, location_id, name, send_on, enabled)
        values (${ctx.orgId}, ${ctx.locationId}, ${input.name},
                ${input.sendOn}::date, ${input.enabled})
        on conflict (location_id, send_on) do update set
          name = excluded.name, enabled = excluded.enabled, updated_at = now()
        returning id`;

  if (!row) {
    throw new AppError(ERROR_CODES.NOT_FOUND, {
      details: { entity: 'marketing_holiday', id: input.holidayId },
    });
  }

  audit({
    entityType: 'marketing_holiday', entityId: row.id,
    after: { name: input.name, sendOn: input.sendOn, enabled: input.enabled },
  });
  return { holidayId: row.id, sendOn: input.sendOn };
});

registerHandler(DeleteMarketingHoliday, async ({ input, ctx, tx, audit }: HandlerArgs<
  typeof DeleteMarketingHoliday.input._type>) => {
  const [row] = await tx<{ id: string; name: string; send_on: string }[]>`
    delete from marketing_holidays
    where id = ${input.holidayId} and location_id = ${ctx.locationId}
    returning id, name, send_on::text as send_on`;
  if (!row) {
    throw new AppError(ERROR_CODES.NOT_FOUND, {
      details: { entity: 'marketing_holiday', id: input.holidayId },
    });
  }
  audit({
    entityType: 'marketing_holiday', entityId: row.id,
    before: { name: row.name, sendOn: row.send_on },
    after: { deleted: true },
  });
  return { holidayId: row.id };
});
