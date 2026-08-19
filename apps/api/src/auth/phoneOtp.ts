/**
 * 手机验证码：技师上机的第二条路（sql/0031、docs/09 §5）
 *
 * ## 为什么用别人的 Verify 服务，而不是自己发一条短信
 *
 * 验证码的生成、有效期、尝试次数、重发节流，每一条自己实现都是一次
 * 可能写错的机会，而写错了没人会发现 —— 和 `12` §2.2 不自造激活链接
 * 是同一个判断。Verify 类服务把这些做完了，我们只问它一句「这个码对不对」。
 *
 * ## ⭐ 为什么是 Twilio 而不是 Telnyx（2026-08-18 定，临时）
 *
 * 语音那条路已经定了走 Telnyx（`09`），**但验证码短信是另一回事**：
 * 美国 A2P 10DLC 在 Telnyx 名下要重新排队（`09` §1.1），批下来之前
 * 长号码发的验证码会被运营商静默过滤 —— 而「静默」是最糟的失败方式。
 *
 * Twilio Verify 走的是它自己那套为 OTP 预注册的通道，绕开了这条排队。
 * 所以：**语音 Telnyx，验证码 Twilio**，等 Telnyx 的 10DLC 批下来再合并
 * （Telnyx 那条路的代码留着，见下面 `telnyx` 分支 —— 配上
 * `TELNYX_VERIFY_PROFILE_ID` 就切过去，不用改一行代码）。
 *
 * ⚠️ 这**不推翻** `09` 的结论：那份文档定的是**语音与业务短信**走 Telnyx。
 * 这里是登录验证码，量小、和门店号码无关、随时可以换回来。
 *
 * ## 短信仍然不在依赖链上
 *
 * 宪法第 13 条照旧：技师上机的**第一条路是上机码**（老板念的 6 位数字，
 * 不经过任何运营商）。这一条是第二条路 —— 整个供应商挂掉，
 * 开店和用店都不受影响。
 */

import { AppError, ERROR_CODES } from '@gf/contracts';
import type { Locale } from '@gf/contracts';

type Provider = 'twilio' | 'telnyx';

/**
 * 用哪家。
 *
 * ⭐ 顺序即优先级，**由环境变量决定，不由代码决定** ——
 * 以后要切回 Telnyx 就是删掉 `TWILIO_VERIFY_SERVICE_SID` 那一行，
 * 不用发一次版。
 */
export function otpProvider(): Provider | null {
  const env = process.env;
  if (env['TWILIO_ACCOUNT_SID'] && env['TWILIO_AUTH_TOKEN'] && env['TWILIO_VERIFY_SERVICE_SID']) {
    return 'twilio';
  }
  if (env['TELNYX_API_KEY'] && env['TELNYX_VERIFY_PROFILE_ID']) return 'telnyx';
  return null;
}

export function verifyConfigured(): boolean {
  return otpProvider() !== null;
}

function notConfigured(): AppError {
  // 宁可整条路不可用，也不要「发了但没人收得到」——
  // 后者会让技师在登录页反复点重发，而每一次都真的花钱
  return new AppError(ERROR_CODES.UPSTREAM_UNAVAILABLE, {
    details: { service: 'phone_otp', reason: 'not_configured' },
  });
}

function upstream(service: string, reason: string): AppError {
  // ⚠️ 只留错误码，不把供应商的原文抛给前端 —— 那里面带着我们的
  // 账号 id 和请求 id
  return new AppError(ERROR_CODES.UPSTREAM_UNAVAILABLE, { details: { service, reason } });
}

// ─────────────────────────────────────────────────────────────────── Twilio

/**
 * 短信用哪种语言写。
 *
 * ⭐ 值得单独做的一件事：越南语技师收到的验证码短信是越南语的。
 * 他还没登录，所以语言只能由**他手机上那个界面**告诉我们 ——
 * 技师端登录页把当前界面语言一起传过来。
 *
 * Twilio 的语言标签和我们的不完全一样（它用 `zh-CN` / `zh-HK`），
 * 认不出的一律回落到英文 —— 发一条英文验证码，好过发不出去。
 */
const TWILIO_LOCALE: Record<string, string> = {
  en: 'en', 'zh-Hans': 'zh-CN', 'zh-Hant': 'zh-HK', ko: 'ko', vi: 'vi', es: 'es',
};

function twilioAuth(): { auth: string; serviceSid: string } {
  const sid = process.env['TWILIO_ACCOUNT_SID'];
  const token = process.env['TWILIO_AUTH_TOKEN'];
  const serviceSid = process.env['TWILIO_VERIFY_SERVICE_SID'];
  if (!sid || !token || !serviceSid) throw notConfigured();
  return {
    auth: `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}`,
    serviceSid,
  };
}

/** Twilio 的 API 收的是表单，不是 JSON —— 传 JSON 会拿到一个 400 加一句看不懂的话 */
async function twilioPost(
  path: string, form: Record<string, string>,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const { auth, serviceSid } = twilioAuth();
  const res = await fetch(`https://verify.twilio.com/v2/Services/${serviceSid}${path}`, {
    method: 'POST',
    headers: { Authorization: auth, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
    // 技师站在登录页等着，卡半分钟他会以为是自己手机的问题
    signal: AbortSignal.timeout(15_000),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, json };
}

// ─────────────────────────────────────────────────────────────────── Telnyx

async function telnyxPost(
  path: string, body: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const key = process.env['TELNYX_API_KEY'];
  if (!key) throw notConfigured();
  const res = await fetch(`https://api.telnyx.com/v2${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, json };
}

function telnyxErrorCode(json: Record<string, unknown>): string | null {
  const errs = json['errors'] as Array<{ code?: string | number }> | undefined;
  const code = errs?.[0]?.code;
  return code === undefined ? null : String(code);
}

// ─────────────────────────────────────────────────────────────────── 对外

/**
 * 发一条验证码短信。
 *
 * ⚠️ **调用方要先确认这个号码是店里某位在岗员工的**，否则等于
 * 给任意号码发短信的接口 —— 既花钱，又是一个能被用来骚扰别人的东西。
 */
export async function sendPhoneCode(phoneE164: string, locale?: Locale): Promise<void> {
  const p = otpProvider();
  if (!p) throw notConfigured();

  if (p === 'twilio') {
    const { status, json } = await twilioPost('/Verifications', {
      To: phoneE164,
      Channel: 'sms',
      Locale: TWILIO_LOCALE[locale ?? 'en'] ?? 'en',
    });
    if (status < 300) return;

    /**
     * Twilio 用 `code` 分得很细，其中两条要原样告诉技师，
     * 因为**他自己能解决**：
     *   60203 = 这个号码今天要码要得太多了 → 等一会儿
     *   60205 = 这是个座机 → 换手机
     * 其余一律收敛成 upstream 错误。
     *
     * ⚠️ 21608 = 试用账号只能发给已验证的号码。上线前一定要看一眼
     * Twilio 账号是不是还在 trial —— 这条会在真实技师身上才暴露。
     */
    const code = String(json['code'] ?? `http_${status}`);
    throw upstream('twilio_verify', code);
  }

  const { status, json } = await telnyxPost('/verifications/sms', {
    phone_number: phoneE164,
    verify_profile_id: process.env['TELNYX_VERIFY_PROFILE_ID'],
  });
  if (status >= 300) throw upstream('telnyx_verify', telnyxErrorCode(json) ?? `http_${status}`);
}

/**
 * 验一个码。返回 true = 通过。
 *
 * ⚠️ 码错了**不抛异常**：那是业务分支，不是故障。调用方要把
 * 「码不对」和「供应商挂了」分开告诉技师 —— 前者他该重输，
 * 后者他重输一百次也没用。
 */
export async function checkPhoneCode(phoneE164: string, code: string): Promise<boolean> {
  const p = otpProvider();
  if (!p) throw notConfigured();

  if (p === 'twilio') {
    const { status, json } = await twilioPost('/VerificationCheck', { To: phoneE164, Code: code });

    if (status < 300) return json['status'] === 'approved' && json['valid'] === true;

    /**
     * 这两个都是**业务分支**，不是故障：
     *   404   = 这个号码上没有进行中的验证（码过期了，或者压根没发过）
     *   60202 = 试错次数用完了，这次验证作废
     * 对技师来说两者要做的事一样：重新要一条。
     */
    if (status === 404 || String(json['code']) === '60202') return false;

    throw upstream('twilio_verify', String(json['code'] ?? `http_${status}`));
  }

  const { status, json } = await telnyxPost(
    `/verifications/by_phone_number/${encodeURIComponent(phoneE164)}/actions/verify`,
    { code, verify_profile_id: process.env['TELNYX_VERIFY_PROFILE_ID'] },
  );
  // Telnyx 对「码不对」返回的是 200 + response_code=rejected（不是 4xx）
  if (status < 300) {
    return (json['data'] as { response_code?: string } | undefined)?.response_code === 'accepted';
  }
  if (status === 404) return false;
  throw upstream('telnyx_verify', telnyxErrorCode(json) ?? `http_${status}`);
}
