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

import { timingSafeEqual } from 'node:crypto';
import { AppError, ERROR_CODES } from '@gf/contracts';
import type { Locale } from '@gf/contracts';
import { isProductionEnv } from '../comms/mode';

type Provider = 'twilio' | 'telnyx';

// ──────────────────────────────────────────────── staging 固定验证码（测试用）

/**
 * ## 为什么必须做这一件事
 *
 * Twilio Verify **没有 Test Credentials 这条路**：它不像 Programmable SMS
 * 那样有一组「假装发出去了」的测试凭据，验证码只会真的发到真手机上。
 * 于是 staging 上「技师用手机号上机」这条路在自动化里根本走不通 ——
 * 要么每次找个真人念验证码，要么这条路就永远没被测过。
 *
 * 所以在**应用侧**做一个测试 provider：白名单里的号码用固定验证码。
 *
 * ## 三道锁，缺一不可
 *
 *   1. `GF_ENV` 不是 production（`comms/mode.ts`：GF_ENV 缺失时按生产处理）
 *   2. `STAGING_OTP_CODE` 显式配了，且是 4–8 位数字
 *   3. 这个号码在 `STAGING_OTP_PHONES` 白名单里 —— **没有默认白名单**
 *
 * 第 3 条是重点：不限号码的话，这个开关等于「任何人的手机号都能用固定码
 * 登录」，而 staging 上是有真实店主数据的。白名单支持前缀（`+1617555*`），
 * 因为测试号段是一批而不是一个。
 *
 * ⚠️ 生产环境只要检测到 `STAGING_OTP_CODE` 就**拒绝启动**
 * （`assertCommunicationSafety`）—— 这一条不能只靠「记得别配」。
 */
function stagingOtpCode(env = process.env): string | null {
  if (isProductionEnv(env)) return null;
  const code = env['STAGING_OTP_CODE'];
  if (!code || !/^\d{4,8}$/.test(code)) return null;
  return code;
}

/** 白名单：整号或以 `*` 结尾的前缀，逗号分隔。 */
function stagingOtpAllows(phoneE164: string, env = process.env): boolean {
  const raw = env['STAGING_OTP_PHONES'];
  if (!raw) return false;
  return raw.split(',').map((s) => s.trim()).filter(Boolean).some((entry) => (
    entry.endsWith('*')
      ? phoneE164.startsWith(entry.slice(0, -1))
      : phoneE164 === entry
  ));
}

/** 这个号码走不走测试 provider。三道锁全开才算。 */
export function stagingOtpApplies(phoneE164: string, env = process.env): boolean {
  return stagingOtpCode(env) !== null && stagingOtpAllows(phoneE164, env);
}

/** 定长比较。验证码短，逐字符早退的比较是能被计时区分出来的。 */
function sameCode(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

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
  // staging 上配了固定验证码，这条路就是通的 —— 哪怕一家供应商都没接
  return otpProvider() !== null || stagingOtpCode() !== null;
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
  /**
   * 测试 provider：什么都不发，直接当成功。
   *
   * ⚠️ 这里**不把验证码写进任何地方**（日志、发件箱都不写）：它是配置里的
   * 一个常量，跑测试的人本来就知道。写出来只会多一个泄漏点。
   */
  if (stagingOtpApplies(phoneE164)) return;

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
  /**
   * 测试 provider。⚠️ 判到这里就**不再往下走真供应商**：
   * 白名单里的号码在 staging 上永远只认这个固定码，
   * 免得出现「有时通过有时不通过」这种最难查的状态。
   */
  const staged = stagingOtpCode();
  if (staged && stagingOtpAllows(phoneE164)) return sameCode(code, staged);

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
