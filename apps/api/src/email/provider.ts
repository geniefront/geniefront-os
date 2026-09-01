/**
 * 邮件供应商的切换点 —— Resend 与 AWS SES 二选一。
 *
 * ```
 * EMAIL_PROVIDER=resend   （默认，当前生产在用）
 * EMAIL_PROVIDER=ses      （SES 脱离沙箱后改这一行即可，不需要改代码）
 * ```
 *
 * ## 为什么两家都留着
 *
 * SES 账号在 2026-09-01 时仍处于沙箱：只有已在 SES 验证过的收件地址能收到邮件，
 * 发往其余地址一律 `MessageRejected`。而生产环境必须能给任意顾客发信，
 * 因此发信实际走 Resend，SES 的整套实现（`@gf/aws` + `snsWebhook.ts`）保留待用。
 *
 * ## ⚠️ 切换时必须一起动的三样东西
 *
 * 换 `EMAIL_PROVIDER` **不只是换一个发信通道**：
 *
 *   1. **发件域名要在新供应商那边验证过。** 三个域（`notify.` / `appointment.` /
 *      `mkt.`）当前只在 Resend 验证。SES 侧验过的是另外三个（`mail.` / `app.` /
 *      根域），两边的 DKIM 记录不同 —— 直接切会让每一封都被拒。
 *   2. **投递回调换路由。** Resend 走 `/v1/webhooks/resend`（Svix HMAC），
 *      SES 走 `/v1/webhooks/ses`（SNS 的 X.509 签名 + 配置集事件目标）。
 *      漏配的表现是退信与投诉**静默停止回流**，而发信一切正常。
 *   3. **历史 `provider_id` 不通用。** 发件箱里已有的行记的是旧供应商的消息 id，
 *      新供应商的回调永远匹配不上它们。这不是错误，但会让切换当天的
 *      「送达率」看起来断崖 —— 那是口径变化，不是投递故障。
 *
 * 切换前后都跑一次 `pnpm diagnose:comms:*`，它按当前 provider 体检对应那一侧。
 */

export type EmailProvider = 'resend' | 'ses';

/**
 * 当前供应商。
 *
 * ⚠️ 无法识别的值**回退到 `resend`**，而不是抛错或回退到 SES。理由：这个变量
 * 打错字（`Resend `、`RESEND`、`sess`）时，最坏情况必须是「继续用当前能真正
 * 送达的那一家」，而不是「切到一个沙箱账号后所有邮件被静默拒收」。
 * 大小写与首尾空白都容忍。
 */
export function emailProvider(env = process.env): EmailProvider {
  return env['EMAIL_PROVIDER']?.trim().toLowerCase() === 'ses' ? 'ses' : 'resend';
}

/** 当前供应商的凭据是否配齐。发件地址是否配齐由 `send.ts` 单独判断。 */
export function providerConfigured(env = process.env): boolean {
  return emailProvider(env) === 'ses'
    ? Boolean(env['AWS_ACCESS_KEY_ID'] && env['AWS_SECRET_ACCESS_KEY'])
    : Boolean(env['RESEND_API_KEY']);
}
