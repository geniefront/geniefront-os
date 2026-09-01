/**
 * 通知设置页要的一整份数据。
 *
 * ⚠️ 与 `queries/notifications.ts` 是两件事：那一份是**应用内通知中心**
 * （前台看的消息列表与未读数），这一份是**外发通知的配置**
 * （规则、模板、节日日程）。名字像，用途完全不同。
 *
 * ## 为什么把「闸门状态」也一并给出来
 *
 * 这一页最容易产生的误解是：店主把某个营销开关打开，以为顾客就会收到。
 * 而实际上后面还有四道闸门（10DLC、发件域名、顾客订阅、静默时段），
 * 任何一道不通都一条也发不出去 —— **而且不会报错**。
 *
 * 只给开关不给闸门状态，店主唯一能得到的反馈是「打开了，然后什么也没发生」。
 * 因此这份返回里带上 `gates`，界面据此在开关旁边直接说明它现在通不通。
 */

import type postgres from 'postgres';
import type { CommandContext } from '@gf/contracts';
import { NOTIFICATION_EVENTS, EVENT_VARIABLES, MARKETING_EVENTS } from '@gf/contracts';

export interface NotificationRuleDto {
  eventKey: string;
  enabled: boolean;
  channels: string[];
  offsetMin: number;
}

export interface NotificationTemplateDto {
  id: string;
  eventKey: string;
  channel: 'sms' | 'email';
  locale: string;
  version: number;
  subject: string | null;
  body: string;
}

export interface MarketingHolidayDto {
  id: string;
  name: string;
  sendOn: string;
  enabled: boolean;
}

export interface NotificationSettingsDto {
  /** 12 个事件，每个都有一行 —— 没配过的也给出默认关闭的那一行 */
  rules: NotificationRuleDto[];
  /** 只给**在用**的那一版；历史版本留在库里给已入队的消息用 */
  templates: NotificationTemplateDto[];
  holidays: MarketingHolidayDto[];
  /** 每个事件认得哪些变量。界面据此告诉店主他能用什么 */
  variables: Record<string, readonly string[]>;
  marketingEvents: readonly string[];
  gates: {
    /** 门店自己的 10DLC。营销短信、技师通知、前台手打都卡在这里 */
    tenDlcStatus: string;
    /** 营销邮件的门店专属发件地址。null = 未就绪 */
    marketingEmailFrom: string | null;
    /** 顾客侧短信的静默时段，门店本地时间 */
    quietHours: { start: number; end: number };
  };
}

export async function loadNotificationSettings(
  tx: postgres.TransactionSql,
  ctx: CommandContext,
): Promise<NotificationSettingsDto> {
  const ruleRows = await tx<{
    event_key: string; enabled: boolean; channels: string[]; offset_min: number;
  }[]>`
    select event_key, enabled, channels, offset_min
    from notification_rules where location_id = ${ctx.locationId}`;
  const byEvent = new Map(ruleRows.map((r) => [r.event_key, r]));

  /*
   * ⚠️ 12 个事件**全部给出来**，没配过的补一行默认关闭的。
   *
   * 只返回已有行的话，界面上就只看得到店主动过的那几个 —— 而他找不到的
   * 那几个看起来像「这个功能不存在」，而不是「这个开关是关着的」。
   */
  const rules: NotificationRuleDto[] = NOTIFICATION_EVENTS.map((eventKey) => {
    const row = byEvent.get(eventKey);
    return {
      eventKey,
      enabled: row?.enabled ?? false,
      channels: row?.channels ?? [],
      offsetMin: row?.offset_min ?? 0,
    };
  });

  /*
   * 只取 `active = true` 的那一版。历史版本留在库里是给**已经入队**的消息
   * 用的（0044：outbox 那一行就是那封信本身，内容不该事后漂移），
   * 不该出现在编辑器里。
   */
  const templates = await tx<{
    id: string; event_key: string; channel: 'sms' | 'email'; locale: string;
    version: number; subject: string | null; body: string;
  }[]>`
    select id, event_key, channel, locale, version, subject, body
    from notification_templates
    where location_id = ${ctx.locationId} and active = true
    order by event_key, channel, locale`;

  const holidays = await tx<{
    id: string; name: string; send_on: string; enabled: boolean;
  }[]>`
    select id, name, send_on::text as send_on, enabled
    from marketing_holidays where location_id = ${ctx.locationId}
    order by send_on`;

  const [dlc] = await tx<{ status: string }[]>`
    select status from location_10dlc_registrations where location_id = ${ctx.locationId}`;
  const [loc] = await tx<{ from_addr: string | null }[]>`
    select marketing_email_from as from_addr from locations where id = ${ctx.locationId}`;

  return {
    rules,
    templates: templates.map((t) => ({
      id: t.id, eventKey: t.event_key, channel: t.channel, locale: t.locale,
      version: t.version, subject: t.subject, body: t.body,
    })),
    holidays: holidays.map((h) => ({
      id: h.id, name: h.name, sendOn: h.send_on, enabled: h.enabled,
    })),
    variables: EVENT_VARIABLES,
    marketingEvents: MARKETING_EVENTS,
    gates: {
      // 查不到行 = 从未提交 = 未获批（与 `sms/gate.ts` 的判定一致）
      tenDlcStatus: dlc?.status ?? 'not_submitted',
      marketingEmailFrom: loc?.from_addr ?? null,
      quietHours: { start: 8, end: 21 },
    },
  };
}
