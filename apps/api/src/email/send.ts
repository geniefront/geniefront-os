/**
 * 发邮件。供应商由 `EMAIL_PROVIDER` 决定（见 `email/provider.ts`）——
 * 当前是 Resend，SES 脱离沙箱后改一个环境变量即可切换。
 *
 * ⭐ **本模块只在业务事务之外被调用**（`email/flush.ts` 的文件头注释）。
 *
 * ⚠️ 单封邮件发送失败**不得阻断业务流程**。预约创建成功而确认邮件未送达时，
 * 预约本身仍应保留 —— 最坏情况由前台电话补充告知。反向处理（因邮件失败而
 * 回滚已成功的业务操作）不可接受（宪法第 14 条：增强项永不成为阻断点）。
 *
 * ## 三个发件域名的划分（2026-09-01 定，2026-09-02 调整域名）
 *
 * ```
 *   店家事务邮件   noreply@notify.geniefront.com        订阅、账单、平台通知
 *   客户事务邮件   noreply@appointment.geniefront.com   预约确认、变更、提醒、表单
 *   客户营销邮件   <门店标签>@mkt.geniefront.com        每店一个本地部分
 * ```
 *
 * ⚠️ 划分的依据是**信誉隔离**，不是美观。三类邮件的投诉率与退信率差异极大：
 * 营销邮件的投诉率天然高于事务性邮件，而发信信誉**按域名累积**。混用同一
 * 域名时，营销邮件的投诉会直接拉低预约确认邮件的送达率 —— 而「预约确认进了
 * 垃圾箱」这件事不会有任何人来投诉，只会表现为到店率下降。
 *
 * ⚠️ 营销侧的隔离**只到「营销 vs 事务」这一层为止**：全部门店共用
 * `mkt.geniefront.com` 一个域，收件人看到的门店身份来自本地部分。也就是说
 * **门店之间的营销信誉是共享的** —— 一家店的名单质量差会影响其余门店的营销
 * 送达率，而各店对彼此的名单既无从知晓也无从干预。这是拿「每店一个子域要
 * 每店一套 DNS 验证」换来的简化（2026-09-02 店主定）。事务性邮件不受影响，
 * 那才是这套划分真正要保护的东西。
 */

import { randomUUID } from 'node:crypto';
import { isCaptureMode, mailpitEndpoint } from '../comms/mode';
import { sesSendEmail, SesError } from '@gf/aws';
import { resendSendEmail, ResendError } from './resend';
import { emailProvider, providerConfigured } from './provider';

export interface SendResult {
  ok: boolean;
  providerId?: string;
  error?: string;
  /** 该封邮件是否**重试无意义**（地址或发件身份本身不合法）。 */
  permanent?: boolean;
  /** capture 模式：**未实际投递**，仅保留在发件箱中供测试查看。 */
  captured?: boolean;
}

/**
 * 客户事务邮件使用的 `kind`。这几类的收件人是**门店的顾客**，
 * 因此从预约域（`appointment.geniefront.com`）发出。
 *
 * ⚠️ 未列入此集合的 `kind` 一律按店家事务邮件处理（走 `FROM_EMAIL`）。
 * 默认值选择「店家域」而非「顾客域」的理由：新增一种店家通知时若忘记登记，
 * 后果只是发件域名不够贴切；反之，新增一种顾客通知时若忘记登记而默认走了
 * 顾客域，则会把一封店家邮件计入顾客域的信誉，属于静默污染。
 *
 * 完整白名单见 `packages/db/sql/0090_outbox_delivery_gaps.sql` 的
 * `email_outbox_kind` 约束。
 */
const CUSTOMER_FACING_KINDS = new Set([
  'appointment_confirm',
  'appointment_changed',
  'appointment_reminder',
  'receipt',
  'form_invite',
]);

/**
 * capture 模式与测试进程中同样视为「已配置」—— 否则 `flushEmails()` 会在
 * 首行直接返回，发件箱中的邮件将永远停留在 pending 状态，测试收件箱为空，
 * 而该页面存在的意义正是让这些邮件可见。
 */
export function emailConfigured(env = process.env): boolean {
  if (isCaptureMode(env) || env['NODE_ENV'] === 'test') return true;
  return providerConfigured(env) && Boolean(env['FROM_EMAIL']);
}

/**
 * 按邮件类型选择发件地址。
 *
 * 优先级：
 *   1. 行上已存的 `from_email`（营销邮件，门店专属子域，见 `marketingDomain.ts`）
 *   2. 客户事务类 → `CUSTOMER_FROM_EMAIL`
 *   3. 其余 → `FROM_EMAIL`
 *
 * ⚠️ `CUSTOMER_FROM_EMAIL` 未配置时回落到 `FROM_EMAIL`，而不是拒发。该变量是
 * 本次域名拆分新增的，回落保证了旧部署在未更新环境变量时仍能正常发信 ——
 * 拆分是送达率优化，不应成为发信能力的前置条件。
 */
export function fromAddressFor(
  msg: { from?: string | null; kind?: string | null }, env = process.env,
): string | undefined {
  if (msg.from) return msg.from;
  const platform = env['FROM_EMAIL'];
  if (msg.kind && CUSTOMER_FACING_KINDS.has(msg.kind)) {
    return env['CUSTOMER_FROM_EMAIL'] || platform;
  }
  return platform;
}

/**
 * capture：不出网，仅返回本地凭证。
 *
 * 同时向本机 Mailpit 投递一份（仅在配置了 `MAILPIT_URL` 时），使本地开发能在
 * 真实邮件客户端中检查排版与链接。**投递成功与否不影响返回结果** ——
 * 发件箱中保存的整封邮件才是凭据，Mailpit 仅为便于查看的视图。
 */
async function captureEmail(msg: OutgoingEmail): Promise<SendResult> {
  const endpoint = mailpitEndpoint();
  if (endpoint) {
    try {
      await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          From: { Email: 'capture@geniefront.test', Name: 'GenieFront capture' },
          To: [{ Email: msg.to }],
          Subject: msg.subject,
          HTML: msg.html,
          Text: msg.text,
        }),
        signal: AbortSignal.timeout(5_000),
      });
    } catch {
      // 本机未运行 Mailpit 属于常见情况，无需记录
    }
  }
  return { ok: true, captured: true, providerId: `capture:${randomUUID()}` };
}

export interface OutgoingEmail {
  to: string;
  subject: string;
  html: string;
  text: string;
  /**
   * 一键退订地址（RFC 8058）。**仅营销类邮件有值**。
   *
   * 有值时写入两个头部：`List-Unsubscribe` 指向该地址，`List-Unsubscribe-Post`
   * 声明其支持一键退订。缺少后者时，Gmail 与 Outlook 不会在界面上呈现
   * 「取消订阅」入口 —— 收件人只能转而点击「举报垃圾邮件」，而该操作会直接
   * 损害发信域名的信誉。
   */
  unsubscribeUrl?: string | null;
  /**
   * 覆盖发件地址。**仅营销邮件有值**（门店自身的 `marketing_email_from`，
   * 该域名须已在 SES 完成验证）。
   *
   * ⚠️ 事务性邮件不得使用该字段，其发件地址由 `fromAddressFor()` 按 `kind`
   * 决定（见本文件头「三个发件域名的划分」）。
   */
  from?: string | null;
  /** 发件箱行上的 `kind`，用于选择事务性邮件的发件域名。 */
  kind?: string | null;
}

export async function sendEmail(msg: OutgoingEmail): Promise<SendResult> {
  /**
   * 🔴 **capture 模式与测试进程中不得实际发送任何邮件。**
   *
   * `.env` 在测试进程中是被加载的（`vitest.shared` 的 `loadEnv`），因此
   * AWS 凭据在测试中有值 —— 不拦截的话，每次执行测试都会向一批不可达地址
   * 真实投递：既消耗 SES 配额，其投递失败率也会损害发信域名的信誉。
   *
   * 拦截点设在此处而非 `flush`：入队、渲染、去重、重试计数等步骤照常被覆盖，
   * 仅「实际发出」这一步被替换（与 `sms/send.ts` 遵循同一约束）。
   */
  if (isCaptureMode() || process.env['NODE_ENV'] === 'test') return captureEmail(msg);

  const from = fromAddressFor(msg);
  if (!emailConfigured() || !from) return { ok: false, error: 'not_configured' };

  /*
   * RFC 8058 的两个头部对两家供应商是同一份 —— 缺了 `List-Unsubscribe-Post`，
   * Gmail 与 Outlook 不会呈现「取消订阅」入口，收件人只能点「举报垃圾邮件」。
   */
  const headers = msg.unsubscribeUrl
    ? {
        'List-Unsubscribe': `<${msg.unsubscribeUrl}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      }
    : undefined;

  try {
    if (emailProvider() === 'ses') {
      const res = await sesSendEmail({
        from, to: msg.to, subject: msg.subject, html: msg.html, text: msg.text,
        ...(process.env['SES_CONFIGURATION_SET']
          ? { configurationSet: process.env['SES_CONFIGURATION_SET'] }
          : {}),
        ...(headers ? { headers } : {}),
      });
      return { ok: true, providerId: res.MessageId };
    }

    const res = await resendSendEmail({
      from, to: msg.to, subject: msg.subject, html: msg.html, text: msg.text,
      ...(headers ? { headers } : {}),
    });
    return { ok: true, providerId: res.id };
  } catch (e) {
    if (e instanceof SesError || e instanceof ResendError) {
      /*
       * ⭐ 4xx（地址非法、发件域名未验证、SES 沙箱下收件人未验证）
       * **重试多少次结果都相同**。不标记为永久失败的话，一个错误地址会在每次
       * 补发扫描中重试一遍，长期占据队首。
       */
      return { ok: false, error: e.message.slice(0, 200), permanent: e.permanent };
    }
    // 网络层或凭据缺失 —— 下次补发扫描时重试
    return { ok: false, error: e instanceof Error ? e.message : 'network' };
  }
}
