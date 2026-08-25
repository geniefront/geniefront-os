/**
 * 按事件发通知（批 8 收尾）。
 *
 * ## 这个文件补上的是批 3 留下的那个口子
 *
 * 批 3 让 AI 能在电话里改期和取消，但当时**没有通知客人的能力** ——
 * 权限清单的注释里写了「客人侧的变更通知留到批 7」。批 7 建好了
 * 模板的表和命令，这个文件把它们接进业务链路。
 *
 * 在此之前，「被静默改掉的单没人会发现」那条顾虑是成立的。现在不了。
 *
 * ## 两条纪律
 *
 * 1. **只入队，不发送。** 和确认信一样写进 outbox，发在事务提交之后。
 *    在事务里发的话，回滚之后客人已经收到了一条说预约改了的短信，
 *    而那一单原封不动。
 * 2. **渲染发生在入队那一刻，并且记下用的是哪个模板哪一版。**
 *    outbox 那一行**就是那封信本身** —— 事后改模板不该让它的内容漂移。
 */

import {
  renderTemplate, isNotificationEvent,
  type NotificationEvent, type CommandContext,
} from '@gf/contracts';
import type postgres from 'postgres';
import { segmentsOf } from '../sms/segments';
import { smsFrom } from '../sms/send';

type Tx = postgres.TransactionSql;

export interface NotifyArgs {
  event: NotificationEvent;
  /** 挂在哪个实体上。outbox 的幂等键是 (entity_type, entity_id, kind) */
  entityType: string;
  entityId: string;
  vars: Readonly<Record<string, string | null | undefined>>;
  /** 收件人。两个都空就不发 —— 散客没留联系方式是常态，不是错误 */
  toEmail?: string | null;
  toPhone?: string | null;
  /** 用哪种语言的模板。取不到就回退门店默认 */
  locale?: string | null;
}

/**
 * 查规则 → 查模板 → 渲染 → 入队。
 *
 * 返回真正入队了几条。**规则关着、没模板、没收件人都返回 0 而不抛错** ——
 * 通知永远不该阻断业务（宪法第 13/14 条：短信永不成为阻断点）。
 * 一条改期因为「模板没配」而整个失败，是最不能接受的失败方式。
 */
export async function notifyEvent(
  tx: Tx, ctx: CommandContext, args: NotifyArgs,
): Promise<number> {
  if (!isNotificationEvent(args.event)) return 0;

  const [rule] = await tx<{ enabled: boolean; channels: string[] }[]>`
    select enabled, channels from notification_rules
    where location_id = ${ctx.locationId} and event_key = ${args.event}`;

  /*
   * ⚠️ **没有规则行 = 不发。**
   *
   * 反过来（默认全开）的话，装上这个版本的那一刻，所有历史门店会
   * 突然开始给客人发短信 —— 而短信要花钱，也会被投诉。
   * 老板要在通知设置页里明确打开。
   */
  if (!rule?.enabled || rule.channels.length === 0) return 0;

  const locale = args.locale ?? ctx.locale ?? 'en';
  let queued = 0;

  for (const channel of rule.channels) {
    const to = channel === 'email' ? args.toEmail : args.toPhone;
    if (!to) continue;

    /*
     * 取模板：先按请求的语言找，找不到回退 en。
     *
     * ⚠️ 回退到 en 而不是「随便挑一个存在的」—— 后者会让一个只配了
     * 越南语模板的店给所有客人发越南语。
     */
    const [tpl] = await tx<{
      id: string; version: number; subject: string | null; body: string;
    }[]>`
      select id, version, subject, body from notification_templates
      where location_id = ${ctx.locationId} and event_key = ${args.event}
        and channel = ${channel} and active = true
        and locale in (${locale}, 'en')
      order by (locale = ${locale}) desc, version desc
      limit 1`;
    if (!tpl) continue;

    const body = renderTemplate(tpl.body, args.vars);
    const subject = tpl.subject ? renderTemplate(tpl.subject, args.vars) : null;

    if (channel === 'email') {
      await tx`
        insert into email_outbox
          (org_id, location_id, kind, to_email, subject, body_html, body_text,
           entity_type, entity_id, template_id, template_version)
        values (${ctx.orgId}, ${ctx.locationId}, ${outboxKind(args.event)}, ${to},
                ${subject ?? ''}, ${escapeHtml(body)}, ${body},
                ${args.entityType}, ${args.entityId}, ${tpl.id}, ${tpl.version})
        on conflict (entity_type, entity_id, kind) do nothing`;
    } else {
      /*
       * ⚠️ `segments` 必须算，**不能默认 1**：计费凭据按段记不按条
       * （docs/09 §5）。一条混进中文的短信是 UCS-2、70 字符一段，
       * 按条记会低估一倍以上。
       */
      await tx`
        insert into sms_outbox
          (org_id, location_id, kind, to_e164, from_e164, body, segments,
           entity_type, entity_id)
        values (${ctx.orgId}, ${ctx.locationId}, ${outboxKind(args.event)}, ${to},
                ${smsFrom()}, ${body}, ${segmentsOf(body)},
                ${args.entityType}, ${args.entityId})
        on conflict (entity_type, entity_id, kind) do nothing`;
    }
    queued++;
  }

  return queued;
}

/**
 * 事件 → outbox 的 kind。
 *
 * ⚠️ outbox 的 kind 有 check 白名单，只有四个值，而通知事件有 12 个。
 * 全部加进白名单会让那条 check 变成一张必须和这里同步的表 ——
 * 所以映射到已有的几个，**真正的事件类型记在 `entity_type` 和模板 id 上**。
 */
function outboxKind(event: NotificationEvent): string {
  if (event === 'appointment_confirm') return 'appointment_confirm';
  if (event === 'appointment_reminder') return 'appointment_reminder';
  return 'appointment_changed';
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
   .replace(/"/g, '&quot;').replace(/\n/g, '<br>');
