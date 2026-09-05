/**
 * 按事件发通知（批 8 收尾）。
 *
 * ## 这个文件补上的是批 3 留下的缺口
 *
 * 批 3 让 AI 能在电话里改期和取消，但当时**没有通知顾客的能力** ——
 * 权限清单的注释里写明「顾客侧的变更通知留到批 7」。批 7 建好了模板的表
 * 与命令，本文件把它们接入业务链路。
 *
 * ## 四条纪律
 *
 * 1. **只入队，不投递。** 与确认信一致，写进 outbox，投递发生在事务提交
 *    之后。在事务内投递意味着回滚之后顾客已经收到一条说预约改了的短信，
 *    而那一单原封不动。
 * 2. **渲染发生在入队那一刻，并记录用的是哪个模板哪一版。**
 *    outbox 中的那一行**即是那封信本身** —— 事后修改模板不应使其内容漂移。
 * 3. **顾客侧的语言恒为英语。** 调用方固定传 `'en'`，本文件不做语言推断
 *    （`email/render.ts` 文件头的语言策略）。
 * 4. **合规约束在此处强制，不交给模板。** 短信的品牌署名与退订说明由
 *    `withComplianceFooter()` 补齐；营销邮件的退订地址由本文件生成。
 *    写进模板意味着店主可以在编辑框里把它删掉。
 */

import {
  renderTemplate, isNotificationEvent, MARKETING_EVENTS,
  type NotificationEvent, type CommandContext,
} from '@gf/contracts';
import type postgres from 'postgres';
import { measure, segmentsOf } from '../sms/segments';
import { smsFrom } from '../sms/send';
import { withComplianceFooter } from '../sms/render';
import { tenDlcApproved, usesPlatformBrand } from '../sms/gate';
import { mintUnsubscribeToken } from '../email/unsubscribe';
import { renderMarketingEmail, renderTemplatedEmailHtml } from '../email/layout';
import { enqueueShopCopy } from '../email/shopCopy';
import { emailUnsubscribePostUrl, emailUnsubscribeUrl } from '../links';

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
  /**
   * 用哪种语言的模板。
   *
   * ⚠️ 顾客侧一律传 `'en'`。此前调用方传的是 `customers.locale`，
   * 于是只要店主配过一份中文模板，`locale = 'zh-Hans'` 的顾客收到的
   * 就是中文邮件与中文短信。
   */
  locale?: string | null;
  /**
   * 营销类事件的退订标识。缺省时不放退订链接。
   *
   * ⚠️ 营销邮件**必须**能退订（CAN-SPAM）。因此营销事件缺少该标识时
   * 邮件渠道会被跳过 —— 宁可不发，也不发一封退不掉的商业邮件。
   */
  customerId?: string | null;
}

const isMarketing = (e: NotificationEvent): boolean =>
  (MARKETING_EVENTS as readonly string[]).includes(e);

/**
 * 查规则 → 查营销订阅 → 查模板 → 渲染 → 入队。
 *
 * 返回真正入队了几条。**规则关着、没模板、没收件人、未订阅营销都返回 0
 * 而不抛错** —— 通知永远不该阻断业务（宪法第 13/14 条）。
 * 一次改期因为「模板没配」而整体失败，是最不能接受的失败方式。
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
   * 反过来（默认全开）意味着部署本版本的那一刻，所有存量门店会突然开始
   * 给顾客发短信 —— 短信要花钱，也会被投诉。店主须在通知设置页明确打开。
   */
  if (!rule?.enabled || rule.channels.length === 0) return 0;

  const marketing = isMarketing(args.event);
  // Phase 1: no marketing, including SMS and callers outside the scheduler.
  if (marketing) return 0;

  /*
   * 🔴 **短信品牌闸门（2026-09-01 店主定）。**
   *
   * 只有四类事务性通知走平台注册品牌，无条件放行；其余一律要等门店自己的
   * 10DLC 获批。理由见 `sms/gate.ts`：在未获批的品牌上发商业性短信，
   * 运营商掐的是**整条通道**，届时连预约确认也一并发不出去。
   *
   * ⚠️ 拦在这里而不是「让店主别打开那个开关」—— 开关是一次点击的事，
   * 而那一次点击不该有能力触发上述后果。
   */
  const smsAllowed = usesPlatformBrand(args.event)
    || await tenDlcApproved(tx, ctx.locationId);

  /*
   * 🔴 **营销邮件需要门店专属发件域名。**
   *
   * 用平台的 `FROM_EMAIL` 群发商业邮件，会把投诉率与退信率算到平台域名
   * 头上 —— 一家店的营销邮件被举报，受损的是所有门店的事务性邮件送达率。
   * 因此营销邮件必须从门店自己的、已在 SES 完成验证的地址发出
   * （`locations.marketing_email_from`，sql/0088）。为空即视为未就绪。
   */
  let marketingEmailFrom: string | null = null;
  if (marketing) {
    const [loc] = await tx<{ from_addr: string | null }[]>`
      select marketing_email_from as from_addr from locations
      where id = ${ctx.locationId}`;
    marketingEmailFrom = loc?.from_addr ?? null;
  }

  /*
   * ⭐ 营销类必须查订阅开关，事务性不查。
   *
   * 两者在 TCPA / CAN-SPAM 下是分开的：顾客自己刚订了这个预约，我们回执
   * 一条确认属于事务性通信；而生日祝福、唤回、求评属商业信息，必须有
   * 明示同意。把确认卡在营销开关后面会导致「订了但没收到确认」，
   * 把营销发给未订阅者则是合规事故。
   */
  let allowMarketingSms = false;
  let allowMarketingEmail = false;
  if (marketing) {
    if (!args.customerId) return 0;
    const [c] = await tx<{ sms: boolean; email: boolean }[]>`
      select marketing_sms_opt_in as sms, marketing_email_opt_in as email
      from customers where id = ${args.customerId} and org_id = ${ctx.orgId}`;
    if (!c) return 0;
    allowMarketingSms = c.sms;
    allowMarketingEmail = c.email;
    if (!allowMarketingSms && !allowMarketingEmail) return 0;
  }

  /*
   * ⚠️ 顾客侧固定 `'en'`。调用方漏传时同样落到 `'en'` 而不是 `ctx.locale` ——
   * 后者是当前操作员的界面语言，与收件人无关。
   */
  const locale = args.locale ?? 'en';
  let queued = 0;

  for (const channel of rule.channels) {
    const to = channel === 'email' ? args.toEmail : args.toPhone;
    if (!to) continue;
    if (marketing && channel === 'email' && !allowMarketingEmail) continue;
    if (marketing && channel === 'sms' && !allowMarketingSms) continue;
    // 门店 10DLC 未获批：除四类事务性通知外，短信一律不发
    if (channel === 'sms' && !smsAllowed) continue;
    // 门店专属发件域名未就绪：营销邮件一律不发
    if (marketing && channel === 'email' && !marketingEmailFrom) continue;

    /*
     * 取模板：先按请求的语言找，找不到回退 en。
     *
     * ⚠️ 回退到 en 而不是「任选一个存在的」—— 后者会让一家只配了越南语
     * 模板的门店给所有顾客发越南语。
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
      /*
       * 营销邮件的退订地址。
       *
       * ⚠️ 令牌签发失败（`APP_JWT_SECRET` 未配置）时**跳过这一封**，
       * 而不是发一封没有退订入口的商业邮件。
       */
      let unsubscribeUrl: string | null = null;
      let text = body;
      let html = renderTemplatedEmailHtml(body);
      if (marketing) {
        const token = args.customerId
          ? mintUnsubscribeToken({ customerId: args.customerId, orgId: ctx.orgId })
          : null;
        if (!token) continue;
        unsubscribeUrl = emailUnsubscribePostUrl(token);
        const rendered = renderMarketingEmail(body, emailUnsubscribeUrl(token));
        text = rendered.text;
        html = rendered.html;
      }

      await tx`
        insert into email_outbox
          (org_id, location_id, kind, to_email, subject, body_html, body_text,
           entity_type, entity_id, template_id, template_version,
           unsubscribe_url, from_email)
        values (${ctx.orgId}, ${ctx.locationId}, ${outboxKind(args.event)}, ${to},
                ${subject ?? ''}, ${html}, ${text},
                ${args.entityType}, ${args.entityId}, ${tpl.id}, ${tpl.version},
                ${unsubscribeUrl}, ${marketingEmailFrom})
        on conflict (entity_type, entity_id, kind) do nothing`;

      /*
       * 预约类邮件抄送门店一份（可在设置里关）。
       *
       * ⚠️ 只抄送走平台品牌的那四类。营销邮件抄给店主没有意义 ——
       * 那是他自己发起的群发，而且抄送里带着顾客的退订链接。
       */
      if (usesPlatformBrand(args.event)) {
        await enqueueShopCopy(tx, {
          orgId: ctx.orgId,
          locationId: ctx.locationId,
          kind: outboxKind(args.event),
          entityType: args.entityType,
          entityId: args.entityId,
          subject: subject ?? '',
          html, text,
          customerEmail: to,
        });
      }
    } else {
      /*
       * ⭐ 合规署名与退订说明在此处补齐，不依赖模板内容。
       * 模板里写的话，店主可以在编辑框里把它删掉。
       */
      const smsBody = withComplianceFooter(body);

      /*
       * 🔴 **非 GSM-7 的短信一律不发。**
       *
       * 顾客短信恒为英语。此处是最后一道闸：变量替换之后才知道正文里到底
       * 有没有中文 —— 模板本身是英语，但 `{{shop_name}}` 之类的变量可能带
       * 进非 ASCII 字符。一个这样的字符就把整条从 GSM-7（160 字符/段）推进
       * UCS-2（70 字符/段），费用翻倍。
       *
       * 落 `suppressed` 而不是静默丢弃：outbox 里留着这一行与原因，
       * 运营台上看得见，否则「顾客没收到通知」将无从追查。
       */
      const encoding = measure(smsBody).encoding;
      if (encoding !== 'GSM-7') {
        await tx`
          insert into sms_outbox
            (org_id, location_id, kind, to_e164, from_e164, body, segments,
             entity_type, entity_id, status, last_error)
          values (${ctx.orgId}, ${ctx.locationId}, ${outboxKind(args.event)}, ${to},
                  ${smsFrom()}, ${smsBody}, ${segmentsOf(smsBody)},
                  ${args.entityType}, ${args.entityId}, 'suppressed', 'non_gsm7_body')
          on conflict (entity_type, entity_id, kind) do nothing`;
        continue;
      }

      /*
       * ⚠️ `segments` 必须算，**不能默认 1**：计费凭据按段记不按条
       * （docs/09 §5）。
       */
      /*
       * ⚠️ `quiet_hours` 只对营销类置 true。
       *
       * TCPA 限制商业性短信只能在收件人当地 08:00–21:00 之间发送；事务性
       * 短信不受此限，也不应受限 —— 晚上十点下的单拖到次日早八点才确认，
       * 等于确认没有发生。实际判定在 `sms/flush.ts` 投递前进行。
       */
      await tx`
        insert into sms_outbox
          (org_id, location_id, kind, to_e164, from_e164, body, segments,
           entity_type, entity_id, quiet_hours)
        values (${ctx.orgId}, ${ctx.locationId}, ${outboxKind(args.event)}, ${to},
                ${smsFrom()}, ${smsBody}, ${segmentsOf(smsBody)},
                ${args.entityType}, ${args.entityId}, ${marketing})
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
 * 全部加进白名单会让那条 check 变成一张必须与此处同步的表 ——
 * 因此映射到已有的几个，**真正的事件类型记在 `entity_type` 与模板 id 上**。
 */
function outboxKind(event: NotificationEvent): string {
  if (event === 'appointment_confirm') return 'appointment_confirm';
  if (event === 'appointment_reminder') return 'appointment_reminder';
  return 'appointment_changed';
}
