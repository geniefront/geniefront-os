/** Explicit provider selection; a typo must not silently change the sending account. */
export type EmailProvider = 'resend' | 'ses' | 'elasticemail';

/**
 * 当前供应商。
 *
 * ⚠️ 无法识别的值**回退到 `resend`**，而不是抛错或回退到 SES。理由：这个变量
 * 打错字（`Resend `、`RESEND`、`sess`）时，最坏情况必须是「继续用当前能真正
 * 送达的那一家」，而不是「切到一个沙箱账号后所有邮件被静默拒收」。
 * 大小写与首尾空白都容忍。
 */
export function emailProvider(env = process.env): EmailProvider {
  const value = env['EMAIL_PROVIDER']?.trim().toLowerCase();
  if (value === 'elasticemail' || value === 'elastic') return 'elasticemail';
  if (value === 'ses') return 'ses';
  if (!value || value === 'resend') return 'resend';
  throw new Error('invalid_email_provider');
}

/** 当前供应商的凭据是否配齐。发件地址是否配齐由 `send.ts` 单独判断。 */
export function providerConfigured(env = process.env): boolean {
  if (emailProvider(env) === 'elasticemail') return Boolean(env['ELASTICEMAIL_SEND_API_KEY'] || env['ELASTICEMAIL_API_KEY'] || env['ELASTIC_EMAIL_API_KEY']);
  return emailProvider(env) === 'ses'
    ? Boolean(env['AWS_ACCESS_KEY_ID'] && env['AWS_SECRET_ACCESS_KEY'])
    : Boolean(env['RESEND_API_KEY']);
}
